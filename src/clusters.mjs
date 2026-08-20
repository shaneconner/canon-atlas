/* Semantic clusters: the color and region signal for the constellation.
   Spherical k-means over embeddings when the corpus ships them, deterministic
   greedy modularity over the link graph otherwise. The logic lives in
   ui/pipeline.cjs so the browser clusters identically; this re-exports it. */

import { createRequire } from "node:module";

const P = createRequire(import.meta.url)("./ui/pipeline.cjs");

export const communities = P.communities;
export const assignClusters = P.assignClusters;
