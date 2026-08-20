#!/usr/bin/env node
/* canon-atlas: an atlas over a catalog of markdown that references itself.

   canon-atlas build [root] [-o atlas.html]   one self-contained chart
   canon-atlas serve [root] [-p 4747]         the live atlas, with editing */

import { spawn } from "node:child_process";
import { build, buildApp } from "./build.mjs";
import { embed } from "./embed.mjs";
import { serve, serveApp } from "./serve.mjs";

const USAGE = `canon-atlas: view a catalog of markdown documents as a constellation

usage:
  canon-atlas open [-p 4700]                 open the atlas in your browser,
                                             starting the local host if needed;
                                             made for a launcher entry, and it
                                             exits after a day with no atlas tab
  canon-atlas app [-o atlas-app.html]        write the pure-client app as one
                                             file, to host anywhere static
  canon-atlas embed [root] [-m PROVIDER]     write embeddings.json at the corpus
                                             root, upgrading cluster color from
                                             link structure to meaning; reruns
                                             embed only what changed
  canon-atlas build [root] [-o atlas.html]   write one self-contained chart
  canon-atlas serve [root] [-p 4747]         serve one corpus live, with editing

The root is a directory of markdown documents, current directory by default.
A canon-atlas.json at the root defines collections; without one, a root that
holds articles/ and journal/ gets the pi-canon preset, and anything else is
read as a single mutable collection. An embeddings.json of path to vector
upgrades cluster color from link structure to meaning.

embed is the one command that touches a network, and only the provider named:
the default is ollama (local, so nothing leaves the machine; OLLAMA_HOST
overrides the address, model nomic-embed-text unless -m ollama:MODEL names
another). -m openai[:MODEL] uses the OpenAI API instead, with OPENAI_API_KEY
and optionally OPENAI_BASE_URL from the environment. A corpus embedded before
keeps its recorded model on rerun; -m switches it, re-embedding everything.

The app needs no root: it reads folders in the browser, so one page serves
every project and each browser tab holds one. Anywhere the File System Access
API runs (Chrome or Edge over http or https) it edits in place; elsewhere,
and on file:// pages, it browses read-only, which is why hosting it (-p, or
any static host) is the full experience.`;

function parse(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") args.out = argv[++i];
    else if (a === "-p" || a === "--port") args.port = Number(argv[++i]);
    else if (a === "-m" || a === "--model") args.model = argv[++i];
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
  } else if (cmd === "open") {
    const port = args.port ?? 4700;
    const url = `http://127.0.0.1:${port}/`;
    // Constants over knobs: a full day of no atlas tab, then the host exits.
    const IDLE_MS = 24 * 60 * 60 * 1000;
    const browse = () => {
      const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
      child.on("error", () => console.error(`xdg-open is missing; open ${url} yourself`));
      child.unref();
    };
    try {
      await serveApp(port, { idleMs: IDLE_MS, onIdle: () => process.exit(0) });
      browse();
      console.log(`${url}\nexits after a day with no atlas tab open`);
    } catch (e) {
      if (e && e.code === "EADDRINUSE") {
        // A host is already on the port: reuse it if it is ours.
        const ours = await fetch(url + "ping")
          .then((r) => r.headers.get("x-canon-atlas") === "app")
          .catch(() => false);
        if (!ours) throw new Error(`port ${port} is taken by something else`);
        browse();
        // The running host serves the tab; this process is done. An explicit
        // exit, because the probe fetch can hold the loop open on keep-alive.
        setTimeout(() => process.exit(0), 300);
      } else throw e;
    }
  } else if (cmd === "app") {
    const r = buildApp(args.out);
    console.log(`${r.out}\nopen it in a Chromium browser, then pick a folder`);
  } else if (cmd === "embed") {
    const r = await embed(args._[1], args.model, (p) => process.stderr.write(`\rembedding ${p}   `));
    if (r.embedded) process.stderr.write("\n");
    console.log(
      `${r.file}\n${r.embedded} embedded, ${r.reused} unchanged` +
        (r.removed ? `, ${r.removed} removed` : "") +
        `, model ${r.model}\nbuild, serve, and the app pick it up on the next load`
    );
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
