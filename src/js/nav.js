/** Shared site header, so the three pages cannot drift apart. */

const LINKS = [
  ["index.html",      "Map"],
  ["wall.html",       "Camera Wall"],
  ["contribute.html", "Contribute"],
];

export function mountHeader(current) {
  const nav = LINKS.map(
    ([href, label]) =>
      `<a href="${href}"${href === current ? ' class="active"' : ""}>${label}</a>`
  ).join("");

  document.body.insertAdjacentHTML(
    "afterbegin",
    `<header class="site-header">
       <a class="brand" href="index.html">
         <span class="mark">WATCH BACK</span>
         <span class="sub">Steubenville, OH</span>
       </a>
       <nav class="site-nav">${nav}</nav>
     </header>`
  );
}
