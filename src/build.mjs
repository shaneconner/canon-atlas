/* Build: corpus in, one self-contained chart out. Or, with no corpus, the
   pure-client app: one self-contained page that opens folders in the browser. */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, loadVectors } from "./config.mjs";
import { scanCorpus } from "./scan.mjs";
import { buildGraph } from "./graph.mjs";
import { buildData, renderPage, renderAppPage } from "./page.mjs";

export function build(rootArg, outArg) {
  const root = resolve(rootArg || ".");
  const out = resolve(outArg || "atlas.html");
  const config = loadConfig(root);
  config.vectors = loadVectors(root, config);
  const docs = scanCorpus(root, config);
  if (!docs.length) throw new Error(`no markdown documents under ${root}`);
  const graph = buildGraph(docs);
  const data = buildData(config, graph, "chart");
  writeFileSync(out, renderPage(data));
  return {
    out,
    documents: docs.length,
    references: graph.edges.length,
    clusters: data.clusters.length,
    basis: data.basis,
  };
}

/* The pure-client app carries no corpus: it reads folders in the browser. One
   self-contained file, opened once, serves every project. */
export function buildApp(outArg) {
  const out = resolve(outArg || "atlas-app.html");
  writeFileSync(out, renderAppPage());
  return { out };
}

