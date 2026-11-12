// Model prose is shown only if it makes no safety promise. Where the server computes the numbers
// (lunch sets, a single dish), prose that states money amounts is also dropped: prices come from code.
const UNSAFE = /allergen[\s-]*free|free (?:of|from) (?:all )?allergens|no allergens|guarantee|100\s?%|completely safe|safe (?:for|to eat)|certif|(?:nut|peanut|gluten|dairy|milk|lactose|egg|soy|sesame|shellfish|fish)[\s-]*free|does(?:n't| not) contain|without (?:any )?(?:nuts|peanuts|gluten|dairy|milk|eggs?|soy|sesame|shellfish|fish)|без аллерген|гарант|безопасн|не содерж/i;
const MONEY = /\bRM\s?\d|\d+(?:[.,]\d+)?\s?(?:ringgit|myr|rm\b|ринг)|ringgit|ринггит/i;

export function safeProse(text, { max = 320, allowMoney = false } = {}) {
  const t = String(text ?? "").replace(/[ \t]+/g, " ").trim();
  if (!t || t.length > max || UNSAFE.test(t) || (!allowMoney && MONEY.test(t))) return null;
  return t;
}
