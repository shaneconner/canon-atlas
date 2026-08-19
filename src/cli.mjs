#!/usr/bin/env node
/* canon-atlas: an atlas over a catalog of markdown that references itself.

   canon-atlas build [root] [-o atlas.html]   one self-contained chart
   canon-atlas serve [root] [-p 4747]         the live atlas, with editing */

import { build } from "./build.mjs";
import { serve } from "./serve.mjs";

const USAGE = `canon-atlas: view a catalog of markdown documents as a constellation

usage:
  canon-atlas build [root] [-o atlas.html]   write one self-contained chart
  canon-atlas serve [root] [-p 4747]         serve the live atlas, with editing

The root is a directory of markdown documents, current directory by default.
A canon-atlas.json at the root defines collections; without one, a root that
holds articles/ and journal/ gets the pi-canon preset, and anything else is
read as a single mutable collection. An embeddings.json of path to vector
upgrades cluster color from link structure to meaning.`;

function parse(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") args.out = argv[++i];
    else if (a === "-p" || a === "--port") args.port = Number(argv[++i]);
    else if (a === "-h" || a === "--help") args.help = true;
    else args._.push(a);
  }
  return args;
}

const args = parse(process.argv.slice(2));
const cmd = args._[0];

try {
  if (args.help || !cmd) {
    console.log(USAGE);
  } else if (cmd === "build") {
    const r = build(args._[1], args.out);
    console.log(
      `${r.out}\n${r.documents} documents, ${r.references} references, ` +
        `${r.clusters} clusters from ${r.basis === "embeddings" ? "embeddings" : "link structure"}`
    );
  } else if (cmd === "serve") {
    const r = await serve(args._[1], args.port);
    console.log(`canon-atlas over ${r.root}\nhttp://127.0.0.1:${r.port}/`);
  } else {
    console.error(`unknown command: ${cmd}\n\n${USAGE}`);
    process.exit(2);
  }
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
