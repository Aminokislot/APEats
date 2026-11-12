// APEats server: static web app + JSON API (Node 22+).
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./lib/env.js";
import { campusClock } from "./lib/clock.js";
import { recommend, DEFAULT_MODEL } from "./lib/recommend.js";
import { createVotes } from "./lib/votes.js";
import { createFirestoreVotes } from "./lib/firestore-votes.js";
import { normalizePrefs, constraintsFor, hasState, dishNameIndex } from "./lib/constraints.js";
import { normalizeSelectedLunch, lunchConstraints } from "./lib/lunch-context.js";
import { loadMenu } from "./lib/menu-data.js";
import { normalizeLunchRequest, budgetPresets, RequestError } from "./lib/lunch.js";
import { findLunch } from "./lib/lunch-ai.js";
import { enterpriseConfigured, enterpriseEndpoint } from "./lib/enterprise.js";

const root = dirname(fileURLToPath(import.meta.url));
loadEnv(join(root, ".env"));

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = join(root, "public");

// DATA_DIR lets tests run against a copy of the data. The menu is validated at start: invalid data is refused.
const DATA_DIR = process.env.DATA_DIR || join(root, "data");
const menu = loadMenu({ dataDir: DATA_DIR, publicDir: PUBLIC_DIR });
const { stalls, dishes, allDishes } = menu;
const generatedAt = menu.meta.generatedAt;
const menuMeta = { ...menu.meta, lunch: budgetPresets(dishes) };
const dishNames = dishNameIndex(dishes);
const storage=process.env.VOTE_STORAGE || 'local';
if (process.env.K_SERVICE && storage!=='firestore') throw new Error('Cloud Run requires VOTE_STORAGE=firestore for durable votes');
if (!['local','firestore'].includes(storage)) throw new Error('Unknown VOTE_STORAGE');
if (!['gemini','enterprise','offline'].includes(process.env.AI_PROVIDER || 'gemini')) throw new Error('Unknown AI_PROVIDER');
if (process.env.AI_PROVIDER === 'enterprise') enterpriseEndpoint();
const votes = storage==='firestore'
  ? createFirestoreVotes({projectId:process.env.GOOGLE_CLOUD_PROJECT,stallIds:stalls.map(s=>s.id),database:process.env.FIRESTORE_DATABASE || '(default)'})
  : createVotes({path:process.env.VOTES_FILE || join(DATA_DIR,'votes.json'),stallIds:stalls.map(s=>s.id)});

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".webmanifest": "application/manifest+json",
};

// Per-client rate limits: protect the Gemini key (12 questions/min) and the poll (40 votes/min).
const rateLogs = { ask: new Map(), lunch: new Map(), vote: new Map() };
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const log of Object.values(rateLogs)) for (const [client, times] of log) {
    if (!times.some(t=>t>cutoff)) log.delete(client);
  }
}, 60000).unref();
function allow(kind, client, perMinute) {
  const now = Date.now();
  const log = rateLogs[kind];
  const recent = (log.get(client) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= perMinute) return false;
  recent.push(now);
  log.set(client, recent);
  return true;
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024) throw new Error("Body too large");
    chunks.push(chunk);
  }
  const body=chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  if (!body || typeof body!=='object' || Array.isArray(body)) throw new Error('Expected a JSON object');
  return body;
}

const clientOf = (req) => ((process.env.TRUST_PROXY === "true" ? req.headers["x-forwarded-for"]?.split(",")[0] : null) ?? req.socket.remoteAddress ?? "?").trim();

async function handleApi(req, res, path) {
  const clock = campusClock();
  if(req.method==='POST') {
    if(!String(req.headers['content-type']??'').startsWith('application/json')) return send(res,415,{error:'Expected application/json'});
    if(req.headers.origin && new URL(req.headers.origin).host!==req.headers.host) return send(res,403,{error:'Cross-origin request denied'});
  }

  if (req.method === "GET" && path === "/api/status") {
    return send(res, 200, { gemini: Boolean(process.env.GEMINI_API_KEY), provider:process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY?'gemini':'offline'), enterpriseConfigured:enterpriseConfigured(), storage, menuVersion:generatedAt, menuSourceDate:menu.meta.sourceCompiledOn, clock });
  }
  if (req.method === "GET" && path === "/api/menu") {
    return send(res, 200, { stalls, dishes, meta: menuMeta });
  }
  if (req.method === "POST" && path === "/api/lunch") {
    if (!allow("lunch", clientOf(req), 20)) return send(res, 429, { error: "Too many requests, wait a minute" });
    const body = await readBody(req);
    let request;
    try { request = normalizeLunchRequest(body, clock); }
    catch (error) { if (error instanceof RequestError) return send(res, 400, { error: error.message }); throw error; }
    const result = await findLunch({ menu, req: request, mode: body.mode === "swap" ? "swap" : "full" });
    return send(res, 200, {
      ...result,
      request: { budgetSen: request.budgetSen, spice: request.spice, withDrink: request.withDrink, usePrefs: request.usePrefs, prefs: request.prefs, weekday: request.weekday, isToday: request.weekday === clock.weekday },
      menuVersion: generatedAt,
    });
  }
  if (req.method === "POST" && path === "/api/ask") {
    if (!allow("ask", clientOf(req), 12)) return send(res, 429, { error: "Too many questions, wait a minute" });
    const body = await readBody(req);
    const message = String(body.message ?? "").trim().slice(0, 500);
    if (!message) return send(res, 400, { error: "Empty message" });
    const history = Array.isArray(body.history) ? body.history.filter(t=>t && ["user","model"].includes(t.role) && typeof t.text==="string").slice(-8).map(t=>({role:t.role,text:t.text.slice(0,1000)})) : [];
    // A selected lunch arrives as IDs and choices only; names, prices and totals are rebuilt from our menu.
    const selected = normalizeSelectedLunch(body.lunch, { dishes, stalls }, clock, generatedAt);
    const lunch = selected?.ok ? selected.lunch : null;
    // While a lunch is discussed, its own preference choice applies ("Use my saved preferences" may be off).
    const prefs = lunch ? lunch.prefs : normalizePrefs(body.prefs);
    const previous = hasState(body.conversationConstraints) ? body.conversationConstraints : lunch ? lunchConstraints(lunch) : null;
    const constraints = constraintsFor(message, prefs, history, previous, { dishNames });
    const result = await recommend({
      message,
      dishId: typeof body.dishId === "string" ? body.dishId.slice(0, 80) : null,
      dishSticky: body.dishSticky === true,
      lunch,
      lunchError: selected && !selected.ok ? selected.error : null,
      history,
      constraints,
      prefs,
      dishes,
      stalls,
      ratings: (await votes.summary()).ratings,
      clock,
    });
    const { saved, notes, clarify, ru, restricted, ...state } = constraints;
    return send(res, 200, { ...result, conversationConstraints: state, lunch, lunchError: selected && !selected.ok ? selected.error : null, menuVersion: generatedAt });
  }

  // Student poll: favourite cuisine + 1-5 star ratings.
  if (req.method === "GET" && path === "/api/poll") {
    const voter = new URL(req.url, "http://localhost").searchParams.get("voter");
    return send(res, 200, await votes.summary(voter));
  }
  if (req.method === "POST" && (path === "/api/poll/favorite" || path === "/api/poll/rate")) {
    if (!allow("vote", clientOf(req), 40)) return send(res, 429, { error: "Too many votes, wait a minute" });
    const body = await readBody(req);
    try {
      if (path.endsWith("favorite")) await votes.setFavorite(String(body.voter), String(body.stallId));
      else await votes.rate(String(body.voter), String(body.stallId), body.stars);
    } catch (error) {
      const invalid = ['Bad voter id','Unknown cuisine','Stars must be 1-5'].includes(error.message);
      return send(res, invalid ? 400 : 503, { error: invalid ? error.message : 'Vote could not be saved. Please try again.' });
    }
    return send(res, 200, await votes.summary(String(body.voter)));
  }
  return send(res, 404, { error: "Not found" });
}

async function serveStatic(res, path) {
  const file = normalize(join(PUBLIC_DIR, path === "/" ? "index.html" : decodeURIComponent(path)));
  const rel=relative(PUBLIC_DIR,file);
  if (rel.startsWith("..") || isAbsolute(rel)) return send(res, 403, { error: "Forbidden" });
  try {
    const content = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache", "X-Content-Type-Options":"nosniff" });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname.startsWith("/api/")) await handleApi(req, res, pathname);
    else await serveStatic(res, pathname);
  } catch (error) {
    console.error("Request failed:", error.name);
    send(res, 400, { error: "Request could not be processed. Check the input and try again." });
  }
});

server.listen(PORT, () => {
  const provider = process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : 'offline');
  const gemini = provider === 'enterprise' ? 'Gemini Enterprise' : provider === 'gemini' && process.env.GEMINI_API_KEY ? `Gemini: ${process.env.GEMINI_MODEL || DEFAULT_MODEL}` : 'Local menu matching';
  const hidden = allDishes.length - dishes.length;
  const noPhoto = dishes.filter((d) => !d.photo).length;
  console.log(`APEats running at http://localhost:${PORT}  |  ${gemini}  |  ${dishes.length} items${hidden ? ` (${hidden} without photo hidden)` : ` (${noPhoto} shown with a placeholder photo)`}, ${stalls.length} stalls`);
});

for (const signal of ["SIGINT","SIGTERM"]) process.on(signal,()=>server.close(()=>process.exit(0)));
