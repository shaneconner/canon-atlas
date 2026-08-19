/* Corpus configuration: which files belong to which collection, how frontmatter
   maps onto the fields the atlas reads, and where optional embeddings live.

   Resolution order: an explicit canon-atlas.json at the corpus root wins, then
   preset detection, then the bare default of one mutable collection over every
   markdown file. A collection's `match` is a directory prefix relative to the
   root, not a glob: constants over knobs. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_NAME = "canon-atlas.json";

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

const DEFAULT = {
  preset: "default",
  collections: [{ name: "notes", match: "", immutable: false, fields: {} }],
};

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

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

export function loadConfig(root) {
  const file = join(root, CONFIG_NAME);
  let raw = null;
  if (existsSync(file)) {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } else if (isDir(join(root, "articles")) && isDir(join(root, "journal"))) {
    raw = PI_CANON_PRESET;
  } else {
    raw = DEFAULT;
  }
  const collections = (raw.collections || DEFAULT.collections).map(normalizeCollection);
  // Longest prefix claims the file, so an inner directory can override an outer one.
  collections.sort((a, b) => b.match.length - a.match.length);
  return {
    preset: raw.preset || "custom",
    title: raw.title || "",
    collections,
    embeddings: raw.embeddings || "embeddings.json",
  };
}

/* Optional embedding vectors: a JSON object of root-relative markdown path to
   an array of floats, at the path config.embeddings names. Absent is normal;
   clustering falls back to link structure. */
export function loadVectors(root, config) {
  const file = join(root, config.embeddings);
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v) && v.every((x) => typeof x === "number")) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/* The collection a root-relative markdown path belongs to, or null when no
   collection claims it and there is no catch-all. */
export function collectionFor(config, relPath) {
  for (const c of config.collections) {
    if (relPath.startsWith(c.match)) return c;
  }
  return null;
}
