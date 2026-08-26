/** Spherical helpers. All angles in degrees, all distances in meters. */

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Great-circle distance between two lat/lon points. */
export function distance(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export const metersToMiles = (m) => m / 1609.344;

/** Point `meters` away from (lat, lon) along `bearing`. Returns [lon, lat]. */
export function destination(lat, lon, bearing, meters) {
  const d = meters / R;
  const br = rad(bearing);
  const l1 = rad(lat);
  const o1 = rad(lon);
  const l2 = Math.asin(
    Math.sin(l1) * Math.cos(d) + Math.cos(l1) * Math.sin(d) * Math.cos(br)
  );
  const o2 =
    o1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(l1),
      Math.cos(d) - Math.sin(l1) * Math.sin(l2)
    );
  return [deg(o2), deg(l2)];
}

/**
 * OSM `direction` is messy in the wild: "105", "105;343" for a dual-head unit,
 * or a compass point like "NNE". Normalise all of it to a list of degrees.
 */
const COMPASS = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

export function parseDirections(raw) {
  if (raw == null) return [];
  return String(raw)
    .split(";")
    .map((part) => {
      const t = part.trim();
      if (t === "") return null;
      const up = t.toUpperCase();
      if (up in COMPASS) return COMPASS[up];
      const n = Number(t);
      return Number.isFinite(n) ? ((n % 360) + 360) % 360 : null;
    })
    .filter((v) => v !== null);
}

/**
 * A wedge showing roughly what a camera covers, as a GeoJSON ring.
 * Deliberately short — this is "which way is it pointed", not a claimed
 * read range. Real ALPR range depends on optics, speed and plate angle.
 */
export function coneRing(lat, lon, bearing, meters = 90, spread = 46, steps = 14) {
  const ring = [[lon, lat]];
  const start = bearing - spread / 2;
  for (let i = 0; i <= steps; i++) {
    ring.push(destination(lat, lon, start + (spread * i) / steps, meters));
  }
  ring.push([lon, lat]);
  return ring;
}

/** Bounding box [s, w, n, e] around a point, for Overpass. */
export function bboxAround(lat, lon, meters) {
  const dLat = deg(meters / R);
  const dLon = deg(meters / (R * Math.cos(rad(lat))));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

/**
 * Keyless Google Street View link at a point.
 *
 * Maps URLs needs no API key and has no quota, unlike the embeddable Street
 * View iframe — so this stays free no matter how much the site gets used.
 *
 * Google snaps to the panorama nearest `lat/lon`, which is normally the road
 * the device overlooks. `heading` is an absolute compass bearing, not a
 * look-at, so where the pano lands off-road the aim is approximate.
 */
export function streetViewUrl(lat, lon, heading) {
  const u = new URL("https://www.google.com/maps/@");
  u.searchParams.set("api", "1");
  u.searchParams.set("map_action", "pano");
  u.searchParams.set("viewpoint", `${lat},${lon}`);
  if (Number.isFinite(heading)) {
    u.searchParams.set("heading", String(Math.round(((heading % 360) + 360) % 360)));
  }
  u.searchParams.set("fov", "80");
  return u.toString();
}

/**
 * Two useful ways to look at a camera:
 *   toward — aim back down its line of sight, so the housing is in frame.
 *            This is how you read a manufacturer or operator off the pole.
 *   along  — aim the way it points, to see the stretch of road it captures.
 */
export function streetViewLinks(lat, lon, directions) {
  const facing = directions && directions.length ? directions[0] : null;
  return {
    toward: streetViewUrl(lat, lon, facing === null ? undefined : facing + 180),
    along: facing === null ? null : streetViewUrl(lat, lon, facing),
  };
}
