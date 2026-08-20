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
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { loadConfig, loadVectors, collectionFor } from "./config.mjs";
import { scanCorpus } from "./scan.mjs";
import { buildGraph } from "./graph.mjs";
import { buildData, renderPage, renderAppPage } from "./page.mjs";

const P = createRequire(import.meta.url)("./ui/pipeline.cjs");

const CACHE_TTL_MS = 3000;
const BODY_LIMIT = 4_000_000;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
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

/* One corpus behind one API: the graph and the documents of a single root,
   with confinement and mutability enforced here rather than in any UI. serve
   mounts one of these at /api; the app host mounts one per registered
   workspace at /w/<id>/api, so both doors share every rule. */
export function corpusApi(rootArg) {
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

  /* The store's schema, enforced at this door the way pi-canon enforces it at
     its own: a required violation the save touched (or a create) rejects with
     nothing written, so the client keeps the text and says what to correct;
     everything else comes back as warnings beside the success. */
  function schemaGate(content, prevRaw, col) {
    const cfg = config();
    if (col.immutable) return [];
    /* A broken declaration enforces nothing, but every write says so. */
    if (!cfg.schema) return cfg.schemaProblems || [];
    const r = P.checkDoc(String(content ?? ""), prevRaw, cfg.schema, col.fields.summary);
    if (r.rejects.length) {
      throw httpError(422, "Write rejected by this store's schema.json:\n- " + r.rejects.join("\n- "));
    }
    return r.warns.concat(cfg.schemaProblems || []);
  }

  /* Serve one API request whose path inside the API is sub ("/graph",
     "/doc"). Returns true when the route was taken; errors throw httpError
     for the caller's catch, so both hosts report them the same way. */
  async function handle(req, res, url, sub, send) {
    if (req.method === "GET" && sub === "/graph") {
      requireLoopbackHost(req);
      send(200, data());
      return true;
    }
    if (sub === "/doc") {
      if (req.method === "GET") {
        requireLoopbackHost(req);
        const { full, rel } = confine(url.searchParams.get("path"));
        if (!existsSync(full)) throw httpError(404, "no such document");
        send(200, { path: rel, raw: readFileSync(full, "utf8") });
        return true;
      }
      if (req.method === "POST") {
        guardMutation(req);
        const body = await readBody(req);
        const { full, rel, col } = confine(body.path);
        if (existsSync(full)) throw httpError(409, "document already exists");
        const warnings = schemaGate(body.content, null, col);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, String(body.content ?? ""), { flag: "wx" });
        bust();
        send(201, warnings.length ? { path: rel, warnings } : { path: rel });
        return true;
      }
      if (req.method === "PUT") {
        guardMutation(req);
        const body = await readBody(req);
        const { full, rel, col } = confine(body.path);
        if (col.immutable) throw httpError(403, `${col.name} is immutable`);
        if (!existsSync(full)) throw httpError(404, "no such document");
        const warnings = schemaGate(body.content, readFileSync(full, "utf8"), col);
        atomicWrite(full, String(body.content ?? ""));
        bust();
        send(200, warnings.length ? { path: rel, warnings } : { path: rel });
        return true;
      }
      if (req.method === "DELETE") {
        guardMutation(req);
        const { full, rel, col } = confine(url.searchParams.get("path"));
        if (col.immutable) throw httpError(403, `${col.name} is immutable`);
        if (!existsSync(full)) throw httpError(404, "no such document");
        unlinkSync(full);
        bust();
        send(200, { path: rel });
        return true;
      }
    }
    return false;
  }

  return { root, data, handle };
}

export function serve(rootArg, port = 4747) {
  const api = corpusApi(rootArg);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, payload, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type + "; charset=utf-8" });
      res.end(type === "application/json" ? JSON.stringify(payload) : payload);
    };
    try {
      if (req.method === "GET" && url.pathname === "/") {
        requireLoopbackHost(req);
        return send(200, renderPage(api.data()), "text/html");
      }
      if (url.pathname.startsWith("/api/")) {
        if (await api.handle(req, res, url, url.pathname.slice(4), send)) return;
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
      res({ server, port: server.address().port, root: api.root });
    });
  });
}

/* ── the app host and its workspaces ─────────────────────────────────────── */

/* The host remembers projects by absolute path, which the in-browser folder
   picker never reveals. The registry is a plain JSON file in the user's
   config directory; ids are content-free (a hash of the real path), so the
   same folder always answers to the same id. */
function workspacesFileDefault() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "canon-atlas", "workspaces.json");
}
function workspaceId(realPath) {
  return createHash("sha256").update(realPath).digest("hex").slice(0, 12);
}
function loadWorkspaces(file) {
  try {
    const rows = JSON.parse(readFileSync(file, "utf8")).workspaces;
    return Array.isArray(rows) ? rows.filter((w) => w && w.id && typeof w.path === "string") : [];
  } catch {
    return [];
  }
}
function saveWorkspaces(file, rows) {
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify({ workspaces: rows }, null, 2) + "\n");
}

/* Host the pure-client app: one static page, plus a workspace registry so a
   project can be opened by its absolute path and remembered as one. Each
   registered workspace gets the full corpus API under /w/<id>/api, the same
   handlers serve() mounts, so editing by path carries every confinement and
   mutability rule. Browsers block the writable folder picker on file://
   pages; an http origin unblocks it, and this is the smallest one, so the
   in-browser pickers keep working beside the path door.

   Atlas tabs beat GET /ping while open. With opts.idleMs set, a stretch of
   silence that long closes the server and calls opts.onIdle, so the launcher
   flow can exit itself instead of lingering. Every response carries an
   x-canon-atlas header so a relaunch can tell this host from a stranger on
   the same port. */
export function serveApp(port = 4700, opts = {}) {
  const page = renderAppPage();
  const wsFile = opts.workspacesFile || workspacesFileDefault();
  let workspaces = loadWorkspaces(wsFile);
  const apis = new Map(); // workspace id -> corpusApi, built on first use

  function registerWorkspace(rawPath) {
    if (typeof rawPath !== "string" || !rawPath.trim()) throw httpError(400, "path required");
    const p = rawPath.trim();
    if (!isAbsolute(p)) throw httpError(400, "path must be absolute");
    if (!existsSync(p)) throw httpError(400, `no such directory: ${p}`);
    if (!statSync(p).isDirectory()) throw httpError(400, "path must be a directory");
    const real = realpathSync(p);
    const id = workspaceId(real);
    const known = workspaces.find((w) => w.id === id);
    if (known) return { row: known, created: false };
    const row = { id, path: real };
    workspaces.push(row);
    saveWorkspaces(wsFile, workspaces);
    return { row, created: true };
  }
  function forgetWorkspace(id) {
    const i = workspaces.findIndex((w) => w.id === id);
    if (i < 0) throw httpError(404, "no such workspace");
    workspaces.splice(i, 1);
    apis.delete(id);
    saveWorkspaces(wsFile, workspaces);
  }
  function apiFor(id) {
    const row = workspaces.find((w) => w.id === id);
    if (!row) throw httpError(404, "no such workspace");
    if (!existsSync(row.path)) throw httpError(404, `workspace folder is missing: ${row.path}`);
    if (!apis.has(id)) apis.set(id, corpusApi(row.path));
    return apis.get(id);
  }

  let lastSeen = Date.now();
  const server = createServer(async (req, res) => {
    lastSeen = Date.now();
    const stamp = { "x-canon-atlas": "app" };
    const url = new URL(req.url, "http://localhost");
    const send = (status, payload, type = "application/json") => {
      res.writeHead(status, { ...stamp, "Content-Type": type + "; charset=utf-8" });
      res.end(type === "application/json" ? JSON.stringify(payload) : payload);
    };
    try {
      requireLoopbackHost(req);
      if (req.method === "GET" && url.pathname === "/ping") {
        res.writeHead(204, stamp);
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/api/workspaces") {
        return send(200, {
          workspaces: workspaces.map((w) => ({ id: w.id, path: w.path, exists: existsSync(w.path) })),
        });
      }
      if (url.pathname === "/api/workspace") {
        if (req.method === "POST") {
          guardMutation(req);
          const body = await readBody(req);
          const { row, created } = registerWorkspace(body.path);
          return send(created ? 201 : 200, { id: row.id, path: row.path });
        }
        if (req.method === "DELETE") {
          guardMutation(req);
          const id = url.searchParams.get("id") || "";
          forgetWorkspace(id);
          return send(200, { id });
        }
      }
      /* /w/<id>/api/... is the registered workspace's own corpus API. */
      const m = url.pathname.match(/^\/w\/([0-9a-f]+)\/api(\/.*)$/);
      if (m) {
        if (await apiFor(m[1]).handle(req, res, url, m[2], send)) return;
        throw httpError(404, "not found");
      }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/w/")) {
        throw httpError(404, "not found");
      }
      if (req.method !== "GET") throw httpError(405, "the app host is static");
      return send(200, page, "text/html");
    } catch (e) {
      send(e.status || 500, { error: e.message });
    }
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
