// Shared by the browser (menu filters) and the server (lunch finder, AI context, offline recommender).
// Vegetarian and explicitly confirmed vegan are separate diet choices.

export const DIETS = ["any", "vegetarian", "vegan"];
export const ALLERGENS = ["peanuts", "tree nuts", "milk", "egg", "wheat/gluten", "soy", "fish", "shellfish", "sesame"];

export const ROLE_LABELS = {
  main: "Main dish",
  side: "Side / snack",
  drink: "Drink",
  dessert: "Dessert",
  addon: "Add-on",
  unknown: "Not sure it is a full meal",
};
export const BASE_LABELS = {
  rice: "Rice", noodles: "Noodles", pasta: "Pasta", flatbread: "Flatbread", bread: "Bread / bun", potato: "Potato",
};

// ---------- Money: always whole sen (1 RM = 100 sen) so 7.9 + 2.1 is exactly 1000 ----------

export function toSen(rm) {
  const n = typeof rm === "string" ? Number(rm.replace(",", ".")) : Number(rm);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

export const formatSen = (sen) => `RM${(sen / 100).toFixed(2)}`;

// Upper end of a price: a range or two board prices count at their highest value.
export function priceMaxOf(dish) {
  if (Number.isFinite(dish.priceMax)) return dish.priceMax;
  if (dish.price == null) return null;
  const prices = String(dish.priceText ?? "").match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return Math.max(dish.price, ...prices);
}

// Price usable under a hard budget: known, not estimated, upper bound, in sen. null = cannot be used.
export function budgetPriceSen(dish) {
  if (dish.price == null || dish.priceEstimated) return null;
  const max = priceMaxOf(dish);
  return max == null ? null : toSen(max);
}

// ---------- Spice ----------

// Spice is estimated on a 0-5 scale but shown simply: 0-1 not spicy, 2-3 a little, 4-5 very.
export const isSpicy = (dish) => (dish.spicy ?? 0) >= 2;

export function spiceNote(dish) {
  if ((dish.spicy ?? 0) >= 4) return "Very spicy";
  if (isSpicy(dish)) return "A little spicy";
  return null;
}

export function spiceLabel(dish) {
  if (!Number.isFinite(dish.spicy)) return "Spice unknown";
  if (dish.spicy >= 4) return "Very spicy";
  if (dish.spicy >= 2) return "A little spicy";
  return "Not spicy";
}

// Unknown spice never counts as "not spicy".
export const isNotSpicy = (dish) => Number.isFinite(dish.spicy) && dish.spicy <= 1;

// ---------- Diet and allergens ----------

export function fitsDiet(dish, diet) {
  if (diet === "vegan") return dish.vegan === true;
  if (diet === "vegetarian") return dish.vegetarian === true;
  return true;
}

// filter: "any" | "spicy" | "not-spicy"
export function fitsSpiceFilter(dish, filter) {
  if (filter === "spicy") return isSpicy(dish);
  if (filter === "not-spicy") return isNotSpicy(dish);
  return true;
}

export function fitsBudget(dish, budget) {
  if (budget == null) return true;
  const price = budgetPriceSen(dish);
  return price != null && price <= toSen(budget);
}

// Allergens are AI estimates from usual recipes, so this is a "likely contains" filter.
// Unknown allergens (null) never pass an exclusion.
export function avoidsAllergens(dish, avoid) {
  if (!avoid?.length) return true;
  return Array.isArray(dish.allergens) && !dish.allergens.some((a) => avoid.includes(a));
}

// prefs: { diet, avoidAllergens }
export function fitsPrefs(dish, prefs) {
  if (!prefs) return true;
  return fitsDiet(dish, prefs.diet) && avoidsAllergens(dish, prefs.avoidAllergens);
}
