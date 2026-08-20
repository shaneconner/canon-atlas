/* The isomorphic data pipeline: corpus text in, wire data out, byte-identical
   in Node and the browser. The CLI build/serve path requires this in Node; the
   pure-client app inlines it as a plain script, where the module guard at the
   foot is skipped and it reads the AtlasResolve global instead of requiring it.

   Everything here is pure: strings and plain data, no filesystem, no network,
   no clock. The Node wrappers (config.mjs, scan.mjs, graph.mjs, clusters.mjs,
   markdown.mjs, page.mjs) keep only their fs edges and re-export these, so one
   implementation feeds both worlds and the two can never drift. */

var AtlasPipeline = (function () {
  var Resolve =
    typeof require !== "undefined"
      ? require("./resolve.cjs")
      : typeof AtlasResolve !== "undefined"
        ? AtlasResolve
        : null;
  const { AMBIGUOUS, buildIndex, resolveLink } = Resolve;

  /* ── configuration ────────────────────────────────────────────────────────
     Which files belong to which collection, how frontmatter maps onto the
     fields the atlas reads, and where optional embeddings live. buildConfig is
     the pure core of loadConfig once the raw object is chosen; the Node wrapper
     picks it from a file or directory shape, the browser from the file list. */

  const CONFIG_NAME = "canon-atlas.json";

  const FIELD_DEFAULTS = { title: "title", tags: "tags", date: "date", summary: "summary", refs: "refs" };

  const PI_CANON_PRESET = {
    preset: "pi-canon",
    collections: [
      {
        name: "articles",
        match: "articles/",
        immutable: false,
        fields: { summary: "capsule", date: "updated", tags: "legacy-tags" },
      },
      {
        name: "journal",
        match: "journal/",
        immutable: true,
        reveal: "focus",
        fields: { date: "logged", refs: "subject" },
      },
    ],
  };

  const DEFAULT_CONFIG = {
    preset: "default",
    collections: [{ name: "notes", match: "", immutable: false, fields: {} }],
  };

  const REVEALS = new Set(["always", "focus", "off"]);

  function normalizeCollection(c) {
    if (!c || typeof c.name !== "string" || !c.name) throw new Error("collection needs a name");
    let match = typeof c.match === "string" ? c.match : "";
    match = match.replace(/^\.?\//, "");
    if (match && !match.endsWith("/")) match += "/";
    const reveal = c.reveal ?? "always";
    if (!REVEALS.has(reveal)) throw new Error(`unknown reveal: ${reveal}`);
    return {
      name: c.name,
      match,
      immutable: !!c.immutable,
      reveal,
      fields: { ...FIELD_DEFAULTS, ...(c.fields || {}) },
    };
  }

  /* A raw config object (an explicit canon-atlas.json, or one of the presets)
     into the normalized shape the rest of the pipeline reads. */
  function buildConfig(raw) {
    raw = raw || DEFAULT_CONFIG;
    const collections = (raw.collections || DEFAULT_CONFIG.collections).map(normalizeCollection);
    // Longest prefix claims the file, so an inner directory can override an outer one.
    collections.sort((a, b) => b.match.length - a.match.length);
    return {
      preset: raw.preset || "custom",
      title: raw.title || "",
      collections,
      embeddings: raw.embeddings || "embeddings.json",
    };
  }

  /* No explicit config: a corpus that holds both an articles/ and a journal/
     directory is a pi-canon store, anything else is one mutable collection.
     relPaths are the root-relative markdown paths the browser already listed. */
  /* A config that names a title but no collections keeps the detected preset:
     naming your workspace must not cost you the pi-canon shape. */
  function composeConfig(raw, detect) {
    if (!raw) return detect();
    if (raw.collections) return raw;
    return Object.assign({}, detect(), raw);
  }

  function detectPreset(relPaths) {
    for (const prefix of ["", ".canon/"]) {
      let hasArticles = false;
      let hasJournal = false;
      for (const p of relPaths) {
        if (p.startsWith(prefix + "articles/")) hasArticles = true;
        if (p.startsWith(prefix + "journal/")) hasJournal = true;
      }
      if (hasArticles && hasJournal) {
        if (!prefix) return PI_CANON_PRESET;
        return Object.assign({}, PI_CANON_PRESET, {
          collections: PI_CANON_PRESET.collections.map((c) =>
            Object.assign({}, c, { match: prefix + c.match })),
        });
      }
    }
    return DEFAULT_CONFIG;
  }

  /* Optional embedding vectors: a parsed JSON object of root-relative markdown
     path to an array of floats. Keep only the numeric-array entries; null when
     none survive, so clustering falls back to link structure. */
  function parseVectors(raw) {
    if (!raw || typeof raw !== "object") return null;
    const out = {};
    for (const k of Object.keys(raw)) {
      const v = raw[k];
      if (Array.isArray(v) && v.every((x) => typeof x === "number")) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  }

  /* The collection a root-relative markdown path belongs to, or null when no
     collection claims it and there is no catch-all. */
  function collectionFor(config, relPath) {
    for (const c of config.collections) {
      if (relPath.startsWith(c.match)) return c;
    }
    return null;
  }

  /* ── frontmatter and links ─────────────────────────────────────────────────
     Parse flat frontmatter and pull the links each document actually authors. */

  const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  const MDLINK_RE = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

  /* Frontmatter between --- fences: `key: value` scalars and inline `[a, b]`
     arrays, plus the block sequence form
         tags:
           - one
           - two
     which is how ordinary Obsidian and Markdown files write lists. A key whose
     value is empty and is followed by indented `- item` lines takes them as its
     array. Other nested structures this tool does not read pass through. */
  function parseFrontmatter(text) {
    if (!text.startsWith("---")) return { meta: {}, body: text };
    const firstNl = text.indexOf("\n");
    if (firstNl < 0) return { meta: {}, body: text };
    // Parse on lines with any trailing CR removed, but slice the body from the
    // original text so a CRLF document keeps its line endings.
    const rawLines = text.slice(firstNl + 1).split("\n");
    const lines = rawLines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
    let close = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === "---" || lines[i] === "...") {
        close = i;
        break;
      }
    }
    if (close < 0) return { meta: {}, body: text };
    const body = rawLines.slice(close + 1).join("\n");
    const head = lines.slice(0, close);
    const meta = {};
    for (let i = 0; i < head.length; i++) {
      const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(head[i]);
      if (!m) continue;
      const key = m[1];
      const rest = m[2].trim();
      if (rest) {
        meta[key] = parseValue(rest);
        continue;
      }
      // Empty value: gather any immediately following `- item` block sequence,
      // indented or at column zero, both of which are valid YAML.
      const items = [];
      let j = i + 1;
      for (; j < head.length; j++) {
        const seq = /^[ \t]*-[ \t]+(.*)$/.exec(head[j]);
        if (!seq) break;
        const v = unquote(seq[1].trim());
        if (v) items.push(v);
      }
      if (j > i + 1) {
        meta[key] = items;
        i = j - 1;
      } else {
        meta[key] = "";
      }
    }
    return { meta, body };
  }

  function parseValue(v) {
    v = v.trim();
    if (!v) return "";
    if (v.startsWith("[") && v.endsWith("]")) {
      const inner = v.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(",").map((s) => unquote(s.trim())).filter(Boolean);
    }
    return unquote(v);
  }

  function unquote(v) {
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
      return v.slice(1, -1);
    }
    return v;
  }

  function asTags(v) {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === "string" && v) return v.split(",").map((s) => s.trim()).filter(Boolean);
    return [];
  }

  function asRefs(v) {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === "string" && v) return [v];
    return [];
  }

  function firstHeading(body) {
    const m = /^#{1,6}\s+(.+)$/m.exec(body);
    return m ? m[1].trim() : "";
  }

  /* ── article schema ────────────────────────────────────────────────────────
     A store may carry a schema.json beside its collections: pi-canon writes one
     when it creates a store, and this file is the shared contract, so the atlas
     enforces the same rules at its own write doors. The shape mirrors pi-canon
     exactly: an "article" object with capsule / title / body rules, each rule
     taking required, min_chars, max_chars, hint. Enforcement is asymmetric on
     purpose: required rejects a save that touches the field (and everything on
     create), everything else warns, and a document read in violation carries
     heal notes instead of errors. A malformed file fails open and loud: nothing
     is enforced and the problems say so, because a contract the owner believes
     is enforced while a typo disabled it is the worst state. */

  const SCHEMA_FILE = "schema.json";
  const SCHEMA_FIELDS = ["capsule", "title", "body"];
  const SCHEMA_RULE_KEYS = ["required", "min_chars", "max_chars", "hint"];

  /* The store lives either at the corpus root or nested under .canon/; the
     schema file sits beside the collections, wherever they are. */
  function schemaPrefix(config) {
    return config.collections.some((c) => (c.match || "").startsWith(".canon/")) ? ".canon/" : "";
  }

  /* Raw file text (or null when absent) into { schema, problems }. */
  function parseSchema(text) {
    if (text == null) return { schema: undefined, problems: [] };
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return {
        schema: undefined,
        problems: [SCHEMA_FILE + " is not valid JSON (" + e.message + "); its rules are not being enforced."],
      };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { schema: undefined, problems: [SCHEMA_FILE + " must hold a JSON object; its rules are not being enforced."] };
    }
    const problems = [];
    const declared = raw.article;
    if (declared === undefined) return { schema: {}, problems };
    if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
      return { schema: undefined, problems: [SCHEMA_FILE + ': "article" must be an object; its rules are not being enforced.'] };
    }
    const schema = {};
    for (const [name, value] of Object.entries(declared)) {
      if (!SCHEMA_FIELDS.includes(name)) {
        problems.push(SCHEMA_FILE + ': unknown article field "' + name + '" is ignored (fields: ' + SCHEMA_FIELDS.join(", ") + ").");
        continue;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        problems.push(SCHEMA_FILE + ': rule for "' + name + '" must be an object and is ignored.');
        continue;
      }
      const rule = {};
      for (const [key, val] of Object.entries(value)) {
        if (!SCHEMA_RULE_KEYS.includes(key)) {
          problems.push(SCHEMA_FILE + ': unknown rule key "' + name + "." + key + '" is ignored (keys: ' + SCHEMA_RULE_KEYS.join(", ") + ").");
        } else if (key === "required" && typeof val === "boolean") rule.required = val;
        else if ((key === "min_chars" || key === "max_chars") && typeof val === "number" && Number.isInteger(val) && val >= 0) rule[key] = val;
        else if (key === "hint" && typeof val === "string") rule.hint = val;
        else problems.push(SCHEMA_FILE + ': "' + name + "." + key + '" has the wrong type and is ignored.');
      }
      schema[name] = rule;
    }
    return { schema, problems };
  }

  /* The title the schema means: the body's leading # heading, nothing later. */
  function titleOf(body) {
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      const m = /^#\s+(.+)$/.exec(line);
      return m ? m[1].trim() : "";
    }
    return "";
  }

  /* One save (or one read, when prevRaw === raw so nothing counts as touched)
     against the schema. summaryKey is the frontmatter key this collection
     carries its capsule under. A required violation rejects only when the save
     touched that field or created the document; a legacy violation the save
     left alone warns instead, so a body edit is never held hostage to an old
     missing capsule. */
  function checkDoc(raw, prevRaw, schema, summaryKey) {
    const rejects = [];
    const warns = [];
    if (!schema) return { rejects, warns };
    const created = prevRaw == null;
    const extract = (text) => {
      const { meta, body } = parseFrontmatter(text);
      return {
        capsule: String(meta[summaryKey] || "").trim(),
        title: titleOf(body),
        body: body.trim(),
      };
    };
    const now = extract(raw);
    const before = created ? null : extract(prevRaw);
    for (const name of SCHEMA_FIELDS) {
      const rule = schema[name];
      if (!rule) continue;
      const value = now[name];
      const touched = created || value !== before[name];
      const hint = rule.hint ? " (" + rule.hint + ")" : "";
      if (rule.required && !value) {
        if (touched) rejects.push(name + " is required" + hint);
        else warns.push("schema: " + name + " is required and missing; this document can be healed by editing" + hint);
      }
      if (value && rule.min_chars != null && value.length < rule.min_chars) {
        warns.push("schema: " + name + " is under " + rule.min_chars + " characters" + hint);
      }
      if (value && rule.max_chars != null && value.length > rule.max_chars) {
        warns.push("schema: " + name + " is over " + rule.max_chars + " characters (" + value.length + ")" + hint);
      }
    }
    return { rejects, warns };
  }

  function extractLinks(body) {
    const out = [];
    // Fenced code carries example links that were never authored as references.
    const stripped = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    for (const m of stripped.matchAll(WIKILINK_RE)) {
      const t = m[1].trim();
      if (t) out.push({ target: t, via: "wikilink" });
    }
    for (const m of stripped.matchAll(MDLINK_RE)) {
      const t = m[1].trim();
      if (/^[a-z][a-z0-9+.-]*:/i.test(t)) continue; // absolute URL schemes
      if (t.startsWith("#")) continue;
      if (!/\.(md|markdown)(#|$)/i.test(t)) continue;
      // Pass the raw target; the resolver decodes it safely, so a malformed
      // percent escape resolves to nothing instead of throwing mid-scan.
      out.push({ target: t.split("#")[0], via: "mdlink" });
    }
    return out;
  }

  /* One document's text into one scanned doc, or null when no collection claims
     it. `address` is the path a wikilink resolves against: the root-relative
     path minus extension, and minus the collection prefix when one claimed the
     file, so `articles/lab/x.md` answers to `lab/x`. */
  function scanFile(rel, text, config) {
    const col = collectionFor(config, rel);
    if (!col) return null;
    const { meta, body } = parseFrontmatter(text);
    const f = col.fields;
    const noExt = rel.replace(/\.(md|markdown)$/i, "");
    const address = col.match && noExt.startsWith(col.match) ? noExt.slice(col.match.length) : noExt;
    const title = String(meta[f.title] || "") || firstHeading(body) || address;
    const links = extractLinks(body);
    for (const r of asRefs(meta[f.refs])) links.push({ target: r, via: "ref" });
    /* A migrated pi-canon store carries `path:VALUE` tags that record where a
       document came from, not what it is about. Under that preset they are
       source metadata: lift the first one out so it can be shown, and keep them
       all out of the tag vote. Any other corpus keeps its tags untouched. */
    const allTags = asTags(meta[f.tags]);
    const lift = config.preset === "pi-canon";
    const fromPath = lift ? allTags.filter((t) => t.startsWith("path:")) : [];
    /* A read never rejects: a document in violation carries heal notes. */
    let schemaNotes;
    if (config.schema && !col.immutable) {
      const w = checkDoc(text, text, config.schema, f.summary).warns;
      if (w.length) schemaNotes = w;
    }
    return {
      schemaNotes,
      path: rel,
      address,
      collection: col.name,
      immutable: col.immutable,
      title,
      tags: lift ? allTags.filter((t) => !t.startsWith("path:")) : allTags,
      sourcePath: fromPath.length ? fromPath[0].slice(5) : undefined,
      date: String(meta[f.date] || ""),
      summary: String(meta[f.summary] || ""),
      body,
      links,
    };
  }

  /* files: [{ path, text }] over the whole corpus. Unclaimed files drop out. */
  function scanFiles(files, config) {
    const docs = [];
    for (const file of files) {
      const doc = scanFile(file.path, file.text, config);
      if (doc) docs.push(doc);
    }
    return docs;
  }

  /* Node walks the tree depth-first, sorting each directory level; that order
     fixes node ids and so the whole graph. A browser enumerates a directory in
     no guaranteed order, so put the files back into walk order before scanning:
     compare paths segment by segment, which reproduces the per-level sort (a
     directory "a" sorts before a sibling file "a.md", and "a/x.md" before it). */
  function comparePath(a, b) {
    const as = a.split("/");
    const bs = b.split("/");
    const n = Math.min(as.length, bs.length);
    for (let i = 0; i < n; i++) {
      if (as[i] !== bs[i]) return as[i] < bs[i] ? -1 : 1;
    }
    return as.length - bs.length;
  }

  function orderFiles(files) {
    return files.slice().sort((a, b) => comparePath(a.path, b.path));
  }

  /* ── link graph ────────────────────────────────────────────────────────────
     Resolve every authored link through the shared resolver, keep the ones that
     land, and surface the ones that do not as phantom nodes. */

  /* Two authored link kinds render identically (a plain link), so they collapse
     to one edge kind; a frontmatter ref stays distinct. */
  function edgeVia(via) {
    return via === "ref" ? "ref" : "link";
  }

  function pagerank(n, outLinks, damping = 0.85, iters = 50) {
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
  function buildGraph(docs) {
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

  /* ── semantic clusters ─────────────────────────────────────────────────────
     Spherical k-means over embeddings when the corpus ships them, deterministic
     greedy modularity over the link graph otherwise. Same shape either way. */

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

  /* Greedy modularity, the node-moving phase of Louvain, swept in fixed order so
     the result is deterministic. Modularity gain weighs a move by how much
     denser it makes the community, so a bridge stays a bridge. */
  function communities(n, edges, sweeps = 50) {
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

  function shape(nodes, memberIds, labelOf) {
    // memberIds: raw label -> member node ids. Singleton groups stay unplaced.
    const groups = [...memberIds.entries()]
      .filter(([, ids]) => ids.length >= 2)
      .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, MAX_CLUSTERS);
    const clusters = [];
    const assign = new Map();
    groups.forEach(([key, ids], i) => {
      let label = labelOf ? labelOf(key) : "";
      if (!label) {
        const tagVotes = new Map();
        for (const id of ids) {
          for (const t of nodes[id].tags) tagVotes.set(t, (tagVotes.get(t) || 0) + 1);
        }
        let best = 0;
        for (const [t, c] of [...tagVotes.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
          if (c > best) {
            best = c;
            label = t;
          }
        }
      }
      if (!label) {
        /* An immutable tier's entries are dated event slugs; the cluster's
           best-ranked mutable member names the theme far better. */
        const ranked = ids.slice().sort((a, b) => nodes[b].rank - nodes[a].rank);
        const top = ranked.find((id) => !nodes[id].immutable);
        label = nodes[top !== undefined ? top : ranked[0]].title;
      }
      clusters.push({ id: i, label, size: ids.length });
      for (const id of ids) assign.set(id, i);
    });
    const pos = clusters.length > 1 ? clusters.map((_, i) => i / (clusters.length - 1)) : [0.5];
    clusters.forEach((c, i) => (c.pos = pos[i]));
    return { clusters, assign };
  }

  function assignClusters(nodes, edges, vectors) {
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

    /* A store whose addresses are a real hierarchy (src/core/config,
       meta/memory/folds/x) names its own neighborhoods: the first path segment
       is a deterministic, fully-covering cluster with an honest label. Link
       communities fragment on a sparse graph, so paths take precedence when
       they form at least two real groups. */
    const bySegment = new Map();
    for (const d of docs) {
      if (!d.address) continue;
      const seg = d.address.split("/")[0];
      const arr = bySegment.get(seg) || [];
      arr.push(d.id);
      bySegment.set(seg, arr);
    }
    const segGroups = [...bySegment.values()].filter((ids) => ids.length >= 2);
    if (segGroups.length >= 2) {
      return { basis: "paths", ...shape(nodes, bySegment, (key) => String(key)) };
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

  /* ── markdown ───────────────────────────────────────────────────────────────
     A small renderer for the reader panel. Everything is escaped first, so a
     document can never inject markup; wikilinks and relative markdown links
     become internal anchors the app wires to the graph. */

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function inline(s) {
    let out = esc(s);
    out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    out = out.replace(
      /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g,
      (_, t, alias) => `<a class="wl" data-via="wikilink" data-target="${t.trim()}">${alias ? alias.trim() : t.trim()}</a>`
    );
    out = out.replace(/(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, text, href) => {
      if (/^https?:/i.test(href)) return `<a href="${href}" target="_blank" rel="noopener">${text || href}</a>`;
      if (/\.(md|markdown)(#|$)/i.test(href)) return `<a class="wl" data-via="mdlink" data-target="${href.split("#")[0]}">${text || href}</a>`;
      return text || href;
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, "<em>$1</em>");
    return out;
  }

  function renderMarkdown(md) {
    const lines = md.split("\n");
    const out = [];
    let list = null; // "ul" | "ol"
    let para = [];
    let quote = [];
    let code = null;

    const flushPara = () => {
      if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    const flushQuote = () => {
      if (quote.length) out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
      quote = [];
    };
    const flushAll = () => {
      flushPara();
      flushList();
      flushQuote();
    };

    for (const raw of lines) {
      if (code !== null) {
        if (/^```/.test(raw)) {
          out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
          code = null;
        } else code.push(raw);
        continue;
      }
      const line = raw.replace(/\s+$/, "");
      const fence = /^```/.exec(line);
      if (fence) {
        flushAll();
        code = [];
        continue;
      }
      if (!line.trim()) {
        flushAll();
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        flushAll();
        const level = Math.min(h[1].length + 1, 6); // corpus h1 renders as page h2
        out.push(`<h${level}>${inline(h[2])}</h${level}>`);
        continue;
      }
      if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
        flushAll();
        out.push("<hr>");
        continue;
      }
      const q = /^>\s?(.*)$/.exec(line);
      if (q) {
        flushPara();
        flushList();
        quote.push(q[1]);
        continue;
      }
      const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        flushQuote();
        const want = ul ? "ul" : "ol";
        if (list !== want) {
          flushList();
          out.push(`<${want}>`);
          list = want;
        }
        out.push(`<li>${inline((ul || ol)[1])}</li>`);
        continue;
      }
      flushList();
      flushQuote();
      para.push(line.trim());
    }
    if (code !== null) out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    flushAll();
    return out.join("\n");
  }

  /* ── wire data ──────────────────────────────────────────────────────────────
     The graph the page renders. No generated timestamp: identical corpus in,
     identical bytes out. */

  /* JSON destined for a script tag: escape the characters that could terminate
     the tag or open one, so a document body can never break out of the data. */
  function scriptJson(value) {
    return JSON.stringify(value)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  }

  function buildData(config, graph, mode) {
    const { nodes, edges } = graph;
    const { basis, clusters, assign } = assignClusters(nodes, edges, config.vectors || null);
    const counts = new Map();
    for (const n of nodes) {
      if (n.exists) counts.set(n.collection, (counts.get(n.collection) || 0) + 1);
    }
    return {
      title: config.title,
      preset: config.preset,
      mode,
      basis,
      schemaProblems: config.schemaProblems && config.schemaProblems.length ? config.schemaProblems : undefined,
      collections: config.collections.map((c) => ({
        name: c.name,
        match: c.match,
        immutable: c.immutable,
        reveal: c.reveal,
        fields: c.fields || {},
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
        schemaNotes: n.schemaNotes,
        html: n.body ? renderMarkdown(n.body) : "",
      })),
      edges,
    };
  }

  /* The whole pipeline in one call, for the pure-client app: markdown files and
     optional parsed config/vectors in, wire data out.
       files:       [{ path, text }] over the corpus (root-relative paths)
       configJson:  parsed canon-atlas.json, or null to detect a preset
       vectorsJson: parsed embeddings object, or null
       mode:        "chart" | "live" | "fs" */
  function buildWireData(files, opts) {
    opts = opts || {};
    // collectionFor matches by directory prefix, not extension, so a stray
    // non-markdown file under a collection would otherwise be parsed as one.
    // Keep only markdown, then canonicalize order so the result matches Node.
    const md = orderFiles(files.filter((f) => /\.(md|markdown)$/i.test(f.path)));
    const raw = composeConfig(opts.configJson, () => detectPreset(md.map((f) => f.path)));
    const config = buildConfig(raw);
    config.vectors = parseVectors(opts.vectorsJson);
    /* schemaTexts carries both candidate files ({ root, nested }); which one is
       the store's contract depends on where the collections landed, so the
       choice waits for the config. */
    const texts = opts.schemaTexts || {};
    const s = parseSchema((schemaPrefix(config) ? texts.nested : texts.root) ?? null);
    config.schema = s.schema;
    config.schemaProblems = s.problems;
    const docs = scanFiles(md, config);
    const graph = buildGraph(docs);
    return buildData(config, graph, opts.mode || "fs");
  }

  return {
    CONFIG_NAME,
    SCHEMA_FILE,
    PI_CANON_PRESET,
    DEFAULT_CONFIG,
    buildConfig,
    composeConfig,
    detectPreset,
    parseVectors,
    parseSchema,
    schemaPrefix,
    checkDoc,
    collectionFor,
    parseFrontmatter,
    extractLinks,
    scanFile,
    scanFiles,
    orderFiles,
    edgeVia,
    pagerank,
    buildGraph,
    communities,
    assignClusters,
    esc,
    renderMarkdown,
    scriptJson,
    buildData,
    buildWireData,
  };
})();

if (typeof module !== "undefined") module.exports = AtlasPipeline;
