/* Serve: the same page as the build, with the corpus behind it. The server
   binds to localhost only, because this mode edits the files it shows.

   Write rules follow the collections: a mutable collection takes create, edit,
   and delete; an immutable collection is append-only, so it takes create and
   nothing else. Every path is confined to the corpus root. */

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { loadConfig, loadVectors, collectionFor } from "./config.mjs";
import { scanCorpus } from "./scan.mjs";
import { buildGraph } from "./graph.mjs";
import { buildData, renderPage } from "./page.mjs";

const CACHE_TTL_MS = 3000;

export function serve(rootArg, port = 4747) {
  const root = resolve(rootArg || ".");
  if (!existsSync(root)) throw new Error(`no such directory: ${root}`);

  let cache = null;
  function data() {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
    const config = loadConfig(root);
    config.vectors = loadVectors(root, config);
    const graph = buildGraph(scanCorpus(root, config));
    cache = { at: Date.now(), data: buildData(config, graph, "live"), config };
    return cache.data;
  }
  function config() {
    data();
    return cache.config;
  }
  const bust = () => (cache = null);

  /* A client path is only ever a root-relative markdown file inside the tree. */
  function confine(rel) {
    if (typeof rel !== "string" || !rel) throw httpError(400, "path required");
    if (!/\.(md|markdown)$/i.test(rel)) throw httpError(400, "path must end in .md");
    const norm = rel.split("\\").join("/");
    const segments = norm.split("/");
    if (norm.startsWith("/") || segments.some((s) => !s || s === "." || s === "..")) {
      throw httpError(400, "path escapes the corpus");
    }
    const full = join(root, norm);
    if (!(full + sep).startsWith(root + sep)) throw httpError(400, "path escapes the corpus");
    const col = collectionFor(config(), norm);
    if (!col) throw httpError(400, "no collection claims this path");
    return { full, rel: norm, col };
  }

  function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
  }

  function readBody(req) {
    return new Promise((res, rej) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 4_000_000) rej(httpError(413, "document too large"));
      });
      req.on("end", () => {
        try {
          res(body ? JSON.parse(body) : {});
        } catch {
          rej(httpError(400, "invalid JSON"));
        }
      });
    });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, payload, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type + "; charset=utf-8" });
      res.end(type === "application/json" ? JSON.stringify(payload) : payload);
    };
    try {
      if (req.method === "GET" && url.pathname === "/") {
        return send(200, renderPage(data()), "text/html");
      }
      if (req.method === "GET" && url.pathname === "/api/graph") {
        return send(200, data());
      }
      if (url.pathname === "/api/doc") {
        if (req.method === "GET") {
          const { full, rel } = confine(url.searchParams.get("path"));
          if (!existsSync(full)) throw httpError(404, "no such document");
          return send(200, { path: rel, raw: readFileSync(full, "utf8") });
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const { full, rel } = confine(body.path);
          if (existsSync(full)) throw httpError(409, "document already exists");
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, String(body.content ?? ""), { flag: "wx" });
          bust();
          return send(201, { path: rel });
        }
        if (req.method === "PUT") {
          const body = await readBody(req);
          const { full, rel, col } = confine(body.path);
          if (col.immutable) throw httpError(403, `${col.name} is immutable`);
          if (!existsSync(full)) throw httpError(404, "no such document");
          writeFileSync(full, String(body.content ?? ""));
          bust();
          return send(200, { path: rel });
        }
        if (req.method === "DELETE") {
          const { full, rel, col } = confine(url.searchParams.get("path"));
          if (col.immutable) throw httpError(403, `${col.name} is immutable`);
          if (!existsSync(full)) throw httpError(404, "no such document");
          unlinkSync(full);
          bust();
          return send(200, { path: rel });
        }
      }
      throw httpError(404, "not found");
    } catch (e) {
      send(e.status || 500, { error: e.message });
    }
  });

  return new Promise((res) => {
    server.listen(port, "127.0.0.1", () => {
      res({ server, port: server.address().port, root });
    });
  });
}
