/* Link graph: resolve every authored link against the scanned corpus, keep the
   ones that land, and surface the ones that do not as phantom nodes, because a
   dangling reference is a fact about the corpus rather than an error. Resolution
   runs through the shared resolver the reader also uses, so an edge the graph
   draws is a link the reader can follow. */

import { createRequire } from "node:module";
const { AMBIGUOUS, buildIndex, resolveLink } = createRequire(import.meta.url)("./ui/resolve.cjs");

/* Two authored link kinds render identically (a plain link), so they collapse
   to one edge kind; a frontmatter ref stays distinct. Both survive between the
   same pair, because a document that links to and also refers to another states
   two different relations. */
function edgeVia(via) {
  return via === "ref" ? "ref" : "link";
}

export function pagerank(n, outLinks, damping = 0.85, iters = 50) {
  let rank = new Array(n).fill(1 / n);
  for (let it = 0; it < iters; it++) {
    const next = new Array(n).fill((1 - damping) / n);
    let sinkMass = 0;
    for (let i = 0; i < n; i++) {
      const outs = outLinks[i];
      if (!outs.length) {
        sinkMass += rank[i];
        continue;
      }
      const share = (damping * rank[i]) / outs.length;
      for (const j of outs) next[j] += share;
    }
    const sinkShare = (damping * sinkMass) / n;
    for (let i = 0; i < n; i++) next[i] += sinkShare;
    rank = next;
  }
  return rank;
}

/* Docs in, graph out: nodes carry the document plus its measures, edges carry
   resolved references. Unresolved wikilink targets become phantom nodes shared
   by every document that names them. */
export function buildGraph(docs) {
  const index = buildIndex(docs);
  const nodes = docs.map((d) => ({ ...d, exists: true }));
  const idOf = new Map(nodes.map((n, i) => [n.path, i]));
  const phantoms = new Map();
  const edgeSet = new Set();
  const edges = [];

  for (const d of docs) {
    const from = idOf.get(d.path);
    for (const link of d.links) {
      const hit = resolveLink(index, d.path, link.target, link.via);
      let to;
      if (hit === AMBIGUOUS) {
        // A name two documents share resolves to neither: no invented edge.
        continue;
      } else if (hit) {
        to = idOf.get(hit.path);
      } else {
        if (link.via === "mdlink") continue; // a broken file path is noise, not a phantom
        const key = link.target.toLowerCase();
        if (!phantoms.has(key)) {
          phantoms.set(key, nodes.length);
          nodes.push({
            path: "",
            address: link.target,
            collection: "",
            immutable: true,
            title: link.target,
            tags: [],
            date: "",
            summary: "",
            body: "",
            links: [],
            exists: false,
          });
        }
        to = phantoms.get(key);
      }
      if (to === from || to == null) continue;
      const via = edgeVia(link.via);
      const key = from + ">" + to + ">" + via;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ source: from, target: to, via });
    }
  }

  const degree = new Array(nodes.length).fill(0);
  const outLinks = nodes.map(() => []);
  for (const e of edges) {
    degree[e.source]++;
    degree[e.target]++;
    outLinks[e.source].push(e.target);
  }
  const rank = pagerank(nodes.length, outLinks);
  nodes.forEach((n, i) => {
    n.id = i;
    n.degree = degree[i];
    n.rank = rank[i];
    delete n.links;
  });
  return { nodes, edges };
}
