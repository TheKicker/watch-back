/**
 * The place picker in the header.
 *
 * Every page gets the same one, so wherever you are looking follows you from
 * the map to the wall to the contribute list without being asked twice.
 *
 * The privacy note is not boilerplate. This is a site about who is watching
 * whom; a vague claim here would undercut the entire argument. So it says both
 * halves of the truth — we have no server and cannot collect anything, *and*
 * your browser still talks directly to OSM, CARTO and your state's DOT, which
 * see your IP the way any site you visit does.
 */

import * as locale from "./locale.js";

const esc = (s) =>
  String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

export function mountLocalePicker(host) {
  host.innerHTML = `
    <button class="locale-chip" id="locale-chip" aria-expanded="false" aria-haspopup="dialog">
      <span class="locale-pin" aria-hidden="true">◎</span>
      <span class="locale-name" id="locale-name">${esc(locale.label())}</span>
      <span class="locale-caret" aria-hidden="true">▾</span>
    </button>

    <div class="locale-pop panel hide" id="locale-pop" role="dialog" aria-label="Choose a place">
      <form class="locale-search" id="locale-form">
        <input id="locale-q" class="search" type="search" autocomplete="off"
               placeholder="Town, ZIP or address…" aria-label="Search for a place">
        <button class="btn btn-sm btn-primary" type="submit">Go</button>
      </form>

      <div class="locale-results hide" id="locale-results"></div>
      <p class="locale-msg hide" id="locale-msg"></p>

      <button class="btn btn-sm locale-wide" id="locale-locate">◎ Use my location</button>

      <div class="locale-saved">
        <button class="btn btn-sm locale-wide" id="locale-save">☆ Save this view</button>
        <button class="btn btn-sm locale-wide hide" id="locale-clear">Clear saved view</button>
      </div>

      <p class="locale-note">
        <b>We have no server.</b> Your location never leaves this browser — there is
        nothing here that could collect it, and a saved view is stored only on this
        device. But drawing the map means your browser talks directly to
        OpenStreetMap, CARTO and your state's DOT, and those services see your IP
        address like any site you visit.
      </p>
    </div>`;

  const $ = (id) => host.querySelector(id);
  const chip = $("#locale-chip");
  const pop = $("#locale-pop");
  const msg = $("#locale-msg");
  const results = $("#locale-results");

  const say = (text, tone) => {
    msg.textContent = text;
    msg.className = `locale-msg${tone ? " " + tone : ""}`;
  };
  const quiet = () => msg.classList.add("hide");

  function open(next) {
    pop.classList.toggle("hide", !next);
    chip.setAttribute("aria-expanded", String(next));
    if (next) {
      $("#locale-clear").classList.toggle("hide", !locale.hasSaved());
      $("#locale-q").focus();
    }
  }

  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    open(pop.classList.contains("hide"));
  });

  document.addEventListener("click", (e) => {
    if (!host.contains(e.target)) open(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") open(false);
  });

  /* ---- search ---- */

  $("#locale-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#locale-q").value.trim();
    if (!q) return;

    results.classList.add("hide");
    say("Searching…");
    msg.classList.remove("hide");

    try {
      const hits = await locale.search(q);
      quiet();
      if (hits.length === 0) {
        say("Nothing found. Try a town and state.", "warn");
        msg.classList.remove("hide");
        return;
      }
      results.innerHTML = hits
        .map((h, i) => `<button class="locale-hit" data-i="${i}">${esc(h.name)}</button>`)
        .join("");
      results.classList.remove("hide");
      results.querySelectorAll(".locale-hit").forEach((btn) => {
        btn.addEventListener("click", () => {
          locale.set(hits[Number(btn.dataset.i)]);
          results.classList.add("hide");
          open(false);
        });
      });
    } catch (err) {
      say(err.message, "warn");
      msg.classList.remove("hide");
    }
  });

  /* ---- geolocation, on click and only on click ---- */

  $("#locale-locate").addEventListener("click", async () => {
    say("Asking your browser…");
    msg.classList.remove("hide");
    try {
      locale.set(await locale.locate());
      quiet();
      open(false);
    } catch (err) {
      say(err.message, "warn");
      msg.classList.remove("hide");
    }
  });

  /* ---- saved view ---- */

  $("#locale-save").addEventListener("click", () => {
    const ok = locale.saveView(locale.get());
    say(
      ok ? "Saved to this browser only." : "This browser is blocking local storage.",
      ok ? "ok" : "warn"
    );
    msg.classList.remove("hide");
    $("#locale-clear").classList.toggle("hide", !locale.hasSaved());
  });

  $("#locale-clear").addEventListener("click", () => {
    locale.clearSaved();
    $("#locale-clear").classList.add("hide");
    say("Saved view cleared.", "ok");
    msg.classList.remove("hide");
  });

  locale.subscribe((next) => {
    $("#locale-name").textContent = locale.label(next);
  });
}
