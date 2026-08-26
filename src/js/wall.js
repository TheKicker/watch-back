/**
 * The camera wall — every public view at once.
 *
 * This is the original single-camera page generalised. It is also the friendliest
 * argument the site makes: this much is openly watchable, and nobody had to ask.
 */

import { CAMERA_REFRESH_MS } from "./config.js";
import { loadCameras, bust } from "./data.js";

const $ = (sel) => document.querySelector(sel);

const state = { tiles: [], timer: null, paused: false, filter: "" };

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
        location: cam.location || "ODOT camera",
        direction: view.direction || "",
        route: view.mainRoute || "",
        lat: cam.latitude,
        lon: cam.longitude,
      });
    }
  }
  return tiles;
}

function render() {
  const q = state.filter.trim().toLowerCase();
  const shown = q
    ? state.tiles.filter((t) =>
        `${t.location} ${t.route} ${t.direction}`.toLowerCase().includes(q)
      )
    : state.tiles;

  $("#shown-count").textContent = shown.length;

  if (shown.length === 0) {
    $("#grid").innerHTML =
      '<p class="empty">No cameras match. ' +
      (state.tiles.length === 0
        ? 'The catalog is empty — see <a href="contribute.html">Contribute</a> to bake it.'
        : "Try a different search.") +
      "</p>";
    return;
  }

  $("#grid").innerHTML = shown
    .map(
      (t, i) => `
      <figure class="tile" data-i="${i}">
        <div class="tile-img"><img alt="${esc(t.location)}" data-url="${esc(t.url)}" loading="lazy"></div>
        <figcaption>
          <span class="tile-loc">${esc(t.location)}</span>
          <span class="tile-meta">${esc([t.route, t.direction].filter(Boolean).join(" · "))}</span>
        </figcaption>
      </figure>`
    )
    .join("");

  // Keep a handle on the visible tiles so the refresh tick only touches these.
  state.visible = Array.from($("#grid").querySelectorAll("img"));
  refresh();

  $("#grid").querySelectorAll(".tile").forEach((el) => {
    el.addEventListener("click", () => {
      const t = shown[Number(el.dataset.i)];
      window.open(`index.html#${t.lat},${t.lon}`, "_self");
    });
  });
}

function refresh() {
  if (state.paused) return;
  const tick = Date.now();
  (state.visible || []).forEach((img) => (img.src = bust(img.dataset.url, tick)));
  $("#last-refresh").textContent = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function setPaused(paused) {
  state.paused = paused;
  const btn = $("#pause");
  btn.textContent = paused ? "▶ Resume" : "⏸ Pause";
  btn.classList.toggle("btn-primary", paused);
  if (!paused) refresh();
}

async function boot() {
  const data = await loadCameras();
  state.tiles = toTiles(data.cameras);
  $("#total-count").textContent = state.tiles.length;
  if (data.source === "seed") $("#seed-hint").classList.remove("hide");

  render();
  state.timer = setInterval(refresh, CAMERA_REFRESH_MS);

  $("#search").addEventListener("input", (e) => {
    state.filter = e.target.value;
    render();
  });
  $("#pause").addEventListener("click", () => setPaused(!state.paused));
  $("#size").addEventListener("input", (e) => {
    $("#grid").style.setProperty("--tile-min", `${e.target.value}px`);
  });

  // Don't hammer ODOT while the tab is in the background.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearInterval(state.timer);
    else {
      refresh();
      state.timer = setInterval(refresh, CAMERA_REFRESH_MS);
    }
  });
}

boot();
