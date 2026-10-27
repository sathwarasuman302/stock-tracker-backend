import "dotenv/config";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);

import {
  connectDatabase,
  getDatabaseName,
  getDatabaseStatus,
  loadAdminOverview,
  loadPersistedOrders,
  loadJsonState,
  saveJsonState,
} from "./persistence.js";
import {
  authenticateAuthUser,
  deleteAuthUser,
  initializeAuthStore,
  isDeletedAuthEmail,
  listAuthUsers,
  registerAuthUser,
  updateAuthUserAvatar,
} from "./authStore.js";
import { createYahooQuoteClient } from "./yahooMarketData.js";
import { createGeminiMarketCommentator } from "./geminiMarketAnalysis.js";


const app = express();
const port = Number(process.env.PORT) || 5000;
let backendInitialized = false;
let backendInitializationMessage = "The API is initializing its data stores.";
let backendInitializationStage = "startup";
const isBackendReady = () => backendInitialized;
const initializationStageMessages = {
  startup: "The API is initializing its data stores.",
  database: "The configured database could not be connected. Check MongoDB availability and the backend database configuration.",
  authentication: "The authentication store could not be initialized. Check its stored data and database availability.",
  marketStocks: "The market-stock store could not be initialized. Check its stored data and database availability.",
  tradingLedger: "The trading ledger could not be initialized. Check its stored data and database availability.",
  accounts: "Trading accounts could not be initialized. Check the authentication store, trading ledger, and database availability.",
};
const configuredInitialCash = Number(process.env.INITIAL_CASH_BALANCE);
const initialCashBalance = Number.isFinite(configuredInitialCash) && configuredInitialCash > 0
  ? configuredInitialCash
  : 1_000_000;
const ledgerPath = process.env.PAPER_TRADING_LEDGER_PATH
  ? resolve(process.env.PAPER_TRADING_LEDGER_PATH)
  : join(dirname(fileURLToPath(import.meta.url)), "..", "data", "paper-trading-ledger.json");
const customMarketStocksPath = process.env.CUSTOM_MARKET_STOCKS_PATH
  ? resolve(process.env.CUSTOM_MARKET_STOCKS_PATH)
  : join(dirname(fileURLToPath(import.meta.url)), "..", "data", "custom-market-stocks.json");
const deletedMarketStocksPath = process.env.DELETED_MARKET_STOCKS_PATH
  ? resolve(process.env.DELETED_MARKET_STOCKS_PATH)
  : join(dirname(fileURLToPath(import.meta.url)), "..", "data", "deleted-market-stocks.json");

const stockSeed = [
  { id: "2", symbol: "TCS.BO", name: "TCS", basePrice: 2280.0, exchange: "BSE" },
  { id: "3", symbol: "NIFTY", name: "Nifty 50", basePrice: 25000, exchange: "NSE" },
  { id: "1", symbol: "RELIANCE.NS", name: "RELIANCE", basePrice: 2485.3, exchange: "NSE" },
  { id: "4", symbol: "HDFCBANK.NS", name: "HDFCBANK", basePrice: 1725.4, exchange: "NSE" },
  { id: "5", symbol: "ICICIBANK.NS", name: "ICICIBANK", basePrice: 1248.75, exchange: "NSE" },
  { id: "6", symbol: "ITC.NS", name: "ITC", basePrice: 465.2, exchange: "NSE" },
  { id: "7", symbol: "INFY.NS", name: "INFY", basePrice: 1500, exchange: "NSE" },
  { id: "8", symbol: "SBIN.NS", name: "SBIN", basePrice: 0, exchange: "NSE" },
  { id: "9", symbol: "BTC-USD", name: "Bitcoin USD", basePrice: 0, exchange: "CRYPTO" },
];
const stockSeedById = new Map(stockSeed.map((stock) => [stock.id, stock]));

const marketState = stockSeed.map((stock, index) => ({
  ...stock,
  lastPrice: stock.basePrice,
  lastUpdated: Date.now(),
  driftIndex: index + 1,
}));
const sensexMarketState = {
  id: "sensex",
  symbol: "SENSEX",
  name: "BSE Sensex",
  basePrice: 77235.46,
  exchange: "BSE",
  lastPrice: 77235.46,
  lastUpdated: Date.now(),
  driftIndex: stockSeed.length + 1,
};
let marketRegistryQueue = Promise.resolve();
const deletedMarketStockIds = new Set();
const yahooQuoteClient = createYahooQuoteClient();
const generateMarketCommentary = createGeminiMarketCommentator();
const analysisRequestsByClient = new Map();
const analysisTimeframes = new Set(["1m", "5m", "15m", "30m", "1H", "4H", "1D", "1W", "1M"]);

const createEmptyLedger = () => ({ investors: {} });

let ledger = createEmptyLedger();
let transactionQueue = Promise.resolve();
let pendingLedgerTransactions = 0;

const roundMoney = (value) => Number(value.toFixed(2));

const persistLedger = async (nextLedger) => {
  await saveJsonState("paper-trading-ledger", ledgerPath, nextLedger);
};

const loadLedger = async () => {
  const stored = await loadJsonState("paper-trading-ledger", ledgerPath, createEmptyLedger());
  if (stored && typeof stored.investors === "object" && !Array.isArray(stored.investors)) {
    ledger = stored;
    await persistLedger(ledger);
    return;
  }
  if (
    Number.isFinite(stored?.cashBalance) &&
    Array.isArray(stored.orders) &&
    Array.isArray(stored.positions)
  ) {
    const legacyInitialBalance = roundMoney(
      stored.cashBalance +
        stored.orders.reduce((sum, order) => sum + (order.side === "BUY" ? order.totalValue : -order.totalValue), 0)
    );
    ledger = {
      investors: {
        __legacy__: {
          email: "",
          displayName: "",
          avatarUrl: "",
          initialBalance: legacyInitialBalance,
          cashBalance: stored.cashBalance,
          orders: stored.orders,
          positions: stored.positions,
          transactions: stored.orders.map((order) => ({ ...order, type: order.side })),
        },
      },
    };
    await persistLedger(ledger);
    return;
  }
  throw new Error("The persisted trading ledger has an invalid format.");
};

const withLedgerTransaction = (operation) => {
  pendingLedgerTransactions += 1;
  const transaction = transactionQueue.then(async () => {
    const nextLedger = JSON.parse(JSON.stringify(ledger));
    const result = operation(nextLedger);
    await persistLedger(nextLedger);
    ledger = nextLedger;
    return result;
  });
  transactionQueue = transaction.then(
    () => { pendingLedgerTransactions -= 1; },
    () => { pendingLedgerTransactions -= 1; }
  );
  return transaction;
};

const createTradeError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const sendTradeError = (response, error) => {
  response.status(error.status || 500).json({
    error: error.message || "Unable to process the trade.",
  });
};

const normalizeAvatarUrl = (value) => {
  if (value === undefined || value === null || value === "") return "";
  if (
    typeof value !== "string" ||
    value.length > 160_000 ||
    !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw createTradeError("Upload a valid JPG, PNG, or WebP profile image.");
  }
  const encodedImage = value.slice(value.indexOf(",") + 1);
  const imageBytes = Buffer.from(encodedImage, "base64");
  if (
    imageBytes.length === 0 ||
    imageBytes.length > 120_000 ||
    imageBytes.toString("base64") !== encodedImage ||
    imageBytes[0] !== 0xff ||
    imageBytes[1] !== 0xd8 ||
    imageBytes[2] !== 0xff
  ) {
    throw createTradeError("Upload a valid compressed JPG profile photo no larger than 120 KB.");
  }
  return value;
};

const findMarketStock = (body = {}) => {
  const id = String(body.stockId ?? body.id ?? "").trim();
  const symbol = String(body.symbol ?? "").trim().toUpperCase();
  return marketState.find((stock) => stock.id === id) ??
    marketState.find((stock) => stock.symbol.toUpperCase() === symbol) ??
    null;
};

const persistMarketStocks = async () => {
  const stocks = marketState.map((stock) => ({
    id: stock.id,
    symbol: stock.symbol,
    name: stock.name,
    exchange: stock.exchange,
    basePrice: stock.basePrice,
    ...(stock.sector ? { sector: stock.sector } : {}),
    ...(Number.isFinite(stock.changePercent) ? { changePercent: stock.changePercent } : {}),
    ...(stock.marketDataValidated ? { marketDataValidated: true } : {}),
    ...(stock.providerQuote ? { providerQuote: stock.providerQuote } : {}),
  }));
  await saveJsonState("custom-market-stocks", customMarketStocksPath, stocks);
};

const registerCustomMarketStock = async (body = {}) => {
  const id = String(body.stockId ?? body.id ?? "").trim();
  if (deletedMarketStockIds.has(id)) return null;
  const existingStock = marketState.find((stock) => stock.id === id);
  if (existingStock) return existingStock;
  if (!/^admin-[a-zA-Z0-9-]{1,100}$/.test(id)) return null;

  const symbol = String(body.symbol ?? "").trim().toUpperCase();
  const exchange = String(body.exchange ?? "NSE").trim().toUpperCase() || "NSE";
  const basePrice = Number(body.basePrice);
  if (!/^[A-Z0-9][A-Z0-9 .&_-]{0,29}$/.test(symbol)) return null;
  if (!/^[A-Z0-9-]{2,12}$/.test(exchange)) return null;
  if (!Number.isFinite(basePrice) || basePrice <= 0 || basePrice > 1_000_000_000) return null;

  const registration = marketRegistryQueue.then(async () => {
    const registeredStock = marketState.find((stock) => stock.id === id);
    if (registeredStock) return registeredStock;
    const nextStock = {
      id,
      symbol,
      name: symbol,
      exchange,
      sector: String(body.sector ?? "General").trim() || "General",
      basePrice: roundMoney(basePrice),
      lastPrice: roundMoney(basePrice),
      lastUpdated: Date.now(),
      driftIndex: marketState.length + 1,
      ...(body.marketDataValidated === true ? { marketDataValidated: true } : {}),
      ...(body.providerQuote ? { providerQuote: body.providerQuote } : {}),
    };
    marketState.push(nextStock);
    await persistMarketStocks();
    return nextStock;
  });
  marketRegistryQueue = registration.then(() => undefined, () => undefined);
  return registration;
};

const resolveOrderStock = async (body = {}) =>
  findMarketStock(body) ?? await registerCustomMarketStock(body);

const validateQuantity = (value, allowFractional = false) => {
  const quantity = Number(value);
  if (allowFractional) {
    if (
      Number.isFinite(quantity) &&
      quantity > 0 &&
      quantity <= 1_000_000_000 &&
      Number(quantity.toFixed(8)) === quantity
    ) {
      return quantity;
    }
    throw createTradeError("Enter a positive BTC quantity with up to 8 decimal places.");
  }
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw createTradeError("Enter a positive whole-number quantity.");
  }
  return quantity;
};

const validateOrderValue = (price, quantity) => {
  const totalValue = roundMoney(price * quantity);
  if (!Number.isFinite(totalValue) || totalValue <= 0 || !Number.isSafeInteger(Math.round(totalValue * 100))) {
    throw createTradeError("The order value is outside the supported range.");
  }
  return totalValue;
};

const investorContext = (request) => {
  const email = String(request.get("x-investor-id") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw createTradeError("Sign in with an investor account to access trading data.", 401);
  }
  const cleanHeader = (value, maxLength = 120) => String(value ?? "").trim().slice(0, maxLength);
  const requestedRole = cleanHeader(request.get("x-investor-role"), 20).toLowerCase();
  const role = ["investor", "trader", "admin"].includes(requestedRole) ? requestedRole : "investor";
  return {
    id: createHash("sha256").update(`${role}:${email}`).digest("hex"),
    legacyId: createHash("sha256").update(email).digest("hex"),
    email,
    displayName: cleanHeader(request.get("x-investor-name")) || email.split("@")[0],
    avatarUrl: cleanHeader(request.get("x-investor-avatar"), 500),
    role,
  };
};

const createInvestorAccount = (identity) => ({
  email: identity.email,
  displayName: identity.displayName,
  avatarUrl: identity.avatarUrl,
  role: identity.role,
  initialBalance: initialCashBalance,
  cashBalance: initialCashBalance,
  cryptoInitialBalance: initialCashBalance,
  cryptoCashBalance: initialCashBalance,
  orders: [],
  positions: [],
  transactions: [],
  cryptoOrders: [],
  cryptoPositions: [],
  cryptoTransactions: [],
});

const normalizeInvestorAccount = (investor, identity) => {
  investor.email = identity.email;
  investor.displayName = identity.displayName;
  if (identity.updateAvatar) investor.avatarUrl = identity.avatarUrl;
  else if (identity.avatarUrl) investor.avatarUrl = identity.avatarUrl;
  investor.role = identity.role;
  investor.initialBalance = Number.isFinite(investor.initialBalance)
    ? investor.initialBalance
    : initialCashBalance;
  investor.positions ??= [];
  investor.cryptoInitialBalance = Number.isFinite(investor.cryptoInitialBalance)
    ? investor.cryptoInitialBalance
    : initialCashBalance;
  investor.cryptoCashBalance = Number.isFinite(investor.cryptoCashBalance)
    ? investor.cryptoCashBalance
    : initialCashBalance;
  investor.cryptoOrders ??= [];
  investor.cryptoPositions ??= [];
  investor.cryptoTransactions ??= [];
  for (const position of investor.positions) {
    position.direction = position.direction === "SHORT" ? "SHORT" : "LONG";
  }
  for (const position of investor.cryptoPositions) {
    position.direction = position.direction === "SHORT" ? "SHORT" : "LONG";
  }
  investor.transactions ??= investor.orders.map((order) => ({ ...order, type: order.side }));
  return investor;
};

const resolveInvestorAccount = (nextLedger, identity) => {
  let investor = nextLedger.investors[identity.id];
  if (!investor) {
    investor = nextLedger.investors[identity.legacyId];
    if (investor) delete nextLedger.investors[identity.legacyId];
    if (!investor && identity.role !== "admin") {
      investor = nextLedger.investors.__legacy__;
      if (investor) delete nextLedger.investors.__legacy__;
    }
    if (!investor) investor = createInvestorAccount(identity);
    nextLedger.investors[identity.id] = investor;
  }
  return normalizeInvestorAccount(investor, identity);
};

const ensureInvestor = async (identity) => {
  if (pendingLedgerTransactions > 0) await transactionQueue;
  if (identity.updateAvatar) {
    return withLedgerTransaction((nextLedger) => resolveInvestorAccount(nextLedger, identity));
  }
  const existingInvestor = ledger.investors[identity.id];
  if (existingInvestor) return normalizeInvestorAccount(existingInvestor, identity);
  return withLedgerTransaction((nextLedger) => resolveInvestorAccount(nextLedger, identity));
};

const ensureRegisteredTradingAccount = async (user) => {
  if (user.role === "admin") return;
  const email = String(user.email).trim().toLowerCase();
  const role = user.role === "trader" ? "trader" : "investor";
  const displayName = `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() || email.split("@")[0];
  await ensureInvestor({
    id: createHash("sha256").update(`${role}:${email}`).digest("hex"),
    legacyId: createHash("sha256").update(email).digest("hex"),
    email,
    displayName,
    avatarUrl: user.avatarUrl ?? "",
    updateAvatar: Object.hasOwn(user, "avatarUrl"),
    role,
  });
};

const getInvestorSnapshot = (investor) => {
  const positions = investor.positions
    .filter((position) => position.status === "OPEN")
    .map(positionWithMarketValue);
  const closedPositions = investor.positions.filter((position) => position.status === "CLOSED");
  const totalInvested = roundMoney(positions.reduce((sum, position) => sum + position.investedAmount, 0));
  const currentValue = roundMoney(positions.reduce((sum, position) => sum + position.currentValue, 0));
  const unrealizedPnl = roundMoney(positions.reduce((sum, position) => sum + position.unrealizedPnl, 0));
  const realizedPnl = roundMoney(investor.positions.reduce((sum, position) => sum + position.realizedPnl, 0));
  const totalPnl = roundMoney(realizedPnl + unrealizedPnl);
  const totalTradeValue = investor.orders.reduce((sum, order) => sum + order.totalValue, 0);
  const todayPnl = roundMoney(positions.reduce((sum, position) => {
    const stock = marketState.find((item) => item.id === position.stockId);
    const dailyReference = stock?.basePrice ?? position.currentPrice;
    const directionMultiplier = position.direction === "SHORT" ? -1 : 1;
    return sum + (position.currentPrice - dailyReference) * position.quantity * directionMultiplier;
  }, 0));

  return {
    cashBalance: investor.cashBalance,
    initialBalance: investor.initialBalance,
    positions,
    totalInvested,
    currentValue,
    unrealizedPnl,
    realizedPnl,
    totalPnl,
    totalPnlPercent: totalTradeValue > 0 ? roundMoney((totalPnl / totalTradeValue) * 100) : 0,
    todayPnl,
    openPositionCount: positions.length,
    closedPositionCount: closedPositions.length,
    holdingCount: positions.length,
    totalAccountValue: roundMoney(investor.cashBalance + currentValue),
  };
};

const derivePrice = (stock, timestamp) => {
  const drift =
    Math.sin(timestamp / 48000 + stock.driftIndex) * 0.0024 +
    Math.cos(timestamp / 87000 + stock.driftIndex * 1.7) * 0.0016;
  const nextPrice = stock.lastPrice * (1 + drift);
  const lowerBound = stock.basePrice * 0.94;
  const upperBound = stock.basePrice * 1.08;

  return Number(Math.min(Math.max(nextPrice, lowerBound), upperBound).toFixed(2));
};

const buildQuote = (stock, timestamp) => {
  if (stock.providerQuote) {
    return {
      id: stock.id,
      symbol: stock.symbol,
      name: stock.name,
      exchange: stock.exchange,
      sector: stock.sector ?? "General",
      basePrice: stock.basePrice,
      ...stock.providerQuote,
      dataSource: stock.providerQuote.dataSource ?? "provider",
    };
  }

  const price = derivePrice(stock, timestamp);
  const change = Number((price - stock.basePrice).toFixed(2));
  const changePercent = Number(((change / stock.basePrice) * 100).toFixed(2));

  stock.lastPrice = price;
  stock.lastUpdated = timestamp;

  return {
    id: stock.id,
    symbol: stock.symbol,
    name: stock.name,
    exchange: stock.exchange,
    sector: stock.sector ?? "General",
    basePrice: stock.basePrice,
    price,
    change,
    changePercent,
    lastUpdated: timestamp,
    dataSource: "simulated",
  };
};

const refreshMarketQuote = async (stock) => {
  if (stockSeedById.has(stock.id) || stock.marketDataValidated) {
    const quote = await yahooQuoteClient.getQuote(stock);
    if (stock.basePrice <= 0) stock.basePrice = quote.price;
    stock.lastPrice = quote.price;
    stock.lastUpdated = quote.lastUpdated;
    stock.providerQuote = quote;
    return buildQuote(stock, quote.lastUpdated);
  }

  return buildQuote(stock, Date.now());
};

const refreshOrderQuote = async (stock) => {
  try {
    return await refreshMarketQuote(stock);
  } catch (error) {
    console.error("Market quote unavailable for paper order:", error);
    throw createTradeError("A live market quote is unavailable; the paper order was not placed.", 503);
  }
};

const sendMarketQuoteError = (response, error) => {
  console.error("Market quote request failed:", {
    message: error instanceof Error ? error.message : "Unknown market-data error.",
  });
  response.status(502).json({
    error: "Market data is temporarily unavailable. Please try again shortly.",
  });
};

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

app.use((request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Investor-Id, X-Investor-Name, X-Investor-Avatar, X-Investor-Role");

  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }

  next();
});

app.use("/api", async (request, response, next) => {
  const email = String(request.get("x-investor-id") ?? "").trim().toLowerCase();
  if (!email || request.path.startsWith("/auth/")) {
    next();
    return;
  }
  try {
    if (await isDeletedAuthEmail(email)) {
      response.status(401).json({ error: "This account has been deleted." });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
});

const getServiceStatus = () => {
  const database = getDatabaseStatus();
  const message = database === "connecting"
    ? "Connecting to MongoDB. The API will become ready after its data stores are initialized."
    : backendInitializationMessage;
  return {
    status: isBackendReady() ? "ok" : "degraded",
    service: "stock-tracker-api",
    ready: isBackendReady(),
    database,
    databaseName: getDatabaseName(),
    ...(isBackendReady() ? {} : {
      initializationStage: backendInitializationStage,
      message,
    }),
    endpoints: {
      register: "POST /api/auth/register",
      login: "POST /api/auth/login",
      health: "GET /api/health",
    },
  };
};

app.get("/", (_request, response) => {
  response.json(getServiceStatus());
});

app.get("/api/health", (_request, response) => {
  const status = getServiceStatus();
  response.status(status.ready ? 200 : 503).json(status);
});

app.use("/api", (request, response, next) => {
  const isMarketQuoteRead = request.method === "GET" &&
    (request.path === "/market/quote" ||
      request.path === "/market/quotes" ||
      request.path === "/market/index/quote" ||
      request.path === "/market/nifty/quote" ||
      request.path === "/market/candles") ||
    (request.method === "POST" && request.path === "/market/analysis/commentary");
  if (request.path === "/health" || isMarketQuoteRead || isBackendReady()) {
    next();
    return;
  }
  response.status(503).json({
    error: "Service temporarily unavailable.",
    initializationStage: backendInitializationStage,
  });
});

app.post("/api/auth/register", async (request, response) => {
  const firstName = String(request.body?.first_name ?? "").trim();
  const lastName = String(request.body?.last_name ?? "").trim();
  const email = String(request.body?.email ?? "").trim().toLowerCase();
  const password = String(request.body?.password ?? "");
  const role = String(request.body?.role ?? "investor").trim().toLowerCase();

  if (!firstName || firstName.length > 80 || !lastName || lastName.length > 80) {
    response.status(400).json({ error: "Enter your first and last name." });
    return;
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    response.status(400).json({ error: "Enter a valid email address." });
    return;
  }
  if (password.length < 6 || password.length > 1024) {
    response.status(400).json({ error: "Password must be at least 6 characters." });
    return;
  }
  if (role !== "investor" && role !== "trader") {
    response.status(400).json({ error: "Choose a valid account type." });
    return;
  }

  try {
    const avatarUrl = normalizeAvatarUrl(request.body?.avatarUrl);
    const user = await registerAuthUser({ first_name: firstName, last_name: lastName, email, password, role, avatarUrl });
    if (!user) {
      response.status(409).json({ error: "An account with this email already exists." });
      return;
    }
    await ensureRegisteredTradingAccount(user);
    response.status(201).json({ user });
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.post("/api/auth/avatar", async (request, response) => {
  try {
    const identity = investorContext(request);
    const avatarUrl = normalizeAvatarUrl(request.body?.avatarUrl);
    const user = await updateAuthUserAvatar(identity.email, identity.role, avatarUrl);
    if (!user) throw createTradeError("The signed-in account could not be found.", 404);
    await ensureRegisteredTradingAccount(user);
    response.json({ user });
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.post("/api/auth/login", async (request, response) => {
  const email = String(request.body?.email ?? "").trim().toLowerCase();
  const password = String(request.body?.password ?? "");
  if (!email || !password) {
    response.status(400).json({ error: "Enter your email and password." });
    return;
  }

  try {
    if (await isDeletedAuthEmail(email)) {
      response.status(410).json({ error: "This account has been deleted." });
      return;
    }
    const user = await authenticateAuthUser(email, password);
    if (!user) {
      response.status(401).json({ error: "Email or password is incorrect." });
      return;
    }
    response.json({ user });
  } catch {
    response.status(500).json({ error: "Login could not be completed. Please try again." });
  }
});

app.get("/api/market/quotes", async (_request, response) => {
  try {
    const quotes = await Promise.all(marketState.map(refreshMarketQuote));
    response.json(quotes);
  } catch (error) {
    sendMarketQuoteError(response, error);
  }
});

app.get("/api/market/quote", async (request, response) => {
  const { id, symbol } = request.query;
  const normalizedId = String(id ?? "").trim();
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();

  const stock =
    marketState.find((item) => item.id === normalizedId) ??
    marketState.find((item) => item.symbol.toUpperCase() === normalizedSymbol);

  if (!stock) {
    response.status(404).json({ error: "Stock not found" });
    return;
  }

  try {
    const quote = await refreshMarketQuote(stock);
    response.json(quote);
  } catch (error) {
    sendMarketQuoteError(response, error);
  }
});

app.get("/api/market/index/quote", async (_request, response) => {
  try {
    const quote = await refreshMarketQuote(sensexMarketState);
    response.json(quote);
  } catch (error) {
    sendMarketQuoteError(response, error);
  }
});

app.get("/api/market/nifty/quote", async (_request, response) => {
  const stock = marketState.find((item) => item.id === "3");
  if (!stock) {
    response.status(404).json({ error: "Stock not found" });
    return;
  }

  try {
    const quote = await refreshMarketQuote(stock);
    response.json(quote);
  } catch (error) {
    sendMarketQuoteError(response, error);
  }
});

app.get("/api/market/candles", async (request, response) => {
  const stockId = String(request.query.id ?? "").trim();
  const timeframe = String(request.query.timeframe ?? "").trim();
  const stock = marketState.find((item) => item.id === stockId);
  if (!stock) {
    response.status(404).json({ error: "Stock not found" });
    return;
  }

  try {
    const candles = await yahooQuoteClient.getCandles(stock, timeframe);
    response.json({
      symbol: stock.symbol,
      name: stock.name,
      exchange: stock.exchange,
      provider: "Yahoo Finance",
      dataSource: "delayed",
      timeframe,
      lastUpdated: candles.at(-1)?.time ?? null,
      candles,
    });
  } catch (error) {
    console.error("Yahoo Finance candle request failed:", {
      symbol: stock.symbol,
      timeframe,
      message: error.message,
    });
    response.status(502).json({ error: error.message });
  }
});

app.post("/api/market/analysis/commentary", async (request, response) => {
  const stockId = String(request.body?.stockId ?? "").trim();
  const timeframe = String(request.body?.timeframe ?? "").trim();
  const context = request.body?.context;
  const stock = marketState.find((item) => item.id === stockId);
  if (!stock || !analysisTimeframes.has(timeframe) ||
    typeof context !== "string" || context.trim().length === 0 || context.length > 1500) {
    response.status(400).json({ error: "Valid stock analysis context is required." });
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    response.status(503).json({
      error: "AI commentary is not configured. Set GEMINI_API_KEY in the backend environment and restart the API.",
    });
    return;
  }

  const now = Date.now();
  const clientKey = request.ip || request.socket.remoteAddress || "unknown";
  const clientRequests = analysisRequestsByClient.get(clientKey);
  if (clientRequests && now - clientRequests.windowStartedAt < 60_000) {
    if (clientRequests.count >= 5) {
      response.status(429).json({ error: "AI analysis is limited to 5 requests per minute. Please try again shortly." });
      return;
    }
    clientRequests.count += 1;
  } else {
    analysisRequestsByClient.set(clientKey, { windowStartedAt: now, count: 1 });
  }
  if (analysisRequestsByClient.size > 1000) {
    for (const [key, requests] of analysisRequestsByClient) {
      if (now - requests.windowStartedAt >= 60_000) analysisRequestsByClient.delete(key);
    }
  }

  try {
    const commentary = await generateMarketCommentary({
      symbol: stock.symbol,
      timeframe,
      context: context.trim(),
    });
    response.json({ commentary, provider: "Gemini" });
  } catch (error) {
    console.error("Market analysis commentary failed:", {
      symbol: stock.symbol,
      timeframe,
      message: error instanceof Error ? error.message : "Unknown analysis error.",
    });
    response.status(502).json({ error: "AI commentary is unavailable." });
  }
});

const positionWithMarketValue = (position) => {
  const isOpen = position.status === "OPEN";
  const direction = position.direction === "SHORT" ? "SHORT" : "LONG";
  const stock = isOpen
    ? marketState.find((item) => item.id === position.stockId)
    : null;
  const currentPrice = stock
    ? buildQuote(stock, Date.now()).price
    : position.finalSellPrice ?? position.averageBuyPrice;
  const marketValue = isOpen ? roundMoney(position.quantity * currentPrice) : 0;
  const currentValue = direction === "SHORT" ? -marketValue : marketValue;
  const unrealizedPnl = !isOpen
    ? 0
    : direction === "SHORT"
      ? roundMoney(position.investedAmount - marketValue)
      : roundMoney(marketValue - position.investedAmount);

  return {
    ...position,
    direction,
    currentPrice,
    currentValue,
    unrealizedPnl,
    unrealizedPnlPercent: position.investedAmount > 0
      ? roundMoney((unrealizedPnl / position.investedAmount) * 100)
      : 0,
  };
};

app.get("/api/investor/profile", async (request, response) => {
  try {
    const identity = investorContext(request);
    const investor = await ensureInvestor(identity);
    response.json({
      id: identity.id,
      email: investor.email,
      name: investor.displayName,
      avatarUrl: investor.avatarUrl,
      ...getInvestorSnapshot(investor),
    });
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.get("/api/investor/balance", async (request, response) => {
  try {
    const investor = await ensureInvestor(investorContext(request));
    response.json({
      initialBalance: investor.initialBalance,
      availableCash: investor.cashBalance,
      cashBalance: investor.cashBalance,
      totalAccountValue: roundMoney(investor.cashBalance + getInvestorSnapshot(investor).currentValue),
    });
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.get("/api/portfolio", async (request, response) => {
  try {
    const investor = await ensureInvestor(investorContext(request));
    const snapshot = getInvestorSnapshot(investor);

    response.json({
      ...snapshot,
    });
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.get("/api/positions", async (request, response) => {
  try {
    const investor = await ensureInvestor(investorContext(request));
    const status = String(request.query.status ?? "").trim().toUpperCase();
    if (status && status !== "OPEN" && status !== "CLOSED") {
      throw createTradeError("Position status must be OPEN or CLOSED.");
    }
    const positions = investor.positions
      .filter((position) => !status || position.status === status)
      .sort((a, b) => b.openedAt - a.openedAt)
      .map(positionWithMarketValue);
    response.json(positions);
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.get("/api/orders", async (request, response) => {
  try {
    const investor = await ensureInvestor(investorContext(request));
    response.json([...investor.orders].sort((a, b) => b.timestamp - a.timestamp));
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.get("/api/transactions", async (request, response) => {
  try {
    const investor = await ensureInvestor(investorContext(request));
    response.json([...investor.transactions].sort((a, b) => b.timestamp - a.timestamp));
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.post("/api/legacy/orders/buy", async (request, response) => {
  try {
    const identity = investorContext(request);
    if (identity.role === "admin") throw createTradeError("Admin accounts cannot place investor orders.", 403);
    const quantity = validateQuantity(request.body?.quantity);
    const stock = await resolveOrderStock(request.body);
    if (!stock) throw createTradeError("Unknown stock.", 404);

    const quote = await refreshOrderQuote(stock);
    if (!Number.isFinite(quote.price) || quote.price <= 0) {
      throw createTradeError("The market price is invalid.", 503);
    }
    const price = roundMoney(quote.price);
    const totalValue = validateOrderValue(price, quantity);

    const result = await withLedgerTransaction((nextLedger) => {
      const investor = resolveInvestorAccount(nextLedger, identity);

      const clientOrderId = String(request.body?.clientOrderId ?? "").trim();
      if (clientOrderId) {
        const duplicate = investor.orders.find((order) => order.clientOrderId === clientOrderId);
        if (duplicate) {
          const existingPosition = investor.positions.find((item) => item.id === duplicate.positionId);
          return { order: duplicate, position: existingPosition, cashBalance: investor.cashBalance, duplicate: true };
        }
      }
      if (!Number.isFinite(investor.cashBalance) || investor.cashBalance < 0) {
        throw createTradeError("Investor balance is invalid; order was not executed.", 409);
      }
      if (investor.cashBalance < totalValue) {
        throw createTradeError("Insufficient cash balance for this order.", 409);
      }

      let position = investor.positions.find(
        (item) => item.stockId === stock.id && item.status === "OPEN"
      );
      if (position) {
        const nextQuantity = position.quantity + quantity;
        if (!Number.isSafeInteger(nextQuantity)) throw createTradeError("The resulting share quantity is too large.");
        const nextInvested = roundMoney(position.investedAmount + totalValue);
        position.averageBuyPrice = Number((nextInvested / nextQuantity).toFixed(6));
        position.quantity = nextQuantity;
        position.investedAmount = nextInvested;
        position.updatedAt = Date.now();
      } else {
        position = {
          id: randomUUID(),
          stockId: stock.id,
          symbol: stock.symbol,
          quantity,
          averageBuyPrice: price,
          investedAmount: totalValue,
          realizedPnl: 0,
          status: "OPEN",
          openedAt: Date.now(),
          updatedAt: Date.now(),
          closedAt: null,
          finalSellPrice: null,
        };
        investor.positions.push(position);
      }

      investor.cashBalance = roundMoney(investor.cashBalance - totalValue);
      if (investor.cashBalance < 0) throw createTradeError("Insufficient cash balance for this order.", 409);
      const order = {
        id: randomUUID(),
        positionId: position.id,
        stockId: stock.id,
        symbol: stock.symbol,
        side: "BUY",
        quantity,
        price,
        totalValue,
        timestamp: Date.now(),
        status: "FILLED",
        realizedPnl: 0,
        ...(clientOrderId ? { clientOrderId } : {}),
      };
      investor.orders.unshift(order);
      investor.transactions.unshift({ ...order, type: "BUY" });
      return { order, position, cashBalance: investor.cashBalance };
    });

    response.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.post("/api/legacy/orders/sell", async (request, response) => {
  try {
    const identity = investorContext(request);
    if (identity.role === "admin") throw createTradeError("Admin accounts cannot place investor orders.", 403);
    const quantity = validateQuantity(request.body?.quantity);
    const stock = await resolveOrderStock(request.body);
    if (!stock) throw createTradeError("Unknown stock.", 404);

    const quote = await refreshOrderQuote(stock);
    if (!Number.isFinite(quote.price) || quote.price <= 0) {
      throw createTradeError("The market price is invalid.", 503);
    }
    const price = roundMoney(quote.price);
    const totalValue = validateOrderValue(price, quantity);

    const result = await withLedgerTransaction((nextLedger) => {
      const investor = resolveInvestorAccount(nextLedger, identity);
      const clientOrderId = String(request.body?.clientOrderId ?? "").trim();
      if (clientOrderId) {
        const duplicate = investor.orders.find((order) => order.clientOrderId === clientOrderId);
        if (duplicate) {
          const existingPosition = investor.positions.find((item) => item.id === duplicate.positionId);
          return { order: duplicate, position: existingPosition, cashBalance: investor.cashBalance, duplicate: true };
        }
      }
      if (!Number.isFinite(investor.cashBalance) || investor.cashBalance < 0) {
        throw createTradeError("Investor balance is invalid; order was not executed.", 409);
      }
      const position = investor.positions.find(
        (item) => item.stockId === stock.id && item.status === "OPEN"
      );
      if (!position) throw createTradeError("There is no open position to sell.", 409);
      if (quantity > position.quantity) {
        throw createTradeError(`You can sell at most ${position.quantity} shares.`, 409);
      }

      const costBasis = roundMoney(position.averageBuyPrice * quantity);
      const realizedPnl = roundMoney(totalValue - costBasis);
      position.quantity -= quantity;
      position.investedAmount = roundMoney(position.averageBuyPrice * position.quantity);
      position.realizedPnl = roundMoney(position.realizedPnl + realizedPnl);
      position.updatedAt = Date.now();
      position.finalSellPrice = price;
      if (position.quantity === 0) {
        position.status = "CLOSED";
        position.closedAt = Date.now();
        position.investedAmount = 0;
      }

      investor.cashBalance = roundMoney(investor.cashBalance + totalValue);
      const order = {
        id: randomUUID(),
        positionId: position.id,
        stockId: stock.id,
        symbol: stock.symbol,
        side: "SELL",
        quantity,
        price,
        totalValue,
        timestamp: Date.now(),
        status: "FILLED",
        realizedPnl,
        ...(clientOrderId ? { clientOrderId } : {}),
      };
      investor.orders.unshift(order);
      investor.transactions.unshift({ ...order, type: "SELL" });
      return { order, position, cashBalance: investor.cashBalance };
    });

    response.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) {
    sendTradeError(response, error);
  }
});

const executePaperOrder = async (request, side, currency = "INR") => {
  const identity = investorContext(request);
  if (identity.role === "admin") throw createTradeError("Admin accounts cannot place investor orders.", 403);
  const isCrypto = currency === "USD";
  const quantity = validateQuantity(request.body?.quantity, isCrypto);
  const stock = await resolveOrderStock(request.body);
  if (!stock) throw createTradeError("Unknown stock.", 404);
  if ((stock.exchange === "CRYPTO") !== isCrypto) {
    throw createTradeError(isCrypto
      ? "Only crypto instruments can use the USD paper wallet."
      : "Crypto instruments must use the USD paper wallet.");
  }

  const quote = await refreshOrderQuote(stock);
  if (!Number.isFinite(quote.price) || quote.price <= 0) {
    throw createTradeError("The market price is invalid.", 503);
  }
  const price = roundMoney(quote.price);
  const totalValue = validateOrderValue(price, quantity);

  return withLedgerTransaction((nextLedger) => {
    const investor = resolveInvestorAccount(nextLedger, identity);
    const balanceField = isCrypto ? "cryptoCashBalance" : "cashBalance";
    const ordersField = isCrypto ? "cryptoOrders" : "orders";
    const positionsField = isCrypto ? "cryptoPositions" : "positions";
    const transactionsField = isCrypto ? "cryptoTransactions" : "transactions";
    const clientOrderId = String(request.body?.clientOrderId ?? "").trim();
    if (clientOrderId) {
      const duplicate = investor[ordersField].find((order) => order.clientOrderId === clientOrderId);
      if (duplicate) {
        const existingPosition = investor[positionsField].find((item) => item.id === duplicate.positionId);
        return { order: duplicate, position: existingPosition, cashBalance: investor[balanceField], currency, duplicate: true };
      }
    }
    if (!Number.isFinite(investor[balanceField]) || investor[balanceField] < 0) {
      throw createTradeError("Investor balance is invalid; order was not executed.", 409);
    }
    if (side === "BUY" && investor[balanceField] < totalValue) {
      throw createTradeError(`Insufficient ${currency} paper balance for this order.`, 409);
    }

    const incomingDirection = side === "BUY" ? "LONG" : "SHORT";
    let position = investor[positionsField].find(
      (item) => item.stockId === stock.id && item.status === "OPEN"
    );
    let realizedPnl = 0;
    if (!position || position.direction === incomingDirection) {
      if (position) {
        const nextQuantity = isCrypto
          ? Number((position.quantity + quantity).toFixed(8))
          : position.quantity + quantity;
        if (!Number.isFinite(nextQuantity) || nextQuantity > 1_000_000_000) {
          throw createTradeError("The resulting order quantity is too large.");
        }
        const nextInvested = roundMoney(position.investedAmount + totalValue);
        position.averageBuyPrice = Number((nextInvested / nextQuantity).toFixed(6));
        position.quantity = nextQuantity;
        position.investedAmount = nextInvested;
        position.updatedAt = Date.now();
      } else {
        position = {
          id: randomUUID(),
          stockId: stock.id,
          symbol: stock.symbol,
          direction: incomingDirection,
          quantity,
          averageBuyPrice: price,
          investedAmount: totalValue,
          realizedPnl: 0,
          status: "OPEN",
          openedAt: Date.now(),
          updatedAt: Date.now(),
          closedAt: null,
          finalSellPrice: null,
        };
        investor[positionsField].push(position);
      }
    } else {
      const quantityToClose = Math.min(quantity, position.quantity);
      const positionDirection = position.direction === "SHORT" ? "SHORT" : "LONG";
      realizedPnl = roundMoney(
        (positionDirection === "SHORT"
          ? position.averageBuyPrice - price
          : price - position.averageBuyPrice) * quantityToClose
      );
      const remainingQuantity = isCrypto
        ? Number((position.quantity - quantityToClose).toFixed(8))
        : position.quantity - quantityToClose;
      position.quantity = remainingQuantity;
      position.investedAmount = roundMoney(position.averageBuyPrice * remainingQuantity);
      position.realizedPnl = roundMoney(position.realizedPnl + realizedPnl);
      position.updatedAt = Date.now();
      position.finalSellPrice = price;
      if (remainingQuantity === 0) {
        position.status = "CLOSED";
        position.closedAt = Date.now();
        position.investedAmount = 0;
      }

      const remainingOrderQuantity = isCrypto
        ? Number((quantity - quantityToClose).toFixed(8))
        : quantity - quantityToClose;
      if (remainingOrderQuantity > 0) {
        position = {
          id: randomUUID(),
          stockId: stock.id,
          symbol: stock.symbol,
          direction: incomingDirection,
          quantity: remainingOrderQuantity,
          averageBuyPrice: price,
          investedAmount: roundMoney(price * remainingOrderQuantity),
          realizedPnl: 0,
          status: "OPEN",
          openedAt: Date.now(),
          updatedAt: Date.now(),
          closedAt: null,
          finalSellPrice: null,
        };
        investor[positionsField].push(position);
      }
    }

    investor[balanceField] = roundMoney(
      investor[balanceField] + (side === "BUY" ? -totalValue : totalValue)
    );
    if (investor[balanceField] < 0) throw createTradeError(`Insufficient ${currency} paper balance for this order.`, 409);
    const order = {
      id: randomUUID(),
      positionId: position.id,
      stockId: stock.id,
      symbol: stock.symbol,
      currency,
      side,
      quantity,
      price,
      totalValue,
      timestamp: Date.now(),
      status: "FILLED",
      realizedPnl,
      ...(clientOrderId ? { clientOrderId } : {}),
    };
    investor[ordersField].unshift(order);
    investor[transactionsField].unshift({ ...order, type: side });
    return { order, position, cashBalance: investor[balanceField], currency };
  });
};

for (const side of ["BUY", "SELL"]) {
  app.post(`/api/orders/${side.toLowerCase()}`, async (request, response) => {
    try {
      const result = await executePaperOrder(request, side);
      response.status(result.duplicate ? 200 : 201).json(result);
    } catch (error) {
      sendTradeError(response, error);
    }
  });

  app.post(`/api/crypto/orders/${side.toLowerCase()}`, async (request, response) => {
    try {
      const result = await executePaperOrder(request, side, "USD");
      response.status(result.duplicate ? 200 : 201).json(result);
    } catch (error) {
      sendTradeError(response, error);
    }
  });
}

app.get("/api/crypto/balance", async (request, response) => {
  try {
    const investor = await ensureInvestor(investorContext(request));
    const positions = investor.cryptoPositions
      .filter((position) => position.status === "OPEN")
      .map(positionWithMarketValue);
    const currentValue = roundMoney(positions.reduce((sum, position) => sum + position.currentValue, 0));
    response.json({
      currency: "USD",
      initialBalance: investor.cryptoInitialBalance,
      availableCash: investor.cryptoCashBalance,
      cashBalance: investor.cryptoCashBalance,
      totalAccountValue: roundMoney(investor.cryptoCashBalance + currentValue),
    });
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.get("/api/crypto/positions", async (request, response) => {
  try {
    const investor = await ensureInvestor(investorContext(request));
    const status = String(request.query.status ?? "").trim().toUpperCase();
    if (status && status !== "OPEN" && status !== "CLOSED") {
      throw createTradeError("Position status must be OPEN or CLOSED.");
    }
    response.json(investor.cryptoPositions
      .filter((position) => !status || position.status === status)
      .sort((first, second) => second.openedAt - first.openedAt)
      .map(positionWithMarketValue));
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.get("/api/crypto/orders", async (request, response) => {
  try {
    const investor = await ensureInvestor(investorContext(request));
    response.json([...investor.cryptoOrders].sort((first, second) => second.timestamp - first.timestamp));
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.get("/api/admin/users", async (request, response) => {
  try {
    if (investorContext(request).role !== "admin") {
      response.status(403).json({ error: "Administrator access is required." });
      return;
    }
    response.json(await listAuthUsers());
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.get("/api/admin/stocks", async (request, response) => {
  try {
    if (investorContext(request).role !== "admin") {
      throw createTradeError("Administrator access is required.", 403);
    }
    response.json(marketState.map((stock) => ({
      id: stock.id,
      symbol: stock.symbol,
      exchange: stock.exchange,
      sector: stock.sector ?? "General",
      price: stock.basePrice,
      changePercent: stock.changePercent ?? 0,
    })));
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.post("/api/admin/stocks/quote", async (request, response) => {
  try {
    if (investorContext(request).role !== "admin") {
      throw createTradeError("Administrator access is required.", 403);
    }

    const symbol = String(request.body?.symbol ?? "").trim().toUpperCase();
    const exchange = String(request.body?.exchange ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9 .&_-]{0,29}$/.test(symbol)) {
      throw createTradeError("Enter a valid stock symbol.");
    }
    if (exchange !== "NSE" && exchange !== "BSE") {
      throw createTradeError("Live quotes are currently supported for NSE and BSE stocks.");
    }
    const exchangeSuffix = exchange === "NSE" ? ".NS" : ".BO";
    const storedSymbol = symbol.includes(".") ? symbol : `${symbol}${exchangeSuffix}`;
    const persistedStock = marketState.find((entry) =>
      String(entry.exchange ?? "").toUpperCase() === exchange &&
      [symbol, storedSymbol].includes(String(entry.symbol ?? "").toUpperCase())
    );
    const stock = {
      id: `admin-quote:${exchange}:${symbol}`,
      symbol,
      exchange,
      sector: persistedStock?.sector,
    };
    const [quote, sectorResult] = await Promise.allSettled([
      yahooQuoteClient.getQuote(stock),
      yahooQuoteClient.getSector(stock),
    ]);
    if (quote.status === "rejected") throw quote.reason;

    let sector = null;
    let sectorError;
    if (sectorResult.status === "fulfilled") {
      sector = sectorResult.value;
      if (!sector) sectorError = "Yahoo Finance sector data is unavailable. Enter the sector manually.";
    } else {
      console.error("Yahoo Finance sector lookup failed:", {
        message: sectorResult.reason instanceof Error
          ? sectorResult.reason.message
          : "Unknown sector lookup error.",
      });
      sectorError = "Yahoo Finance sector data is unavailable. Enter the sector manually.";
    }
    response.json({
      symbol,
      exchange,
      ...quote.value,
      sector,
      ...(sectorError ? { sectorError } : {}),
    });
  } catch (error) {
    if (error.status) {
      sendTradeError(response, error);
      return;
    }
    sendMarketQuoteError(response, error);
  }
});

app.put("/api/admin/stocks/:id", async (request, response) => {
  try {
    if (investorContext(request).role !== "admin") {
      throw createTradeError("Administrator access is required.", 403);
    }

    const id = String(request.params.id ?? "").trim();
    const symbol = String(request.body?.symbol ?? "").trim().toUpperCase();
    const exchange = String(request.body?.exchange ?? "NSE").trim().toUpperCase();
    const sector = String(request.body?.sector ?? "General").trim() || "General";
    let basePrice = Number(request.body?.price);
    let changePercent = Number(request.body?.changePercent);
    const stockExists = marketState.some((stock) => stock.id === id);
    const existingStock = marketState.find((stock) => stock.id === id);

    if (!stockExists && !/^admin-[a-zA-Z0-9-]{1,100}$/.test(id)) {
      throw createTradeError("Unknown stock.", 404);
    }
    if (!/^[A-Z0-9][A-Z0-9 .&_-]{0,29}$/.test(symbol)) {
      throw createTradeError("Enter a valid stock symbol.");
    }
    if (!/^[A-Z0-9-]{2,12}$/.test(exchange)) {
      throw createTradeError("Enter a valid stock exchange.");
    }
    if (sector.length > 80) {
      throw createTradeError("The stock sector must be 80 characters or fewer.");
    }
    if (!Number.isFinite(basePrice) || basePrice <= 0 || basePrice > 1_000_000_000) {
      throw createTradeError("Enter a valid stock price.");
    }
    if (!Number.isFinite(changePercent)) {
      throw createTradeError("Enter a valid stock change percentage.");
    }

    let providerQuote;
    if (!stockExists || existingStock?.marketDataValidated) {
      try {
        providerQuote = await yahooQuoteClient.getQuote({ id, symbol, exchange });
      } catch (error) {
        throw createTradeError(
          error instanceof Error
            ? `A live Yahoo Finance quote could not be fetched for ${symbol} (${exchange}): ${error.message}`
            : "A live Yahoo Finance quote could not be fetched for this stock.",
          502
        );
      }
      basePrice = providerQuote.price;
      changePercent = providerQuote.changePercent;
    }

    const update = marketRegistryQueue.then(async () => {
      let stock = marketState.find((entry) => entry.id === id);
      if (!stock) {
        stock = {
          id,
          symbol,
          name: symbol,
          exchange,
          sector,
          basePrice: roundMoney(basePrice),
          lastPrice: roundMoney(basePrice),
          lastUpdated: Date.now(),
          driftIndex: marketState.length + 1,
        };
        marketState.push(stock);
      }
      Object.assign(stock, {
        symbol,
        name: symbol,
        exchange,
        sector,
        basePrice: roundMoney(basePrice),
        lastPrice: roundMoney(basePrice),
        changePercent,
        lastUpdated: Date.now(),
        ...(providerQuote ? { marketDataValidated: true, providerQuote } : {}),
      });
      await persistMarketStocks();
      return {
        id: stock.id,
        symbol: stock.symbol,
        name: stock.name,
        exchange: stock.exchange,
        sector: stock.sector,
        price: stock.basePrice,
        changePercent: stock.changePercent,
        ...(stock.providerQuote ? {
          dataSource: stock.providerQuote.dataSource,
          lastUpdated: stock.providerQuote.lastUpdated,
        } : {}),
      };
    });
    marketRegistryQueue = update.then(() => undefined, () => undefined);
    response.json(await update);
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.delete("/api/admin/stocks/:id", async (request, response) => {
  try {
    if (investorContext(request).role !== "admin") {
      throw createTradeError("Administrator access is required.", 403);
    }

    const id = String(request.params.id ?? "").trim();
    if (!id || id.length > 120) throw createTradeError("A valid stock ID is required.");
    if (!marketState.some((stock) => stock.id === id) && !deletedMarketStockIds.has(id)) {
      throw createTradeError("Stock not found.", 404);
    }

    const deletion = marketRegistryQueue.then(async () => {
      const nextDeletedIds = [...new Set([...deletedMarketStockIds, id])];
      await saveJsonState("deleted-market-stocks", deletedMarketStocksPath, nextDeletedIds);
      await saveJsonState(
        "custom-market-stocks",
        customMarketStocksPath,
        marketState
          .filter((stock) => stock.id !== id)
          .map(({ id: stockId, symbol, name, exchange, basePrice, sector, changePercent }) => ({
            id: stockId,
            symbol,
            name,
            exchange,
            basePrice,
            ...(sector ? { sector } : {}),
            ...(Number.isFinite(changePercent) ? { changePercent } : {}),
          }))
      );
      deletedMarketStockIds.add(id);
      const stockIndex = marketState.findIndex((stock) => stock.id === id);
      if (stockIndex !== -1) marketState.splice(stockIndex, 1);
    });
    marketRegistryQueue = deletion.then(() => undefined, () => undefined);
    await deletion;
    response.json({ id, deleted: true });
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.post("/api/admin/users", async (request, response) => {
  try {
    if (investorContext(request).role !== "admin") {
      throw createTradeError("Administrator access is required.", 403);
    }

    const firstName = String(request.body?.first_name ?? "").trim();
    const lastName = String(request.body?.last_name ?? "").trim();
    const email = String(request.body?.email ?? "").trim().toLowerCase();
    const password = String(request.body?.password ?? "");
    const role = String(request.body?.role ?? "investor").trim().toLowerCase();
    const avatarUrl = normalizeAvatarUrl(request.body?.avatarUrl);

    if (!firstName || firstName.length > 80 || !lastName || lastName.length > 80) {
      throw createTradeError("Enter your first and last name.");
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw createTradeError("Enter a valid email address.");
    }
    if (password.length < 6 || password.length > 1024) {
      throw createTradeError("Password must be at least 6 characters.");
    }
    if (!["investor", "trader", "admin"].includes(role)) {
      throw createTradeError("Choose a valid account type.");
    }

    const user = await registerAuthUser({
      first_name: firstName,
      last_name: lastName,
      email,
      password,
      role,
      avatarUrl,
    });
    if (!user) throw createTradeError("An account with this email already exists.", 409);
    await ensureRegisteredTradingAccount(user);
    response.status(201).json({ user });
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.delete("/api/admin/users/:email", async (request, response) => {
  try {
    const identity = investorContext(request);
    if (identity.role !== "admin") {
      response.status(403).json({ error: "Administrator access is required." });
      return;
    }
    const email = String(request.params.email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      response.status(400).json({ error: "A valid account email is required." });
      return;
    }
    if (email === identity.email) {
      response.status(403).json({ error: "You cannot delete your own administrator account." });
      return;
    }

    const deletedAuthUsers = await deleteAuthUser(email);
    const accountIds = new Set([
      createHash("sha256").update(email).digest("hex"),
      ...["investor", "trader", "admin"].map((role) =>
        createHash("sha256").update(`${role}:${email}`).digest("hex")
      ),
    ]);
    const deletedTradingAccounts = await withLedgerTransaction((nextLedger) => {
      let removed = 0;
      for (const [id, account] of Object.entries(nextLedger.investors)) {
        if (accountIds.has(id) || String(account.email ?? "").toLowerCase() === email) {
          delete nextLedger.investors[id];
          removed += 1;
        }
      }
      return removed;
    });

    response.json({ email, deletedAuthUsers, deletedTradingAccounts });
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.get("/api/admin/investors", async (request, response) => {
  try {
    const identity = investorContext(request);
    if (identity.role !== "admin") throw createTradeError("Administrator access is required.", 403);
    await transactionQueue;
    const accounts = Object.entries(ledger.investors)
      .filter(([, account]) => account.role === "investor" || account.role === "trader" || account.email === "")
      .map(([id, account]) => {
        const snapshot = getInvestorSnapshot(account);
        const closedPositions = account.positions
          .filter((position) => position.status === "CLOSED")
          .map(positionWithMarketValue);
        return {
          id,
          email: account.email || "legacy-account",
          name: account.displayName || "Legacy account",
          avatarUrl: account.avatarUrl || "",
          role: account.role === "trader" ? "trader" : "investor",
          ...snapshot,
          closedPositions,
          orders: [...account.orders].sort((a, b) => b.timestamp - a.timestamp),
        };
      });
    response.json(accounts);
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.get("/api/admin/orders", async (request, response) => {
  try {
    if (investorContext(request).role !== "admin") {
      throw createTradeError("Administrator access is required.", 403);
    }

    const persistedOrders = await loadPersistedOrders();
    if (persistedOrders) {
      response.json(persistedOrders.map(({ _id, accountEmail, accountRole, ...order }) => ({
        ...order,
        id: order.id ?? String(_id),
        ownerEmail: accountEmail ?? "",
        ownerRole: accountRole ?? "investor",
      })));
      return;
    }

    await transactionQueue;
    const orders = Object.values(ledger.investors).flatMap((account) =>
      (account.orders ?? []).map((order) => ({
        ...order,
        ownerEmail: account.email ?? "",
        ownerRole: account.role ?? "investor",
      }))
    );
    response.json(orders.sort((a, b) => b.timestamp - a.timestamp));
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.get("/api/admin/overview", async (request, response) => {
  try {
    if (investorContext(request).role !== "admin") {
      throw createTradeError("Administrator access is required.", 403);
    }
    response.json(await loadAdminOverview());
  } catch (error) {
    sendTradeError(response, error);
  }
});

app.use("/api", (_request, response) => {
  response.status(404).json({ error: "API route not found" });
});

const loadCustomMarketStocks = async () => {
  const deletedIds = await loadJsonState("deleted-market-stocks", deletedMarketStocksPath, []);
  if (!Array.isArray(deletedIds)) throw new Error("The deleted market stocks store is invalid.");
  for (const id of deletedIds) {
    deletedMarketStockIds.add(id);
  }
  for (let index = marketState.length - 1; index >= 0; index -= 1) {
    if (deletedMarketStockIds.has(marketState[index].id)) marketState.splice(index, 1);
  }

  const stocks = await loadJsonState("custom-market-stocks", customMarketStocksPath, []);
  if (!Array.isArray(stocks)) throw new Error("The custom market stocks store is invalid.");
  for (const stock of stocks) {
    if (deletedMarketStockIds.has(String(stock.id))) continue;
    const storedSymbol = String(stock.symbol ?? "").trim().toUpperCase();
    const storedExchange = String(stock.exchange ?? "").trim().toUpperCase();
    const symbol = storedExchange === "BSE" && storedSymbol === "BES SENSEX"
      ? "SENSEX"
      : stock.symbol;
    const name = storedExchange === "BSE" && storedSymbol === "BES SENSEX"
      ? "SENSEX"
      : stock.name;
    const existingStock = marketState.find((entry) => entry.id === String(stock.id));
    if (existingStock) {
      const seededIdentity = stockSeedById.get(existingStock.id);
      Object.assign(existingStock, {
        symbol: seededIdentity?.symbol ?? symbol ?? existingStock.symbol,
        name: seededIdentity?.name ?? name ?? existingStock.name,
        exchange: seededIdentity?.exchange ?? stock.exchange ?? existingStock.exchange,
        basePrice: Number.isFinite(stock.basePrice) ? stock.basePrice : existingStock.basePrice,
        sector: stock.sector ?? existingStock.sector,
        changePercent: Number.isFinite(stock.changePercent)
          ? stock.changePercent
          : existingStock.changePercent,
        marketDataValidated: stock.marketDataValidated === true || existingStock.marketDataValidated === true,
        ...(stock.providerQuote ? { providerQuote: stock.providerQuote } : {}),
      });
      continue;
    }
    await registerCustomMarketStock({ ...stock, symbol });
  }
  await persistMarketStocks();
};

const initializeBackend = async () => {
  try {
    backendInitialized = false;
    backendInitializationStage = "database";
    backendInitializationMessage = "The API is initializing its data stores.";
    await connectDatabase();

    backendInitializationStage = "authentication";
    await initializeAuthStore();

    backendInitializationStage = "marketStocks";
    await loadCustomMarketStocks();

    backendInitializationStage = "tradingLedger";
    await loadLedger();

    backendInitializationStage = "accounts";
    const registeredMembers = (await listAuthUsers())
      .filter((user) => user.role === "investor" || user.role === "trader")
      .map((user) => {
        const email = user.email.trim().toLowerCase();
        const role = user.role;
        return {
          id: createHash("sha256").update(`${role}:${email}`).digest("hex"),
          email,
          displayName: `${user.first_name} ${user.last_name}`.trim() || email.split("@")[0],
          avatarUrl: "",
          role,
        };
      })
      .filter((identity) => !ledger.investors[identity.id]);
    if (registeredMembers.length > 0) {
      await withLedgerTransaction((nextLedger) => {
        for (const identity of registeredMembers) {
          resolveInvestorAccount(nextLedger, {
            ...identity,
            legacyId: createHash("sha256").update(identity.email).digest("hex"),
          });
        }
      });
    }
    backendInitializationStage = "database";
    const databaseStatus = getDatabaseStatus();
    if (databaseStatus !== "connected" && databaseStatus !== "file") {
      throw new Error("The configured database disconnected during initialization.");
    }
    backendInitializationMessage = "";
    backendInitializationStage = "";
    backendInitialized = true;
    console.log(`Stock Tracker backend is ready with ${getDatabaseStatus()} storage.`);
  } catch (error) {
    backendInitializationMessage = initializationStageMessages[backendInitializationStage] ??
      "The API could not initialize its required data stores. Check the backend storage configuration.";
    console.error(`Stock Tracker backend initialization failed during ${backendInitializationStage}.`, {
      errorType: error instanceof Error ? error.name : "UnknownError",
      errorLocation: error instanceof Error ? error.stack?.split("\n")[1]?.trim() : undefined,
    });
    const retryTimer = setTimeout(() => {
      void initializeBackend();
    }, 10_000);
    retryTimer.unref();
  }
};

const startHttpServer = () => {
  app.listen(port, () => {
    console.log(`Stock Tracker API listening on http://localhost:${port}`);
  });
};

startHttpServer();
void initializeBackend();
