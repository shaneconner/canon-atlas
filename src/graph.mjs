/* Link graph: the shared pipeline resolves every authored link through the same
   resolver the reader uses, keeps the ones that land, and surfaces the ones
   that do not as phantom nodes. This wrapper re-exports it for the Node build
   path and the gate suite; the logic lives in ui/pipeline.cjs. */

import { createRequire } from "node:module";

const P = createRequire(import.meta.url)("./ui/pipeline.cjs");

export const buildGraph = P.buildGraph;
export const pagerank = P.pagerank;
