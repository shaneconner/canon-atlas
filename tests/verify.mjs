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

{
  // The block sequence form, which ordinary Obsidian and Markdown files use.
  const { meta, body } = parseFrontmatter(
    "---\ntitle: Blocked\ntags:\n  - harness\n  - memory\nrefs:\n  - design/decision\nempty:\ntrailing: kept\n---\nThe body.\n"
  );
  assert.equal(meta.title, "Blocked");
  assert.deepEqual(meta.tags, ["harness", "memory"]);
  assert.deepEqual(meta.refs, ["design/decision"]);
  assert.equal(meta.empty, "");
  assert.equal(meta.trailing, "kept");
  assert.equal(body, "The body.\n");
  pass("frontmatter reads block sequences, so ordinary list tags and refs survive");
}

{
  // A closing fence must be an exact line; a rule inside the body does not end it.
  const { meta, body } = parseFrontmatter("---\ntitle: T\n---\nBody with a --- rule below\n\n---\ntail\n");
  assert.equal(meta.title, "T");
  assert.ok(body.startsWith("Body with a --- rule"));
  pass("only an exact fence line closes the frontmatter");
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

{
  // A malformed percent escape in a link target must not crash the scan.
  const root = corpus("badescape", {
    "a.md": "# A\n[bad](bad%ZZ.md) and [[b]]\n",
    "b.md": "# B\n",
  });
  const g = buildGraph(scanCorpus(root, loadConfig(root)));
  const a = g.nodes.find((n) => n.title === "A");
  const outs = g.edges.filter((e) => e.source === a.id).map((e) => g.nodes[e.target].title);
  assert.deepEqual(outs, ["B"]); // the bad target resolves to nothing, [[b]] still lands
  pass("a malformed percent escape resolves to nothing instead of aborting the scan");
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
  assert.equal(journal.reveal, "focus");
  assert.equal(config.collections.find((c) => c.name === "articles").reveal, "always");
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
  const wl = graph.edges.find((e) => e.via === "link");
  assert.equal(graph.nodes[wl.target].address, "pi-canon/design_decisions");
  pass("refs and wikilinks resolve across collections by address");
}

{
  const root = corpus("pathtags", {
    "articles/a.md": '---\ncapsule: "A."\nlegacy-tags: [wiki, "path:pi-canon/x"]\n---\nSee [[b]].\n',
    "articles/b.md": '---\nlegacy-tags: [wiki, "path:pi-canon/x"]\n---\n# B\nBack to [[a]].\n',
    "journal/2026-08-19-e.md": "---\nsubject: [a]\n---\nAn event.\n",
  });
  const config = loadConfig(root);
  const docs = scanCorpus(root, config);
  const a = docs.find((d) => d.path === "articles/a.md");
  assert.deepEqual(a.tags, ["wiki"]);
  assert.equal(a.sourcePath, "pi-canon/x");
  const data = buildData(config, buildGraph(docs), "chart");
  const node = data.nodes.find((n) => n.path === "articles/a.md");
  assert.equal(node.sourcePath, "pi-canon/x");
  assert.ok(data.clusters.length, "no cluster formed, so the label check proves nothing");
  for (const c of data.clusters) {
    assert.ok(!c.label.startsWith("path:"), `a path tag became a cluster label: ${c.label}`);
  }
  pass("a path: tag is source metadata, never a tag and never a cluster label");
}

{
  const root = corpus("pathtags-bare", {
    "one.md": '---\ntags: ["path:deliberate", alpha]\n---\n# One\n[[two]]\n',
    "two.md": "# Two\n",
  });
  const docs = scanCorpus(root, loadConfig(root));
  const one = docs.find((d) => d.path === "one.md");
  assert.deepEqual(one.tags, ["path:deliberate", "alpha"]);
  assert.equal(one.sourcePath, undefined);
  pass("outside the pi-canon preset a path: tag stays a tag");
}

/* --- labels --------------------------------------------------------------------- */

{
  const { createRequire } = await import("node:module");
  const { truncateLabel, assignTiers } = createRequire(import.meta.url)("../src/ui/labels.cjs");

  const short = "a".repeat(46);
  assert.equal(truncateLabel(short), short);
  const wordy = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
  const cutWordy = truncateLabel(wordy);
  assert.ok(cutWordy.endsWith("…") && cutWordy.length <= 45 && !cutWordy.includes("  "));
  assert.equal(cutWordy, wordy.slice(0, wordy.lastIndexOf(" ", 44)) + "…");
  const solid = "x".repeat(80);
  assert.equal(truncateLabel(solid), "x".repeat(44) + "…");
  const emoji = "x" + "\u{1F600}".repeat(30);
  const cutEmoji = truncateLabel(emoji);
  assert.ok(cutEmoji.isWellFormed(), "truncation split a surrogate pair");
  pass("labels cut at a word boundary, hard at 44, and never through a surrogate pair");

  const nodes = [];
  for (let i = 0; i < 159; i++) nodes.push({ exists: true, rank: 1000 - i });
  for (let i = 0; i < 7; i++) nodes.push({ exists: false, rank: 0 });
  assignTiers(nodes);
  const count = (k) => nodes.filter((n) => n._minK === k).length;
  assert.equal(count(0), 8);
  assert.equal(count(0.75), Math.round(159 * 0.2));
  assert.equal(count(1.2), Math.round(159 * 0.4));
  assert.ok(nodes.slice(159).every((n) => n._minK === 1.7), "a phantom label must wait for close zoom");
  const again = nodes.map((n) => ({ exists: n.exists, rank: n.rank }));
  assignTiers(again);
  assert.deepEqual(again.map((n) => n._minK), nodes.map((n) => n._minK));
  pass("zoom tiers split 8, then 20 percent, then 40 percent, deterministically");
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

{
  const root = corpus("reveal", {
    "canon-atlas.json": JSON.stringify({
      collections: [
        { name: "log", match: "log/", reveal: "focus" },
        { name: "rest", match: "" },
      ],
    }),
    "log/one.md": "# One\n",
    "rest.md": "# Rest\n[[one]]\n",
  });
  const config = loadConfig(root);
  assert.equal(config.collections.find((c) => c.name === "log").reveal, "focus");
  assert.equal(config.collections.find((c) => c.name === "rest").reveal, "always");
  const data = buildData(config, buildGraph(scanCorpus(root, config)), "chart");
  assert.equal(data.collections.find((c) => c.name === "log").reveal, "focus");

  const bad = corpus("reveal-bad", {
    "canon-atlas.json": JSON.stringify({ collections: [{ name: "x", match: "", reveal: "sometimes" }] }),
    "a.md": "# A\n",
  });
  assert.throws(() => loadConfig(bad), /unknown reveal/);
  pass("reveal is a validated collection option and rides the wire data");
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

{
  // A basename two documents share must not resolve to a coin-flip winner.
  const root = corpus("ambiguous", {
    "a/index.md": "# A index\n",
    "b/index.md": "# B index\n",
    "hub.md": "# Hub\nSee [[index]] and [[a/index]].\n",
  });
  const g = buildGraph(scanCorpus(root, loadConfig(root)));
  const hub = g.nodes.find((n) => n.title === "Hub");
  const targets = g.edges.filter((e) => e.source === hub.id).map((e) => g.nodes[e.target].path).sort();
  // [[index]] is ambiguous, so it forms no edge and no phantom; [[a/index]] is
  // an exact path and resolves.
  assert.deepEqual(targets, ["a/index.md"]);
  assert.ok(!g.nodes.some((n) => !n.exists && n.title === "index"), "an ambiguous name must not become a phantom");
  pass("an ambiguous name resolves to no edge, not a silent winner");
}

{
  // A relative link that walks above the corpus resolves to nothing rather than
  // clamping onto an unrelated root document.
  const root = corpus("relesc", {
    "x.md": "# X root\n",
    "deep/here.md": "# Here\n[up two](../../x.md) and [up one](../x.md)\n",
  });
  const g = buildGraph(scanCorpus(root, loadConfig(root)));
  const here = g.nodes.find((n) => n.title === "Here");
  const outs = g.edges.filter((e) => e.source === here.id).map((e) => g.nodes[e.target].path);
  // ../x.md from deep/here.md is root x.md and resolves; ../../x.md escapes.
  assert.deepEqual(outs, ["x.md"]);
  pass("a relative link above the corpus root resolves to nothing, never clamps");
}

{
  // Body links and a frontmatter ref between the same pair are two relations,
  // so both survive; two identical body links collapse to one.
  const root = corpus("dualkind", {
    "canon-atlas.json": JSON.stringify({
      collections: [{ name: "art", match: "art/", fields: { refs: "refs" } }],
    }),
    "art/a.md": "---\nrefs:\n  - b\n---\n# A\n[[b]] [[b]]\n",
    "art/b.md": "# B\n",
  });
  const g = buildGraph(scanCorpus(root, loadConfig(root)));
  const a = g.nodes.find((n) => n.title === "A");
  const kinds = g.edges.filter((e) => e.source === a.id).map((e) => e.via).sort();
  assert.deepEqual(kinds, ["link", "ref"]);
  pass("a link and a ref between one pair both survive; identical links dedupe");
}

{
  // Reader resolution must agree with the edge the graph drew, through the one
  // shared resolver.
  const { createRequire } = await import("node:module");
  const { buildIndex, resolveLink, AMBIGUOUS } = createRequire(import.meta.url)("../src/ui/resolve.cjs");
  const docs = [
    { path: "a/index.md", address: "a/index", title: "A index" },
    { path: "b/index.md", address: "b/index", title: "B index" },
    { path: "solo.md", address: "solo", title: "Solo" },
  ];
  const idx = buildIndex(docs);
  assert.equal(resolveLink(idx, "hub.md", "index", "wikilink"), AMBIGUOUS);
  assert.equal(resolveLink(idx, "hub.md", "solo", "wikilink").path, "solo.md");
  assert.equal(resolveLink(idx, "a/note.md", "../solo.md", "mdlink").path, "solo.md");
  assert.equal(resolveLink(idx, "a/note.md", "../../solo.md", "mdlink"), null);
  assert.equal(resolveLink(idx, "hub.md", "missing", "wikilink"), null);
  // A target that names an Object.prototype member must not match an inherited
  // property; the lookup tables carry no prototype.
  for (const magic of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    assert.equal(resolveLink(idx, "hub.md", magic, "wikilink"), null, `${magic} must not resolve`);
  }
  // A leading-slash root-relative target still folds . and .. segments.
  assert.equal(resolveLink(idx, "deep/note.md", "/solo.md", "mdlink").path, "solo.md");
  assert.equal(resolveLink(idx, "deep/note.md", "/a/../solo.md", "mdlink").path, "solo.md");
  pass("the shared resolver is unique on aliases and rejects above-root traversal");
}

{
  // A magic-word reference is still an honest dangling reference: it forms a
  // phantom, not a silent nothing and not a junk built-in.
  const root = corpus("magicref", {
    "a.md": "# A\nSee [[constructor]] and [[toString]].\n",
  });
  const g = buildGraph(scanCorpus(root, loadConfig(root)));
  const phantoms = g.nodes.filter((n) => !n.exists).map((n) => n.title).sort();
  assert.deepEqual(phantoms, ["constructor", "toString"]);
  const a = g.nodes.find((n) => n.title === "A");
  assert.equal(g.edges.filter((e) => e.source === a.id).length, 2);
  pass("a reference named like a built-in is a phantom, not a prototype hit");
}

{
  // foo.md and foo.markdown strip to the same key, so it is ambiguous, not a
  // silent last-writer-wins.
  const { createRequire } = await import("node:module");
  const { buildIndex, resolveLink, AMBIGUOUS } = createRequire(import.meta.url)("../src/ui/resolve.cjs");
  const idx = buildIndex([
    { path: "foo.md", address: "foo", title: "Foo one" },
    { path: "foo.markdown", address: "foo2", title: "Foo two" },
  ]);
  assert.equal(resolveLink(idx, "x.md", "foo", "wikilink"), AMBIGUOUS);
  pass("two files that strip to one path key are ambiguous, not last-wins");
}

{
  // A CRLF-authored document still has its frontmatter parsed and stripped.
  const crlf = "---\r\ntitle: Hello\r\ntags:\r\n  - a\r\n  - b\r\n---\r\nBody line one\r\nsecond\r\n";
  const { meta, body } = parseFrontmatter(crlf);
  assert.equal(meta.title, "Hello");
  assert.deepEqual(meta.tags, ["a", "b"]);
  assert.ok(body.startsWith("Body line one"));
  assert.ok(!body.includes("title:"));
  // A column-zero block sequence is also read.
  const flat = parseFrontmatter("---\ntags:\n- one\n- two\n---\nBody\n");
  assert.deepEqual(flat.meta.tags, ["one", "two"]);
  pass("frontmatter survives CRLF line endings and column-zero sequences");
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

  // Fourteen disjoint pairs: more communities than the ramp can separate.
  const manyNodes = [];
  const manyEdges = [];
  for (let i = 0; i < 28; i += 2) {
    manyNodes.push({ id: i, exists: true, tags: [], rank: 1, title: "n" + i });
    manyNodes.push({ id: i + 1, exists: true, tags: [], rank: 1, title: "n" + (i + 1) });
    manyEdges.push({ source: i, target: i + 1 });
  }
  const capped = assignClusters(manyNodes, manyEdges, null);
  assert.equal(capped.clusters.length, 10);
  assert.ok(manyNodes.some((n) => !capped.assign.has(n.id)), "the tail must stay unclustered");
  pass("the cluster count caps at ten so the ramp keeps separating hues");
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
  // The line and paragraph separators are legal JSON string content but break a
  // script body, so they are escaped, never dropped: a document keeps its text.
  const body = "a" + String.fromCharCode(0x2028) + "b" + String.fromCharCode(0x2029) + "c";
  const sep = scriptJson({ body });
  assert.ok(sep.includes("\\u2028") && sep.includes("\\u2029"));
  assert.deepEqual(JSON.parse(sep), { body });
  pass("data destined for a script tag cannot terminate the tag and loses no characters");
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

{
  // Symlinks must not defeat confinement or immutability: a link out of the
  // tree, and a mutable-collection alias onto an immutable file, are both
  // refused before anything is read or written.
  const root = corpus("symlinkme", {
    "articles/a.md": "# A\n",
    "journal/2026-08-19-e.md": "---\nsubject: [a]\n---\nEvent.\n",
    "outside/secret.md": "# outside\n",
  });
  const { symlinkSync, readFileSync: rf, existsSync: ex } = await import("node:fs");
  symlinkSync(join(root, "outside"), join(root, "articles", "escape"));
  symlinkSync(join(root, "journal", "2026-08-19-e.md"), join(root, "articles", "alias.md"));
  const { server, port } = await serve(root, 0);
  const base = `http://127.0.0.1:${port}`;

  let res = await fetch(base + "/api/doc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "articles/escape/pwn.md", content: "x" }),
  });
  assert.equal(res.status, 400, "a write through a symlinked directory must be refused");
  assert.ok(!ex(join(root, "outside", "pwn.md")), "nothing may land outside the corpus");

  res = await fetch(base + "/api/doc", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "articles/alias.md", content: "REWRITTEN" }),
  });
  assert.equal(res.status, 400, "a mutable alias onto an immutable file must be refused");
  assert.equal(rf(join(root, "journal", "2026-08-19-e.md"), "utf8"), "---\nsubject: [a]\n---\nEvent.\n");
  pass("a symlink cannot escape the corpus or rewrite an immutable file");

  server.close();
}

{
  // The browser is not a boundary that 127.0.0.1 alone establishes: a rebound
  // Host, a cross-origin Origin, and a non-JSON POST are all refused.
  const root = corpus("browserguard", { "a.md": "# A\n" });
  const { server, port } = await serve(root, 0);
  const base = `http://127.0.0.1:${port}`;

  let res = await fetch(base + "/api/doc", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ path: "csrf.md", content: "x" }),
  });
  assert.equal(res.status, 415, "a non-JSON POST must be refused");

  res = await fetch(base + "/api/doc", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ path: "csrf.md", content: "x" }),
  });
  assert.equal(res.status, 403, "a cross-origin write must be refused");

  // fetch forbids overriding Host, so drive a raw request to rebind it.
  const http = await import("node:http");
  const rebound = await new Promise((resolve) => {
    const rq = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/api/doc",
        headers: { "Content-Type": "application/json", Host: "attacker.test" } },
      (r) => { r.resume(); resolve(r.statusCode); }
    );
    rq.end(JSON.stringify({ path: "csrf.md", content: "x" }));
  });
  assert.equal(rebound, 403, "a non-loopback Host must be refused");

  res = await fetch(base + "/api/doc", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ path: "ok.md", content: "x" }),
  });
  assert.equal(res.status, 201, "a same-origin JSON write is allowed");
  pass("the editing API refuses cross-origin, non-JSON, and rebound-Host requests");

  server.close();
}

{
  // A busy port surfaces as a rejected promise the CLI can catch, not an
  // unhandled event.
  const root = corpus("portclash", { "a.md": "# A\n" });
  const { server, port } = await serve(root, 0);
  await assert.rejects(serve(root, port), /EADDRINUSE|address|listen/i);
  pass("a listen failure rejects instead of throwing loose");
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
