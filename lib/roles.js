// Explicit item roles for the lunch finder: is this a main dish, a side, a drink...?
// Defaults come from the menu-board section (source `category`). Hand-made decisions for single
// items live in data/menu-overrides.json, which the import applies after these defaults, so a
// re-import never loses them. Ambiguous items stay "unknown" instead of being promoted to "main".

export { ROLE_LABELS, BASE_LABELS } from "../public/shared/filters.js";

export const ROLES = ["main", "side", "drink", "dessert", "addon", "unknown"];

// Menu-board section -> role, with the reason shown in the classification report.
const SECTION_ROLES = {
  main: {
    basis: "Menu section of plated rice, noodle, bread or pasta meals",
    sections: ["rice", "rice_with_egg", "mixed_rice", "nasi_lemak", "fried_rice", "katsu_rice", "grilled_chicken_rice",
      "stir_fried_rice", "cheese_baked_rice", "chicken_rice", "noodles", "fried_noodles", "pan_mee", "bento", "sushi",
      "burger_board", "hotdog_board", "grab_n_go", "wrap", "quesadilla", "sandwich", "fish_and_chips", "chicken_chop",
      "western_main", "main"],
  },
  side: {
    basis: "Menu section of small plates, single pieces or snacks",
    sections: ["snack", "appetiser", "side", "salad", "oden", "temaki", "separate_dish", "toast_and_egg", "roti",
      "naan_and_tandoori", "capati", "tosai", "rice_cakes", "breakfast"],
  },
  addon: { basis: "Menu section of add-ons and toppings", sections: ["add_on", "food_add_on", "topping"] },
  dessert: { basis: "Menu section of desserts", sections: ["dessert"] },
  unknown: {
    basis: "Section mixes meals and single dishes; needs an item-level decision",
    sections: ["ready_counter", "prepared_dish", "korean_section", "soup", "ayam_kunyit"],
  },
};
const ROLE_OF_SECTION = Object.fromEntries(
  Object.entries(SECTION_ROLES).flatMap(([role, { sections }]) => sections.map((s) => [s, role])),
);

export function defaultRole(item) {
  if (item.category === "Drinks") return { role: "drink", basis: "Listed among the drinks on the menu board" };
  const role = ROLE_OF_SECTION[item.subcategory];
  if (role) return { role, basis: SECTION_ROLES[role].basis + ` (${item.subcategory})` };
  return { role: "unknown", basis: `No rule for menu section "${item.subcategory ?? "none"}"` };
}

// What the meal is built on, from the name and the menu section. Shown as "base"; null = not clear.
const BASES = [
  ["pasta", /\b(pasta|penne|aglio|carbonara|bolognese|macaroni|mac & cheese)\b/i],
  ["noodles", /noodle|\bmee\b|mee\b|\bmie\b|udon|ramen|kuey|koay|kuew|teow|mihun|mee ?hoon|meehoon|maggi|indomee|laksa|\byee\b|dan hor/i],
  ["rice", /\brice\b|\bnasi\b|briyani|biryani|\bdon\b|bento|sushi|temaki|mandy|makhlouba/i],
  ["flatbread", /\broti\b|naan|capati|chapati|tosai|puri|lebanese bread|arayes|tortilla|wrap|quesadilla|shawarma — lebanese/i],
  ["bread", /\bbread\b|burger|hotdog|sandwich|toast|ciabatta/i],
  ["potato", /fries|wedges|potato|hash ?brown|shepherd|\bchips?\b/i],
];
const SECTION_BASE = {
  rice: "rice", rice_with_egg: "rice", mixed_rice: "rice", nasi_lemak: "rice", fried_rice: "rice", katsu_rice: "rice",
  grilled_chicken_rice: "rice", stir_fried_rice: "rice", cheese_baked_rice: "rice", chicken_rice: "rice", bento: "rice",
  sushi: "rice", temaki: "rice", noodles: "noodles", fried_noodles: "noodles", pan_mee: "noodles",
  burger_board: "bread", hotdog_board: "bread", grab_n_go: "bread", sandwich: "bread",
  wrap: "flatbread", quesadilla: "flatbread", roti: "flatbread", capati: "flatbread", tosai: "flatbread", rice_cakes: "rice",
};
// Oden pieces have names like "Fish Sandwich" (a fish cake); the name says nothing about a base.
const NO_BASE_SECTIONS = new Set(["oden", "dessert", "topping"]);

export function baseOf(item) {
  if (item.category === "Drinks" || NO_BASE_SECTIONS.has(item.subcategory)) return null;
  for (const [base, re] of BASES) if (re.test(item.name)) return base;
  return SECTION_BASE[item.subcategory] ?? null;
}

