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
   detection (a store with both articles/ and journal/ is pi-canon), then the
   bare default of one mutable collection over every markdown file. A config
   that names a title but no collections keeps the detected preset. */
export function loadConfig(root) {
  const file = join(root, CONFIG_NAME);
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const detect = () =>
    isDir(join(root, "articles")) && isDir(join(root, "journal")) ? P.PI_CANON_PRESET : P.DEFAULT_CONFIG;
  return P.buildConfig(P.composeConfig(raw, detect));
}

/* Optional embedding vectors at the path config.embeddings names. Absent is
   normal; clustering falls back to link structure. */
export function loadVectors(root, config) {
  const file = join(root, config.embeddings);
  if (!existsSync(file)) return null;
  return P.parseVectors(JSON.parse(readFileSync(file, "utf8")));
}
