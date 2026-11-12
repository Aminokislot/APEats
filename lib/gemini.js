// Small Gemini client (REST, no SDK) with a model fallback chain.
// Busy (503), rate-limited (429), retired (404) or slow models are skipped in order, and a
// model that just failed is tried last for COOLDOWN_MS so requests don't wait on it again.

// gemini-2.5-flash is closed to new API keys (Nov 2026). On the free tier (6 Nov 2026)
// gemini-3.8-flash and gemini-flash-latest were mostly overloaded (503/timeouts), while
// 3.5-flash and 3.1-flash-lite answered reliably - so they go first. Override with GEMINI_MODEL.
export const DEFAULT_MODEL = "gemini-3.5-flash";
const DEFAULT_FALLBACKS = "gemini-3.1-flash-lite,gemini-3.8-flash,gemini-flash-latest";
const COOLDOWN_MS = 2 * 60 * 1000;
const RETRYABLE_STATUS = [404, 429, 500, 502, 503, 504];

const coolingUntil = new Map();

export const hasGeminiKey = () => Boolean(process.env.GEMINI_API_KEY);

function modelChain() {
  const primary = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const fallbacks = (process.env.GEMINI_FALLBACK_MODELS ?? DEFAULT_FALLBACKS).split(",").map((m) => m.trim());
  const chain = [...new Set([primary, ...fallbacks].filter(Boolean))];
  const now = Date.now();
  return [...chain.filter((m) => !(coolingUntil.get(m) > now)), ...chain.filter((m) => coolingUntil.get(m) > now)];
}

async function callModel({ model, system, contents, schema, temperature, timeoutMs }) {
  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { temperature, responseMimeType: "application/json", responseSchema: schema },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (error) {
    throw Object.assign(new Error(`network/timeout: ${error.message}`), { retryable: true });
  }

  if (!response.ok) {
    await response.text();
    const error = new Error(`Gemini HTTP ${response.status}`);
    error.retryable = RETRYABLE_STATUS.includes(response.status);
    throw error;
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Gemini returned non-JSON"), { retryable: true });
  }
}

/**
 * Ask Gemini for JSON matching `schema`. Returns { data, model }.
 * contents: Gemini "contents" array (user/model turns).
 */
export async function generateJson({ system, contents, schema, temperature = 0.4, timeoutMs = 12000, budgetMs = 20000 }) {
  if (!hasGeminiKey()) throw new Error("GEMINI_API_KEY is not set");
  let lastError;
  const deadline = Date.now() + budgetMs;
  for (const model of modelChain()) {
    if (Date.now() >= deadline) break;
    try {
      const data = await callModel({ model, system, contents, schema, temperature, timeoutMs: Math.min(timeoutMs, Math.max(1,deadline-Date.now())) });
      coolingUntil.delete(model);
      return { data, model };
    } catch (error) {
      lastError = error;
      if (!error.retryable) throw error;
      coolingUntil.set(model, Date.now() + COOLDOWN_MS);
      console.warn(`[gemini] ${model} unavailable (${error.message.split("\n")[0].slice(0, 60)}), trying next model`);
    }
  }
  throw lastError;
}
