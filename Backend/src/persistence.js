import mongoose from "mongoose";
// import dns from "node:dns";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// dns.setServers(["8.8.8.8", "1.1.1.1"]);

// await mongoose.connect(process.env.MONGO_URI, {
//   serverSelectionTimeoutMS: 10000,
// });

const storageDriver = process.env.STORAGE_DRIVER ?? "mongodb";
let connectionAttempt;
const stateCollections = {
  "auth-users": {
    name: "users",
    encode: (users) => users.map((user) => ({ ...user, _id: user.email })),
    decode: (documents) => documents.map(({ _id, ...user }) => user),
    merge: (current, legacy) => {
      const users = new Map(legacy.map((user) => [user.email, user]));
      for (const user of current) users.set(user.email, user);
      return [...users.values()];
    },
  },
  "auth-deleted-users": {
    name: "deleted_users",
    encode: (markers) => markers.map((_marker, index) => ({ _id: String(index), marker: _marker })),
    decode: (documents) => documents.map(({ marker }) => marker),
    merge: (current, legacy) => [...new Set([...legacy, ...current])],
  },
  "paper-trading-ledger": {
    name: "trading_accounts",
    encode: (ledger) => Object.entries(ledger.investors).map(([id, account]) => ({ ...account, _id: id })),
    decode: (documents) => ({
      investors: Object.fromEntries(documents.map(({ _id, ...account }) => [_id, account])),
    }),
    merge: (current, legacy) => ({
      investors: { ...legacy.investors, ...current.investors },
    }),
  },
  "custom-market-stocks": {
    name: "stocks",
    encode: (stocks) => stocks.map((stock) => ({ ...stock, _id: stock.id })),
    decode: (documents) => documents.map(({ _id, ...stock }) => stock),
    merge: (current, legacy) => {
      const stocks = new Map(legacy.map((stock) => [stock.id, stock]));
      for (const stock of current) stocks.set(stock.id, stock);
      return [...stocks.values()];
    },
  },
  "deleted-market-stocks": {
    name: "deleted_stocks",
    encode: (ids) => ids.map((id) => ({ _id: id })),
    decode: (documents) => documents.map(({ _id }) => _id),
    merge: (current, legacy) => [...new Set([...legacy, ...current])],
  },
};

const readLegacyState = async (filePath, fallbackValue) => {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallbackValue;
    throw error;
  }
};

const getDatabaseCollection = (collectionName) => {
  const database = mongoose.connection.db;
  if (!database) {
    throw new Error(`MongoDB is not connected; cannot access the "${collectionName}" collection.`);
  }
  return database.collection(collectionName);
};

const encodeOrders = (ledger) =>
  Object.entries(ledger.investors).flatMap(([accountId, account]) =>
    (account.orders ?? []).map((order) => ({
      ...order,
      _id: order.id,
      accountId,
      accountEmail: account.email ?? "",
      accountRole: account.role ?? "investor",
    }))
  );

export const encodeOrdersByRole = (ledger, role) =>
  Object.entries(ledger.investors)
    .filter(([, account]) => (account.role === "trader" ? "trader" : "investor") === role)
    .flatMap(([accountId, account]) =>
      (account.orders ?? []).map((order) => ({
        ...order,
        _id: order.id,
        accountId,
        accountEmail: account.email ?? "",
        accountRole: role,
      }))
    );

export const encodeTraderHistory = (ledger) => encodeOrdersByRole(ledger, "trader");
export const encodeInvestorHistory = (ledger) => encodeOrdersByRole(ledger, "investor");

export const encodeTraderUsers = (users) =>
  users
    .filter((user) => user.role === "trader")
    .map((user) => ({ ...user, _id: user.email }));

export const encodeInvestorUsers = (users) =>
  users
    .filter((user) => user.role === "investor")
    .map((user) => ({ ...user, _id: user.email }));

const encodePositions = (ledger, status, collectionField) =>
  Object.entries(ledger.investors).flatMap(([accountId, account]) =>
    (account.positions ?? [])
      .filter((position) => position.status === status)
      .map((position) => ({
        ...position,
        _id: position.id,
        accountId,
        accountEmail: account.email ?? "",
        accountName: account.displayName ?? "",
        accountRole: account.role ?? "investor",
        positionType: collectionField,
      }))
  );


const ensureCollectionExists = async (collectionName) => {
  try {
    await mongoose.connection.db.createCollection(collectionName);
  } catch (error) {
    if (error.code !== 48) throw error;
  }
};

const syncDocuments = async (collectionName, documents) => {
  await ensureCollectionExists(collectionName);
  const collection = getDatabaseCollection(collectionName);
  if (documents.length > 0) {
    await collection.bulkWrite(
      documents.map((document) => ({
        replaceOne: {
          filter: { _id: document._id },
          replacement: document,
          upsert: true,
        },
      }))
    );
  }
  const ids = documents.map(({ _id }) => _id);
  await collection.deleteMany(ids.length > 0 ? { _id: { $nin: ids } } : {});
};

const loadStateDocuments = async (key, collectionName) => {
  if (key === "paper-trading-ledger") {
    const accountCollections = await Promise.all([
      "trading_accounts",
      "investor_accounts",
      "admin_trading_accounts",
    ].map((name) => getDatabaseCollection(name).find({}).toArray()));
    return accountCollections.flat();
  }
  return getDatabaseCollection(collectionName).find({}).toArray();
};

const tradingAccountRole = (account) =>
  ["investor", "trader", "admin"].includes(account.role) ? account.role : "investor";

export const encodeTradingAccountsByRole = (ledger, role) =>
  Object.entries(ledger.investors)
    .filter(([, account]) => tradingAccountRole(account) === role)
    .map(([id, account]) => ({ ...account, _id: id }));

export const encodeAccountDashboard = (ledger, role, stocks = []) => {
  const stockById = new Map(stocks.map((stock) => [String(stock.id ?? stock._id), stock]));
  return Object.entries(ledger.investors)
    .filter(([, account]) => tradingAccountRole(account) === role)
    .map(([accountId, account]) => {
      const positions = (account.positions ?? [])
        .filter((position) => position.status === "OPEN")
        .map((position) => {
          const stock = stockById.get(String(position.stockId));
          const currentPrice = Number(stock?.basePrice ?? position.currentPrice ?? position.averageBuyPrice ?? 0);
          const marketValue = Number(position.quantity ?? 0) * currentPrice;
          const isShort = position.direction === "SHORT";
          const currentValue = isShort ? -marketValue : marketValue;
          const unrealizedPnl = isShort
            ? Number(position.investedAmount ?? 0) - marketValue
            : marketValue - Number(position.investedAmount ?? 0);
          return {
            ...position,
            currentPrice,
            currentValue: Number(currentValue.toFixed(2)),
            unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
            unrealizedPnlPercent: Number(
              (Number(position.investedAmount) > 0
                ? (unrealizedPnl / Number(position.investedAmount)) * 100
                : 0).toFixed(2)
            ),
          };
        });
      const currentValue = positions.reduce((sum, position) => sum + position.currentValue, 0);
      const unrealizedPnl = positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
      const realizedPnl = (account.positions ?? []).reduce(
        (sum, position) => sum + Number(position.realizedPnl ?? 0),
        0
      );
      const totalPnl = realizedPnl + unrealizedPnl;
      const recentOrders = [...(account.orders ?? [])]
        .sort((first, second) => second.timestamp - first.timestamp)
        .slice(0, 5);

      return {
        _id: accountId,
        accountId,
        email: String(account.email ?? "").toLowerCase(),
        displayName: account.displayName ?? "",
        role,
        cashBalance: Number(account.cashBalance ?? 0),
        currentValue: Number(currentValue.toFixed(2)),
        totalInvested: Number(positions.reduce(
          (sum, position) => sum + Number(position.investedAmount ?? 0),
          0
        ).toFixed(2)),
        realizedPnl: Number(realizedPnl.toFixed(2)),
        unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
        totalPnl: Number(totalPnl.toFixed(2)),
        openPositionCount: positions.length,
        closedPositionCount: (account.positions ?? []).filter((position) => position.status === "CLOSED").length,
        orderCount: (account.orders ?? []).length,
        positions,
        recentOrders,
        updatedAt: new Date(),
      };
    });
};

export const encodeTraderDashboard = (ledger, stocks = []) =>
  encodeAccountDashboard(ledger, "trader", stocks);

export const encodeInvestorDashboard = (ledger, stocks = []) =>
  encodeAccountDashboard(ledger, "investor", stocks);

export const encodeInvestorPortfolio = (ledger, stocks = []) => {
  return encodeAccountPortfolio(ledger, "investor", stocks);
};

export const encodeAccountPortfolio = (ledger, role, stocks = []) => {
  const stockById = new Map(stocks.map((stock) => [String(stock.id ?? stock._id), stock]));
  return encodeAccountDashboard(ledger, role, stocks).map((summary) => {
    const account = ledger.investors[summary.accountId];
    const openPositions = new Map(summary.positions.map((position) => [position.id, position]));
    const positions = (account.positions ?? []).map((position) => {
      const currentPosition = openPositions.get(position.id);
      if (currentPosition) return currentPosition;

      const stock = stockById.get(String(position.stockId));
      return {
        ...position,
        currentPrice: Number(position.finalSellPrice ?? stock?.basePrice ?? position.averageBuyPrice ?? 0),
        currentValue: 0,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
      };
    });

    return {
      _id: summary._id,
      accountId: summary.accountId,
      email: summary.email,
      displayName: summary.displayName,
      role: summary.role,
      initialBalance: Number(account.initialBalance ?? 0),
      cashBalance: summary.cashBalance,
      currentValue: summary.currentValue,
      totalInvested: summary.totalInvested,
      realizedPnl: summary.realizedPnl,
      unrealizedPnl: summary.unrealizedPnl,
      totalPnl: summary.totalPnl,
      openPositionCount: summary.openPositionCount,
      closedPositionCount: summary.closedPositionCount,
      positions,
      updatedAt: new Date(),
    };
  });
};

export const encodeTraderPortfolio = (ledger, stocks = []) =>
  encodeAccountPortfolio(ledger, "trader", stocks);

let overviewSyncQueue = Promise.resolve();

const syncAdminOverview = async () => {
  const database = mongoose.connection.db;
  if (!database) throw new Error('MongoDB is not connected; cannot update the "admin_overview" collection.');

  const [users, traderAccounts, investorAccounts, adminAccounts, stocks, orders] = await Promise.all([
    database.collection("users").find({}).toArray(),
    database.collection("trading_accounts").find({}).toArray(),
    database.collection("investor_accounts").find({}).toArray(),
    database.collection("admin_trading_accounts").find({}).toArray(),
    database.collection("stocks").find({}).toArray(),
    database.collection("orders").find({}).toArray(),
  ]);
  const accounts = [...traderAccounts, ...investorAccounts, ...adminAccounts];
  const userByKey = new Map();
  for (const user of users) {
    if (!user.email || !["investor", "trader", "admin"].includes(user.role)) continue;
    userByKey.set(`${user.role}:${user.email.toLowerCase()}`, user);
  }

  const stockById = new Map(stocks.map((stock) => [String(stock.id ?? stock._id), stock]));
  const overviewAccounts = [];
  const accountByKey = new Map();
  for (const account of accounts) {
    if (!account.email) continue;
    const role = ["investor", "trader", "admin"].includes(account.role) ? account.role : "investor";
    const email = String(account.email).toLowerCase();
    const key = `${role}:${email}`;
    const openPositions = (account.positions ?? []).filter((position) => position.status === "OPEN");
    const currentValue = openPositions.reduce((sum, position) => {
      const stock = stockById.get(String(position.stockId));
      const price = Number(stock?.basePrice ?? position.averageBuyPrice);
      const direction = position.direction === "SHORT" ? -1 : 1;
      return sum + direction * Number(position.quantity ?? 0) * price;
    }, 0);
    const unrealizedPnl = openPositions.reduce((sum, position) => {
      const stock = stockById.get(String(position.stockId));
      const marketValue = Number(position.quantity ?? 0) * Number(stock?.basePrice ?? position.averageBuyPrice);
      return sum + (position.direction === "SHORT"
        ? Number(position.investedAmount ?? 0) - marketValue
        : marketValue - Number(position.investedAmount ?? 0));
    }, 0);
    const totalPnl = (account.positions ?? []).reduce(
      (sum, position) => sum + Number(position.realizedPnl ?? 0),
      unrealizedPnl
    );
    const user = userByKey.get(key);
    const row = {
      _id: `account:${createHash("sha256").update(key).digest("hex")}`,
      first_name: user?.first_name ?? String(account.displayName ?? "").trim().split(/\s+/)[0] ?? "",
      last_name: user?.last_name ?? String(account.displayName ?? "").trim().split(/\s+/).slice(1).join(" "),
      email,
      role,
      cashBalance: Number(account.cashBalance ?? 0),
      currentValue: Number(currentValue.toFixed(2)),
      totalPnl: Number(totalPnl.toFixed(2)),
      openPositionCount: openPositions.length,
      orderCount: (account.orders ?? []).length,
      updatedAt: new Date(),
    };
    accountByKey.set(key, row);
  }

  for (const [key, user] of userByKey) {
    if (accountByKey.has(key)) continue;
    accountByKey.set(key, {
      _id: `account:${createHash("sha256").update(key).digest("hex")}`,
      first_name: String(user.first_name ?? ""),
      last_name: String(user.last_name ?? ""),
      email: String(user.email).toLowerCase(),
      role: user.role,
      cashBalance: null,
      currentValue: null,
      totalPnl: null,
      openPositionCount: null,
      orderCount: null,
      updatedAt: new Date(),
    });
  }

  overviewAccounts.push(...accountByKey.values());
  const metrics = {
    users: overviewAccounts.length,
    investors: overviewAccounts.filter((account) => account.role === "investor").length,
    traders: overviewAccounts.filter((account) => account.role === "trader").length,
    admins: overviewAccounts.filter((account) => account.role === "admin").length,
    stocks: stocks.length,
    orders: orders.length,
    holdings: overviewAccounts.reduce((sum, account) => sum + (account.openPositionCount ?? 0), 0),
    cash: Number(overviewAccounts.reduce((sum, account) => sum + (account.cashBalance ?? 0), 0).toFixed(2)),
    portfolioValue: Number(overviewAccounts.reduce((sum, account) => sum + (account.currentValue ?? 0), 0).toFixed(2)),
    pnl: Number(overviewAccounts.reduce((sum, account) => sum + (account.totalPnl ?? 0), 0).toFixed(2)),
  };
  const documents = [
    {
      _id: "summary",
      recordType: "summary",
      database: database.databaseName,
      metrics,
      updatedAt: new Date(),
    },
    ...overviewAccounts,
  ];
  await syncDocuments("admin_overview", documents);
};

const saveNormalizedState = async (key, value) => {
  const config = stateCollections[key];
  if (!config) throw new Error(`No MongoDB collection is configured for "${key}".`);

  if (key === "paper-trading-ledger") {
    const orders = encodeOrders(value);
    const holdings = encodePositions(value, "OPEN", "holding");
    const closedPositions = encodePositions(value, "CLOSED", "closed_position");
    await Promise.all([
      syncDocuments("trading_accounts", encodeTradingAccountsByRole(value, "trader")),
      syncDocuments("investor_accounts", encodeTradingAccountsByRole(value, "investor")),
      syncDocuments("admin_trading_accounts", encodeTradingAccountsByRole(value, "admin")),
      syncDocuments("orders", orders),
      syncDocuments("traders_orders", encodeOrdersByRole(value, "trader")),
      syncDocuments("investor_orders", encodeOrdersByRole(value, "investor")),
      syncDocuments("trader_history", encodeTraderHistory(value)),
      syncDocuments("investor_history", encodeInvestorHistory(value)),
      (async () => {
        const stocks = await getDatabaseCollection("stocks").find({}).toArray();
        await Promise.all([
          syncDocuments("trader_dashboard", encodeTraderDashboard(value, stocks)),
          syncDocuments("investor_dashboard", encodeInvestorDashboard(value, stocks)),
          syncDocuments("trader_portfolio", encodeTraderPortfolio(value, stocks)),
          syncDocuments("investor_portfolio", encodeInvestorPortfolio(value, stocks)),
        ]);
      })(),
      syncDocuments("holdings", holdings),
      syncDocuments("closed_positions", closedPositions),
    ]);
  } else {
    await syncDocuments(config.name, config.encode(value));
  }

  if (key === "auth-users") {
    await Promise.all([
      syncDocuments("users_trader", encodeTraderUsers(value)),
      syncDocuments("users_investor", encodeInvestorUsers(value)),
    ]);
  }

  const sync = overviewSyncQueue.then(syncAdminOverview);
  overviewSyncQueue = sync.then(() => undefined, () => undefined);
  await sync;
};

const ensureMigrated = async (key, filePath, fallbackValue) => {
  const migrations = getDatabaseCollection("data_migrations");
  if (await migrations.findOne({ _id: key })) return;

  const config = stateCollections[key];
  if (!config) throw new Error(`No MongoDB collection is configured for "${key}".`);

  await ensureCollectionExists(config.name);
  const currentValue = config.decode(await loadStateDocuments(key, config.name));
  const legacyValue = await readLegacyState(filePath, fallbackValue);
  const value = config.merge(currentValue, legacyValue);

  await saveNormalizedState(key, value);
  await migrations.insertOne({ _id: key, completedAt: new Date() });
};

export const connectDatabase = async () => {
  if (storageDriver === "file") return;
  if (storageDriver !== "mongodb") {
    throw new Error('STORAGE_DRIVER must be either "mongodb" or "file".');
  }
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required. Add your MongoDB Atlas connection string to Backend/.env.");
  }

  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (connectionAttempt) return connectionAttempt;

  connectionAttempt = mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10_000 })
    .then((connection) => {
      console.log(`MongoDB connected: ${connection.connection.host}/${connection.connection.name}`);
      return connection;
    })
    .catch((error) => {
      console.error(
        "MongoDB Atlas connection failed. Confirm the cluster is running and your current public IP is allowed in Atlas Network Access."
      );
      const servers = error.reason?.servers;
      let tlsFailureReported = false;
      if (servers instanceof Map) {
        for (const [address, server] of servers) {
          if (server.error) {
            const message = server.error.message ?? "";
            if (/TLS|SSL/i.test(message)) {
              if (!tlsFailureReported) {
                console.error(
                  "Atlas nodes were resolved, but TLS negotiation failed. Check VPN, firewall, antivirus, or proxy inspection, and verify Atlas Network Access. TLS certificate validation remains enabled."
                );
                tlsFailureReported = true;
              }
              console.error(`MongoDB node ${address}: ${message}`);
            } else {
              console.error(`MongoDB node ${address}: ${message}`);
            }
          }
        }
      }
      throw error;
    })
    .finally(() => {
      connectionAttempt = undefined;
    });

  return connectionAttempt;
};

export const getDatabaseStatus = () => {
  if (storageDriver === "file") return "file";
  switch (mongoose.connection.readyState) {
    case 1:
      return "connected";
    case 2:
      return "connecting";
    case 3:
      return "disconnecting";
    default:
      return "disconnected";
  }
};

export const getDatabaseName = () =>
  storageDriver === "mongodb" && mongoose.connection.readyState === 1
    ? mongoose.connection.name
    : null;

export const loadPersistedOrders = async () => {
  if (storageDriver === "file") return null;
  await connectDatabase();
  const [traderOrders, investorOrders] = await Promise.all([
    getDatabaseCollection("traders_orders").find({}).toArray(),
    getDatabaseCollection("investor_orders").find({}).toArray(),
  ]);
  return [...traderOrders, ...investorOrders].sort((a, b) => b.timestamp - a.timestamp);
};

export const loadAdminOverview = async () => {
  if (storageDriver === "file") return null;
  await connectDatabase();
  const documents = await getDatabaseCollection("admin_overview").find({}).toArray();
  const summary = documents.find((document) => document.recordType === "summary");
  if (!summary) return null;
  const accounts = documents
    .filter((document) => document.recordType !== "summary")
    .map(({ _id, updatedAt, ...account }) => account);
  return { database: summary.database, updatedAt: summary.updatedAt, metrics: summary.metrics, accounts };
};


export const loadJsonState = async (key, filePath, fallbackValue) => {
  if (storageDriver === "file") {
    return readLegacyState(filePath, fallbackValue);
  }

  // Connect to MongoDB before accessing collections
  await connectDatabase();

  await ensureMigrated(key, filePath, fallbackValue);
  const config = stateCollections[key];

  return config.decode(
    await loadStateDocuments(key, config.name)
  );
};

export const saveJsonState = async (key, filePath, value) => {
  if (storageDriver === "file") {
    await mkdir(dirname(filePath), { recursive: true });

    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(
      temporaryPath,
      JSON.stringify(value, null, 2),
      "utf8"
    );
    await rename(temporaryPath, filePath);
    return;
  }

  // Connect before saving data
  await connectDatabase();

  await saveNormalizedState(key, value);
};
