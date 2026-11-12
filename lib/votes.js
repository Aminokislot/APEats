// One anonymous favourite and a 1-5 star rating per cuisine, per browser profile.
// Local development storage; use the separate Firestore adapter on Cloud Run.
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";

const VOTER_ID = /^[a-z0-9-]{8,64}$/;

export function createVotes({ path, stallIds }) {
  const valid = new Set(stallIds);
  const store = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { voters: {} };

  function save() {
    writeFileSync(`${path}.tmp`, JSON.stringify(store));
    renameSync(`${path}.tmp`, path);
  }

  function updateVoter(id, change) {
    if (!VOTER_ID.test(String(id))) throw new Error("Bad voter id");
    const before = store.voters[id];
    const next = before ? structuredClone(before) : { favorite: null, ratings: {} };
    change(next);
    store.voters[id] = next;
    try { save(); } catch (error) {
      if (before) store.voters[id] = before;
      else delete store.voters[id];
      throw error;
    }
  }

  function setFavorite(id, stallId) {
    if (!valid.has(stallId)) throw new Error("Unknown cuisine");
    updateVoter(id, v => { v.favorite = stallId; });
  }

  function rate(id, stallId, stars) {
    if (!valid.has(stallId)) throw new Error("Unknown cuisine");
    const n = typeof stars === 'number' ? stars : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error("Stars must be 1-5");
    updateVoter(id, v => { v.ratings[stallId] = n; });
  }

  function summary(id) {
    const favorites = Object.fromEntries(stallIds.map((s) => [s, 0]));
    const sums = Object.fromEntries(stallIds.map((s) => [s, { total: 0, count: 0 }]));
    let favoriteVotes = 0;
    for (const v of Object.values(store.voters)) {
      if (v.favorite && valid.has(v.favorite)) {
        favorites[v.favorite]++;
        favoriteVotes++;
      }
      for (const [s, n] of Object.entries(v.ratings)) {
        if (!sums[s]) continue;
        sums[s].total += n;
        sums[s].count++;
      }
    }
    const ratings = Object.fromEntries(
      Object.entries(sums).map(([s, { total, count }]) => [s, { avg: count ? Math.round((total / count) * 10) / 10 : null, count }]),
    );
    const mine = VOTER_ID.test(String(id)) && store.voters[id] ? store.voters[id] : { favorite: null, ratings: {} };
    return { favorites, favoriteVotes, ratings, mine };
  }

  return { setFavorite, rate, summary };
}
