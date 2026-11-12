// Downloads one illustrative photo per photo topic (dish type) from Wikimedia, with license info.
//   1. lead image of the English Wikipedia article (photoTitle from the importer), if it is a free
//      photo hosted on Wikimedia Commons (non-free and logo/diagram images are skipped)
//   2. otherwise the best Commons search result for photoQuery
// Saves public/photos/<photoKey>.jpg and data/photos.json (author, license, source page).
// Re-running only fetches topics that are new or were not found before (use --retry-missing).
//
// Usage: npm run photos
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PHOTOS_DIR = join(root, "public", "photos");
const INDEX = join(root, "data", "photos.json");
const WIDTH = 500; // a standard Wikimedia thumbnail width
const HEADERS = { "User-Agent": "APEats/0.1 (student hackathon prototype; campus food guide)" };
const retryMissing = process.argv.includes("--retry-missing");

const BAD_FILE = /(logo|menu|map|sign|stall|restaurant|shop|store|market|street|packag|label|poster|diagram|chart|cover|advert|vending|machine|factory|plant|tree|flower|field)/i;
const PHOTO_EXT = /\.(jpe?g|webp)$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripHtml = (html) => String(html ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

async function getJson(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: HEADERS });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      await sleep(4000 * (attempt + 1)); // Wikimedia rate limit: back off
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url.slice(0, 120)}`);
  }
  throw new Error(`Failed after retries: ${url.slice(0, 120)}`);
}

// Wikipedia article title -> lead image file name (follows redirects).
async function leadImages(titles) {
  const result = new Map();
  for (let s = 0; s < titles.length; s += 50) {
    const batch = titles.slice(s, s + 50);
    const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1&prop=pageimages&piprop=name&titles=${encodeURIComponent(batch.join("|"))}`;
    const data = await getJson(url);
    const alias = new Map();
    for (const n of data.query?.normalized ?? []) alias.set(n.to, n.from);
    for (const r of data.query?.redirects ?? []) alias.set(r.to, alias.get(r.from) ?? r.from);
    for (const page of data.query?.pages ?? []) {
      const original = alias.get(page.title) ?? page.title;
      if (page.pageimage) result.set(original, { file: page.pageimage, article: page.title });
    }
  }
  return result;
}

// File names -> Commons image info (missing for non-free files that live only on Wikipedia).
async function commonsInfo(files) {
  const result = new Map();
  for (let s = 0; s < files.length; s += 50) {
    const batch = files.slice(s, s + 50).map((f) => `File:${f}`);
    const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&prop=imageinfo&iiprop=url|extmetadata|size|mime&iiurlwidth=${WIDTH}&titles=${encodeURIComponent(batch.join("|"))}`;
    const data = await getJson(url);
    const alias = new Map((data.query?.normalized ?? []).map((n) => [n.to, n.from]));
    for (const page of data.query?.pages ?? []) {
      const info = page.imageinfo?.[0];
      if (!info || page.missing) continue;
      const original = (alias.get(page.title) ?? page.title).replace(/^File:/, "");
      result.set(original, describe(page.title, info));
    }
  }
  return result;
}

function describe(title, info) {
  const meta = info.extmetadata ?? {};
  return {
    file: title.replace(/^File:/, ""),
    mime: info.mime,
    width: info.width,
    height: info.height,
    thumb: info.thumburl,
    page: info.descriptionurl,
    author: stripHtml(meta.Artist?.value) || "Unknown author",
    license: stripHtml(meta.LicenseShortName?.value) || "See source",
    licenseUrl: meta.LicenseUrl?.value ?? null,
    nonFree: /non-free|fair use/i.test(meta.LicenseShortName?.value ?? "") || meta.NonFree?.value === "true",
  };
}

function usable(c) {
  if (!c || c.nonFree || !c.thumb) return false;
  if (!/image\/(jpeg|webp)/.test(c.mime) || !PHOTO_EXT.test(c.file)) return false;
  if (c.width < 400 || c.height < 300) return false;
  const ratio = c.width / c.height;
  return ratio > 0.6 && ratio < 2 && !BAD_FILE.test(c.file);
}

// Search results are noisy (buildings, engravings, packaging), so the file name must mention a
// specific word of the query - "udon", "katsu", "sambal" - not just "chicken" or "rice".
const GENERIC = new Set(["chicken", "rice", "fish", "fried", "with", "and", "soup", "noodle", "noodles", "set", "spicy",
  "sauce", "egg", "hot", "iced", "drink", "plate", "dish", "food", "meal", "style", "the", "of", "a", "in", "beef", "fillet"]);
const OLD_PICTURE = /\b1[5-8]\d\d\b|\b19[0-4]\d\b|engraving|illustration|drawing|lithograph/i;

function matchesQuery(fileName, query) {
  const name = fileName.toLowerCase().replace(/[_\-.]/g, " ");
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const specific = words.filter((w) => !GENERIC.has(w));
  if (specific.length) return specific.some((w) => name.includes(w));
  return words.filter((w) => name.includes(w)).length >= Math.min(2, words.length);
}

async function searchCommons(query, skipFiles = []) {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&generator=search&gsrnamespace=6&gsrlimit=15&gsrsearch=${encodeURIComponent(`${query} filetype:bitmap`)}&prop=imageinfo&iiprop=url|extmetadata|size|mime&iiurlwidth=${WIDTH}`;
  const data = await getJson(url);
  const pages = (data.query?.pages ?? []).sort((a, b) => a.index - b.index);
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    const candidate = describe(page.title, info);
    if (skipFiles.includes(candidate.file)) continue;
    if (usable(candidate) && matchesQuery(candidate.file, query) && !OLD_PICTURE.test(candidate.file)) return candidate;
  }
  return null;
}

async function download(url, path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: HEADERS });
    if (res.ok) {
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      return true;
    }
    await sleep(1500 * (attempt + 1));
  }
  return false;
}

// ---------- Main ----------

const { dishes } = JSON.parse(readFileSync(join(root, "data", "dishes.json"), "utf8"));
const index = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, "utf8")) : {};
mkdirSync(PHOTOS_DIR, { recursive: true });

// --reject key1,key2 : a reviewed photo is wrong for its dish. Its file is never chosen again for
// that topic and a replacement is searched (or the item shows a placeholder).
const rejectArg = process.argv.indexOf("--reject");
if (rejectArg > 0) {
  for (const key of (process.argv[rejectArg + 1] ?? "").split(",").filter(Boolean)) {
    const entry = index[key];
    if (!entry?.file) {
      console.warn(`  --reject: no photo for "${key}"`);
      continue;
    }
    rmSync(join(PHOTOS_DIR, entry.file), { force: true });
    index[key] = { missing: true, rejectedFiles: [...(entry.rejectedFiles ?? []), entry.original] };
    console.log(`  rejected ${key} (${entry.original})`);
  }
}

const topics = new Map();
for (const d of dishes) {
  if (!d.photoKey || topics.has(d.photoKey)) continue;
  topics.set(d.photoKey, { key: d.photoKey, title: d.photoTitle, query: d.photoQuery ?? d.name, file: d.photoFile });
}
const todo = [...topics.values()].filter((t) => {
  const entry = index[t.key];
  if (t.file) return entry?.original !== t.file || !existsSync(join(PHOTOS_DIR, `${t.key}.jpg`)); // hand-picked file
  if (entry?.blocked) return false; // reviewed: no fitting free photo, keep the placeholder
  if (entry?.file && existsSync(join(PHOTOS_DIR, `${t.key}.jpg`))) return false;
  return !entry || (entry.missing && (retryMissing || entry.rejectedFiles)) || entry.file;
});
console.log(`Photo topics: ${topics.size}, to fetch: ${todo.length}`);

// 1. Wikipedia lead images
const titles = [...new Set(todo.map((t) => t.title).filter(Boolean))];
const leads = titles.length ? await leadImages(titles) : new Map();
const leadInfo = leads.size ? await commonsInfo([...new Set([...leads.values()].map((l) => l.file))]) : new Map();
const fixedFiles = todo.map((t) => t.file).filter(Boolean);
const fixedInfo = fixedFiles.length ? await commonsInfo([...new Set(fixedFiles)]) : new Map();

let fetched = 0;
let missing = 0;
for (const [n, topic] of todo.entries()) {
  let chosen = null;
  let via = null;
  const rejected = index[topic.key]?.rejectedFiles ?? [];
  const lead = topic.title ? leads.get(topic.title) : null;
  const fixed = topic.file ? fixedInfo.get(topic.file) : null;
  if (topic.file) {
    if (fixed && !fixed.nonFree) {
      chosen = fixed;
      via = `hand-picked:${topic.file}`;
    } else console.warn(`  ${topic.key}: hand-picked file not found or not free: ${topic.file}`);
  } else if (lead && usable(leadInfo.get(lead.file)) && !rejected.includes(lead.file)) {
    chosen = leadInfo.get(lead.file);
    via = `wikipedia:${lead.article}`;
  } else {
    try {
      chosen = await searchCommons(topic.query, rejected);
      via = chosen ? `commons-search:${topic.query}` : null;
    } catch (error) {
      console.warn(`  ${topic.key}: search failed (${error.message.slice(0, 60)})`);
    }
    await sleep(1000);
  }

  const keep = rejected.length ? { rejectedFiles: rejected } : {};
  if (!chosen) {
    index[topic.key] = { missing: true, title: topic.title, query: topic.query, ...keep };
    missing++;
    continue;
  }
  const ok = await download(chosen.thumb, join(PHOTOS_DIR, `${topic.key}.jpg`));
  if (!ok) {
    index[topic.key] = { missing: true, title: topic.title, query: topic.query, error: "download failed", ...keep };
    missing++;
    continue;
  }
  index[topic.key] = {
    ...keep,
    file: `${topic.key}.jpg`,
    via,
    source: chosen.page,
    original: chosen.file,
    author: chosen.author.slice(0, 120),
    license: chosen.license,
    licenseUrl: chosen.licenseUrl,
  };
  fetched++;
  if ((n + 1) % 25 === 0) {
    console.log(`  ${n + 1}/${todo.length}…`);
    writeFileSync(INDEX, JSON.stringify(index, null, 1));
  }
  await sleep(150);
}

writeFileSync(INDEX, JSON.stringify(index, null, 1));
const withPhoto = dishes.filter((d) => index[d.photoKey]?.file).length;
console.log(`Fetched ${fetched}, not found ${missing}. Items with a photo: ${withPhoto}/${dishes.length}.`);
