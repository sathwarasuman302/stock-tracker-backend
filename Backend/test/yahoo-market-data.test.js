import assert from "node:assert/strict";
import { test } from "node:test";
import { createYahooQuoteClient } from "../src/yahooMarketData.js";

const mockResponse = (payload, status = 200, body = JSON.stringify(payload)) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
  text: async () => body,
});

test("fetches a delayed RELIANCE NSE quote from Yahoo Finance", async () => {
  let requestUrl;
  const marketTime = 1_798_000_000;
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      requestUrl = new URL(url);
      return mockResponse({
        chart: {
          result: [{
            meta: {
              symbol: "RELIANCE.NS",
              regularMarketPrice: 1190,
              chartPreviousClose: 1184.5,
              regularMarketTime: marketTime,
              regularMarketVolume: 2400,
            },
            indicators: { quote: [{ volume: [100, 200] }] },
          }],
        },
      });
    },
  });

  const quote = await client.getQuote({
    id: "1",
    symbol: "RELIANCE.NS",
    exchange: "NSE",
  });

  assert.equal(requestUrl.hostname, "query1.finance.yahoo.com");
  assert.equal(decodeURIComponent(requestUrl.pathname.split("/").at(-1)), "RELIANCE.NS");
  assert.equal(quote.price, 1190);
  assert.equal(quote.change, 5.5);
  assert.equal(quote.changePercent, 0.46);
  assert.equal(quote.volume, 2400);
  assert.equal(quote.lastUpdated, marketTime * 1000);
  assert.equal(quote.dataSource, "delayed");
});

test("fetches a delayed TCS BSE quote from Yahoo Finance", async () => {
  let requestedSymbol;
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      requestedSymbol = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
      return mockResponse({
        chart: {
          result: [{
            meta: {
              symbol: "TCS.BO",
              regularMarketPrice: 3400,
              chartPreviousClose: 3380,
              regularMarketTime: 1_798_000_000,
            },
          }],
        },
      });
    },
  });

  const quote = await client.getQuote({
    id: "2",
    symbol: "TCS.BO",
    exchange: "BSE",
  });

  assert.equal(requestedSymbol, "TCS.BO");
  assert.equal(quote.price, 3400);
  assert.equal(quote.change, 20);
  assert.equal(quote.dataSource, "delayed");
});

test("fetches admin-added NSE quotes using the selected exchange", async () => {
  let requestedSymbol;
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      requestedSymbol = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
      return mockResponse({
        chart: {
          result: [{
            meta: {
              symbol: "WIPRO.NS",
              regularMarketPrice: 540,
              previousClose: 535,
              regularMarketTime: 1_798_000_000,
            },
          }],
        },
      });
    },
  });

  const quote = await client.getQuote({ id: "admin-new-stock", symbol: "WIPRO", exchange: "NSE" });

  assert.equal(requestedSymbol, "WIPRO.NS");
  assert.equal(quote.price, 540);
  assert.equal(quote.change, 5);
  assert.equal(quote.changePercent, 0.93);
  assert.equal(quote.dataSource, "delayed");
});

test("fetches a stock sector from Yahoo Finance company profile", async () => {
  let requestUrl;
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      requestUrl = new URL(url);
      return mockResponse({
        quoteSummary: {
          result: [{ assetProfile: { sector: "Information Technology" } }],
        },
      });
    },
  });

  const sector = await client.getSector({
    id: "admin-new-stock",
    symbol: "WIPRO",
    exchange: "NSE",
  });

  assert.equal(requestUrl.hostname, "query1.finance.yahoo.com");
  assert.equal(requestUrl.pathname, "/v10/finance/quoteSummary/WIPRO.NS");
  assert.equal(requestUrl.searchParams.get("modules"), "assetProfile");
  assert.equal(sector, "Information Technology");
});

test("uses a persisted sector without calling Yahoo Finance", async () => {
  const client = createYahooQuoteClient({
    fetchImpl: async () => {
      throw new Error("A stored sector should not trigger a request.");
    },
  });

  const sector = await client.getSector({
    id: "existing-stock",
    symbol: "WIPRO",
    exchange: "NSE",
    sector: "Information Technology",
  });

  assert.equal(sector, "Information Technology");
});

test("suppresses repeated Yahoo sector lookup failures after HTTP 401", async () => {
  let requests = 0;
  const client = createYahooQuoteClient({
    fetchImpl: async () => {
      requests += 1;
      return mockResponse({}, 401, "Invalid Crumb");
    },
  });
  const stock = { id: "wipro", symbol: "WIPRO", exchange: "NSE" };

  assert.equal(await client.getSector(stock), null);
  assert.equal(await client.getSector(stock), null);
  assert.equal(requests, 1);
});

test("does not reuse a cached admin quote for a different symbol with the same ID", async () => {
  const requestedSymbols = [];
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      const symbol = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
      requestedSymbols.push(symbol);
      return mockResponse({
        chart: {
          result: [{
            meta: {
              symbol,
              regularMarketPrice: symbol === "WIPRO.NS" ? 540 : 1100,
              previousClose: symbol === "WIPRO.NS" ? 535 : 1090,
              regularMarketTime: 1_798_000_000,
            },
          }],
        },
      });
    },
  });

  const wipro = await client.getQuote({ id: "quote-preview", symbol: "WIPRO", exchange: "NSE" });
  const infosys = await client.getQuote({ id: "quote-preview", symbol: "INFY", exchange: "NSE" });

  assert.deepEqual(requestedSymbols, ["WIPRO.NS", "INFY.NS"]);
  assert.equal(wipro.price, 540);
  assert.equal(infosys.price, 1100);
});

test("rejects a Yahoo symbol whose suffix conflicts with the selected exchange", async () => {
  const client = createYahooQuoteClient({
    fetchImpl: async () => {
      throw new Error("The fetch should not run for a mismatched exchange.");
    },
  });

  await assert.rejects(
    client.getQuote({ id: "wrong-exchange", symbol: "WIPRO.NS", exchange: "BSE" }),
    /not supported/
  );
  await assert.rejects(
    client.getQuote({ id: "wrong-known-exchange", symbol: "RELIANCE.NS", exchange: "BSE" }),
    /not supported/
  );
});

test("fetches HDFCBANK's NSE quote using its Yahoo Finance symbol", async () => {
  let requestedSymbol;
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      requestedSymbol = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
      return mockResponse({
        chart: {
          result: [{
            meta: {
              symbol: "HDFCBANK.NS",
              regularMarketPrice: 1750,
              previousClose: 1730,
              regularMarketTime: 1_798_000_000,
              regularMarketVolume: 5000,
            },
          }],
        },
      });
    },
  });

  const quote = await client.getQuote({
    id: "4",
    symbol: "HDFCBANK.NS",
    exchange: "NSE",
  });

  assert.equal(requestedSymbol, "HDFCBANK.NS");
  assert.equal(quote.price, 1750);
  assert.equal(quote.change, 20);
  assert.equal(quote.dataSource, "delayed");
});

test("fetches ICICIBANK's NSE quote using its Yahoo Finance symbol", async () => {
  let requestedSymbol;
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      requestedSymbol = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
      return mockResponse({
        chart: {
          result: [{
            meta: {
              symbol: "ICICIBANK.NS",
              regularMarketPrice: 1394.2,
              previousClose: 1398.5,
              regularMarketTime: 1_798_000_000,
            },
          }],
        },
      });
    },
  });

  const quote = await client.getQuote({
    id: "5",
    symbol: "ICICIBANK.NS",
    exchange: "NSE",
  });

  assert.equal(requestedSymbol, "ICICIBANK.NS");
  assert.equal(quote.price, 1394.2);
  assert.equal(quote.change, -4.3);
  assert.equal(quote.dataSource, "delayed");
});

test("fetches ITC's NSE quote using its Yahoo Finance symbol", async () => {
  let requestedSymbol;
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      requestedSymbol = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
      return mockResponse({
        chart: {
          result: [{
            meta: {
              symbol: "ITC.NS",
              regularMarketPrice: 258,
              previousClose: 259,
              regularMarketTime: 1_798_000_000,
              regularMarketVolume: 9000,
            },
          }],
        },
      });
    },
  });

  const quote = await client.getQuote({
    id: "6",
    symbol: "ITC.NS",
    exchange: "NSE",
  });

  assert.equal(requestedSymbol, "ITC.NS");
  assert.equal(quote.price, 258);
  assert.equal(quote.change, -1);
  assert.equal(quote.dataSource, "delayed");
});

test("fetches Infosys's NSE quote using its Yahoo Finance symbol", async () => {
  let requestedSymbol;
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      requestedSymbol = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
      return mockResponse({
        chart: {
          result: [{
            meta: {
              symbol: "INFY.NS",
              regularMarketPrice: 1520,
              previousClose: 1500,
              regularMarketTime: 1_798_000_000,
              regularMarketVolume: 12000,
            },
          }],
        },
      });
    },
  });

  const quote = await client.getQuote({
    id: "7",
    symbol: "INFY.NS",
    exchange: "NSE",
  });

  assert.equal(requestedSymbol, "INFY.NS");
  assert.equal(quote.price, 1520);
  assert.equal(quote.change, 20);
  assert.equal(quote.volume, 12000);
  assert.equal(quote.dataSource, "delayed");
});

test("maps NIFTY to Yahoo Finance's NSE index symbol", async () => {
  let requestedSymbol;
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      requestedSymbol = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
      return mockResponse({
        chart: {
          result: [{
            meta: {
              symbol: "^NSEI",
              regularMarketPrice: 25000,
              previousClose: 24900,
              regularMarketTime: 1_798_000_000,
            },
          }],
        },
      });
    },
  });

  const quote = await client.getQuote({ id: "3", symbol: "NIFTY", exchange: "NSE" });

  assert.equal(requestedSymbol, "^NSEI");
  assert.equal(quote.price, 25000);
});

test("fetches NIFTY historical candles from Yahoo Finance's NSE index symbol", async () => {
  let requestedSymbol;
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      requestedSymbol = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
      return mockResponse({
        chart: {
          result: [{
            meta: { symbol: "^NSEI" },
            timestamp: [1_798_000_000],
            indicators: {
              quote: [{
                open: [25000],
                high: [25100],
                low: [24950],
                close: [25075],
                volume: [0],
              }],
            },
          }],
        },
      });
    },
  });

  const candles = await client.getCandles(
    { id: "3", symbol: "NIFTY", exchange: "NSE" },
    "5m"
  );

  assert.equal(requestedSymbol, "^NSEI");
  assert.deepEqual(candles, [
    { time: 1_798_000_000_000, open: 25000, high: 25100, low: 24950, close: 25075, volume: 0 },
  ]);
});

test("returns Yahoo OHLC candles for the requested timeframe", async () => {
  let requestUrl;
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      requestUrl = new URL(url);
      return mockResponse({
        chart: {
          result: [{
            meta: { symbol: "RELIANCE.NS" },
            timestamp: [1_798_000_000, 1_798_000_300],
            indicators: {
              quote: [{
                open: [1190, 1192],
                high: [1193, 1194],
                low: [1189, 1191],
                close: [1192, 1193],
                volume: [1000, 1200],
              }],
            },
          }],
        },
      });
    },
  });

  const candles = await client.getCandles(
    { id: "1", symbol: "RELIANCE.NS", exchange: "NSE" },
    "5m"
  );

  assert.equal(requestUrl.searchParams.get("interval"), "5m");
  assert.equal(requestUrl.searchParams.get("range"), "5d");
  assert.deepEqual(candles, [
    { time: 1_798_000_000_000, open: 1190, high: 1193, low: 1189, close: 1192, volume: 1000 },
    { time: 1_798_000_300_000, open: 1192, high: 1194, low: 1191, close: 1193, volume: 1200 },
  ]);
});

test("logs chart 404 context with a short sanitized response body", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  const client = createYahooQuoteClient({
    fetchImpl: async () => mockResponse({}, 404, "Not Found; crumb=private-value"),
  });

  try {
    await assert.rejects(
      client.getCandles(
        { id: "admin-stock", symbol: "NEWCO", exchange: "NSE" },
        "5m"
      ),
      /chart request failed with status 404/
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "Yahoo Finance chart request returned HTTP 404.");
  assert.deepEqual(warnings[0][1], {
    symbol: "NEWCO.NS",
    interval: "5m",
    range: "5d",
    status: 404,
    body: "Not Found; crumb=[redacted]",
  });
  assert.doesNotMatch(JSON.stringify(warnings), /private-value/);
});

test("fetches TCS historical candles from Yahoo Finance's BSE symbol", async () => {
  let requestedSymbol;
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      requestedSymbol = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
      return mockResponse({
        chart: {
          result: [{
            meta: { symbol: "TCS.BO" },
            timestamp: [1_798_000_000],
            indicators: {
              quote: [{
                open: [3400],
                high: [3450],
                low: [3380],
                close: [3425],
                volume: [12000],
              }],
            },
          }],
        },
      });
    },
  });

  const candles = await client.getCandles(
    { id: "2", symbol: "TCS.BO", exchange: "BSE" },
    "1D"
  );

  assert.equal(requestedSymbol, "TCS.BO");
  assert.deepEqual(candles, [
    { time: 1_798_000_000_000, open: 3400, high: 3450, low: 3380, close: 3425, volume: 12000 },
  ]);
});

test("fetches SBIN NSE quotes and candles from Yahoo Finance", async () => {
  const requestedSymbols = [];
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      const requestUrl = new URL(url);
      const symbol = decodeURIComponent(requestUrl.pathname.split("/").at(-1));
      requestedSymbols.push(symbol);
      const chart = requestUrl.searchParams.get("interval") === "1m"
        ? {
            result: [{
              meta: {
                symbol,
                regularMarketPrice: 820,
                previousClose: 810,
                regularMarketTime: 1_798_000_000,
              },
            }],
          }
        : {
            result: [{
              meta: { symbol },
              timestamp: [1_798_000_000],
              indicators: {
                quote: [{ open: [810], high: [825], low: [805], close: [820], volume: [1000] }],
              },
            }],
          };
      return mockResponse({ chart });
    },
  });
  const stock = { id: "8", symbol: "SBIN.NS", exchange: "NSE" };

  const quote = await client.getQuote(stock);
  const candles = await client.getCandles(stock, "1D");

  assert.deepEqual(requestedSymbols, ["SBIN.NS", "SBIN.NS"]);
  assert.equal(quote.price, 820);
  assert.deepEqual(candles, [
    { time: 1_798_000_000_000, open: 810, high: 825, low: 805, close: 820, volume: 1000 },
  ]);
});

test("fetches BTC-USD quote data from Yahoo Finance without an exchange suffix", async () => {
  let requestUrl;
  const marketTime = 1_798_000_000;
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      requestUrl = new URL(url);
      return mockResponse({
        chart: {
          result: [{
            meta: {
              symbol: "BTC-USD",
              regularMarketPrice: 67250.45,
              chartPreviousClose: 66800,
              regularMarketTime: marketTime,
              regularMarketVolume: 8000,
            },
          }],
        },
      });
    },
  });

  const quote = await client.getQuote({ id: "9", symbol: "BTC-USD", exchange: "CRYPTO" });

  assert.equal(decodeURIComponent(requestUrl.pathname.split("/").at(-1)), "BTC-USD");
  assert.equal(requestUrl.searchParams.get("interval"), "1m");
  assert.equal(quote.price, 67250.45);
  assert.equal(quote.change, 450.45);
  assert.equal(quote.changePercent, 0.67);
  assert.equal(quote.lastUpdated, marketTime * 1000);
  assert.equal(quote.dataSource, "delayed");
});

test("fetches BTC-USD one-minute candles from Yahoo Finance", async () => {
  let requestUrl;
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      requestUrl = new URL(url);
      return mockResponse({
        chart: {
          result: [{
            meta: { symbol: "BTC-USD" },
            timestamp: [1_798_000_000],
            indicators: {
              quote: [{
                open: [67200],
                high: [67280],
                low: [67180],
                close: [67250],
                volume: [12],
              }],
            },
          }],
        },
      });
    },
  });

  const candles = await client.getCandles(
    { id: "9", symbol: "BTC-USD", exchange: "CRYPTO" },
    "1m"
  );

  assert.equal(decodeURIComponent(requestUrl.pathname.split("/").at(-1)), "BTC-USD");
  assert.equal(requestUrl.searchParams.get("interval"), "1m");
  assert.equal(requestUrl.searchParams.get("range"), "1d");
  assert.deepEqual(candles, [
    { time: 1_798_000_000_000, open: 67200, high: 67280, low: 67180, close: 67250, volume: 12 },
  ]);
});

test("fetches supported admin-added NSE and BSE stocks using exchange-based Yahoo symbols", async () => {
  const requestedSymbols = [];
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      const symbol = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
      requestedSymbols.push(symbol);
      return mockResponse({
        chart: {
          result: [{
            meta: { symbol },
            timestamp: [1_798_000_000],
            indicators: {
              quote: [{ open: [100], high: [105], low: [98], close: [103], volume: [5000] }],
            },
          }],
        },
      });
    },
  });

  await client.getCandles({ id: "admin-nse", symbol: "NEWCO", exchange: "NSE" }, "1D");
  await client.getCandles({ id: "admin-bse", symbol: "NEWCO", exchange: "BSE" }, "1D");
  await client.getCandles({ id: "admin-explicit", symbol: "NEWCO.NS", exchange: "NSE" }, "1D");

  assert.deepEqual(requestedSymbols, ["NEWCO.NS", "NEWCO.BO", "NEWCO.NS"]);
});

test("rejects admin stock symbols when no supported Yahoo exchange is known", async () => {
  const client = createYahooQuoteClient({
    fetchImpl: async () => {
      throw new Error("Unsupported exchange must be rejected before fetching.");
    },
  });

  await assert.rejects(
    client.getCandles({ id: "admin-lse", symbol: "NEWCO", exchange: "LSE" }, "1D"),
    /not supported for NEWCO on LSE/
  );
});

test("rejects unsupported Yahoo symbols without requesting chart data", async () => {
  const client = createYahooQuoteClient({
    fetchImpl: async () => {
      throw new Error("Unsupported symbols must be rejected before fetching.");
    },
  });

  await assert.rejects(
    client.getCandles({ id: "invalid", symbol: "BAD!SYMBOL", exchange: "NSE" }, "1D"),
    /not supported/
  );
  await assert.rejects(
    client.getQuote({ id: "wrong-index-exchange", symbol: "NIFTY", exchange: "BSE" }),
    /not supported/
  );
});

test("fetches Infosys historical candles from Yahoo Finance", async () => {
  let requestedSymbol;
  const client = createYahooQuoteClient({
    fetchImpl: async (url) => {
      requestedSymbol = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
      return mockResponse({
        chart: {
          result: [{
            meta: { symbol: "INFY.NS" },
            timestamp: [1_798_000_000],
            indicators: {
              quote: [{
                open: [1500],
                high: [1530],
                low: [1490],
                close: [1520],
                volume: [12000],
              }],
            },
          }],
        },
      });
    },
  });

  const candles = await client.getCandles(
    { id: "7", symbol: "INFY.NS", exchange: "NSE" },
    "5m"
  );

  assert.equal(requestedSymbol, "INFY.NS");
  assert.deepEqual(candles, [
    { time: 1_798_000_000_000, open: 1500, high: 1530, low: 1490, close: 1520, volume: 12000 },
  ]);
});

test("omits malformed Yahoo candles with missing or invalid OHLC values", async () => {
  const client = createYahooQuoteClient({
    fetchImpl: async () => mockResponse({
      chart: {
        result: [{
          meta: { symbol: "RELIANCE.NS" },
          timestamp: [1_798_000_000, 1_798_000_060],
          indicators: {
            quote: [{
              open: [null, 1190],
              high: [null, 1193],
              low: [null, 1189],
              close: [null, 1192],
              volume: [null, 1000],
            }],
          },
        }],
      },
    }),
  });

  const candles = await client.getCandles(
    { id: "1", symbol: "RELIANCE.NS", exchange: "NSE" },
    "1m"
  );

  assert.deepEqual(candles, [
    { time: 1_798_000_060_000, open: 1190, high: 1193, low: 1189, close: 1192, volume: 1000 },
  ]);
});

test("rejects unsupported symbols and incomplete Yahoo quotes", async () => {
  const client = createYahooQuoteClient({
    fetchImpl: async () => mockResponse({
      chart: { result: [{ meta: { symbol: "RELIANCE.NS" } }] },
    }),
  });

  await assert.rejects(
    client.getQuote({ id: "custom", symbol: "CUSTOM", exchange: "NSE" }),
    /instead of CUSTOM\.NS/
  );
  await assert.rejects(
    client.getQuote({ id: "1", symbol: "RELIANCE.NS", exchange: "NSE" }),
    /incomplete market quote/
  );
  await assert.rejects(
    client.getCandles(
      { id: "1", symbol: "RELIANCE.NS", exchange: "NSE" },
      "5m"
    ),
    /incomplete candle data/
  );
});

test("does not fabricate quote or candle data when Yahoo chart requests fail", async () => {
  const client = createYahooQuoteClient({
    fetchImpl: async () => mockResponse({}, 404, "Not Found"),
  });
  const stock = { id: "1", symbol: "RELIANCE.NS", exchange: "NSE" };

  await assert.rejects(client.getQuote(stock), /chart request failed with status 404/);
  await assert.rejects(client.getCandles(stock, "1D"), /chart request failed with status 404/);
});
