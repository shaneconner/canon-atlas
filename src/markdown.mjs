/* The reader panel's small markdown renderer. Everything is escaped first, so a
   document can never inject markup; wikilinks and relative markdown links become
   internal anchors the app wires to the graph. The logic lives in
   ui/pipeline.cjs so the browser renders identically; this re-exports it. */

import { createRequire } from "node:module";

const P = createRequire(import.meta.url)("./ui/pipeline.cjs");

export const renderMarkdown = P.renderMarkdown;
