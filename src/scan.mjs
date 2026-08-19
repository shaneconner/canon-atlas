/* Corpus scan: walk the root for markdown, parse flat frontmatter, and pull the
   links each document actually authors. No LLM, no network, fully deterministic. */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { collectionFor } from "./config.mjs";

const SKIP_DIRS = new Set([".git", "node_modules", ".obsidian", ".atlas"]);

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const MDLINK_RE = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/* Flat frontmatter: `key: value` lines between --- fences. Values are bare
   scalars, quoted strings, or inline arrays. Indented lines belong to nested
   structures this tool does not read; they pass through untouched. */
export function parseFrontmatter(text) {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: text };
  const head = text.slice(text.indexOf("\n") + 1, end);
  const body = text.slice(text.indexOf("\n", end + 1) + 1);
  const meta = {};
  for (const line of head.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    meta[m[1]] = parseValue(m[2]);
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

export function extractLinks(body) {
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
    out.push({ target: decodeURIComponent(t.split("#")[0]), via: "mdlink" });
  }
  return out;
}

function walk(dir, root, acc) {
  const entries = readdirSync(dir).sort();
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, root, acc);
    else if (/\.(md|markdown)$/i.test(name)) acc.push(relative(root, full).split("\\").join("/"));
  }
  return acc;
}

/* One scanned document. `address` is the path a wikilink resolves against:
   the root-relative path minus extension, and minus the collection prefix when
   one claimed the file, so `articles/lab/x.md` answers to `lab/x`. */
export function scanCorpus(root, config) {
  const docs = [];
  for (const rel of walk(root, root, [])) {
    const col = collectionFor(config, rel);
    if (!col) continue;
    const text = readFileSync(join(root, rel), "utf8");
    const { meta, body } = parseFrontmatter(text);
    const f = col.fields;
    const noExt = rel.replace(/\.(md|markdown)$/i, "");
    const address = col.match && noExt.startsWith(col.match) ? noExt.slice(col.match.length) : noExt;
    const title = String(meta[f.title] || "") || firstHeading(body) || address;
    const links = extractLinks(body);
    for (const r of asRefs(meta[f.refs])) links.push({ target: r, via: "ref" });
    docs.push({
      path: rel,
      address,
      collection: col.name,
      immutable: col.immutable,
      title,
      tags: asTags(meta[f.tags]),
      date: String(meta[f.date] || ""),
      summary: String(meta[f.summary] || ""),
      body,
      links,
    });
  }
  return docs;
}
