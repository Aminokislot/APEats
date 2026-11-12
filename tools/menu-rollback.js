// Restores the previous menu (dishes.json, stalls.json, import-report.json) from data/backups/.
// The backup is validated first; the current files are themselves backed up before being replaced.
//
// Usage: npm run menu:rollback                      (latest backup)
//        npm run menu:rollback -- --list            (show backups)
//        npm run menu:rollback -- --to <folder>     (a specific backup)
//        npm run menu:rollback -- --data-dir <dir>  (another data folder, used by tests)
import { readFileSync, readdirSync, existsSync, copyFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateMenu } from "../lib/menu-data.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
};
const DATA = resolve(option("--data-dir") ?? join(root, "data"));
const BACKUPS = join(DATA, "backups");
const FILES = ["dishes.json", "stalls.json", "import-report.json"];

const backups = existsSync(BACKUPS) ? readdirSync(BACKUPS).filter((f) => /^\d{4}-/.test(f)).sort() : [];
if (args.includes("--list")) {
  if (!backups.length) console.log("No backups yet.");
  for (const b of backups) {
    const report = existsSync(join(BACKUPS, b, "import-report.json")) ? JSON.parse(readFileSync(join(BACKUPS, b, "import-report.json"), "utf8")) : null;
    console.log(`${b}  ${report ? `menu imported ${report.importedAt}, ${report.counts?.items ?? "?"} items` : "(no report)"}`);
  }
  process.exit(0);
}

const chosen = option("--to") ?? backups.filter((b) => !b.includes("before-rollback")).at(-1);
if (!chosen || !existsSync(join(BACKUPS, chosen, "dishes.json"))) {
  console.error(`No usable backup${chosen ? ` "${chosen}"` : ""} in ${BACKUPS}. Nothing changed.`);
  process.exit(1);
}

const read = (name) => JSON.parse(readFileSync(join(BACKUPS, chosen, name), "utf8"));
const { errors } = validateMenu({ stalls: read("stalls.json").stalls, dishes: read("dishes.json").dishes });
if (errors.length) {
  console.error(`Backup ${chosen} is not valid (${errors.slice(0, 3).join("; ")}). Nothing changed.`);
  process.exit(1);
}

const safety = join(BACKUPS, `${new Date().toISOString().replace(/[:.]/g, "-")}-before-rollback`);
mkdirSync(safety, { recursive: true });
for (const f of FILES) if (existsSync(join(DATA, f))) copyFileSync(join(DATA, f), join(safety, f));
for (const f of FILES) {
  if (!existsSync(join(BACKUPS, chosen, f))) continue;
  copyFileSync(join(BACKUPS, chosen, f), join(DATA, `${f}.tmp`));
  renameSync(join(DATA, `${f}.tmp`), join(DATA, f));
}
console.log(`Restored the menu from backups/${chosen}. The replaced version is in backups/${safety.split(/[\\/]/).at(-1)}.`);
console.log("Restart the server to serve the restored menu.");
