/**
 * Bakes per-state ALPR counts into data/alpr-summary.json.
 *
 * Why this exists: the map's national view cannot query Overpass live. One
 * countrywide request per visitor would be slow for them and abusive to a
 * service donated by volunteers. So CI asks the question once a day, and every
 * visitor reads a few kilobytes of JSON instead.
 *
 * These are counts, not positions. The bubbles they draw sit on fixed state
 * centroids below — the point of the zoomed-out view is "how much, and where
 * should I look", not "exactly which pole".
 *
 * Usage:  node scripts/fetch-alpr-summary.mjs
 * Needs no API key. Failures for one state keep that state's previous count.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "alpr-summary.json");

/** Mirrors, tried in order — the same two the site itself uses. */
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** Overpass asks automated clients to identify themselves. */
const UA = "WatchBack/1.0 (+https://github.com/TheKicker/watch-back)";

/**
 * Ask in batches, not one state at a time.
 *
 * Overpass limits by execution slot, and a whole-state area query is not cheap.
 * Fifty-one of them in a row trips its abuse protection within about a dozen
 * states — first 429s, then the IP stops being answered at all. No amount of
 * sleeping fixes that, because the problem is the number of requests.
 *
 * Overpass allows several `out count;` statements in one query, so a batch asks
 * about eight states at once and the whole job costs seven requests instead of
 * fifty-one. Counts come back positionally, in statement order.
 */
const BATCH_SIZE = 8;
const DELAY_MS = 8000;
const RETRIES = 3;

/** 429 means "come back later", so wait properly rather than hammering. */
const RATE_LIMIT_BACKOFF_MS = 30000;

/**
 * Visual centres, not centroids of area — these only ever place a label
 * bubble, so "where the eye expects the state" beats geometric truth.
 */
const STATES = [
  ["AL", "Alabama", 32.806, -86.791],       ["AK", "Alaska", 63.588, -154.493],
  ["AZ", "Arizona", 33.729, -111.431],      ["AR", "Arkansas", 34.970, -92.373],
  ["CA", "California", 36.116, -119.682],   ["CO", "Colorado", 39.059, -105.311],
  ["CT", "Connecticut", 41.597, -72.755],   ["DE", "Delaware", 39.318, -75.507],
  ["DC", "District of Columbia", 38.897, -77.026],
  ["FL", "Florida", 27.766, -81.686],       ["GA", "Georgia", 33.040, -83.643],
  ["HI", "Hawaii", 21.094, -157.498],       ["ID", "Idaho", 44.240, -114.478],
  ["IL", "Illinois", 40.349, -88.986],      ["IN", "Indiana", 39.849, -86.258],
  ["IA", "Iowa", 42.011, -93.210],          ["KS", "Kansas", 38.526, -96.726],
  ["KY", "Kentucky", 37.668, -84.670],      ["LA", "Louisiana", 31.169, -91.867],
  ["ME", "Maine", 44.693, -69.381],         ["MD", "Maryland", 39.064, -76.802],
  ["MA", "Massachusetts", 42.230, -71.530], ["MI", "Michigan", 43.326, -84.536],
  ["MN", "Minnesota", 45.694, -93.900],     ["MS", "Mississippi", 32.741, -89.678],
  ["MO", "Missouri", 38.456, -92.288],      ["MT", "Montana", 46.921, -110.454],
  ["NE", "Nebraska", 41.125, -98.268],      ["NV", "Nevada", 38.313, -117.055],
  ["NH", "New Hampshire", 43.452, -71.563], ["NJ", "New Jersey", 40.298, -74.521],
  ["NM", "New Mexico", 34.840, -106.248],   ["NY", "New York", 42.165, -74.948],
  ["NC", "North Carolina", 35.630, -79.806],["ND", "North Dakota", 47.528, -99.784],
  ["OH", "Ohio", 40.388, -82.764],          ["OK", "Oklahoma", 35.565, -96.928],
  ["OR", "Oregon", 44.572, -122.070],       ["PA", "Pennsylvania", 40.590, -77.209],
  ["RI", "Rhode Island", 41.680, -71.511],  ["SC", "South Carolina", 33.856, -80.945],
  ["SD", "South Dakota", 44.299, -99.438],  ["TN", "Tennessee", 35.747, -86.692],
  ["TX", "Texas", 31.054, -97.563],         ["UT", "Utah", 40.150, -111.862],
  ["VT", "Vermont", 44.045, -72.710],       ["VA", "Virginia", 37.769, -78.170],
  ["WA", "Washington", 47.400, -121.490],   ["WV", "West Virginia", 38.491, -80.954],
  ["WI", "Wisconsin", 44.268, -89.616],     ["WY", "Wyoming", 42.756, -107.302],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Count ALPR nodes for a batch of states in a single request.
 *
 * `out count` returns a tally rather than the nodes themselves, which is what
 * makes it reasonable to ask about eight states at once. The reply carries one
 * count element per `out count;`, in the order they were written — there is no
 * label on them, so the caller matches by position and verifies the length.
 */
/** POST a query, trying each mirror before giving up. */
async function ask(query) {
  let lastErr;
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": UA,
        },
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * One state, asked on its own.
 *
 * The batched path above is the polite one and is what normally runs. This is
 * the fallback for when a batch comes back the wrong shape — an Overpass build
 * that dislikes several `out count;` in one query would otherwise cost eight
 * states at a time, and a slow correct answer beats a fast missing one.
 */
async function countOne(code) {
  const body = await ask(`[out:json][timeout:300];
area["ISO3166-2"="US-${code}"]["admin_level"="4"]->.a;
node["man_made"="surveillance"]["surveillance:type"="ALPR"](area.a);
out count;`);
  const tally = (body.elements ?? []).find((e) => e.type === "count");
  const n = Number(tally?.tags?.nodes ?? tally?.tags?.total);
  if (!Number.isFinite(n)) throw new Error("no count in response");
  return n;
}

async function countBatch(batch) {
  const parts = batch.map(
    ([code], i) => `area["ISO3166-2"="US-${code}"]["admin_level"="4"]->.a${i};
node["man_made"="surveillance"]["surveillance:type"="ALPR"](area.a${i});
out count;`
  );
  const query = ["[out:json][timeout:300];", ...parts].join("\n");

  const body = await ask(query);
  const counts = (body.elements ?? [])
    .filter((e) => e.type === "count")
    .map((e) => Number(e.tags?.nodes ?? e.tags?.total));

  // Positional matching is only safe if the shapes agree; a short reply would
  // silently assign one state's count to another.
  if (counts.length !== batch.length) {
    throw new Error(`expected ${batch.length} counts, got ${counts.length}`);
  }
  if (counts.some((n) => !Number.isFinite(n))) {
    throw new Error("non-numeric count in response");
  }
  return counts;
}

async function withRetries(batch) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await countBatch(batch);
    } catch (err) {
      lastErr = err;
      if (attempt === RETRIES) break;

      // Overpass sheds load with 429/504 under pressure, and stops answering
      // entirely if pushed further. Backing off properly is the difference
      // between a flaky job and a rude one.
      const rateLimited = /429|fetch failed/.test(err.message);
      const wait = rateLimited
        ? RATE_LIMIT_BACKOFF_MS * (attempt + 1)
        : DELAY_MS * (attempt + 2);
      const label = batch.map(([c]) => c).join(",");
      console.warn(`  [${label}] retry ${attempt + 1}/${RETRIES} in ${Math.round(wait / 1000)}s (${err.message})`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function main() {
  const prev = await readFile(OUT, "utf8").then(JSON.parse).catch(() => null);
  const prevByCode = new Map((prev?.states ?? []).map((s) => [s.code, s]));

  const states = [];
  let failed = 0;

  for (let i = 0; i < STATES.length; i += BATCH_SIZE) {
    const batch = STATES.slice(i, i + BATCH_SIZE);
    const label = batch.map(([c]) => c).join(" ");

    try {
      const counts = await withRetries(batch);
      batch.forEach(([code, name, lat, lon], n) => {
        states.push({ code, name, lat, lon, count: counts[n] });
      });
      console.log(`${label} -> ${counts.join(" ")}`);
    } catch (err) {
      console.warn(`${label} batch failed (${err.message}) — falling back one at a time`);

      // Losing eight states to one bad reply is worse than spending eight
      // requests, so retry the batch member by member before giving up on it.
      for (const [code, name, lat, lon] of batch) {
        try {
          const count = await countOne(code);
          states.push({ code, name, lat, lon, count });
          console.log(`  ${code} ${count}`);
        } catch (inner) {
          failed++;
          // A failed state keeps its last known count rather than vanishing
          // from the map: a missing bubble reads as "none here", a lie.
          const old = prevByCode.get(code)?.count ?? null;
          states.push({ code, name, lat, lon, count: old });
          console.warn(`  ${code} failed (${inner.message}) — keeping ${old ?? "null"}`);
        }
        await sleep(DELAY_MS);
      }
    }

    if (i + BATCH_SIZE < STATES.length) await sleep(DELAY_MS);
  }

  if (failed === STATES.length) {
    console.error("every batch failed — leaving the existing summary alone.");
    process.exit(prev ? 0 : 1);
  }

  const known = states.filter((s) => Number.isFinite(s.count));
  const next = {
    source: "overpass",
    generatedAt: new Date().toISOString(),
    note: "Per-state ALPR node counts from OpenStreetMap. Generated by scripts/fetch-alpr-summary.mjs. A null count means the last run could not reach Overpass for that state; the map draws no bubble rather than claiming zero.",
    total: known.reduce((n, s) => n + s.count, 0),
    states,
  };

  await writeFile(OUT, JSON.stringify(next, null, 2) + "\n");
  console.log(`\nwrote ${known.length}/${states.length} states, ${next.total} readers`);
}

main().catch((err) => {
  console.error("summary update failed:", err.message);
  process.exit(1);
});
