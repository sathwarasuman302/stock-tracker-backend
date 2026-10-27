const DEFAULT_MODEL = "gemini-2.5-flash";

export const createGeminiMarketCommentator = ({
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_MODEL || DEFAULT_MODEL,
  fetchImpl = fetch,
} = {}) => async ({ symbol, timeframe, context }) => {
  if (!apiKey) {
    const error = new Error("AI commentary is not configured.");
    error.code = "AI_NOT_CONFIGURED";
    throw error;
  }
  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: [
              `Write one concise educational commentary for ${symbol} on the ${timeframe} timeframe.`,
              "Use only this deterministic technical-analysis summary. Do not add or alter prices, levels, indicators, or trade recommendations.",
              "Do not claim certainty or provide personalized financial advice. Return plain text under 500 characters.",
              context,
            ].join("\n"),
          }],
        }],
        generationConfig: { temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(20_000),
    }
  );
  if (!response.ok) throw new Error(`Gemini commentary request failed with status ${response.status}.`);
  const payload = await response.json();
  const commentary = payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text)
    .filter((part) => typeof part === "string")
    .join("")
    .trim();
  if (!commentary || commentary.length > 500) {
    throw new Error("Gemini returned invalid commentary.");
  }
  return commentary;
};
