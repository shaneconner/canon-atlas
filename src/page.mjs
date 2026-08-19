/* Page assembly: one self-contained HTML document. d3, the stylesheet, the app,
   and the graph data are all inlined, so the chart opens from file:// and ships
   as a single artifact. The only external reference is the Google Fonts
   stylesheet, and the page falls back to system fonts without it. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "./markdown.mjs";
import { assignClusters } from "./clusters.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), "utf8");

/* JSON destined for a script tag: escape the characters that could terminate
   the tag or open one, so a document body can never break out of the data. */
export function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildData(config, graph, mode) {
  const { nodes, edges } = graph;
  const { basis, clusters, assign } = assignClusters(
    nodes,
    edges,
    config.vectors || null
  );
  const counts = new Map();
  for (const n of nodes) {
    if (n.exists) counts.set(n.collection, (counts.get(n.collection) || 0) + 1);
  }
  return {
    title: config.title,
    preset: config.preset,
    mode,
    basis,
    collections: config.collections.map((c) => ({
      name: c.name,
      match: c.match,
      immutable: c.immutable,
      reveal: c.reveal,
      count: counts.get(c.name) || 0,
    })),
    clusters,
    nodes: nodes.map((n) => ({
      id: n.id,
      path: n.path,
      sourcePath: n.sourcePath,
      address: n.address,
      collection: n.collection,
      immutable: n.immutable,
      title: n.title,
      tags: n.tags,
      date: n.date,
      summary: n.summary,
      cluster: assign.has(n.id) ? assign.get(n.id) : null,
      exists: n.exists,
      degree: n.degree,
      rank: n.rank,
      html: n.body ? renderMarkdown(n.body) : "",
    })),
    edges,
  };
}

export function renderPage(data) {
  const title = data.title || "canon-atlas";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/[<>&]/g, "")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500&display=swap" rel="stylesheet">
<style>
${read("ui/style.css")}
</style>
</head>
<body>
<div id="app">
  <header id="bar">
    <span id="brand"></span>
    <input id="search" type="search" placeholder="search  ( / )" autocomplete="off" spellcheck="false">
    <span id="count"></span>
    <span id="chips"></span>
    <select id="colorby" class="abtn" aria-label="color by">
      <option value="cluster">color: cluster</option>
      <option value="collection">color: collection</option>
      <option value="tag">color: tag</option>
    </select>
    <button id="refit" class="abtn" title="clear the selection and frame the whole corpus">refit</button>
  </header>
  <div id="grid">
    <div id="stage"></div>
    <aside id="side"></aside>
  </div>
</div>
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
