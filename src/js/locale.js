/**
 * Where the map is looking, and who decided that.
 *
 * This site has no backend, so there is nothing here that *could* phone home —
 * but "we can't track you" is only worth saying if the code makes it obvious.
 * So every way a place gets chosen is local by construction:
 *
 *   default      the whole country. We don't know where you are and don't ask.
 *   hash         the URL. Shareable, bookmarkable, back-button-able.
 *   geolocation  the browser's own permission prompt, fired only by a click.
 *   search       Nominatim, on explicit submit only.
 *   saved        localStorage, which never leaves the browser.
 *
 * Coordinates that came from GPS are rounded before they reach the address bar.
 * Someone who locates themselves and then shares the link should not be
 * publishing their house to do it.
 */

import { US_VIEW, NOMINATIM_URL } from "./config.js";

const SAVED_KEY = "watchback:saved-view";

/** ~110 m. Enough to put the map on your street, not on your driveway. */
const GEO_PRECISION = 3;

const round = (n, places) => Number(Number(n).toFixed(places));

const listeners = new Set();

let current = null;

/* ---------- URL hash ---------- */

/**
 * MapLibre's own convention: #zoom/lat/lon. We parse and write it ourselves
 * rather than using `hash: true` so that a locale change and a map move are
 * the same event, and so precision stays under our control.
 */
function readHash() {
  const raw = (location.hash || "").replace(/^#/, "");
  if (!raw) return null;

  const parts = raw.split("/");
  if (parts.length < 3) return null;

  const [zoom, lat, lon] = parts.map(Number);
  if (![zoom, lat, lon].every(Number.isFinite)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return { lat, lon, zoom, name: null, source: "hash" };
}

/** Zoomed in => more decimals. At z4 six decimals is noise; at z18 it isn't. */
function hashPrecision(zoom) {
  return Math.max(2, Math.min(6, Math.round(zoom / 3)));
}

export function writeHash({ lat, lon, zoom }) {
  const p = hashPrecision(zoom);
  const next = `#${round(zoom, 2)}/${round(lat, p)}/${round(lon, p)}`;
  if (location.hash !== next) {
    history.replaceState(null, "", next);
  }
}

/* ---------- saved view ---------- */

export function readSaved() {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) return null;
    return { ...v, source: "saved" };
  } catch {
    return null; // private mode, blocked storage, corrupt entry — all non-fatal
  }
}

export function saveView({ lat, lon, zoom, name }) {
  const view = { lat: round(lat, 4), lon: round(lon, 4), zoom, name: name || null };
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(view));
    return true;
  } catch {
    return false; // quota or blocked storage — the site works fine without it
  }
}

export function clearSaved() {
  try {
    localStorage.removeItem(SAVED_KEY);
  } catch {
    /* nothing to clean up */
  }
}

export const hasSaved = () => readSaved() !== null;

/* ---------- geolocation ---------- */

/**
 * Never called on load. A permission prompt nobody asked for is not consent,
 * and browsers rightly punish sites that fire one unprompted.
 */
export function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser has no location support."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: round(pos.coords.latitude, GEO_PRECISION),
          lon: round(pos.coords.longitude, GEO_PRECISION),
          zoom: 12,
          name: "Your area",
          source: "geolocation",
        }),
      (err) => {
        const why = {
          1: "Location permission was declined. Pan and zoom works the same either way.",
          2: "Your device could not get a fix.",
          3: "Timed out looking for a fix.",
        };
        reject(new Error(why[err.code] || "Could not get your location."));
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  });
}

/* ---------- geocoding ---------- */

/**
 * Nominatim, keyless. Their usage policy caps automated clients at 1 req/s and
 * asks them to identify themselves; browsers send a Referer automatically and
 * we only ever fire this on an explicit submit, so both are satisfied.
 */
export async function search(query) {
  const url = new URL(`${NOMINATIM_URL}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("limit", "5");

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Search unavailable (${res.status}).`);

  const body = await res.json();
  return body.map((r) => ({
    lat: Number(r.lat),
    lon: Number(r.lon),
    // A city gets a closer look than a whole state does.
    zoom: r.addresstype === "state" ? 7 : r.addresstype === "city" ? 11 : 13,
    name: shortName(r.display_name),
    source: "search",
  }));
}

/** Nominatim returns the full postal chain; the first two parts locate it fine. */
function shortName(displayName) {
  const parts = String(displayName).split(",").map((s) => s.trim());
  if (parts.length <= 2) return parts.join(", ");
  const state = parts[parts.length - 2];
  return `${parts[0]}, ${state}`;
}

/* ---------- current locale ---------- */

/**
 * Precedence: an explicit URL beats a saved view, which beats the country.
 * Geolocation is absent on purpose — it can only ever arrive from a click.
 */
export function initial() {
  if (current) return current;
  current = readHash() || readSaved() || { ...US_VIEW, source: "default" };
  return current;
}

export function get() {
  return current || initial();
}

/** Announce a new place. `silent` moves are map drags syncing themselves back. */
export function set(next, { silent = false } = {}) {
  current = { ...get(), ...next };
  if (!silent) listeners.forEach((fn) => fn(current));
  return current;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * True while we are still showing the whole country because nobody has picked
 * a place. Callers use this to avoid claiming a locale the visitor never gave —
 * "near United States" is not a location, and a 40 km query around the
 * geographic centre of Kansas is not a useful question to ask Overpass.
 */
export const isDefault = () => get().source === "default";

/** What to show in the header chip. */
export function label(locale = get()) {
  if (locale.name) return locale.name;
  if (locale.source === "default") return US_VIEW.name;
  return `${locale.lat.toFixed(3)}, ${locale.lon.toFixed(3)}`;
}
