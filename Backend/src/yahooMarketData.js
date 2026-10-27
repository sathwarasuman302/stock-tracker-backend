const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
const YAHOO_PROFILE_URL = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/";

const readFiniteNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const sanitizeResponseBody = (body) =>
  String(body)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(
      /["']?\b(crumb|token|authorization|cookie|password|secret)["']?\s*[:=]\s*("[^"]*"|'[^']*'|[^,\s}]+)/gi,
      "$1=[redacted]"
    )
    .replace(/https?:\/\/\S+/gi, "[url]")
    .trim()
    .slice(0, 240);

const CHART_REQUESTS = {
  "1m": { interval: "1m", range: "1d" },
  "5m": { interval: "5m", range: "5d" },
  "15m": { interval: "15m", range: "1mo" },
  "30m": { interval: "30m", range: "1mo" },
  "1H": { interval: "60m", range: "3mo" },
  "4H": { interval: "60m", range: "6mo" },
  "1D": { interval: "1d", range: "1y" },
  "1W": { interval: "1wk", range: "5y" },
  "1M": { interval: "1mo", range: "max" },
};

const resolveYahooSymbol = (stock) => {
  const symbol = String(stock.symbol ?? "").trim().toUpperCase();
  const exchange = String(stock.exchange ?? "").trim().toUpperCase();
  if (symbol === "NIFTY") return exchange === "NSE" ? "^NSEI" : null;
  if (exchange === "CRYPTO" && symbol === "BTC-USD") return symbol;
  if (!/^[A-Z0-9][A-Z0-9-]{0,24}(?:\.(?:NS|BO))?$/.test(symbol)) return null;

  if (symbol.endsWith(".NS")) return exchange === "NSE" ? symbol : null;
  if (symbol.endsWith(".BO")) return exchange === "BSE" ? symbol : null;
  if (exchange === "NSE") return `${symbol}.NS`;
  if (exchange === "BSE") return `${symbol}.BO`;
  return null;
};

const resolveQuoteCacheKey = (stock) =>
  `${String(stock.exchange ?? "").trim().toUpperCase()}:${resolveYahooSymbol(stock) ?? String(stock.symbol ?? "").trim().toUpperCase()}`;

export const createYahooQuoteClient = ({
  fetchImpl = fetch,
  cacheDurationMs = 5_000,
  sectorFailureCacheDurationMs = 5 * 60_000,
} = {}) => {
  const quoteCache = new Map();
  const pendingQuotes = new Map();
  const sectorCache = new Map();
  const pendingSectors = new Map();
  const candleCache = new Map();
  const pendingCandles = new Map();

  const fetchChart = async (stock, interval, range) => {
    const yahooSymbol = resolveYahooSymbol(stock);
    if (!yahooSymbol) {
      throw new Error(`Yahoo Finance market data is not supported for ${stock.symbol} on ${stock.exchange}.`);
    }

    const encodedSymbol = encodeURIComponent(yahooSymbol);
    const url = `${YAHOO_CHART_URL}${encodedSymbol}?interval=${interval}&range=${range}`;
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      if (response.status === 404) {
        const body = await response.text().catch(() => "[response body unavailable]");
        console.warn("Yahoo Finance chart request returned HTTP 404.", {
          symbol: yahooSymbol,
          interval,
          range,
          status: response.status,
          body: sanitizeResponseBody(body),
        });
      }
      throw new Error(`Yahoo Finance chart request failed with status ${response.status}.`);
    }

    const result = await response.json();
    const chart = result?.chart?.result?.[0];
    if (result?.chart?.error || !chart?.meta) {
      throw new Error(result?.chart?.error?.description ?? "Yahoo Finance returned no chart data.");
    }
    if (chart.meta.symbol !== yahooSymbol) {
      throw new Error(`Yahoo Finance returned ${chart.meta.symbol ?? "an unknown symbol"} instead of ${yahooSymbol}.`);
    }
    return chart;
  };

  const fetchQuote = async (stock) => {
    const chart = await fetchChart(stock, "1m", "1d");

    const price = readFiniteNumber(chart.meta.regularMarketPrice);
    const previousClose = readFiniteNumber(
      chart.meta.chartPreviousClose ?? chart.meta.previousClose
    );
    const marketTime = readFiniteNumber(chart.meta.regularMarketTime);
    if (price === null || price <= 0 || previousClose === null || previousClose <= 0 || marketTime === null) {
      throw new Error("Yahoo Finance returned an incomplete market quote.");
    }

    const volume = readFiniteNumber(chart.meta.regularMarketVolume);
    const change = Number((price - previousClose).toFixed(2));
    return {
      price,
      change,
      changePercent: Number(((change / previousClose) * 100).toFixed(2)),
      volume: volume ?? undefined,
      lastUpdated: marketTime * 1000,
      dataSource: "delayed",
    };
  };

  const fetchSector = async (stock) => {
    const yahooSymbol = resolveYahooSymbol(stock);
    if (!yahooSymbol) {
      throw new Error(`Yahoo Finance market data is not supported for ${stock.symbol} on ${stock.exchange}.`);
    }

    const url = `${YAHOO_PROFILE_URL}${encodeURIComponent(yahooSymbol)}?modules=assetProfile`;
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      throw new Error(`Yahoo Finance sector lookup failed with status ${response.status}.`);
    }

    const result = await response.json();
    const sector = result?.quoteSummary?.result?.[0]?.assetProfile?.sector;
    return typeof sector === "string" && sector.trim() ? sector.trim() : null;
  };

  const fetchCandles = async (stock, timeframe) => {
    const request = CHART_REQUESTS[timeframe];
    if (!request) throw new Error("Unsupported chart timeframe.");

    const chart = await fetchChart(stock, request.interval, request.range);
    const timestamps = chart.timestamp ?? [];
    const quote = chart.indicators?.quote?.[0];
    if (!quote || !Array.isArray(timestamps)) {
      throw new Error("Yahoo Finance returned incomplete candle data.");
    }

    const candles = timestamps.flatMap((timestamp, index) => {
      const open = readFiniteNumber(quote.open?.[index]);
      const high = readFiniteNumber(quote.high?.[index]);
      const low = readFiniteNumber(quote.low?.[index]);
      const close = readFiniteNumber(quote.close?.[index]);
      if (
        open === null || high === null || low === null || close === null ||
        open <= 0 || high <= 0 || low <= 0 || close <= 0 ||
        high < low || high < open || high < close || low > open || low > close
      ) return [];
      return [{
        time: timestamp * 1000,
        open,
        high,
        low,
        close,
        volume: readFiniteNumber(quote.volume?.[index]) ?? 0,
      }];
    });

    if (candles.length === 0) {
      throw new Error("Yahoo Finance returned no valid candles.");
    }

    if (timeframe === "4H") {
      const bucketDuration = 4 * 60 * 60 * 1000;
      const buckets = new Map();
      for (const candle of candles) {
        const bucketTime = Math.floor(candle.time / bucketDuration) * bucketDuration;
        const current = buckets.get(bucketTime);
        if (current) {
          current.high = Math.max(current.high, candle.high);
          current.low = Math.min(current.low, candle.low);
          current.close = candle.close;
          current.volume += candle.volume;
        } else {
          buckets.set(bucketTime, { ...candle, time: bucketTime });
        }
      }
      return [...buckets.values()];
    }

    return candles;
  };

  return {
    async getQuote(stock) {
      const cacheKey = resolveQuoteCacheKey(stock);
      const cached = quoteCache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < cacheDurationMs) {
        return cached.quote;
      }

      const pending = pendingQuotes.get(cacheKey);
      if (pending) return pending;

      const request = fetchQuote(stock)
        .then((quote) => {
          quoteCache.set(cacheKey, { quote, cachedAt: Date.now() });
          return quote;
        })
        .finally(() => pendingQuotes.delete(cacheKey));
      pendingQuotes.set(cacheKey, request);
      return request;
    },
    async getSector(stock) {
      const existingSector = typeof stock.sector === "string" ? stock.sector.trim() : "";
      if (existingSector) return existingSector;

      const cacheKey = resolveQuoteCacheKey(stock);
      const cached = sectorCache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < cached.durationMs) return cached.sector;

      const pending = pendingSectors.get(cacheKey);
      if (pending) return pending;

      const request = fetchSector(stock)
        .then((sector) => {
          sectorCache.set(cacheKey, { sector, cachedAt: Date.now(), durationMs: cacheDurationMs });
          return sector;
        })
        .catch(() => {
          sectorCache.set(cacheKey, {
            sector: null,
            cachedAt: Date.now(),
            durationMs: sectorFailureCacheDurationMs,
          });
          return null;
        })
        .finally(() => pendingSectors.delete(cacheKey));
      pendingSectors.set(cacheKey, request);
      return request;
    },
    async getCandles(stock, timeframe) {
      const cacheKey = `${stock.id}:${timeframe}`;
      const cached = candleCache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < 60_000) return cached.candles;

      const pending = pendingCandles.get(cacheKey);
      if (pending) return pending;

      const request = fetchCandles(stock, timeframe)
        .then((candles) => {
          candleCache.set(cacheKey, { candles, cachedAt: Date.now() });
          return candles;
        })
        .finally(() => pendingCandles.delete(cacheKey));
      pendingCandles.set(cacheKey, request);
      return request;
    },
  };
};
