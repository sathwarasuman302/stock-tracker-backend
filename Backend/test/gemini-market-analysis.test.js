import assert from "node:assert/strict";
import { test } from "node:test";
import { createGeminiMarketCommentator } from "../src/geminiMarketAnalysis.js";
const response = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

test("returns concise commentary without creating or changing technical levels", async () => {
  let request;
  const comment = createGeminiMarketCommentator({
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      request = { url, ...options };
      return response({ candidates: [{ content: { parts: [{ text: "Momentum supports waiting for the stated breakout confirmation." }] } }] });
    },
  });

  const commentary = await comment({
    symbol: "TCS.BO",
    timeframe: "1D",
    context: "Trend: Bullish. Entry setup: LONG WATCH. Target 3600; stop-loss 3400.",
  });
  assert.equal(request.headers["x-goog-api-key"], "test-key");
  assert.match(JSON.parse(request.body).contents[0].parts[0].text, /Do not add or alter prices/);
  assert.equal(commentary, "Momentum supports waiting for the stated breakout confirmation.");
});

test("reports missing optional commentary configuration", async () => {
  const comment = createGeminiMarketCommentator({ apiKey: "" });
  await assert.rejects(
    comment({ symbol: "TCS.BO", timeframe: "1D", context: "Trend: insufficient." }),
    { code: "AI_NOT_CONFIGURED" }
  );
});

test("rejects empty Gemini commentary", async () => {
  const comment = createGeminiMarketCommentator({
    apiKey: "test-key",
    fetchImpl: async () => response({ candidates: [{ content: { parts: [{ text: " " }] } }] }),
  });
  await assert.rejects(
    comment({ symbol: "TCS.BO", timeframe: "1D", context: "Trend: sideways." }),
    /invalid commentary/
  );
});
