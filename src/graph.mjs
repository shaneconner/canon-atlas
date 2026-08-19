/* Link graph: resolve every authored link against the scanned corpus, keep the
   ones that land, and surface the ones that do not as phantom nodes, because a
   dangling reference is a fact about the corpus rather than an error. */

function normalizeRel(baseDir, target) {
  const parts = (baseDir ? baseDir.split("/") : []).concat(target.split("/"));
  const out = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

function buildIndex(docs) {
  const byPath = new Map(); // root-relative path minus extension
  const byAddress = new Map();
  const byName = new Map(); // lowercase basename
  const byTitle = new Map();
  const claim = (map, key, doc) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, doc);
  };
  for (const d of docs) {
    claim(byPath, d.path.replace(/\.(md|markdown)$/i, ""), d);
    claim(byAddress, d.address, d);
    claim(byName, d.address.split("/").pop().toLowerCase(), d);
    claim(byTitle, d.title.toLowerCase(), d);
  }
  return { byPath, byAddress, byName, byTitle };
}

function resolve(index, doc, link) {
  const t = link.target.replace(/\.(md|markdown)$/i, "");
  if (link.via === "mdlink") {
    const dir = doc.path.includes("/") ? doc.path.slice(0, doc.path.lastIndexOf("/")) : "";
    const abs = normalizeRel(dir, t);
    return index.byPath.get(abs) || index.byPath.get(t) || null;
  }
  return (
    index.byPath.get(t) ||
    index.byAddress.get(t) ||
    index.byName.get(t.toLowerCase()) ||
    index.byTitle.get(t.toLowerCase()) ||
    null
  );
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
      const hit = resolve(index, d, link);
      let to;
      if (hit) {
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
      const key = from + ">" + to;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ source: from, target: to, via: link.via });
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
