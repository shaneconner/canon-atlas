/* Serve: the same page as the build, with the corpus behind it. The server
   binds to localhost only, because this mode edits the files it shows.

   Write rules follow the collections: a mutable collection takes create, edit,
   and delete; an immutable collection is append-only, so it takes create and
   nothing else. Every path is confined to the corpus root, and confinement is
   real: a symlink pointing out of the tree, or a symlinked alias onto another
   collection, is refused rather than followed. Because the page inlines the
   whole corpus and the API mutates it, the browser is kept off the door too:
   loopback Host, same-origin Origin, and a JSON content type are required, so a
   page on another origin cannot drive the API by DNS rebinding or a simple
   cross-site POST. */

import { createServer } from "node:http";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { loadConfig, loadVectors, collectionFor } from "./config.mjs";
import { scanCorpus } from "./scan.mjs";
import { buildGraph } from "./graph.mjs";
import { buildData, renderPage, renderAppPage } from "./page.mjs";

const CACHE_TTL_MS = 3000;
const BODY_LIMIT = 4_000_000;

export function serve(rootArg, port = 4747) {
  if (!existsSync(resolve(rootArg || "."))) throw new Error(`no such directory: ${resolve(rootArg || ".")}`);
  // Canonicalize once: every confinement check compares against the real root,
  // so a symlinked ancestor cannot smuggle a path back inside lexically.
  const root = realpathSync(resolve(rootArg || "."));

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

  function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
  }

  /* A client path is only ever a root-relative markdown file inside the tree,
     reached without crossing a symlink. Lexical checks run first, then every
     existing segment is lstat-ed so a link is refused before it is followed. */
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
    let walk = root;
    for (const s of segments) {
      walk = join(walk, s);
      if (existsSync(walk) && lstatSync(walk).isSymbolicLink()) {
        throw httpError(400, "path crosses a symbolic link");
      }
    }
    const col = collectionFor(config(), norm);
    if (!col) throw httpError(400, "no collection claims this path");
    return { full, rel: norm, col };
  }

  /* The browser is not a trust boundary that 127.0.0.1 alone establishes: a
     page on another origin can still POST here, and DNS rebinding can point a
     hostname at this port. Require a loopback Host so a rebound name is
     refused, and for mutations require a same-origin Origin and a JSON content
     type so no simple cross-site request reaches the write path. */
  function requireLoopbackHost(req) {
    const host = req.headers.host || "";
    const name = host.replace(/:\d+$/, "");
    if (name !== "127.0.0.1" && name !== "localhost" && name !== "[::1]") {
      throw httpError(403, "unexpected Host");
    }
    return host;
  }
  function guardMutation(req) {
    const host = requireLoopbackHost(req);
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) throw httpError(403, "cross-origin request refused");
    // POST is the only mutating method a browser can send cross-site without a
    // preflight, and only with a non-JSON content type. Requiring JSON there
    // closes that path; PUT and DELETE are non-simple methods already gated by
    // the preflight, so a bodyless DELETE is not forced to carry a type.
    if (req.method === "POST") {
      const ct = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (ct !== "application/json") throw httpError(415, "content-type must be application/json");
    }
  }

  function readBody(req) {
    return new Promise((res, rej) => {
      let body = "";
      let over = false;
      req.on("data", (c) => {
        if (over) return;
        body += c;
        if (body.length > BODY_LIMIT) {
          over = true;
          req.destroy();
          rej(httpError(413, "document too large"));
        }
      });
      req.on("end", () => {
        if (over) return;
        try {
          res(body ? JSON.parse(body) : {});
        } catch {
          rej(httpError(400, "invalid JSON"));
        }
      });
    });
  }

  /* Write to a sibling temp file and rename over the destination, so a failed
     write can never leave a document half-written or empty. */
  function atomicWrite(full, content) {
    const tmp = full + ".atlas-tmp-" + process.pid;
    writeFileSync(tmp, content);
    renameSync(tmp, full);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, payload, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type + "; charset=utf-8" });
      res.end(type === "application/json" ? JSON.stringify(payload) : payload);
    };
    try {
      if (req.method === "GET" && url.pathname === "/") {
        requireLoopbackHost(req);
        return send(200, renderPage(data()), "text/html");
      }
      if (req.method === "GET" && url.pathname === "/api/graph") {
        requireLoopbackHost(req);
        return send(200, data());
      }
      if (url.pathname === "/api/doc") {
        if (req.method === "GET") {
          requireLoopbackHost(req);
          const { full, rel } = confine(url.searchParams.get("path"));
          if (!existsSync(full)) throw httpError(404, "no such document");
          return send(200, { path: rel, raw: readFileSync(full, "utf8") });
        }
        if (req.method === "POST") {
          guardMutation(req);
          const body = await readBody(req);
          const { full, rel } = confine(body.path);
          if (existsSync(full)) throw httpError(409, "document already exists");
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, String(body.content ?? ""), { flag: "wx" });
          bust();
          return send(201, { path: rel });
        }
        if (req.method === "PUT") {
          guardMutation(req);
          const body = await readBody(req);
          const { full, rel, col } = confine(body.path);
          if (col.immutable) throw httpError(403, `${col.name} is immutable`);
          if (!existsSync(full)) throw httpError(404, "no such document");
          atomicWrite(full, String(body.content ?? ""));
          bust();
          return send(200, { path: rel });
        }
        if (req.method === "DELETE") {
          guardMutation(req);
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

  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", rej);
      res({ server, port: server.address().port, root });
    });
  });
}

/* Host the pure-client app itself: one static page, no corpus behind it and no
   API, so one process serves every project. Browsers block the writable folder
   picker on file:// pages; an http origin unblocks it, and this is the smallest
   one. All reading and writing still happens in the browser via the picked
   directory handles.

   Atlas tabs beat GET /ping while open. With opts.idleMs set, a stretch of
   silence that long closes the server and calls opts.onIdle, so the launcher
   flow can exit itself instead of lingering. Every response carries an
   x-canon-atlas header so a relaunch can tell this host from a stranger on
   the same port. */
export function serveApp(port = 4700, opts = {}) {
  const page = renderAppPage();
  let lastSeen = Date.now();
  const server = createServer((req, res) => {
    lastSeen = Date.now();
    const stamp = { "x-canon-atlas": "app" };
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
      res.writeHead(403, { ...stamp, "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "unexpected Host" }));
    }
    if (req.method !== "GET") {
      res.writeHead(405, { ...stamp, "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "the app host is static" }));
    }
    if (new URL(req.url, "http://localhost").pathname === "/ping") {
      res.writeHead(204, stamp);
      return res.end();
    }
    res.writeHead(200, { ...stamp, "Content-Type": "text/html; charset=utf-8" });
    res.end(page);
  });
  if (opts.idleMs) {
    const timer = setInterval(() => {
      if (Date.now() - lastSeen > opts.idleMs) {
        clearInterval(timer);
        server.close();
        if (opts.onIdle) opts.onIdle();
      }
    }, Math.min(opts.idleMs, 15000));
  }
  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", rej);
      res({ server, port: server.address().port });
    });
  });
}
