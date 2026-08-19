/* Semantic clusters: the color and region signal for the constellation.

   Two bases, one contract. When the corpus ships embedding vectors, spherical
   k-means over them yields thematic neighborhoods, which is the best looking
   and best separated signal. Without vectors, deterministic label propagation
   over the link graph still finds real neighborhoods at zero cost. Either way
   the result is the same shape, and a node no basis can place stays null. */

const MIN_DOCS = 8;
const K_MIN = 4;
const K_MAX = 10;
/* A ramp only separates so many hues; past this the tail of small communities
   stays unclustered rather than shredding the palette. Matches K_MAX. */
const MAX_CLUSTERS = 10;

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ── link communities ─────────────────────────────────────────────────────── */

/* Greedy modularity, the node-moving phase of Louvain, swept in fixed order so
   the result is deterministic. Naive label propagation with a smallest-label
   tie-break floods one label across any bridge; modularity gain weighs a move
   by how much denser it makes the community, so a bridge stays a bridge. */
export function communities(n, edges, sweeps = 50) {
  const adj = Array.from({ length: n }, () => []);
  for (const e of edges) {
    adj[e.source].push(e.target);
    adj[e.target].push(e.source);
  }
  const deg = adj.map((a) => a.length);
  const m2 = 2 * edges.length;
  const comm = Array.from({ length: n }, (_, i) => i);
  if (!m2) return comm;
  const degSum = deg.slice();
  for (let s = 0; s < sweeps; s++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      if (!deg[i]) continue;
      const old = comm[i];
      degSum[old] -= deg[i];
      const kin = new Map();
      for (const j of adj[i]) {
        if (j === i) continue;
        kin.set(comm[j], (kin.get(comm[j]) || 0) + 1);
      }
      let best = old;
      let bestGain = (kin.get(old) || 0) - (deg[i] * degSum[old]) / m2;
      for (const [c, k] of [...kin.entries()].sort((a, b) => a[0] - b[0])) {
        const gain = k - (deg[i] * degSum[c]) / m2;
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          best = c;
        }
      }
      comm[i] = best;
      degSum[best] += deg[i];
      if (best !== old) moved++;
    }
    if (!moved) break;
  }
  return comm;
}

/* ── embedding k-means ────────────────────────────────────────────────────── */

function normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return v.map((x) => x / s);
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function kmeans(vecs, k, rand) {
  const n = vecs.length;
  // k-means++ seeding on cosine distance.
  const centers = [vecs[Math.floor(rand() * n)]];
  while (centers.length < k) {
    const d = vecs.map((v) => Math.min(...centers.map((c) => 1 - dot(v, c))));
    const total = d.reduce((a, b) => a + b, 0) || 1;
    let pick = rand() * total;
    let idx = 0;
    while (pick > d[idx] && idx < n - 1) pick -= d[idx++];
    centers.push(vecs[idx]);
  }
  let assign = new Array(n).fill(0);
  for (let it = 0; it < 40; it++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestSim = -2;
      for (let c = 0; c < k; c++) {
        const s = dot(vecs[i], centers[c]);
        if (s > bestSim) {
          bestSim = s;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        moved++;
      }
    }
    for (let c = 0; c < k; c++) {
      const members = [];
      for (let i = 0; i < n; i++) if (assign[i] === c) members.push(i);
      if (!members.length) continue;
      const dim = vecs[0].length;
      const mean = new Array(dim).fill(0);
      for (const i of members) for (let d = 0; d < dim; d++) mean[d] += vecs[i][d];
      centers[c] = normalize(mean);
    }
    if (!moved) break;
  }
  return assign;
}

function silhouette(vecs, assign, k) {
  const n = vecs.length;
  const stride = Math.max(1, Math.floor(n / 400));
  let total = 0;
  let count = 0;
  for (let i = 0; i < n; i += stride) {
    const within = [];
    const between = new Map();
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const d = 1 - dot(vecs[i], vecs[j]);
      if (assign[j] === assign[i]) within.push(d);
      else {
        const arr = between.get(assign[j]) || [];
        arr.push(d);
        between.set(assign[j], arr);
      }
    }
    if (!within.length || !between.size) continue;
    const a = within.reduce((x, y) => x + y, 0) / within.length;
    let b = Infinity;
    for (const arr of between.values()) b = Math.min(b, arr.reduce((x, y) => x + y, 0) / arr.length);
    total += (b - a) / Math.max(a, b);
    count++;
  }
  return count ? total / count : -1;
}

/* ── shared shaping ───────────────────────────────────────────────────────── */

function shape(nodes, memberIds) {
  // memberIds: raw label -> member node ids. Singleton groups stay unplaced.
  const groups = [...memberIds.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0] - b[0])
    .slice(0, MAX_CLUSTERS);
  const clusters = [];
  const assign = new Map();
  groups.forEach(([, ids], i) => {
    const tagVotes = new Map();
    for (const id of ids) {
      for (const t of nodes[id].tags) tagVotes.set(t, (tagVotes.get(t) || 0) + 1);
    }
    let label = "";
    let best = 0;
    for (const [t, c] of [...tagVotes.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
      if (c > best) {
        best = c;
        label = t;
      }
    }
    if (!label) {
      const top = ids.slice().sort((a, b) => nodes[b].rank - nodes[a].rank)[0];
      label = nodes[top].title;
    }
    clusters.push({ id: i, label, size: ids.length });
    for (const id of ids) assign.set(id, i);
  });
  const pos = clusters.length > 1 ? clusters.map((_, i) => i / (clusters.length - 1)) : [0.5];
  clusters.forEach((c, i) => (c.pos = pos[i]));
  return { clusters, assign };
}

export function assignClusters(nodes, edges, vectors) {
  const docs = nodes.filter((n) => n.exists);
  if (vectors && docs.filter((d) => vectors[d.path]).length >= MIN_DOCS) {
    const withVec = docs.filter((d) => vectors[d.path]);
    const vecs = withVec.map((d) => normalize(vectors[d.path]));
    const kTop = Math.min(K_MAX, Math.floor(withVec.length / 2));
    let bestAssign = null;
    let bestScore = -2;
    for (let k = K_MIN; k <= Math.max(K_MIN, kTop); k++) {
      const a = kmeans(vecs, k, lcg(42));
      const s = silhouette(vecs, a, k);
      if (s > bestScore) {
        bestScore = s;
        bestAssign = a;
      }
    }
    const memberIds = new Map();
    withVec.forEach((d, i) => {
      const arr = memberIds.get(bestAssign[i]) || [];
      arr.push(d.id);
      memberIds.set(bestAssign[i], arr);
    });
    return { basis: "embeddings", ...shape(nodes, memberIds) };
  }

  const labels = communities(nodes.length, edges);
  const memberIds = new Map();
  for (const n of nodes) {
    if (!n.exists) continue;
    const arr = memberIds.get(labels[n.id]) || [];
    arr.push(n.id);
    memberIds.set(labels[n.id], arr);
  }
  const shaped = shape(nodes, memberIds);
  return { basis: shaped.clusters.length ? "links" : "none", ...shaped };
}
