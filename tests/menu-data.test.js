// Menu data: the real generated menu is valid, roles are conservative, and the documented update
// workflow (import -> report -> backup -> rollback) works on a copy of the data.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMenu, validateMenu } from "../lib/menu-data.js";
import { normalizeLunchRequest, buildCandidates } from "../lib/lunch.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const publicDir = join(root, "public");
const clock = { weekday: 1, hour: 12, minute: 0 };

test("the project menu passes validation and keeps items without a photo", () => {
  const menu = loadMenu({ dataDir: join(root, "data"), publicDir });
  assert(menu.dishes.length > 0);
  assert.deepEqual(validateMenu({ stalls: menu.stalls, dishes: menu.dishes }).errors, []);
  const noPhoto = menu.dishes.filter((d) => !d.photo);
  assert(noPhoto.length > 0, "items without an illustration are still served");
  assert(noPhoto.some((d) => d.role === "main"), "and can be suggested as lunch");
  assert.equal(menu.meta.counts.items, menu.dishes.length);
});

test("roles in the project menu are conservative", () => {
  const { dishes } = loadMenu({ dataDir: join(root, "data"), publicDir });
  const byId = new Map(dishes.map((d) => [d.id, d]));
  for (const d of dishes) {
    if (["add_on", "food_add_on", "topping"].includes(d.subcategory)) assert.equal(d.role, "addon", d.id);
    if (d.category === "Drinks") assert.equal(d.role, "drink", d.id);
    if (d.role === "main") assert.notEqual(d.category, "Drinks", d.id);
    assert.ok(d.roleBasis, `${d.id} has a recorded reason`);
  }
  assert.equal(byId.get("kopitiam--ad01").role, "addon", "White Rice is an add-on");
  assert.equal(byId.get("asian--se_m17").role, "addon", "Plain Rice at the counter is an add-on");
  assert.equal(byId.get("asian--se_m04").role, "side", "a piece of counter fried chicken is not a meal");
  assert.equal(byId.get("asian--se_m02").role, "main", "rice + chicken + vegetable is a meal");
  assert.equal(byId.get("western--ct05").role, "unknown", "unclear counter item stays unknown");
  assert.equal(byId.get("chinese--x_d01").priceEstimated, true, "team-estimated can price is not exact");
  const report = JSON.parse(readFileSync(join(root, "data", "import-report.json"), "utf8"));
  for (const d of dishes.filter((x) => x.role === "unknown")) assert(report.disputed.some((x) => x.id === d.id), `${d.id} is listed as disputed`);
});

function copyData() {
  const dir = mkdtempSync(join(tmpdir(), "apeats-menu-"));
  cpSync(join(root, "data"), dir, { recursive: true, filter: (src) => !/[\\/](backups|votes\.json)/.test(src.slice(join(root, "data").length)) });
  return dir;
}
const run = (script, dir) => spawnSync(process.execPath, [join(root, "tools", script), "--no-ai", "--data-dir", dir], { encoding: "utf8", env: { ...process.env, GEMINI_API_KEY: "" } });
const sourcePath = (dir) => join(dir, "source", readdirSync(join(dir, "source")).find((f) => f.endsWith(".json")));
function setSourcePrice(dir, cuisine, id, price) {
  const path = sourcePath(dir);
  const json = JSON.parse(readFileSync(path, "utf8"));
  const item = json.menus.find((m) => m.cuisine === cuisine).items.find((i) => i.id === id);
  item.price_rm = price;
  writeFileSync(path, JSON.stringify(json));
}
const dishIn = (dir, id) => JSON.parse(readFileSync(join(dir, "dishes.json"), "utf8")).dishes.find((d) => d.id === id);

test("13. a price change in the source reaches the lunch finder after the documented update; a bad update changes nothing; rollback restores", () => {
  const dir = copyData();
  try {
    const id = "chinese--n1"; // Cantonese Kuey Teow Meehoon, RM10.00 on the board, no illustration
    const before = dishIn(dir, id);
    assert.equal(before.price, 10);

    // 1. Change the price in the single source file and run the normal import.
    setSourcePrice(dir, "Chinese", "N1", 11.5);
    const ok = run("import-menu.js", dir);
    assert.equal(ok.status, 0, ok.stderr);
    const after = dishIn(dir, id);
    assert.equal(after.price, 11.5);
    assert.equal(after.priceText, "RM11.50");
    assert.equal(after.blurb, before.blurb, "a price change keeps the description");
    assert.deepEqual(after.allergens, before.allergens, "and the allergen estimate");
    const report = JSON.parse(readFileSync(join(dir, "import-report.json"), "utf8"));
    const change = report.changes.changed.find((c) => c.id === id);
    assert.deepEqual(change.fields.price, [10, 11.5]);
    assert.equal(report.changes.added.length, 0);
    assert.equal(report.changes.removed.length, 0);
    assert.equal(readdirSync(join(dir, "backups")).length, 1, "previous version was backed up");

    // 2. The lunch finder uses the new price.
    const menu = loadMenu({ dataDir: dir, publicDir });
    const combos = (budget) => buildCandidates(menu.dishes, normalizeLunchRequest({ budget, withDrink: false, prefs: {} }, clock)).combos;
    assert.equal(combos(11.5).find((c) => c.main.id === id)?.totalSen, 1150);
    assert.equal(combos(11).find((c) => c.main.id === id), undefined, "no longer fits RM11");

    // 3. A broken source is refused and the served menu is untouched.
    const served = readFileSync(join(dir, "dishes.json"), "utf8");
    setSourcePrice(dir, "Chinese", "N2", -3);
    const bad = run("import-menu.js", dir);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /price_rm must be a positive number/);
    assert.match(bad.stderr, /Nothing was written/);
    assert.equal(readFileSync(join(dir, "dishes.json"), "utf8"), served);

    // 4. Rollback restores the menu from before the price change.
    const back = run("menu-rollback.js", dir);
    assert.equal(back.status, 0, back.stderr);
    assert.equal(dishIn(dir, id).price, 10);
    assert(existsSync(join(dir, "backups")) && readdirSync(join(dir, "backups")).some((f) => f.endsWith("before-rollback")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid generated data is refused when the server loads it", () => {
  const dir = copyData();
  try {
    const file = JSON.parse(readFileSync(join(dir, "dishes.json"), "utf8"));
    file.dishes[0].role = "meal";
    file.dishes[1].id = file.dishes[2].id;
    writeFileSync(join(dir, "dishes.json"), JSON.stringify(file));
    assert.throws(() => loadMenu({ dataDir: dir, publicDir }), /Menu data is invalid.*menu:rollback/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
