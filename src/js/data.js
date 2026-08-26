/** Data access: the baked ODOT catalog, and live ALPR nodes from Overpass. */

import { OVERPASS_ENDPOINTS, ALPR_CACHE_MS } from "./config.js";
import { bboxAround } from "./geo.js";

/* Resolved from this module's own URL so every page gets the same path,
   whether it is served from / or from /watch-back/. */
const CAMERAS_URL = new URL("../../data/cameras.json", import.meta.url);
const VENDORS_URL = new URL("../../data/vendors.json", import.meta.url);

const json = async (url) => {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
};

/** ODOT cameras. Baked at build time so no API key ever reaches the browser. */
export async function loadCameras() {
  try {
    const data = await json(CAMERAS_URL);
    return { ...data, cameras: data.cameras ?? [] };
  } catch (err) {
    console.warn("camera catalog unavailable:", err);
    return { cameras: [], source: "unavailable", error: String(err) };
  }
}

/** Vendor reference facts for the transparency scorecard. */
export async function loadVendors() {
  try {
    return await json(VENDORS_URL);
  } catch {
    return { vendors: {} };
  }
}

/* ---------- Overpass ---------- */

const cacheKey = (bbox) => `alpr:${bbox.map((n) => n.toFixed(3)).join(",")}`;

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { at, nodes } = JSON.parse(raw);
    if (Date.now() - at > ALPR_CACHE_MS) return null;
    return { nodes, at, cached: true };
  } catch {
    return null; // private mode, blocked storage, corrupt entry — all non-fatal
  }
}

function writeCache(key, nodes) {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), nodes }));
  } catch {
    /* quota or blocked storage — the map works fine without a cache */
  }
}

/**
 * Every ALPR node OSM knows about near a point.
 *
 * These are the same nodes DeFlock renders — we read OSM directly rather than
 * proxying them, so anything fixed here shows up there too.
 */
export async function loadALPRs(lat, lon, radiusM, { force = false } = {}) {
  const bbox = bboxAround(lat, lon, radiusM);
  const key = cacheKey(bbox);

  if (!force) {
    const hit = readCache(key);
    if (hit) return hit;
  }

  const query = `[out:json][timeout:60];
node["man_made"="surveillance"]["surveillance:type"="ALPR"](${bbox.join(",")});
out body;`;

  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        // Overpass answers 406 to requests with no User-Agent, and its usage
        // policy asks clients to identify themselves. Browsers set this header
        // themselves and ignore ours; setting it is what makes the same code
        // path testable outside one.
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "WatchBack/1.0 (+https://github.com/TheKicker/watch-back)",
        },
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = await res.json();
      const nodes = (body.elements ?? []).filter((e) => e.type === "node");
      writeCache(key, nodes);
      return { nodes, at: Date.now(), cached: false };
    } catch (err) {
      lastErr = err;
      console.warn(`overpass mirror failed (${endpoint}):`, err);
    }
  }

  // Every mirror is down — a stale cache still beats an empty map.
  const stale = (() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw).nodes : null;
    } catch {
      return null;
    }
  })();

  if (stale) return { nodes: stale, at: 0, cached: true, stale: true };
  throw lastErr ?? new Error("no Overpass mirror reachable");
}

/** Which of the tags we care about are missing from a node. */
export function missingTags(node, desired) {
  const tags = node.tags ?? {};
  return desired.filter(({ key }) => !tags[key] || String(tags[key]).trim() === "");
}

/** Deep link into the OSM iD editor, focused on one node. */
export function editUrl(node) {
  return `https://www.openstreetmap.org/edit?editor=id&node=${node.id}#map=19/${node.lat}/${node.lon}`;
}

/** Cache-busted camera image URL — ODOT sets long-lived ETags. */
export function bust(url, tick = Date.now()) {
  return `${url}${url.includes("?") ? "&" : "?"}t=${tick}`;
}
