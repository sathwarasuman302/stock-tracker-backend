import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeMarketCandles } from "../../Frontend/src/services/marketAnalysis.ts";

const makeCandles = (slope, { count = 100, baseTime = 1_800_000_000_000 } = {}) =>
  Array.from({ length: count }, (_, index) => {
    const close = 3500 + index * slope + Math.sin(index * 1.7) * 4;
    const open = 3500 + index * slope + Math.sin((index - 0.5) * 1.7) * 4;
    return {
      time: baseTime - count * 86_400_000 + index * 86_400_000,
      open,
      high: Math.max(open, close) + 2,
      low: Math.min(open, close) - 2,
      close,
      volume: index === count - 1 ? 2500 : 1000,
    };
  });

test("calculates trend indicators, structure, and valid long watch levels from candles", () => {
  const now = 1_800_000_000_000;
  const candles = makeCandles(0.7, { baseTime: now });
  const analysis = analyzeMarketCandles(candles, "1D", "Yahoo Finance — delayed data", now);

  assert.equal(analysis.trend.direction, "Bullish");
  assert.equal(analysis.entry.setup, "LONG WATCH");
  assert.ok(analysis.trend.ema20);
  assert.ok(analysis.trend.ema50);
  assert.ok(analysis.trend.rsi14);
  assert.ok(analysis.trend.support < analysis.trend.resistance);
  assert.ok(analysis.entry.zone);
  assert.ok(analysis.levels.target > analysis.entry.zone.high);
  assert.ok(analysis.levels.stopLoss < analysis.entry.zone.low);
  assert.equal(analysis.levels.riskReward, 2);
  assert.equal(analysis.data.currentPrice, candles.at(-1).close);
  assert.equal(analysis.data.source, "Yahoo Finance — delayed data");
  assert.equal(analysis.data.volumeConfirmed, true);
});

test("keeps trend separate from overbought momentum and waits on entry", () => {
  const now = 1_800_000_000_000;
  const candles = Array.from({ length: 80 }, (_, index) => {
    const close = 3500 + index * 1.2 + Math.sin(index * 1.7) * 3;
    const open = 3500 + index * 1.2 + Math.sin((index - 0.5) * 1.7) * 3;
    return {
      time: now - 80 * 86_400_000 + index * 86_400_000,
      open,
      high: Math.max(open, close) + 2,
      low: Math.min(open, close) - 2,
      close,
      volume: 1000,
    };
  });
  const analysis = analyzeMarketCandles(candles, "1D", "Yahoo Finance", now);

  assert.equal(analysis.trend.direction, "Bullish");
  assert.equal(analysis.trend.momentum, "Overbought");
  assert.equal(analysis.entry.setup, "WAIT");
  assert.equal(analysis.levels.target, null);
});

test("explains when a bearish breakdown has already moved beyond the short-entry zone", () => {
  const now = 1_800_000_000_000;
  const candles = makeCandles(-1, { baseTime: now });
  const analysis = analyzeMarketCandles(candles, "1D", "Yahoo Finance", now);

  assert.equal(analysis.trend.direction, "Bearish");
  assert.equal(analysis.entry.setup, "WAIT");
  assert.equal(analysis.entry.zone, null);
  assert.match(analysis.entry.confirmation, /already below the short watch zone/);
  assert.equal(analysis.levels.target, null);
  assert.match(analysis.levels.explanation, /no confirmed entry setup/);
  assert.match(analysis.risk.mainRisk, /already below the short watch zone/);
});

test("returns WAIT and insufficient levels for too few candles", () => {
  const analysis = analyzeMarketCandles(makeCandles(0.5, { count: 20 }), "1D", "Yahoo Finance", 1_800_000_000_000);

  assert.equal(analysis.trend.direction, "Insufficient Data");
  assert.equal(analysis.entry.setup, "WAIT");
  assert.equal(analysis.entry.zone, null);
  assert.equal(analysis.levels.target, null);
  assert.match(analysis.levels.explanation, /Insufficient data/);
});

test("shows historical indicators for stale candles but never suggests an entry", () => {
  const now = 1_800_000_000_000;
  const staleCandles = makeCandles(0.5, { baseTime: now - 5 * 86_400_000 });
  const staleAnalysis = analyzeMarketCandles(staleCandles, "1D", "Yahoo Finance", now);
  const invalidAnalysis = analyzeMarketCandles(
    [{ ...makeCandles(0.5, { count: 1, baseTime: now })[0], high: 0 }],
    "1D",
    "Yahoo Finance",
    now
  );

  assert.equal(staleAnalysis.data.stale, true);
  assert.equal(staleAnalysis.entry.setup, "WAIT");
  assert.notEqual(staleAnalysis.trend.direction, "Insufficient Data");
  assert.equal(staleAnalysis.levels.target, null);
  assert.match(staleAnalysis.entry.confirmation, /fresh market data/);
  assert.match(staleAnalysis.risk.mainRisk, /stale/i);
  assert.equal(invalidAnalysis.data.candleCount, 0);
  assert.equal(invalidAnalysis.entry.setup, "WAIT");
});

test("keeps trend reasons bounded and reports source/timeframe metadata", () => {
  const now = 1_800_000_000_000;
  const analysis = analyzeMarketCandles(makeCandles(0.5, { baseTime: now }), "1D", "Yahoo Finance — delayed data", now);

  assert.ok(["Bullish", "Bearish", "Sideways"].includes(analysis.trend.direction));
  assert.ok(analysis.trend.reasons.length >= 2 && analysis.trend.reasons.length <= 3);
  assert.equal(analysis.data.timeframe, "1D");
  assert.equal(analysis.data.source, "Yahoo Finance — delayed data");
});
