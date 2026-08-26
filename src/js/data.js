/** Data access: baked camera catalogues, and live ALPR nodes from Overpass. */

import {
  OVERPASS_ENDPOINTS,
  ALPR_CACHE_MS,
  CACHE_GRID_DEG,
  MAX_QUERY_DEG2,
  CACHE_MAX_NODES,
} from "./config.js";
import { bboxAround } from "./geo.js";

/* Resolved from this module's own URL so every page gets the same path,
   whether it is served from / or from /watch-back/. */
const url = (p) => new URL(p, import.meta.url);
const CAMERAS_URL = url("../../data/cameras.json");
const VENDORS_URL = url("../../data/vendors.json");
const SUMMARY_URL = url("../../data/alpr-summary.json");

const json = async (u) => {
  const res = await fetch(u, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${u}`);
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

/**
 * Per-state ALPR counts, baked nightly.
 *
 * The national view can't query Overpass live — one countrywide call per
 * visitor would be slow for them and abusive to a donated service. So the
 * zoomed-out map renders these instead, and only switches to live data once
 * the viewport is small enough to ask about politely.
 */
export async function loadSummary() {
  try {
    const data = await json(SUMMARY_URL);
    return { ...data, states: (data.states ?? []).filter((s) => Number.isFinite(s.count)) };
  } catch (err) {
    console.warn("ALPR summary unavailable:", err);
    return { states: [], error: String(err) };
  }
}

/* ---------- Overpass ---------- */

/**
 * Snap a box outward onto a fixed grid.
 *
 * Two reasons, both load-bearing. It makes the cache key reusable — panning a
 * few hundred metres hits the same cell instead of minting a new entry and
 * filling localStorage. And it makes the query itself repeat, so Overpass gets
 * an identical request it can serve cheaply rather than a slightly different
 * one every time the map twitches.
 */
export function snapBBox([s, w, n, e], grid = CACHE_GRID_DEG) {
  const down = (v) => Math.floor(v / grid) * grid;
  const up = (v) => Math.ceil(v / grid) * grid;
  return [
    Math.max(-90, down(s)),
    Math.max(-180, down(w)),
    Math.min(90, up(n)),
    Math.min(180, up(e)),
  ];
}

const bboxArea = ([s, w, n, e]) => Math.abs(n - s) * Math.abs(e - w);

const cacheKey = (bbox) => `alpr:${bbox.map((v) => v.toFixed(3)).join(",")}`;

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
  if (nodes.length > CACHE_MAX_NODES) return; // see CACHE_MAX_NODES for why
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), nodes }));
  } catch {
    // Quota is the likely cause and the cheapest fix is to drop other cells:
    // a cold cache costs one request, a wedged one costs every request.
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("alpr:") && k !== key) localStorage.removeItem(k);
      }
      localStorage.setItem(key, JSON.stringify({ at: Date.now(), nodes }));
    } catch {
      /* still no room — the map works fine without a cache */
    }
  }
}

function readStale(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw).nodes : null;
  } catch {
    return null;
  }
}

/**
 * Every ALPR node OSM knows about inside a bounding box.
 *
 * These are the same nodes DeFlock renders — we read OSM directly rather than
 * proxying them, so anything fixed here shows up there too. The query is
 * vendor-agnostic on purpose: Flock is the loudest name but Motorola, Genetec
 * and Leonardo units carry the same tag and belong on the same map.
 */
export async function loadALPRsInBBox(rawBBox, { force = false } = {}) {
  const bbox = snapBBox(rawBBox);

  if (bboxArea(bbox) > MAX_QUERY_DEG2) {
    throw new Error("Area too large to query live — zoom in.");
  }

  const key = cacheKey(bbox);
  if (!force) {
    const hit = readCache(key);
    if (hit) return { ...hit, bbox };
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
      return { nodes, at: Date.now(), cached: false, bbox };
    } catch (err) {
      lastErr = err;
      console.warn(`overpass mirror failed (${endpoint}):`, err);
    }
  }

  // Every mirror is down — a stale cache still beats an empty map.
  const stale = readStale(key);
  if (stale) return { nodes: stale, at: 0, cached: true, stale: true, bbox };
  throw lastErr ?? new Error("no Overpass mirror reachable");
}

/** Radius-shaped convenience wrapper, for callers that think in "near here". */
export function loadALPRs(lat, lon, radiusM, opts) {
  return loadALPRsInBBox(bboxAround(lat, lon, radiusM), opts);
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
export function bust(u, tick = Date.now()) {
  return `${u}${u.includes("?") ? "&" : "?"}t=${tick}`;
}
