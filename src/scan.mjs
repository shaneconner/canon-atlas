/* Corpus scan: walk the root for markdown, parse flat frontmatter, and pull the
   links each document actually authors. No LLM, no network, fully deterministic. */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { collectionFor } from "./config.mjs";

const SKIP_DIRS = new Set([".git", "node_modules", ".obsidian", ".atlas"]);

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
export function parseFrontmatter(text) {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const firstNl = text.indexOf("\n");
  if (firstNl < 0) return { meta: {}, body: text };
  const lines = text.slice(firstNl + 1).split("\n");
  let close = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "---" || lines[i] === "...") {
      close = i;
      break;
    }
  }
  if (close < 0) return { meta: {}, body: text };
  const body = lines.slice(close + 1).join("\n");
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
    // Empty value: gather any immediately following `- item` block sequence.
    const items = [];
    let j = i + 1;
    for (; j < head.length; j++) {
      const seq = /^[ \t]+-[ \t]+(.*)$/.exec(head[j]);
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
    // Pass the raw target; the resolver decodes it safely, so a malformed
    // percent escape resolves to nothing instead of throwing mid-scan.
    out.push({ target: t.split("#")[0], via: "mdlink" });
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
    /* A migrated pi-canon store carries `path:VALUE` tags that record where a
       document came from, not what it is about. Under that preset they are
       source metadata: lift the first one out so it can be shown, and keep them
       all out of the tag vote. Any other corpus keeps its tags untouched. */
    const allTags = asTags(meta[f.tags]);
    const lift = config.preset === "pi-canon";
    const fromPath = lift ? allTags.filter((t) => t.startsWith("path:")) : [];
    docs.push({
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
    });
  }
  return docs;
}
