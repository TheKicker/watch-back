/**
 * The camera wall — every public view at once.
 *
 * This is the friendliest argument the site makes: this much is openly
 * watchable, and nobody had to ask.
 *
 * The hard constraint here is bandwidth, not geography. Every tile is a JPEG
 * re-fetched on a timer, so a naive wall over a statewide catalogue would pull
 * tens of megabytes a second from a state DOT — from every visitor at once.
 *
 * The fix is to scope the *refreshing* rather than the list: an
 * IntersectionObserver means only tiles actually on screen ever re-fetch, so
 * cost is bounded by the viewport instead of the catalogue. That is what makes
 * an arbitrary radius unnecessary — the list can be as long as it likes, sorted
 * by distance from wherever you are looking, and you simply scroll.
 */

import { CAMERA_REFRESH_MS, WALL_PAGE } from "./config.js";
import { loadCameras, bust } from "./data.js";
import { distance, metersToMiles } from "./geo.js";
import * as locale from "./locale.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  tiles: [],
  shown: [],
  page: 0,
  timer: null,
  paused: false,
  filter: "",
  /** Images currently intersecting the viewport — the only ones we refresh. */
  onScreen: new Set(),
};

const esc = (s) =>
  String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

/** One tile per camera *view* — a quad unit contributes one tile per view. */
function toTiles(cameras) {
  const tiles = [];
  for (const cam of cameras) {
    for (const view of cam.views || []) {
      if (!view.smallUrl) continue;
      tiles.push({
        url: view.largeUrl || view.smallUrl,
        location: cam.location || "Traffic camera",
        direction: view.direction || "",
        route: view.mainRoute || "",
        lat: cam.latitude,
        lon: cam.longitude,
      });
    }
  }
  return tiles;
}

/* ---------- visibility gating ---------- */

/**
 * A tile that scrolls into view loads at once rather than waiting up to a full
 * tick — otherwise scrolling looks broken for five seconds.
 */
const tileObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const img = entry.target;
      if (entry.isIntersecting) {
        state.onScreen.add(img);
        if (!state.paused && !img.src) img.src = bust(img.dataset.url);
      } else {
        state.onScreen.delete(img);
      }
    }
  },
  // A little margin so tiles are warm by the time they are actually looked at.
  { rootMargin: "200px 0px" }
);

/** Infinite scroll, so the DOM stays bounded no matter how big the catalogue. */
const sentinelObserver = new IntersectionObserver(
  (entries) => {
    if (entries.some((e) => e.isIntersecting)) appendPage();
  },
  { rootMargin: "400px 0px" }
);

/* ---------- rendering ---------- */

function matches(t, q) {
  return `${t.location} ${t.route} ${t.direction}`.toLowerCase().includes(q);
}

/** Sorted by distance from wherever the visitor is looking, nearest first. */
function computeShown() {
  const q = state.filter.trim().toLowerCase();
  const here = locale.get();
  const list = q ? state.tiles.filter((t) => matches(t, q)) : state.tiles.slice();

  for (const t of list) {
    t.dist = distance(here.lat, here.lon, t.lat, t.lon);
  }
  list.sort((a, b) => a.dist - b.dist);
  return list;
}

function tileHTML(t, i) {
  const miles = Number.isFinite(t.dist) ? `${metersToMiles(t.dist).toFixed(1)} mi` : "";
  return `
    <figure class="tile" data-i="${i}">
      <div class="tile-img"><img alt="${esc(t.location)}" data-url="${esc(t.url)}"></div>
      <figcaption>
        <span class="tile-loc">${esc(t.location)}</span>
        <span class="tile-meta">
          <span>${esc([t.route, t.direction].filter(Boolean).join(" · "))}</span>
          <span class="tile-dist mono">${miles}</span>
        </span>
      </figcaption>
    </figure>`;
}

function appendPage() {
  const from = state.page * WALL_PAGE;
  const slice = state.shown.slice(from, from + WALL_PAGE);
  if (slice.length === 0) return;

  const grid = $("#grid");
  grid.insertAdjacentHTML(
    "beforeend",
    slice.map((t, n) => tileHTML(t, from + n)).join("")
  );
  state.page += 1;

  // Wire only the tiles just added.
  const fresh = Array.from(grid.querySelectorAll(".tile")).slice(from);
  for (const el of fresh) {
    tileObserver.observe(el.querySelector("img"));
    el.addEventListener("click", () => {
      const t = state.shown[Number(el.dataset.i)];
      window.location.href = `index.html#14/${t.lat}/${t.lon}`;
    });
  }

  positionSentinel();
}

/** Keep the load-more sentinel after the last tile, and stop when exhausted. */
function positionSentinel() {
  const sentinel = $("#sentinel");
  const done = state.page * WALL_PAGE >= state.shown.length;
  sentinel.classList.toggle("hide", done);
  if (done) {
    sentinelObserver.unobserve(sentinel);
  } else {
    $("#grid").after(sentinel);
    sentinelObserver.observe(sentinel);
  }
}

function render() {
  state.onScreen.clear();
  state.page = 0;
  state.shown = computeShown();

  const grid = $("#grid");
  grid.innerHTML = "";

  $("#shown-count").textContent = state.shown.length.toLocaleString();
  // Everything is distance-sorted, but only say what it is sorted *from* once
  // the visitor has actually named a place.
  $("#sort-note").textContent = !state.shown.length
    ? ""
    : locale.isDefault()
      ? "— set a place to sort from where you are"
      : `nearest ${locale.label()}`;

  if (state.shown.length === 0) {
    grid.innerHTML =
      '<p class="empty">' +
      (state.tiles.length === 0
        ? 'No camera catalogue loaded yet — see <a href="contribute.html">Contribute</a> to bake one.'
        : "No cameras match that search.") +
      "</p>";
    $("#sentinel").classList.add("hide");
    return;
  }

  appendPage();
}

/* ---------- refresh ---------- */

function refresh() {
  if (state.paused) return;
  const tick = Date.now();
  for (const img of state.onScreen) {
    img.src = bust(img.dataset.url, tick);
  }
  $("#live-count").textContent = state.onScreen.size;
  $("#last-refresh").textContent = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function startTimer() {
  clearInterval(state.timer);
  state.timer = setInterval(refresh, CAMERA_REFRESH_MS);
}

function setPaused(paused) {
  state.paused = paused;
  const btn = $("#pause");
  btn.textContent = paused ? "▶ Resume" : "⏸ Pause";
  btn.classList.toggle("btn-primary", paused);
  if (!paused) refresh();
}

/* ---------- boot ---------- */

async function boot() {
  const data = await loadCameras();
  state.tiles = toTiles(data.cameras);
  $("#total-count").textContent = state.tiles.length.toLocaleString();
  if (data.source === "seed") $("#seed-hint").classList.remove("hide");

  render();
  startTimer();

  $("#search").addEventListener("input", (e) => {
    state.filter = e.target.value;
    render();
  });
  $("#pause").addEventListener("click", () => setPaused(!state.paused));
  $("#size").addEventListener("input", (e) => {
    $("#grid").style.setProperty("--tile-min", `${e.target.value}px`);
  });

  // Re-sorting on locale change is the whole point of the header picker.
  locale.subscribe(() => render());

  // Don't hammer the DOTs while the tab is in the background.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearInterval(state.timer);
    } else {
      refresh();
      startTimer();
    }
  });
}

boot();
