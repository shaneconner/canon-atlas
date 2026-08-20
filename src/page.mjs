/* Page assembly: one self-contained HTML document. d3, the stylesheet, the app,
   and the pre-built graph data are all inlined, so the chart opens from file://
   and ships as a single artifact. The only external reference is the Google
   Fonts stylesheet, and the page falls back to system fonts without it.

   buildData and scriptJson are the shared pipeline's, so the chart carries the
   same wire data the live and pure-client paths build. Only the file inlining
   below is Node-bound. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const P = createRequire(import.meta.url)("./ui/pipeline.cjs");
export const scriptJson = P.scriptJson;
export const buildData = P.buildData;

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), "utf8");

/* The head and body markup the chart and the app share. */
function pageHead(title) {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/[<>&]/g, "")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500&display=swap" rel="stylesheet">
<style>
${read("ui/style.css")}
</style>`;
}

/* The shell: a slim header, a rail of icon buttons owning sidebar panels on
   the left, the constellation filling the center, and a tabbed reader on the
   right that appears when a document opens. */
const APP_MARKUP = `<div id="app">
  <div id="grid">
    <nav id="rail" aria-label="panels">
      <button id="rail-wiki" class="railbtn" title="documents" aria-pressed="false">
        <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <circle cx="3.1" cy="4.5" r="1" fill="currentColor" stroke="none"/><line x1="6.4" y1="4.5" x2="15.2" y2="4.5"/>
          <circle cx="3.1" cy="9" r="1" fill="currentColor" stroke="none"/><line x1="6.4" y1="9" x2="15.2" y2="9"/>
          <circle cx="3.1" cy="13.5" r="1" fill="currentColor" stroke="none"/><line x1="6.4" y1="13.5" x2="15.2" y2="13.5"/>
        </svg>
      </button>
      <button id="rail-map" class="railbtn" title="map: clusters, collections, color" aria-pressed="false">
        <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <line x1="5.9" y1="5.3" x2="11.4" y2="6.9"/><line x1="12.4" y1="9.4" x2="7.5" y2="12.6"/>
          <circle cx="4.4" cy="4.8" r="1.8"/><circle cx="13.5" cy="7.5" r="2.2"/><circle cx="6.3" cy="13.7" r="1.5"/>
        </svg>
      </button>
      <button id="rail-folders" class="railbtn" title="folders" aria-pressed="false" hidden>
        <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
          <path d="M2.2 4.6h4.3l1.6 1.8h7.7v7.2a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1z"/>
        </svg>
      </button>
    </nav>
    <aside id="sidebar">
      <div id="wiki" class="panel"></div>
      <div id="overview" class="panel"></div>
      <div id="folders" class="panel"></div>
    </aside>
    <div id="sbgrip" class="grip" title="drag to resize the side panel"></div>
    <div id="stage">
      <button id="refit" class="mapbtn" title="clear the selection and frame the whole corpus">refit</button>
      <button id="lost" class="mapbtn lostbtn" hidden>the sky is off screen: bring it back</button>
    </div>
    <div id="sidegrip" class="grip" title="drag to resize the reader panel"></div>
    <aside id="side">
      <div id="tabs" role="tablist"></div>
      <div id="reader"></div>
    </aside>
  </div>
</div>`;

export function renderPage(data) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${pageHead(data.title || "canon-atlas")}
</head>
<body>
${APP_MARKUP}
<script>
${readFileSync(join(here, "..", "vendor", "d3.v7.min.js"), "utf8")}
</script>
<script>
var DATA = ${scriptJson(data)};
</script>
<script>
${read("ui/labels.cjs")}
</script>
<script>
${read("ui/resolve.cjs")}
</script>
<script>
${read("ui/app.js")}
</script>
</body>
</html>
`;
}

/* The pure-client app: the same page with no baked-in data. The shared pipeline
   and the folder shell are inlined instead, so it opens a directory in the
   browser, builds the wire data client-side, and mounts. No DATA global means
   app.js waits for the shell to call AtlasApp.mount rather than booting a chart.
   Scripts load in dependency order: d3, labels, resolve, then pipeline (which
   reads the resolve global), then app (which exposes AtlasApp), then shell. */
export function renderAppPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
${pageHead("canon-atlas")}
</head>
<body>
${APP_MARKUP}
<script>
${readFileSync(join(here, "..", "vendor", "d3.v7.min.js"), "utf8")}
</script>
<script>
${read("ui/labels.cjs")}
</script>
<script>
${read("ui/resolve.cjs")}
</script>
<script>
${read("ui/pipeline.cjs")}
</script>
<script>
${read("ui/app.js")}
</script>
<script>
${read("ui/shell.js")}
</script>
</body>
</html>
`;
}
