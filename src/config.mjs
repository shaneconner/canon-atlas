/* Corpus configuration in Node: pick the raw config from a canon-atlas.json at
   the root or from the directory shape, then hand off to the shared pipeline
   for normalization. The pure parts (buildConfig, the presets, parseVectors,
   collectionFor) live in ui/pipeline.cjs, so the browser builds the same config
   from the same rules. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const P = createRequire(import.meta.url)("./ui/pipeline.cjs");

export const CONFIG_NAME = P.CONFIG_NAME;
export const collectionFor = P.collectionFor;

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/* Resolution order: an explicit canon-atlas.json at the root wins, then preset
   detection (a store with both articles/ and journal/, at the root or nested
   under .canon/, is pi-canon), then the bare default of one mutable collection
   over every markdown file. A config that names a title but no collections
   keeps the detected preset. The prefix handling lives in the shared
   detectPreset so Node and the browser resolve the same store the same way. */
export function loadConfig(root) {
  const file = join(root, CONFIG_NAME);
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const detect = () => {
    for (const prefix of ["", ".canon/"]) {
      if (isDir(join(root, prefix, "articles")) && isDir(join(root, prefix, "journal"))) {
        return P.detectPreset([prefix + "articles/x.md", prefix + "journal/x.md"]);
      }
    }
    return P.DEFAULT_CONFIG;
  };
  const config = P.buildConfig(P.composeConfig(raw, detect));
  /* The store's article contract, when it carries one: schema.json beside the
     collections (pi-canon writes it at store creation). Parsed by the shared
     pipeline so the browser and this process enforce identical rules. */
  const sf = join(root, P.schemaPrefix(config), P.SCHEMA_FILE);
  const s = P.parseSchema(existsSync(sf) ? readFileSync(sf, "utf8") : null);
  config.schema = s.schema;
  config.schemaProblems = s.problems;
  return config;
}

/* Optional embedding vectors at the path config.embeddings names. Absent is
   normal; clustering falls back to link structure. */
export function loadVectors(root, config) {
  const file = join(root, config.embeddings);
  if (!existsSync(file)) return null;
  return P.parseVectors(JSON.parse(readFileSync(file, "utf8")));
}
