import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import {
  encodeInvestorHistory,
  encodeInvestorUsers,
  encodeInvestorDashboard,
  encodeInvestorPortfolio,
  encodeOrdersByRole,
  encodeTraderPortfolio,
  encodeTraderDashboard,
  encodeTraderHistory,
  encodeTraderUsers,
  encodeTradingAccountsByRole,
} from "../src/persistence.js";

const backendDirectory = fileURLToPath(new URL("..", import.meta.url));
let server;
let apiUrl;
let temporaryDirectory;
const investorHeaders = (email, role = "investor") => ({
  "Content-Type": "application/json",
  "X-Investor-Id": email,
  "X-Investor-Name": email.split("@")[0],
  "X-Investor-Role": role,
});

test("copies only hashed trader account records into users_trader documents", () => {
  const users = [
    {
      first_name: "Trader",
      last_name: "One",
      email: "trader@example.com",
      role: "trader",
      avatarUrl: "data:image/jpeg;base64,/9j/2Q==",
      passwordHash: "salt:hash",
      createdAt: 123,
    },
    {
      first_name: "Investor",
      last_name: "One",
      email: "investor@example.com",
      role: "investor",
      avatarUrl: "data:image/jpeg;base64,/9j/2Q==",
      passwordHash: "salt:hash",
      createdAt: 456,
    },
  ];

  assert.deepEqual(encodeTraderUsers(users), [
    { ...users[0], _id: "trader@example.com" },
  ]);
});

test("copies only hashed investor account records into users_investor documents", () => {
  const users = [
    {
      first_name: "Trader",
      last_name: "One",
      email: "trader@example.com",
      role: "trader",
      passwordHash: "salt:hash",
      createdAt: 123,
    },
    {
      first_name: "Investor",
      last_name: "One",
      email: "investor@example.com",
      role: "investor",
      passwordHash: "salt:hash",
      createdAt: 456,
    },
  ];

  assert.deepEqual(encodeInvestorUsers(users), [
    { ...users[1], _id: "investor@example.com" },
  ]);
});

test("partitions persisted trading accounts by role", () => {
  const ledger = {
    investors: {
      investorId: { email: "investor@example.com", role: "investor" },
      traderId: { email: "trader@example.com", role: "trader" },
      adminId: { email: "admin@example.com", role: "admin" },
      legacyId: { email: "legacy@example.com" },
    },
  };

  assert.deepEqual(
    encodeTradingAccountsByRole(ledger, "trader").map(({ _id, role }) => ({ _id, role })),
    [{ _id: "traderId", role: "trader" }]
  );
  assert.deepEqual(
    encodeTradingAccountsByRole(ledger, "investor").map(({ _id, role }) => ({ _id, role })),
    [{ _id: "investorId", role: "investor" }, { _id: "legacyId", role: undefined }]
  );
  assert.deepEqual(
    encodeTradingAccountsByRole(ledger, "admin").map(({ _id, role }) => ({ _id, role })),
    [{ _id: "adminId", role: "admin" }]
  );
});

test("partitions order documents into trader and investor collections", () => {
  const ledger = {
    investors: {
      traderId: {
        email: "trader@example.com",
        role: "trader",
        orders: [{ id: "trader-order", side: "BUY" }],
      },
      investorId: {
        email: "investor@example.com",
        role: "investor",
        orders: [{ id: "investor-order", side: "SELL" }],
      },
      legacyId: {
        email: "legacy@example.com",
        orders: [{ id: "legacy-order", side: "BUY" }],
      },
    },
  };

  assert.deepEqual(
    encodeOrdersByRole(ledger, "trader").map(({ _id, accountEmail, accountRole }) => ({
      _id,
      accountEmail,
      accountRole,
    })),
    [{ _id: "trader-order", accountEmail: "trader@example.com", accountRole: "trader" }]
  );
  assert.deepEqual(
    encodeOrdersByRole(ledger, "investor").map(({ _id, accountEmail, accountRole }) => ({
      _id,
      accountEmail,
      accountRole,
    })),
    [
      { _id: "investor-order", accountEmail: "investor@example.com", accountRole: "investor" },
      { _id: "legacy-order", accountEmail: "legacy@example.com", accountRole: "investor" },
    ]
  );
  assert.deepEqual(encodeTraderHistory(ledger), encodeOrdersByRole(ledger, "trader"));
  assert.deepEqual(encodeInvestorHistory(ledger), encodeOrdersByRole(ledger, "investor"));
});

test("creates dashboard summary documents for trader accounts only", () => {
  const ledger = {
    investors: {
      traderId: {
        email: "trader@example.com",
        displayName: "Trader One",
        role: "trader",
        cashBalance: 900,
        orders: [{ id: "order-1", timestamp: 100, side: "BUY" }],
        positions: [{
          id: "position-1",
          stockId: "stock-1",
          symbol: "TEST",
          direction: "LONG",
          quantity: 2,
          investedAmount: 100,
          realizedPnl: 5,
          status: "OPEN",
        }],
      },
      investorId: {
        email: "investor@example.com",
        role: "investor",
        orders: [],
        positions: [],
      },
    },
  };

  const [dashboard] = encodeTraderDashboard(ledger, [
    { id: "stock-1", basePrice: 60 },
  ]);
  assert.equal(dashboard._id, "traderId");
  assert.equal(dashboard.email, "trader@example.com");
  assert.equal(dashboard.role, "trader");
  assert.equal(dashboard.cashBalance, 900);
  assert.equal(dashboard.currentValue, 120);
  assert.equal(dashboard.totalInvested, 100);
  assert.equal(dashboard.unrealizedPnl, 20);
  assert.equal(dashboard.realizedPnl, 5);
  assert.equal(dashboard.totalPnl, 25);
  assert.equal(dashboard.openPositionCount, 1);
  assert.equal(dashboard.orderCount, 1);
  assert.equal(dashboard.positions[0].currentPrice, 60);
  assert.deepEqual(dashboard.recentOrders, ledger.investors.traderId.orders);
  assert.equal(encodeTraderDashboard(ledger).length, 1);
});

test("creates dashboard summary documents for investor accounts only", () => {
  const ledger = {
    investors: {
      investorId: {
        email: "investor@example.com",
        displayName: "Investor One",
        role: "investor",
        cashBalance: 750,
        orders: [{ id: "investor-order", timestamp: 200, side: "SELL" }],
        positions: [{
          id: "investor-position",
          stockId: "stock-1",
          symbol: "TEST",
          direction: "SHORT",
          quantity: 2,
          investedAmount: 100,
          realizedPnl: 3,
          status: "OPEN",
        }],
      },
      traderId: {
        email: "trader@example.com",
        role: "trader",
        orders: [],
        positions: [],
      },
    },
  };

  const [dashboard] = encodeInvestorDashboard(ledger, [
    { id: "stock-1", basePrice: 40 },
  ]);
  assert.equal(dashboard._id, "investorId");
  assert.equal(dashboard.email, "investor@example.com");
  assert.equal(dashboard.role, "investor");
  assert.equal(dashboard.cashBalance, 750);
  assert.equal(dashboard.currentValue, -80);
  assert.equal(dashboard.unrealizedPnl, 20);
  assert.equal(dashboard.realizedPnl, 3);
  assert.equal(dashboard.totalPnl, 23);
  assert.equal(dashboard.openPositionCount, 1);
  assert.equal(dashboard.orderCount, 1);
  assert.deepEqual(dashboard.recentOrders, ledger.investors.investorId.orders);
  assert.equal(encodeInvestorDashboard(ledger).length, 1);
});

test("stores investor portfolio summary with open and closed positions", () => {
  const ledger = {
    investors: {
      investorId: {
        email: "investor@example.com",
        displayName: "Investor One",
        role: "investor",
        initialBalance: 1000,
        cashBalance: 700,
        orders: [],
        positions: [
          {
            id: "open-position",
            stockId: "stock-1",
            symbol: "TEST",
            direction: "LONG",
            quantity: 2,
            investedAmount: 100,
            realizedPnl: 0,
            status: "OPEN",
          },
          {
            id: "closed-position",
            stockId: "stock-1",
            symbol: "TEST",
            direction: "LONG",
            quantity: 1,
            investedAmount: 40,
            realizedPnl: 5,
            status: "CLOSED",
            finalSellPrice: 45,
          },
        ],
      },
      traderId: {
        email: "trader@example.com",
        role: "trader",
        positions: [],
      },
    },
  };

  const [portfolio] = encodeInvestorPortfolio(ledger, [
    { id: "stock-1", basePrice: 60 },
  ]);
  assert.equal(portfolio.role, "investor");
  assert.equal(portfolio.initialBalance, 1000);
  assert.equal(portfolio.cashBalance, 700);
  assert.equal(portfolio.openPositionCount, 1);
  assert.equal(portfolio.closedPositionCount, 1);
  assert.equal(portfolio.positions.length, 2);
  assert.equal(portfolio.positions[0].currentValue, 120);
  assert.equal(portfolio.positions[1].currentPrice, 45);
  assert.equal(portfolio.positions[1].realizedPnl, 5);
  assert.equal(encodeInvestorPortfolio(ledger).length, 1);
});

test("stores trader portfolio summary with open and closed positions", () => {
  const ledger = {
    investors: {
      traderId: {
        email: "trader@example.com",
        displayName: "Trader One",
        role: "trader",
        initialBalance: 1200,
        cashBalance: 800,
        orders: [],
        positions: [
          {
            id: "open-position",
            stockId: "stock-1",
            symbol: "TEST",
            direction: "LONG",
            quantity: 2,
            investedAmount: 100,
            realizedPnl: 0,
            status: "OPEN",
          },
          {
            id: "closed-position",
            stockId: "stock-1",
            symbol: "TEST",
            direction: "LONG",
            quantity: 1,
            investedAmount: 40,
            realizedPnl: 5,
            status: "CLOSED",
            finalSellPrice: 45,
          },
        ],
      },
      investorId: {
        email: "investor@example.com",
        role: "investor",
        positions: [],
      },
    },
  };

  const [portfolio] = encodeTraderPortfolio(ledger, [
    { id: "stock-1", basePrice: 60 },
  ]);
  assert.equal(portfolio.role, "trader");
  assert.equal(portfolio.initialBalance, 1200);
  assert.equal(portfolio.cashBalance, 800);
  assert.equal(portfolio.openPositionCount, 1);
  assert.equal(portfolio.closedPositionCount, 1);
  assert.equal(portfolio.positions.length, 2);
  assert.equal(portfolio.positions[0].currentValue, 120);
  assert.equal(portfolio.positions[1].currentPrice, 45);
  assert.equal(portfolio.positions[1].realizedPnl, 5);
  assert.equal(encodeTraderPortfolio(ledger).length, 1);
});

const getAvailablePort = async () => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
};

const waitUntilReady = (child) => new Promise((resolve, reject) => {
  let output = "";
  const timer = setTimeout(() => reject(new Error(`Backend did not become ready. Output: ${output}`)), 8000);
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    if (output.includes("Stock Tracker backend is ready")) {
      clearTimeout(timer);
      resolve();
    }
  });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`Backend exited (${code}). Output: ${output}`));
  });
});

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "stock-tracker-investor-test-"));
  await writeFile(
    join(temporaryDirectory, "custom-market-stocks.json"),
    JSON.stringify([
      {
        id: "2",
        symbol: "TCS.NS",
        name: "TCS",
        exchange: "NSE",
        basePrice: 2280,
      },
      {
        id: "admin-legacy-sensex",
        symbol: "BES SENSEX",
        name: "BES SENSEX",
        exchange: "BSE",
        basePrice: 80000,
      },
    ]),
    "utf8"
  );
  const port = await getAvailablePort();
  apiUrl = `http://127.0.0.1:${port}/api`;
  server = spawn(process.execPath, ["src/server.js"], {
    cwd: backendDirectory,
    env: {
      ...process.env,
      STORAGE_DRIVER: "file",
      PORT: String(port),
      INITIAL_CASH_BALANCE: "1000000",
      PAPER_TRADING_LEDGER_PATH: join(temporaryDirectory, "ledger.json"),
      CUSTOM_MARKET_STOCKS_PATH: join(temporaryDirectory, "custom-market-stocks.json"),
      DELETED_MARKET_STOCKS_PATH: join(temporaryDirectory, "deleted-market-stocks.json"),
      AUTH_USERS_PATH: join(temporaryDirectory, "auth-users.json"),
      AUTH_DELETED_USERS_PATH: join(temporaryDirectory, "auth-deleted-users.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitUntilReady(server);
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

test("registers accounts securely and allows login after registration", async () => {
  const rootStatus = await fetch(`${apiUrl.replace(/\/api$/, "")}/`).then((response) => response.json());
  assert.equal(rootStatus.service, "stock-tracker-api");
  assert.equal(rootStatus.database, "file");
  assert.equal(rootStatus.databaseName, null);

  const health = await fetch(`${apiUrl}/health`).then((response) => response.json());
  assert.equal(health.database, "file");

  const adminHeaders = investorHeaders("admin@example.com", "admin");
  const forbiddenOverview = await fetch(`${apiUrl}/admin/overview`, {
    headers: investorHeaders("ordinary@example.com"),
  });
  assert.equal(forbiddenOverview.status, 403);
  const fileOverview = await fetch(`${apiUrl}/admin/overview`, {
    headers: adminHeaders,
  });
  assert.equal(fileOverview.status, 200);
  assert.equal(await fileOverview.json(), null);

  const forbiddenUserCreate = await fetch(`${apiUrl}/admin/users`, {
    method: "POST",
    headers: investorHeaders("ordinary@example.com"),
    body: JSON.stringify({
      first_name: "Forbidden",
      last_name: "User",
      email: "forbidden@example.com",
      password: "Password123",
      role: "investor",
    }),
  });
  assert.equal(forbiddenUserCreate.status, 403);

  const adminUserCreate = await fetch(`${apiUrl}/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      first_name: "AdminCreated",
      last_name: "Investor",
      email: "ADMIN.CREATED@example.com",
      password: "Password123",
      role: "investor",
    }),
  });
  assert.equal(adminUserCreate.status, 201);
  assert.equal((await adminUserCreate.json()).user.email, "admin.created@example.com");

  const adminRoleUserCreate = await fetch(`${apiUrl}/admin/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      first_name: "Site",
      last_name: "Administrator",
      email: "site.admin@example.com",
      password: "AdminPassword123",
      role: "admin",
    }),
  });
  assert.equal(adminRoleUserCreate.status, 201);

  const registerResponse = await fetch(`${apiUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      first_name: "New",
      last_name: "Trader",
      email: "New.Trader@example.com",
      password: "TraderPassword123",
      role: "trader",
      avatarUrl: "data:image/jpeg;base64,/9j/2Q==",
    }),
  });
  assert.equal(registerResponse.status, 201);
  const registered = await registerResponse.json();
  assert.equal(registered.user.email, "new.trader@example.com");
  assert.equal(registered.user.role, "trader");
  assert.equal(registered.user.avatarUrl, "data:image/jpeg;base64,/9j/2Q==");
  assert.equal(Object.hasOwn(registered.user, "password"), false);
  assert.equal(Object.hasOwn(registered.user, "passwordHash"), false);
  const ledgerAfterRegistration = JSON.parse(
    await readFile(join(temporaryDirectory, "ledger.json"), "utf8")
  );
  const traderAccountId = createHash("sha256")
    .update("trader:new.trader@example.com")
    .digest("hex");
  assert.equal(ledgerAfterRegistration.investors[traderAccountId].role, "trader");
  assert.equal(ledgerAfterRegistration.investors[traderAccountId].avatarUrl, registered.user.avatarUrl);
  assert.equal(ledgerAfterRegistration.investors[traderAccountId].cashBalance, 1_000_000);
  assert.deepEqual(ledgerAfterRegistration.investors[traderAccountId].orders, []);
  assert.deepEqual(ledgerAfterRegistration.investors[traderAccountId].positions, []);

  const profileResponse = await fetch(`${apiUrl}/investor/profile`, {
    headers: investorHeaders("new.trader@example.com", "trader"),
  });
  assert.equal(profileResponse.status, 200);
  assert.equal((await profileResponse.json()).avatarUrl, registered.user.avatarUrl);

  const updatedAvatarUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==";
  const avatarUpdateResponse = await fetch(`${apiUrl}/auth/avatar`, {
    method: "POST",
    headers: investorHeaders("new.trader@example.com", "trader"),
    body: JSON.stringify({ avatarUrl: updatedAvatarUrl }),
  });
  assert.equal(avatarUpdateResponse.status, 200);
  assert.equal((await avatarUpdateResponse.json()).user.avatarUrl, updatedAvatarUrl);
  const updatedLedger = JSON.parse(
    await readFile(join(temporaryDirectory, "ledger.json"), "utf8")
  );
  assert.equal(updatedLedger.investors[traderAccountId].avatarUrl, updatedAvatarUrl);

  const removeAvatarResponse = await fetch(`${apiUrl}/auth/avatar`, {
    method: "POST",
    headers: investorHeaders("new.trader@example.com", "trader"),
    body: JSON.stringify({ avatarUrl: "" }),
  });
  assert.equal(removeAvatarResponse.status, 200);
  assert.equal((await removeAvatarResponse.json()).user.avatarUrl, "");
  registered.user.avatarUrl = "";

  const invalidAvatarResponse = await fetch(`${apiUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      first_name: "Invalid",
      last_name: "Image",
      email: "invalid.image@example.com",
      password: "TraderPassword123",
      role: "investor",
      avatarUrl: "data:image/jpeg;base64,not-a-real-image",
    }),
  });
  assert.equal(invalidAvatarResponse.status, 400);

  const adminUsersResponse = await fetch(`${apiUrl}/admin/users`, { headers: adminHeaders });
  assert.equal(adminUsersResponse.status, 200);
  const registeredAdminUsers = await adminUsersResponse.json();
  assert.equal(
    registeredAdminUsers.find((user) => user.email === "new.trader@example.com").avatarUrl,
    ""
  );

  const loginResponse = await fetch(`${apiUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "NEW.TRADER@example.com", password: "TraderPassword123" }),
  });
  assert.equal(loginResponse.status, 200);
  assert.deepEqual((await loginResponse.json()).user, registered.user);

  const wrongPasswordResponse = await fetch(`${apiUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "new.trader@example.com", password: "wrong-password" }),
  });
  assert.equal(wrongPasswordResponse.status, 401);

  const duplicateResponse = await fetch(`${apiUrl}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      first_name: "Duplicate",
      last_name: "User",
      email: "NEW.TRADER@example.com",
      password: "AnotherPassword123",
      role: "investor",
    }),
  });
  assert.equal(duplicateResponse.status, 409);

  const storedUsers = JSON.parse(await readFile(join(temporaryDirectory, "auth-users.json"), "utf8"));
  assert.equal(storedUsers.length, 3);
  assert.equal(storedUsers[0].password, undefined);
  const storedAdminUser = storedUsers.find((user) => user.email === "admin.created@example.com");
  assert.ok(storedAdminUser);
  assert.equal(storedAdminUser.password, undefined);
  assert.match(storedAdminUser.passwordHash, /^[a-f\d]+:[a-f\d]+$/i);

  const userHeaders = investorHeaders("new.trader@example.com", "trader");
  const createLedgerResponse = await fetch(`${apiUrl}/investor/profile`, { headers: userHeaders });
  assert.equal(createLedgerResponse.status, 200);
  const buyResponse = await fetch(`${apiUrl}/orders/buy`, {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ stockId: "2", quantity: 2 }),
  });
  assert.equal(buyResponse.status, 201);
  const secondRoleProfile = await fetch(`${apiUrl}/investor/profile`, {
    headers: investorHeaders("new.trader@example.com", "investor"),
  });
  assert.equal(secondRoleProfile.status, 200);

  const adminUserList = await fetch(`${apiUrl}/admin/users`, { headers: adminHeaders });
  assert.equal(adminUserList.status, 200);
  const adminUsers = await adminUserList.json();
  assert.ok(adminUsers.some((user) => user.email === "new.trader@example.com"));
  assert.ok(adminUsers.some((user) => user.email === "admin.created@example.com"));
  assert.ok(adminUsers.some((user) => user.email === "site.admin@example.com" && user.role === "admin"));

  const forbiddenDelete = await fetch(`${apiUrl}/admin/users/new.trader%40example.com`, {
    method: "DELETE",
    headers: investorHeaders("ordinary@example.com"),
  });
  assert.equal(forbiddenDelete.status, 403);

  const deleteResponse = await fetch(`${apiUrl}/admin/users/new.trader%40example.com`, {
    method: "DELETE",
    headers: adminHeaders,
  });
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), {
    email: "new.trader@example.com",
    deletedAuthUsers: 1,
    deletedTradingAccounts: 2,
  });
  const deleteCreatedUserResponse = await fetch(`${apiUrl}/admin/users/admin.created%40example.com`, {
    method: "DELETE",
    headers: adminHeaders,
  });
  assert.equal(deleteCreatedUserResponse.status, 200);
  const deleteAdminUserResponse = await fetch(`${apiUrl}/admin/users/site.admin%40example.com`, {
    method: "DELETE",
    headers: adminHeaders,
  });
  assert.equal(deleteAdminUserResponse.status, 200);

  const deletedLogin = await fetch(`${apiUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "new.trader@example.com", password: "TraderPassword123" }),
  });
  assert.equal(deletedLogin.status, 410);
  const staleSessionRequest = await fetch(`${apiUrl}/positions`, { headers: userHeaders });
  assert.equal(staleSessionRequest.status, 401);

  const [remainingUsers, deletedEmails, remainingLedger] = await Promise.all([
    readFile(join(temporaryDirectory, "auth-users.json"), "utf8").then(JSON.parse),
    readFile(join(temporaryDirectory, "auth-deleted-users.json"), "utf8").then(JSON.parse),
    readFile(join(temporaryDirectory, "ledger.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(remainingUsers.length, 0);
  assert.deepEqual(new Set(deletedEmails), new Set([
    createHash("sha256").update("new.trader@example.com").digest("hex"),
    createHash("sha256").update("admin.created@example.com").digest("hex"),
    createHash("sha256").update("site.admin@example.com").digest("hex"),
  ]));
  assert.equal(Object.keys(remainingLedger.investors).length, 0);
});

test("isolates investor ledgers and safely executes the full position lifecycle", async () => {
  const request = (path, email = "alice@example.com", options = {}, role = "investor") => fetch(`${apiUrl}${path}`, {
    ...options,
    headers: { ...investorHeaders(email, role), ...options.headers },
  });
  const profileResponse = await request("/investor/profile");
  assert.equal(profileResponse.status, 200);
  const initialProfile = await profileResponse.json();
  assert.equal(initialProfile.cashBalance, 1_000_000);

  const firstBuyResponse = await request("/orders/buy", "alice@example.com", {
    method: "POST",
    body: JSON.stringify({ stockId: "2", quantity: 10, clientOrderId: "buy-once" }),
  });
  assert.equal(firstBuyResponse.status, 201);
  const firstBuy = await firstBuyResponse.json();
  assert.equal(firstBuy.cashBalance, 1_000_000 - firstBuy.order.totalValue);

  const duplicateResponse = await request("/orders/buy", "alice@example.com", {
    method: "POST",
    body: JSON.stringify({ stockId: "2", quantity: 10, clientOrderId: "buy-once" }),
  });
  assert.equal(duplicateResponse.status, 200);
  assert.equal((await duplicateResponse.json()).order.id, firstBuy.order.id);

  const secondBuyResponse = await request("/orders/buy", "alice@example.com", {
    method: "POST",
    body: JSON.stringify({ stockId: "2", quantity: 20, clientOrderId: "buy-again" }),
  });
  assert.equal(secondBuyResponse.status, 201);
  const secondBuy = await secondBuyResponse.json();
  const expectedAverage = (firstBuy.order.totalValue + secondBuy.order.totalValue) / 30;
  assert.ok(Math.abs(secondBuy.position.averageBuyPrice - expectedAverage) < 0.00001);

  const partialSellResponse = await request("/orders/sell", "alice@example.com", {
    method: "POST",
    body: JSON.stringify({ stockId: "2", quantity: 5, clientOrderId: "sell-part" }),
  });
  assert.equal(partialSellResponse.status, 201);
  const partialSell = await partialSellResponse.json();
  assert.equal(partialSell.position.quantity, 25);
  assert.equal(partialSell.position.status, "OPEN");
  assert.equal(partialSell.order.realizedPnl, Number((partialSell.order.totalValue - expectedAverage * 5).toFixed(2)));

  const balanceBeforeUnaffordableOrder = partialSell.cashBalance;
  const unaffordableResponse = await request("/orders/buy", "alice@example.com", {
    method: "POST",
    body: JSON.stringify({ stockId: "2", quantity: 500, clientOrderId: "not-affordable" }),
  });
  assert.equal(unaffordableResponse.status, 409);

  const closeResponse = await request("/orders/sell", "alice@example.com", {
    method: "POST",
    body: JSON.stringify({ stockId: "2", quantity: 25, clientOrderId: "sell-rest" }),
  });
  assert.equal(closeResponse.status, 201);
  const closed = await closeResponse.json();
  assert.equal(closed.position.quantity, 0);
  assert.equal(closed.position.status, "CLOSED");
  assert.ok(closed.cashBalance > balanceBeforeUnaffordableOrder);

  const [orders, transactions, closedPositions] = await Promise.all([
    request("/orders").then((response) => response.json()),
    request("/transactions").then((response) => response.json()),
    request("/positions?status=CLOSED").then((response) => response.json()),
  ]);
  assert.equal(orders.length, 4);
  assert.equal(transactions.length, 4);
  assert.equal(closedPositions.length, 1);
  assert.equal(closedPositions[0].realizedPnl, Number((partialSell.order.realizedPnl + closed.order.realizedPnl).toFixed(2)));

  const otherInvestorProfile = await request("/investor/profile", "bob@example.com").then((response) => response.json());
  assert.equal(otherInvestorProfile.cashBalance, 1_000_000);
  assert.equal(otherInvestorProfile.positions.length, 0);
  const otherInvestorOrders = await request("/orders", "bob@example.com").then((response) => response.json());
  assert.equal(otherInvestorOrders.length, 0);

  const sameEmailTrader = await request("/investor/profile", "alice@example.com", {}, "trader").then((response) => response.json());
  assert.equal(sameEmailTrader.cashBalance, 1_000_000);
  assert.equal(sameEmailTrader.positions.length, 0);
  const traderBuy = await request("/orders/buy", "alice@example.com", {
    method: "POST",
    body: JSON.stringify({ stockId: "2", quantity: 1, clientOrderId: "trader-separate-buy" }),
  }, "trader");
  assert.equal(traderBuy.status, 201);
  const adminAccountsResponse = await request("/admin/investors", "admin@example.com", {}, "admin");
  assert.equal(adminAccountsResponse.status, 200);
  const adminAccounts = await adminAccountsResponse.json();
  assert.ok(adminAccounts.some((account) => account.email === "alice@example.com" && account.role === "investor" && account.orders.length === 4));
  assert.ok(adminAccounts.some((account) => account.email === "alice@example.com" && account.role === "trader" && account.orders.length === 1));
  assert.ok(adminAccounts.every((account) => !Object.hasOwn(account, "password")));
  const nonAdminAccountList = await request("/admin/investors", "alice@example.com");
  assert.equal(nonAdminAccountList.status, 403);

  const invalidQuantity = await request("/orders/buy", "alice@example.com", {
    method: "POST",
    body: JSON.stringify({ stockId: "2", quantity: 0 }),
  });
  assert.equal(invalidQuantity.status, 400);

  const adminOrder = await request("/orders/buy", "admin@example.com", {
    method: "POST",
    body: JSON.stringify({ stockId: "2", quantity: 1 }),
  }, "admin");
  assert.equal(adminOrder.status, 403);

  const anonymous = await fetch(`${apiUrl}/portfolio`);
  assert.equal(anonymous.status, 401);
});

test("keeps the USD crypto paper wallet separate from the INR stock balance", async () => {
  const headers = investorHeaders("crypto-wallet@example.com");
  const balanceResponse = await fetch(`${apiUrl}/crypto/balance`, { headers });
  assert.equal(balanceResponse.status, 200);
  const balance = await balanceResponse.json();
  assert.equal(balance.currency, "USD");
  assert.equal(balance.availableCash, 1_000_000);

  const inrBalance = await fetch(`${apiUrl}/investor/balance`, { headers }).then((response) => response.json());
  assert.equal(inrBalance.availableCash, 1_000_000);

  const excessivePrecisionResponse = await fetch(`${apiUrl}/crypto/orders/buy`, {
    method: "POST",
    headers,
    body: JSON.stringify({ stockId: "9", quantity: 0.000000001 }),
  });
  assert.equal(excessivePrecisionResponse.status, 400);

  const cryptoOnInrRouteResponse = await fetch(`${apiUrl}/orders/buy`, {
    method: "POST",
    headers,
    body: JSON.stringify({ stockId: "9", quantity: 1 }),
  });
  assert.equal(cryptoOnInrRouteResponse.status, 400);

  const stockOnCryptoRouteResponse = await fetch(`${apiUrl}/crypto/orders/buy`, {
    method: "POST",
    headers,
    body: JSON.stringify({ stockId: "2", quantity: 1 }),
  });
  assert.equal(stockOnCryptoRouteResponse.status, 400);
});

test("opens short positions, covers them with buys, and flips direction when crossing zero", async () => {
  const request = (path, email, options = {}) => fetch(`${apiUrl}${path}`, {
    ...options,
    headers: { ...investorHeaders(email), ...options.headers },
  });
  const placeOrder = (email, side, quantity, clientOrderId) => request(`/orders/${side}`, email, {
    method: "POST",
    body: JSON.stringify({ stockId: "3", quantity, clientOrderId }),
  });

  const shortOpenResponse = await placeOrder("short-seller@example.com", "sell", 4, "short-open");
  assert.equal(shortOpenResponse.status, 201);
  const shortOpen = await shortOpenResponse.json();
  assert.equal(shortOpen.position.direction, "SHORT");
  assert.equal(shortOpen.position.quantity, 4);
  assert.equal(shortOpen.order.realizedPnl, 0);

  const partialCoverResponse = await placeOrder("short-seller@example.com", "buy", 2, "short-cover-part");
  assert.equal(partialCoverResponse.status, 201);
  const partialCover = await partialCoverResponse.json();
  assert.equal(partialCover.position.direction, "SHORT");
  assert.equal(partialCover.position.quantity, 2);
  assert.equal(
    partialCover.order.realizedPnl,
    Number(((shortOpen.position.averageBuyPrice - partialCover.order.price) * 2).toFixed(2))
  );

  const finalCoverResponse = await placeOrder("short-seller@example.com", "buy", 2, "short-cover-rest");
  assert.equal(finalCoverResponse.status, 201);
  const finalCover = await finalCoverResponse.json();
  assert.equal(finalCover.position.direction, "SHORT");
  assert.equal(finalCover.position.status, "CLOSED");
  assert.equal(finalCover.position.quantity, 0);

  const closedShorts = await request("/positions?status=CLOSED", "short-seller@example.com").then((response) => response.json());
  assert.equal(closedShorts.length, 1);
  assert.equal(closedShorts[0].direction, "SHORT");
  assert.equal(closedShorts[0].realizedPnl, Number((partialCover.order.realizedPnl + finalCover.order.realizedPnl).toFixed(2)));

  const longOpenResponse = await placeOrder("crossing-trader@example.com", "buy", 3, "cross-long-open");
  assert.equal(longOpenResponse.status, 201);
  const longOpen = await longOpenResponse.json();
  const crossResponse = await placeOrder("crossing-trader@example.com", "sell", 5, "cross-to-short");
  assert.equal(crossResponse.status, 201);
  const crossed = await crossResponse.json();
  assert.equal(crossed.position.direction, "SHORT");
  assert.equal(crossed.position.quantity, 2);
  assert.equal(crossed.order.realizedPnl, Number(((crossed.order.price - longOpen.position.averageBuyPrice) * 3).toFixed(2)));

  const [openPositions, crossingClosedPositions] = await Promise.all([
    request("/positions?status=OPEN", "crossing-trader@example.com").then((response) => response.json()),
    request("/positions?status=CLOSED", "crossing-trader@example.com").then((response) => response.json()),
  ]);
  assert.equal(openPositions.length, 1);
  assert.equal(openPositions[0].direction, "SHORT");
  assert.equal(openPositions[0].quantity, 2);
  assert.equal(crossingClosedPositions.length, 1);
  assert.equal(crossingClosedPositions[0].direction, "LONG");
});

test("registers and trades an admin-added stock using a backend-generated quote", async () => {
  const headers = investorHeaders("custom-stock-trader@example.com", "trader");
  const stockDetails = {
    stockId: "admin-test-bankex",
    symbol: "BANKEX",
    exchange: "BSE",
    basePrice: 3500,
  };
  const buyResponse = await fetch(`${apiUrl}/orders/buy`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...stockDetails, quantity: 2, price: 1 }),
  });

  assert.equal(buyResponse.status, 201);
  const buy = await buyResponse.json();
  assert.equal(buy.order.stockId, stockDetails.stockId);
  assert.equal(buy.order.symbol, stockDetails.symbol);
  assert.notEqual(buy.order.price, 1, "execution price must come from the backend quote");
  assert.equal(buy.position.quantity, 2);
  const sellerAdminAccounts = await fetch(`${apiUrl}/admin/investors`, {
    headers: investorHeaders("admin@example.com", "admin"),
  }).then((response) => response.json());
  const persistedOrder = sellerAdminAccounts
    .find((account) => account.email === "custom-stock-trader@example.com")
    ?.orders.find((order) => order.id === buy.order.id);
  assert.ok(persistedOrder, "executed order is persisted in the trading account data");

  const quoteResponse = await fetch(
    `${apiUrl}/market/quote?id=${encodeURIComponent(stockDetails.stockId)}`
  );
  assert.equal(quoteResponse.status, 200);
  const quote = await quoteResponse.json();
  assert.equal(quote.basePrice, stockDetails.basePrice);
  assert.equal(quote.exchange, stockDetails.exchange);
  assert.equal(quote.dataSource, "simulated");

  const unauthorizedOrderList = await fetch(`${apiUrl}/admin/orders`, {
    headers: investorHeaders("ordinary@example.com"),
  });
  assert.equal(unauthorizedOrderList.status, 403);

  const orderListResponse = await fetch(`${apiUrl}/admin/orders`, {
    headers: investorHeaders("admin@example.com", "admin"),
  });
  assert.equal(orderListResponse.status, 200);
  const listedOrders = await orderListResponse.json();
  assert.ok(listedOrders.some((order) =>
    order.id === buy.order.id &&
    order.ownerEmail === "custom-stock-trader@example.com" &&
    order.ownerRole === "trader" &&
    order.side === "BUY"
  ));

  const unauthorizedStockList = await fetch(`${apiUrl}/admin/stocks`, {
    headers: investorHeaders("ordinary@example.com"),
  });
  assert.equal(unauthorizedStockList.status, 403);

  const unauthorizedQuoteLookup = await fetch(`${apiUrl}/admin/stocks/quote`, {
    method: "POST",
    headers: investorHeaders("ordinary@example.com"),
    body: JSON.stringify({ symbol: "WIPRO", exchange: "NSE" }),
  });
  assert.equal(unauthorizedQuoteLookup.status, 403);

  const unsupportedQuoteLookup = await fetch(`${apiUrl}/admin/stocks/quote`, {
    method: "POST",
    headers: investorHeaders("admin@example.com", "admin"),
    body: JSON.stringify({ symbol: "WIPRO", exchange: "NASDAQ" }),
  });
  assert.equal(unsupportedQuoteLookup.status, 400);

  const unauthorizedUpdate = await fetch(`${apiUrl}/admin/stocks/${stockDetails.stockId}`, {
    method: "PUT",
    headers: investorHeaders("ordinary@example.com"),
    body: JSON.stringify({
      symbol: "BANKEX",
      exchange: "BSE",
      sector: "Index",
      price: 3600,
      changePercent: 1.25,
    }),
  });
  assert.equal(unauthorizedUpdate.status, 403);

  const updateResponse = await fetch(`${apiUrl}/admin/stocks/${stockDetails.stockId}`, {
    method: "PUT",
    headers: investorHeaders("admin@example.com", "admin"),
    body: JSON.stringify({
      symbol: "BANKEX",
      exchange: "BSE",
      sector: "Index",
      price: 3600,
      changePercent: 1.25,
    }),
  });
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).price, 3600);

  const stockList = await fetch(`${apiUrl}/admin/stocks`, {
    headers: investorHeaders("admin@example.com", "admin"),
  });
  assert.equal(stockList.status, 200);
  const listedStocks = await stockList.json();
  assert.ok(listedStocks.some((stock) => stock.id === "1"), "the admin stock list includes built-in stocks");
  assert.deepEqual(
    listedStocks.find((stock) => stock.id === stockDetails.stockId),
    {
      id: stockDetails.stockId,
      symbol: "BANKEX",
      exchange: "BSE",
      sector: "Index",
      price: 3600,
      changePercent: 1.25,
    }
  );

  const updatedQuote = await fetch(
    `${apiUrl}/market/quote?id=${encodeURIComponent(stockDetails.stockId)}`
  ).then((response) => response.json());
  assert.equal(updatedQuote.basePrice, 3600);
  assert.equal(updatedQuote.sector, "Index");

  const sellResponse = await fetch(`${apiUrl}/orders/sell`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...stockDetails, quantity: 1 }),
  });
  assert.equal(sellResponse.status, 201);
  const sell = await sellResponse.json();
  assert.equal(sell.order.side, "SELL");
  assert.equal(sell.position.quantity, 1);
  assert.equal(sell.position.status, "OPEN");
  const allTradeOrders = await fetch(`${apiUrl}/admin/orders`, {
    headers: investorHeaders("admin@example.com", "admin"),
  }).then((response) => response.json());
  assert.ok(allTradeOrders.some((order) => order.id === sell.order.id && order.side === "SELL"));

  const registeredStocks = JSON.parse(
    await readFile(join(temporaryDirectory, "custom-market-stocks.json"), "utf8")
  );
  assert.ok(registeredStocks.some((stock) =>
    stock.id === stockDetails.stockId &&
    stock.basePrice === 3600 &&
    stock.sector === "Index" &&
    stock.changePercent === 1.25
  ));

  const forbiddenDelete = await fetch(`${apiUrl}/admin/stocks/${stockDetails.stockId}`, {
    method: "DELETE",
    headers: investorHeaders("ordinary@example.com"),
  });
  assert.equal(forbiddenDelete.status, 403);

  const deleteResponse = await fetch(`${apiUrl}/admin/stocks/${stockDetails.stockId}`, {
    method: "DELETE",
    headers: investorHeaders("admin@example.com", "admin"),
  });
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { id: stockDetails.stockId, deleted: true });

  const deletedQuote = await fetch(
    `${apiUrl}/market/quote?id=${encodeURIComponent(stockDetails.stockId)}`
  );
  assert.equal(deletedQuote.status, 404);

  const deletedStocks = JSON.parse(
    await readFile(join(temporaryDirectory, "deleted-market-stocks.json"), "utf8")
  );
  assert.ok(deletedStocks.includes(stockDetails.stockId));

  const visibleQuotes = await fetch(`${apiUrl}/market/quotes`).then((response) => response.json());
  assert.ok(!visibleQuotes.some((stock) => stock.id === stockDetails.stockId));
  const visibleAdminStocks = await fetch(`${apiUrl}/admin/stocks`, {
    headers: investorHeaders("admin@example.com", "admin"),
  }).then((response) => response.json());
  assert.ok(!visibleAdminStocks.some((stock) => stock.id === stockDetails.stockId));
  const activeStockRecords = JSON.parse(
    await readFile(join(temporaryDirectory, "custom-market-stocks.json"), "utf8")
  );
  assert.ok(!activeStockRecords.some((stock) => stock.id === stockDetails.stockId));

  const unknownStock = await fetch(`${apiUrl}/orders/buy`, {
    method: "POST",
    headers,
    body: JSON.stringify({ stockId: "not-a-custom-stock", quantity: 1 }),
  });
  assert.equal(unknownStock.status, 404);
});

test("reports ready after store initialization and routes market quotes", async () => {
  const healthResponse = await fetch(`${apiUrl}/health`);
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(health.ready, true);
  assert.equal(health.database, "file");
  assert.equal("initializationStage" in health, false);

  const quoteResponse = await fetch(`${apiUrl}/market/quote?id=2`);
  assert.equal(quoteResponse.status, 200);
  const quote = await quoteResponse.json();
  assert.equal(quote.id, "2");
  assert.equal(quote.symbol, "TCS.BO");
  assert.equal(quote.exchange, "BSE");
  assert.equal(quote.dataSource, "delayed");

  const normalizedIndex = await fetch(`${apiUrl}/market/quote?id=admin-legacy-sensex`);
  assert.equal(normalizedIndex.status, 200);
  const indexQuote = await normalizedIndex.json();
  assert.equal(indexQuote.symbol, "SENSEX");
  assert.equal(indexQuote.exchange, "BSE");

  const sensexQuoteResponse = await fetch(`${apiUrl}/market/index/quote`);
  assert.equal(sensexQuoteResponse.status, 200);
  const sensexQuote = await sensexQuoteResponse.json();
  assert.equal(sensexQuote.id, "sensex");
  assert.equal(sensexQuote.symbol, "SENSEX");
  assert.equal(sensexQuote.exchange, "BSE");
  assert.equal(sensexQuote.dataSource, "simulated");

  const niftyQuoteResponse = await fetch(`${apiUrl}/market/nifty/quote`);
  assert.equal(niftyQuoteResponse.status, 200);
  const niftyQuote = await niftyQuoteResponse.json();
  assert.equal(niftyQuote.id, "3");
  assert.equal(niftyQuote.symbol, "NIFTY");
  assert.equal(niftyQuote.name, "Nifty 50");
  assert.equal(niftyQuote.exchange, "NSE");
  assert.equal(niftyQuote.dataSource, "delayed");

  const stockThreeQuoteResponse = await fetch(`${apiUrl}/market/quote?id=3`);
  assert.equal(stockThreeQuoteResponse.status, 200);
  const stockThreeQuote = await stockThreeQuoteResponse.json();
  assert.equal(stockThreeQuote.symbol, "NIFTY");
  assert.equal(stockThreeQuote.name, "Nifty 50");
  assert.equal(stockThreeQuote.exchange, "NSE");
  assert.equal(stockThreeQuote.dataSource, "delayed");
});

test("removes deleted core stocks from every market listing and quote route", async () => {
  const deleteResponse = await fetch(`${apiUrl}/admin/stocks/3`, {
    method: "DELETE",
    headers: investorHeaders("admin@example.com", "admin"),
  });
  assert.equal(deleteResponse.status, 200);

  const [adminStocks, marketQuotes] = await Promise.all([
    fetch(`${apiUrl}/admin/stocks`, {
      headers: investorHeaders("admin@example.com", "admin"),
    }).then((response) => response.json()),
    fetch(`${apiUrl}/market/quotes`).then((response) => response.json()),
  ]);
  assert.ok(!adminStocks.some((stock) => stock.id === "3"));
  assert.ok(!marketQuotes.some((stock) => stock.id === "3"));
  assert.equal((await fetch(`${apiUrl}/market/quote?id=3`)).status, 404);
  assert.equal((await fetch(`${apiUrl}/market/nifty/quote`)).status, 404);
});

test("serves health status while MongoDB is unavailable", async () => {
  const port = await getAvailablePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: backendDirectory,
    env: {
      ...process.env,
      STORAGE_DRIVER: "mongodb",
      MONGO_URI: "mongodb://health-test-user:never-expose-this@127.0.0.1:1/stock_tracker",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let childExit;

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Backend did not listen. Output: ${output}`)), 8000);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("Stock Tracker API listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr.on("data", (chunk) => { output += chunk.toString(); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      childExit = once(child, "exit");
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Backend exited (${code}). Output: ${output}`));
      });
    });

    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const health = await response.json();
    assert.equal(response.status, 503);
    assert.equal(health.ready, false);
    assert.equal(health.initializationStage, "database");
    assert.doesNotMatch(JSON.stringify(health), /never-expose-this/);
    assert.ok(["connecting", "disconnected"].includes(health.database));
    if (health.database === "connecting") {
      assert.match(health.message, /Connecting to MongoDB/);
    }

    const quoteResponse = await fetch(`http://127.0.0.1:${port}/api/market/quote?id=2`);
    const quote = await quoteResponse.json();
    assert.equal(quoteResponse.status, 200);
    assert.equal(quote.id, "2");
    assert.equal(quote.dataSource, "delayed");

    const quotesResponse = await fetch(`http://127.0.0.1:${port}/api/market/quotes`);
    assert.equal(quotesResponse.status, 200);
    const quotes = await quotesResponse.json();
    assert.ok(quotes.some((item) => item.id === "2"));

    const sensexQuoteResponse = await fetch(`http://127.0.0.1:${port}/api/market/index/quote`);
    assert.equal(sensexQuoteResponse.status, 200);
    assert.equal((await sensexQuoteResponse.json()).id, "sensex");
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await childExit;
    }
  }
});
