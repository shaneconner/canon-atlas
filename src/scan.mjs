/* Corpus scan in Node: walk the root for markdown, read each claimed file, and
   hand the text to the shared pipeline. Frontmatter parsing, link extraction,
   and the per-document shaping live in ui/pipeline.cjs, so the browser scans
   the same bytes into the same docs. Only the directory walk is fs-bound. */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { collectionFor } from "./config.mjs";

const P = createRequire(import.meta.url)("./ui/pipeline.cjs");

export const parseFrontmatter = P.parseFrontmatter;
export const extractLinks = P.extractLinks;

const SKIP_DIRS = new Set([".git", "node_modules", ".obsidian", ".atlas"]);

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

export function scanCorpus(root, config) {
  const files = [];
  for (const rel of walk(root, root, [])) {
    if (!collectionFor(config, rel)) continue;
    files.push({ path: rel, text: readFileSync(join(root, rel), "utf8") });
  }
  return P.scanFiles(files, config);
}
