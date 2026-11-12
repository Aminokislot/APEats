// AI layer for "Find my lunch". The model never sees items that break the rules: it receives sets that
// lib/lunch.js has already built and checked, picks up to three and explains them in plain words.
// Its answer is checked again: unknown IDs, changed pairs, duplicates or a wrong total reject the whole
// AI answer, and the rules-only result is shown with an honest label. Prices always come from code.
import { generateJson, hasGeminiKey } from "./gemini.js";
import { askEnterpriseJson, isLunchAnswer } from "./enterprise.js";
import { buildCandidates, pickDiverse, optionOut, planLunch, MAX_OPTIONS, WEEKDAY_NAMES } from "./lunch.js";
import { BASE_LABELS, budgetPriceSen, formatSen, spiceLabel, toSen } from "../public/shared/filters.js";
import { safeProse } from "./prose.js";

export { safeProse };

export const LUNCH_INSTRUCTIONS = `You are APEats, a lunch guide for new and international students at APU (Malaysia).
All listed food outlets serve halal food.

You receive LUNCH SETS. The APEats server has already checked every set against the student's budget, diet,
allergen exclusions, spice choice, day and availability, and computed every price. You do not need to check them.

Choose up to 3 sets a newcomer would enjoy. Give variety (different counters or different kinds of dish) when you can.
When other things are equal, prefer a set bought at one counter.

Rules:
- Use mainId and drinkId exactly as a listed pair. drinkId is "" when the listed set has no drink.
- totalRm must equal the listed total of that set.
- why: one or two short plain-English sentences: what the dish is (from its description) and why it suits the request.
  Do not mention prices or ringgit amounts, calories, portion size, or ingredients that are not in the description.
  Never say a dish is allergen-free, safe or guaranteed.
- intro: one short sentence without prices.
Return only JSON: {"intro": "...", "options": [{"mainId": "...", "drinkId": "...", "totalRm": 0, "why": "..."}]}`;

const LUNCH_SCHEMA = {
  type: "OBJECT",
  properties: {
    intro: { type: "STRING" },
    options: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { mainId: { type: "STRING" }, drinkId: { type: "STRING" }, totalRm: { type: "NUMBER" }, why: { type: "STRING" } },
        required: ["mainId", "drinkId", "totalRm", "why"],
      },
    },
  },
  required: ["intro", "options"],
};

export const currentProvider = () => process.env.AI_PROVIDER || (hasGeminiKey() ? "gemini" : "offline");


function requestLine(req) {
  const parts = [`budget ${formatSen(req.budgetSen)}`, `spice: ${req.spice === "not-spicy" ? "not spicy" : "any"}`,
    `drink: ${req.withDrink ? "wanted" : "not wanted"}`, `day: ${WEEKDAY_NAMES[req.weekday]}`];
  if (req.prefs.diet !== "any") parts.push(`diet: ${req.prefs.diet}`);
  if (req.prefs.avoidAllergens.length) parts.push(`avoid: ${req.prefs.avoidAllergens.join(", ")}`);
  return parts.join("; ");
}

export function lunchContext(combos, req) {
  const lines = combos.map((c) => {
    const main = [c.main.id, c.main.name, c.main.cuisine, formatSen(budgetPriceSen(c.main)), BASE_LABELS[c.main.base] ?? "-",
      spiceLabel(c.main), (c.main.blurb ?? c.main.description ?? "").slice(0, 110)].join(" | ");
    const drink = c.drink
      ? `drink: ${c.drink.id} | ${c.drink.name} | ${formatSen(budgetPriceSen(c.drink))} | ${c.drink.stallId === c.main.stallId ? "same counter" : "other counter"}`
      : "drink: \"\"";
    return `${main} || ${drink} || total ${formatSen(c.totalSen)}`;
  });
  return `REQUEST: ${requestLine(req)}\nLUNCH SETS (mainId | name | counter | price | base | spice | description || drink || total):\n${lines.join("\n")}`;
}

// Checks the model's choice against the sets it was given. Returns {ok, picks, intro} or {ok:false, reason}.
export function validateLunchAnswer(data, combos) {
  if (!data || !Array.isArray(data.options) || !data.options.length || data.options.length > MAX_OPTIONS) {
    return { ok: false, reason: "bad_shape" };
  }
  const byMain = new Map(combos.map((c) => [c.main.id, c]));
  const seen = new Set();
  const picks = [];
  for (const o of data.options) {
    const combo = byMain.get(String(o?.mainId ?? ""));
    if (!combo) return { ok: false, reason: "unknown_id" };
    if (seen.has(combo.main.id)) return { ok: false, reason: "duplicate" };
    seen.add(combo.main.id);
    const drinkId = o.drinkId == null ? "" : String(o.drinkId);
    if (drinkId !== (combo.drink?.id ?? "")) return { ok: false, reason: combo.drink && !drinkId ? "drink_missing" : "unknown_id" };
    if (toSen(o.totalRm) !== combo.totalSen) return { ok: false, reason: "total_mismatch" };
    picks.push({ combo, why: safeProse(o.why) });
  }
  return { ok: true, picks, intro: safeProse(data.intro, { max: 240 }) };
}

async function askModel(provider, context) {
  if (provider === "enterprise") {
    return askEnterpriseJson({ query: `${LUNCH_INSTRUCTIONS}\n\nUse your connected APEats menu source only to describe dishes; choose only from these sets.\n${context}`, isValid: isLunchAnswer });
  }
  const { data, model } = await generateJson({
    system: LUNCH_INSTRUCTIONS,
    contents: [{ role: "user", parts: [{ text: context }] }],
    schema: LUNCH_SCHEMA,
    temperature: 0.4,
  });
  return { ...data, model };
}

// mode "swap" (replace one option) uses rules only: fast and deterministic.
export async function findLunch({ menu, req, mode = "full" }) {
  const stallsById = Object.fromEntries(menu.stalls.map((s) => [s.id, s]));
  const rules = planLunch(menu, req);
  const base = { options: rules.options, empty: rules.empty, intro: null };
  if (!rules.options.length || mode === "swap") return { ...base, source: "rules" };
  const provider = currentProvider();
  if (provider === "offline" || (provider === "gemini" && !hasGeminiKey())) return { ...base, source: "offline" };

  const { combos } = buildCandidates(menu.dishes, req);
  const shortlist = pickDiverse(combos, 40);
  try {
    const answer = await askModel(provider, lunchContext(shortlist, req));
    const checked = validateLunchAnswer(answer, shortlist);
    if (!checked.ok) {
      console.warn(`[lunch] AI answer rejected: ${checked.reason}`);
      return { ...base, source: "rules", warning: "ai_rejected", aiProblem: checked.reason };
    }
    return {
      options: checked.picks.map((p) => optionOut(p.combo, req, stallsById, p.why, provider)),
      empty: null,
      intro: checked.intro,
      source: provider,
      model: answer.model,
    };
  } catch (error) {
    console.warn(`[lunch] AI unavailable: ${String(error.message).slice(0, 80)}`);
    return { ...base, source: "rules", warning: "ai_unavailable" };
  }
}
