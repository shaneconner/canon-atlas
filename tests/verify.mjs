/* The gate suite. Every gate is one named invariant; the suite passes only when
   all do. Run: node tests/verify.mjs */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, collectionFor } from "../src/config.mjs";
import { parseFrontmatter, extractLinks, scanCorpus } from "../src/scan.mjs";
import { buildGraph, pagerank } from "../src/graph.mjs";
import { communities, assignClusters } from "../src/clusters.mjs";
import { renderMarkdown } from "../src/markdown.mjs";
import { scriptJson, buildData } from "../src/page.mjs";
import { build } from "../src/build.mjs";
import { serve } from "../src/serve.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
let gates = 0;
const pass = (name) => console.log(`ok ${String(++gates).padStart(2)} ${name}`);

const work = mkdtempSync(join(tmpdir(), "canon-atlas-verify-"));

function corpus(name, files) {
  const root = join(work, name);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

/* --- frontmatter ---------------------------------------------------------------- */

{
  const { meta, body } = parseFrontmatter(
    '---\ncapsule: "A one, liner"\ntags: [alpha, "beta"]\nupdated: 2026-08-12\nnested:\n  inner: skipped\n---\nThe body.\n'
  );
  assert.equal(meta.capsule, "A one, liner");
  assert.deepEqual(meta.tags, ["alpha", "beta"]);
  assert.equal(meta.updated, "2026-08-12");
  assert.equal(body, "The body.\n");
  pass("frontmatter reads scalars, quotes, and inline arrays; nested blocks pass through");
}

{
  const { meta, body } = parseFrontmatter("no fences here\n");
  assert.deepEqual(meta, {});
  assert.equal(body, "no fences here\n");
  pass("a document without frontmatter is all body");
}

/* --- link extraction ------------------------------------------------------------ */

{
  const links = extractLinks(
    "See [[lab/evolving-canon]] and [[Design Decisions|the record]] and [[deep#section]].\n" +
      "Also [neighbor](../other/neighbor.md) and [site](https://example.com) and [top](#local).\n" +
      "```\n[[not-a-link]]\n```\nand `[[also-not]]` inline.\n"
  );
  assert.deepEqual(
    links.map((l) => l.target),
    ["lab/evolving-canon", "Design Decisions", "deep", "../other/neighbor.md"]
  );
  assert.equal(links[3].via, "mdlink");
  pass("wikilinks, aliases, sections, and relative md links extract; code and URLs do not");
}

/* --- config --------------------------------------------------------------------- */

{
  const root = corpus("preset", {
    "articles/pi-canon/design_decisions.md":
      '---\ncapsule: "The record."\nupdated: 2026-08-12\nlegacy-tags: [wiki, system]\n---\nAddressing rules.\n',
    "articles/lab/evolving-canon.md": "---\ncapsule: \"Lab line.\"\n---\nSee [[pi-canon/design_decisions]].\n",
    "journal/2026-08-19-entry.md": "---\nsubject: [lab/evolving-canon]\nlogged: 2026-08-19T10:00:00Z\n---\nAn event.\n",
  });
  const config = loadConfig(root);
  assert.equal(config.preset, "pi-canon");
  const journal = config.collections.find((c) => c.name === "journal");
  assert.equal(journal.immutable, true);
  assert.equal(collectionFor(config, "articles/x.md").name, "articles");
  assert.equal(collectionFor(config, "notes.md"), null);
  pass("a root holding articles/ and journal/ gets the pi-canon preset, journal immutable");

  const docs = scanCorpus(root, config);
  const dd = docs.find((d) => d.path === "articles/pi-canon/design_decisions.md");
  assert.equal(dd.address, "pi-canon/design_decisions");
  assert.equal(dd.summary, "The record.");
  assert.equal(dd.date, "2026-08-12");
  assert.deepEqual(dd.tags, ["wiki", "system"]);
  const j = docs.find((d) => d.collection === "journal");
  assert.deepEqual(j.links, [{ target: "lab/evolving-canon", via: "ref" }]);
  pass("the preset maps capsule, updated, legacy-tags, and journal subject onto the atlas fields");

  const graph = buildGraph(docs);
  const edge = graph.edges.find((e) => e.via === "ref");
  assert.equal(graph.nodes[edge.target].address, "lab/evolving-canon");
  const wl = graph.edges.find((e) => e.via === "wikilink");
  assert.equal(graph.nodes[wl.target].address, "pi-canon/design_decisions");
  pass("refs and wikilinks resolve across collections by address");
}

{
  const root = corpus("custom", {
    "canon-atlas.json": JSON.stringify({
      title: "custom corpus",
      collections: [
        { name: "wiki", match: "wiki" },
        { name: "wiki-meta", match: "wiki/meta/", immutable: true },
      ],
    }),
    "wiki/a.md": "# Alpha\n[[b]]\n",
    "wiki/meta/b.md": "# Beta\n",
    "loose.md": "# Loose\n",
  });
  const config = loadConfig(root);
  assert.equal(config.title, "custom corpus");
  assert.equal(collectionFor(config, "wiki/meta/b.md").name, "wiki-meta");
  assert.equal(collectionFor(config, "wiki/a.md").name, "wiki");
  assert.equal(collectionFor(config, "loose.md"), null);
  const docs = scanCorpus(root, config);
  assert.deepEqual(docs.map((d) => d.path).sort(), ["wiki/a.md", "wiki/meta/b.md"]);
  pass("an explicit config claims by longest prefix and leaves unclaimed files out");
}

{
  const root = corpus("bare", { "one.md": "# One\n[[two]]\n", "two.md": "# Two\n" });
  const config = loadConfig(root);
  assert.equal(config.preset, "default");
  assert.equal(collectionFor(config, "anything.md").name, "notes");
  pass("a bare directory of markdown is one mutable collection");
}

/* --- graph ---------------------------------------------------------------------- */

{
  const root = corpus("graph", {
    "a.md": "# Alpha\n[[b]] [[b]] [[ghost]] [[Alpha]]\n[rel](sub/c.md) [broken](nope/missing.md)\n",
    "b.md": "# Beta\n[[ghost]]\n",
    "sub/c.md": "# Gamma\n[up](../a.md)\n",
  });
  const docs = scanCorpus(root, loadConfig(root));
  const g = buildGraph(docs);
  const byTitle = Object.fromEntries(g.nodes.map((n) => [n.title, n]));
  assert.equal(byTitle.Alpha.exists, true);
  assert.equal(byTitle.ghost.exists, false);
  const aOut = g.edges.filter((e) => e.source === byTitle.Alpha.id);
  assert.equal(aOut.length, 3); // b once, ghost once, sub/c once; self and broken dropped
  const ghostIn = g.edges.filter((e) => e.target === byTitle.ghost.id);
  assert.equal(ghostIn.length, 2);
  const up = g.edges.find((e) => e.source === byTitle.Gamma.id);
  assert.equal(g.nodes[up.target].title, "Alpha");
  pass("edges dedupe, self-links and broken file paths drop, phantoms are shared");

  const rankSum = g.nodes.reduce((s, n) => s + n.rank, 0);
  assert.ok(Math.abs(rankSum - 1) < 1e-6);
  pass("pagerank is a distribution over the nodes");
}

{
  const r1 = pagerank(3, [[1], [2], []]);
  const r2 = pagerank(3, [[1], [2], []]);
  assert.deepEqual(r1, r2);
  assert.ok(r1[2] > r1[0]);
  pass("pagerank is deterministic and flows toward the pointed-at");
}

/* --- clusters ------------------------------------------------------------------- */

{
  // Two cliques joined by one bridge: label propagation should find both sides.
  const edges = [];
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) edges.push({ source: i, target: j });
  for (let i = 5; i < 10; i++) for (let j = i + 1; j < 10; j++) edges.push({ source: i, target: j });
  edges.push({ source: 4, target: 5 });
  const labels = communities(10, edges);
  const left = new Set(labels.slice(0, 4));
  const right = new Set(labels.slice(6));
  assert.equal(left.size, 1);
  assert.equal(right.size, 1);
  assert.notEqual([...left][0], [...right][0]);
  assert.deepEqual(labels, communities(10, edges));
  pass("greedy modularity separates a barbell and is deterministic");
}

{
  // Four orthogonal direction groups in 8 dimensions; k-means must keep them pure.
  const nodes = [];
  const vectors = {};
  for (let g = 0; g < 4; g++) {
    for (let i = 0; i < 8; i++) {
      const id = nodes.length;
      const path = `docs/g${g}-${i}.md`;
      nodes.push({ id, path, exists: true, tags: [`group-${g}`], rank: 1, title: path });
      const v = new Array(8).fill(0);
      v[g * 2] = 1;
      v[g * 2 + 1] = 0.2 + 0.01 * i;
      vectors[path] = v;
    }
  }
  const a = assignClusters(nodes, [], vectors);
  assert.equal(a.basis, "embeddings");
  const seen = new Map();
  for (const n of nodes) {
    const c = a.assign.get(n.id);
    assert.notEqual(c, undefined);
    const g = n.tags[0];
    if (seen.has(c)) assert.equal(seen.get(c), g, "a cluster mixed two true groups");
    seen.set(c, g);
  }
  const b = assignClusters(nodes, [], vectors);
  assert.deepEqual([...a.assign.entries()], [...b.assign.entries()]);
  pass("embedding k-means keeps separated groups pure and is deterministic");

  const linkEdges = [];
  for (let g = 0; g < 4; g++) {
    for (let i = 1; i < 8; i++) linkEdges.push({ source: g * 8, target: g * 8 + i });
  }
  const noVec = assignClusters(nodes, linkEdges, null);
  assert.equal(noVec.basis, "links");
  assert.equal(noVec.clusters.length, 4);
  const bare = assignClusters(nodes, [], null);
  assert.equal(bare.basis, "none");
  pass("without vectors clustering falls back to link structure, and an unlinked corpus has no clusters");
}

/* --- markdown ------------------------------------------------------------------- */

{
  const html = renderMarkdown(
    "# Title\n\nBody with **bold** and `code` and [[target|alias]] and [ext](https://x.dev).\n\n- one\n- two\n\n```\n<script>alert(1)</script>\n```\n"
  );
  assert.ok(html.includes("<h2>Title</h2>"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<code>code</code>"));
  assert.ok(html.includes('data-target="target"') && html.includes(">alias</a>"));
  assert.ok(html.includes('target="_blank"'));
  assert.ok(html.includes("<li>one</li>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  pass("the reader renders structure and never lets a document inject markup");
}

{
  const s = scriptJson({ body: "</script><script>alert(1)</script>" });
  assert.ok(!s.includes("</script>"));
  pass("data destined for a script tag cannot terminate the tag");
}

/* --- build ---------------------------------------------------------------------- */

{
  const root = corpus("buildme", {
    "articles/core.md": "---\ncapsule: \"The core.\"\n---\nSee [[helper]].\n",
    "articles/helper.md": "# Helper\nBack to [[core]].\n",
    "journal/2026-08-19-x.md": "---\nsubject: [core]\n---\nEvent.\n",
  });
  const out = join(work, "atlas.html");
  const r = build(root, out);
  assert.equal(r.documents, 3);
  const html = readFileSync(out, "utf8");
  assert.ok(html.includes("var DATA ="));
  assert.ok(html.includes("d3.forceSimulation") || /d3/.test(html));
  assert.ok(!/<script[^>]*\ssrc=/.test(html), "no external scripts");
  assert.ok(!/<img/.test(html), "no images");
  for (const m of html.matchAll(/<link[^>]*href="([^"]+)"/g)) {
    assert.ok(m[1].startsWith("https://fonts.g"), `unexpected external link: ${m[1]}`);
  }
  pass("the chart is one self-contained file, fonts aside");

  const config = loadConfig(root);
  const data = buildData(config, buildGraph(scanCorpus(root, config)), "chart");
  const core = data.nodes.find((n) => n.path === "articles/core.md");
  assert.equal(core.summary, "The core.");
  assert.ok(core.html.includes('data-target="helper"'));
  const journalCol = data.collections.find((c) => c.name === "journal");
  assert.equal(journalCol.count, 1);
  pass("the wire data carries rendered bodies, summaries, and collection counts");
}

/* --- serve ---------------------------------------------------------------------- */

{
  const root = corpus("liveme", {
    "articles/a.md": "# A\n[[b]]\n",
    "articles/b.md": "# B\n",
    "journal/2026-08-19-e.md": "---\nsubject: [a]\n---\nEvent.\n",
  });
  const { server, port } = await serve(root, 0);
  const base = `http://127.0.0.1:${port}`;
  const j = (r) => r.json();

  const page = await (await fetch(base + "/")).text();
  assert.ok(page.includes('"mode":"live"'));
  const g1 = await j(await fetch(base + "/api/graph"));
  assert.equal(g1.nodes.filter((n) => n.exists).length, 3);

  let res = await fetch(base + "/api/doc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "articles/c.md", content: "# C\nLinks [[a]].\n" }),
  });
  assert.equal(res.status, 201);
  const g2 = await j(await fetch(base + "/api/graph"));
  assert.equal(g2.nodes.filter((n) => n.exists).length, 4);
  pass("a created document lands on disk and in the next graph");

  res = await fetch(base + "/api/doc", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "articles/c.md", content: "# C revised\n" }),
  });
  assert.equal(res.status, 200);
  const doc = await j(await fetch(base + "/api/doc?path=" + encodeURIComponent("articles/c.md")));
  assert.equal(doc.raw, "# C revised\n");
  res = await fetch(base + "/api/doc?path=" + encodeURIComponent("articles/c.md"), { method: "DELETE" });
  assert.equal(res.status, 200);
  pass("edit, read back, and delete round-trip through the API");

  res = await fetch(base + "/api/doc", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "journal/2026-08-19-e.md", content: "rewrite" }),
  });
  assert.equal(res.status, 403);
  res = await fetch(base + "/api/doc?path=" + encodeURIComponent("journal/2026-08-19-e.md"), { method: "DELETE" });
  assert.equal(res.status, 403);
  res = await fetch(base + "/api/doc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "journal/2026-08-19-new.md", content: "---\nsubject: [a]\n---\nNew event.\n" }),
  });
  assert.equal(res.status, 201);
  pass("an immutable collection is append-only: create lands, edit and delete refuse");

  for (const bad of ["../outside.md", "/etc/owned.md", "articles/../../up.md", "articles/x.txt"]) {
    res = await fetch(base + "/api/doc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: bad, content: "x" }),
    });
    assert.equal(res.status, 400, `expected 400 for ${bad}`);
  }
  pass("no write escapes the corpus root");

  server.close();
}

/* --- cli ------------------------------------------------------------------------ */

{
  const root = corpus("cli", { "one.md": "# One\n[[two]]\n", "two.md": "# Two\n" });
  const out = join(work, "cli-atlas.html");
  const r = spawnSync(process.execPath, [join(projectRoot, "src/cli.mjs"), "build", root, "-o", out], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(out, "utf8").includes("var DATA ="));
  const help = spawnSync(process.execPath, [join(projectRoot, "src/cli.mjs")], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes("usage:"));
  pass("the CLI builds a chart and explains itself");
}

console.log(`\nall ${gates} gates green`);
