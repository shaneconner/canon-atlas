/* The pure-client shell: no server, no per-project command. Pick a folder in
   the page, read its markdown, build the wire data with the shared
   AtlasPipeline (the very code the CLI runs), and mount the constellation.

   Two pickers, best available wins. The File System Access API (Chrome and
   Edge, over http or https; browsers like Brave remove it, and file:// pages
   block it) gives the full experience: editing writes back through the
   directory handle, enforcing the same collection mutability the server does,
   and picked folders are remembered in IndexedDB. Everywhere else the page
   falls back to the plain directory input, which reads the same folder into
   the same constellation, read only. Each browser tab holds one project. */

(function () {
  "use strict";

  var MD = /\.(md|markdown)$/i;
  var CONFIG = "canon-atlas.json";
  var SKIP = { ".git": 1, "node_modules": 1, ".obsidian": 1, ".atlas": 1 };

  var stage = document.getElementById("stage");
  var handle = null; // the current project's FileSystemDirectoryHandle
  var currentData = null; // last built wire data, for mutability checks

  var supported = typeof window.showDirectoryPicker === "function";
  var isFile = location.protocol === "file:";

  /* ── remembered folders (IndexedDB stores the directory handles) ─────────── */

  var DB = "canon-atlas";
  var STORE = "folders";

  function openDb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(STORE, mode);
        var req = fn(t.objectStore(STORE));
        t.oncomplete = function () { res(req && req.result); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error); };
      });
    });
  }
  /* A row is { handle, manual }: manual marks a name the user typed (the API
     never reveals paths, so a hand-written path is the only way to see one),
     and a manual name is never overwritten by the automatic labeler. Older
     rows stored the bare handle; listFolders normalizes both shapes. */
  function rememberFolder(name, h, manual) {
    return tx("readwrite", function (s) { return s.put({ handle: h, manual: !!manual }, name); });
  }
  function forgetFolder(name) { return tx("readwrite", function (s) { return s.delete(name); }); }
  function listFolders() {
    return tx("readonly", function (s) { return s.getAllKeys(); }).then(function (keys) {
      return Promise.all((keys || []).map(function (k) {
        return tx("readonly", function (s) { return s.get(k); }).then(function (v) {
          return v && v.handle
            ? { name: k, handle: v.handle, manual: !!v.manual }
            : { name: k, handle: v };
        });
      }));
    });
  }

  /* ── permission ──────────────────────────────────────────────────────────── */

  /* A permission request can go unanswered when the browser fails to render its
     prompt (seen with re-enabled APIs); racing it means the app degrades with a
     message instead of waiting forever. The unanswered promise lingers inertly. */
  function raceMs(promise, ms) {
    return new Promise(function (res, rej) {
      var done = false;
      var t = setTimeout(function () {
        if (!done) { done = true; rej(new Error("timeout")); }
      }, ms);
      promise.then(
        function (v) { if (!done) { done = true; clearTimeout(t); res(v); } },
        function (e) { if (!done) { done = true; clearTimeout(t); rej(e); } }
      );
    });
  }

  function ensurePermission(h, mode) {
    var opts = { mode: mode };
    return Promise.resolve(h.queryPermission(opts)).then(function (p) {
      if (p === "granted") return true;
      return Promise.resolve(h.requestPermission(opts)).then(function (q) { return q === "granted"; });
    });
  }

  /* What the handle already carries, asked without prompting. */
  function grantedMode(h) {
    return Promise.resolve(h.queryPermission({ mode: "readwrite" })).then(function (rw) {
      if (rw === "granted") return "fs";
      return Promise.resolve(h.queryPermission({ mode: "read" })).then(function (r) {
        return r === "granted" ? "browse" : null;
      });
    });
  }

  /* ── folder reading ──────────────────────────────────────────────────────── */

  /* A fat catalog is legitimate: the pi-canon campaign statement names 10,000
     articles, and corpora that size mount and draw (measured; see the gate
     notes). What this line catches is a tree of trees (a repo of fixtures, a
     home directory), where the honest move is to stop fast and say so rather
     than read half a million files into a tab. */
  var MAX_DOCS = 25000;

  function tooMany() {
    return new Error(
      "stopped past " + MAX_DOCS + " markdown documents: this folder looks bigger than one catalog. Pick a narrower folder, like the store itself."
    );
  }

  /* Enumerate first, then read. Listing is cheap and gives the cap an early
     answer; reading goes through a bounded pool, because fanning every file
     out at once exhausts descriptors on a fat corpus and reads start failing
     with NotReadableError. */
  function listDir(dir, prefix, out) {
    var pending = [];
    return (async function () {
      for await (const entry of dir.values()) {
        if (SKIP[entry.name]) continue;
        if (out.length > MAX_DOCS) break;
        const rel = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.kind === "directory") pending.push(listDir(entry, rel, out));
        else if (MD.test(entry.name)) out.push({ path: rel, entry: entry });
      }
      await Promise.all(pending);
      return out;
    })();
  }

  var READ_CONCURRENCY = 64;

  /* Run one worker per item through a fixed number of lanes. A failure skips
     that item and is collected, never sinking the rest: one unreadable file in
     a ten-thousand-document corpus is a fact to report, not a reason to stop. */
  function eachLimit(items, limit, worker) {
    var i = 0;
    var failures = [];
    function next() {
      if (i >= items.length) return Promise.resolve();
      var item = items[i++];
      return worker(item)
        .catch(function (e) { failures.push({ item: item, error: e }); })
        .then(next);
    }
    var lanes = [];
    for (var l = 0; l < Math.min(limit, items.length); l++) lanes.push(next());
    return Promise.all(lanes).then(function () { return failures; });
  }

  function readListed(list, progress) {
    var files = [];
    return eachLimit(list, READ_CONCURRENCY, function (it) {
      return it.entry
        .getFile()
        .then(function (f) { return f.text(); })
        .then(function (text) {
          files.push({ path: it.path, text: text });
          if (progress) progress(files.length);
        });
    }).then(function (failures) {
      if (failures.length) {
        console.warn(
          "canon-atlas: skipped " + failures.length + " unreadable file(s), e.g. " +
            failures[0].item.path + ": " + String((failures[0].error && failures[0].error.message) || failures[0].error)
        );
      }
      if (!files.length && list.length) {
        throw new Error("none of the " + list.length + " documents could be read");
      }
      return files;
    });
  }

  function readJson(name) {
    return handle
      .getFileHandle(name)
      .then(function (fh) { return fh.getFile(); })
      .then(function (f) { return f.text(); })
      .then(function (t) { return JSON.parse(t); })
      .catch(function () { return null; });
  }

  /* "fs" when the handle came with write permission, "browse" when it is
     read-only (a dropped folder whose write grant was declined still reads). */
  var handleMode = "fs";

  function buildFromFolder(progress) {
    return listDir(handle, "", [])
      .then(function (list) {
        if (list.length > MAX_DOCS) throw tooMany();
        return readListed(list, progress);
      })
      .then(function (files) {
        return readJson(CONFIG).then(function (configJson) {
          var vecName = (configJson && configJson.embeddings) || "embeddings.json";
          return readJson(vecName).then(function (vectorsJson) {
            currentData = AtlasPipeline.buildWireData(files, {
              configJson: configJson,
              vectorsJson: vectorsJson,
              mode: handleMode,
            });
            return currentData;
          });
        });
      });
  }

  /* ── writing, confined to the corpus and to mutable collections ──────────── */

  function confine(path) {
    if (typeof path !== "string" || !path) throw new Error("path required");
    if (!MD.test(path)) throw new Error("path must end in .md");
    var segs = path.split("/");
    if (path.charAt(0) === "/" || segs.some(function (s) { return !s || s === "." || s === ".."; })) {
      throw new Error("path escapes the corpus");
    }
    var cols = (currentData && currentData.collections) || [];
    for (var i = 0; i < cols.length; i++) {
      if (path.indexOf(cols[i].match) === 0) return cols[i];
    }
    throw new Error("no collection claims this path");
  }

  // Walk the directory handles by path segment; create intermediates on demand.
  function fileHandleFor(path, create) {
    var parts = path.split("/");
    var dir = Promise.resolve(handle);
    for (var i = 0; i < parts.length - 1; i++) {
      (function (name) {
        dir = dir.then(function (d) { return d.getDirectoryHandle(name, { create: !!create }); });
      })(parts[i]);
    }
    return dir.then(function (d) { return d.getFileHandle(parts[parts.length - 1], { create: !!create }); });
  }

  function writeThrough(fh, content) {
    return fh.createWritable().then(function (w) {
      return w.write(content == null ? "" : String(content)).then(function () { return w.close(); });
    });
  }

  var fsBackend = {
    graph: function () { return buildFromFolder(); },
    readDoc: function (path) {
      confine(path);
      return fileHandleFor(path, false)
        .then(function (fh) { return fh.getFile(); })
        .then(function (f) { return f.text(); })
        .then(function (raw) { return { path: path, raw: raw }; });
    },
    writeDoc: function (path, content) {
      var col = confine(path);
      if (col.immutable) return Promise.reject(new Error(col.name + " is immutable"));
      return fileHandleFor(path, false).then(function (fh) { return writeThrough(fh, content); }).then(function () {
        return { path: path };
      });
    },
    createDoc: function (path, content) {
      confine(path);
      // Refuse to overwrite: succeed only if the file does not already exist.
      return fileHandleFor(path, false).then(
        function () { throw new Error("document already exists"); },
        function () {
          return fileHandleFor(path, true).then(function (fh) { return writeThrough(fh, content); }).then(function () {
            return { path: path };
          });
        }
      );
    },
    deleteDoc: function (path) {
      var col = confine(path);
      if (col.immutable) return Promise.reject(new Error(col.name + " is immutable"));
      var parts = path.split("/");
      var dir = Promise.resolve(handle);
      for (var i = 0; i < parts.length - 1; i++) {
        (function (name) {
          dir = dir.then(function (d) { return d.getDirectoryHandle(name); });
        })(parts[i]);
      }
      return dir.then(function (d) { return d.removeEntry(parts[parts.length - 1]); }).then(function () {
        return { path: path };
      });
    },
  };

  /* ── the read-only fallback picker ───────────────────────────────────────────
     A plain directory input works in every browser and from file://, where the
     File System Access API is absent (Brave removes it) or blocked. It reads
     the same folder into the same constellation; it just cannot write back, so
     the page mounts in browse mode and the editor never appears. Nothing is
     uploaded anywhere: the browser only hands the page the files locally. */

  var dirInput = document.createElement("input");
  dirInput.type = "file";
  dirInput.webkitdirectory = true;
  dirInput.style.display = "none";
  document.body.appendChild(dirInput);
  dirInput.addEventListener("change", function () {
    if (dirInput.files && dirInput.files.length) openFileList(dirInput.files);
    dirInput.value = "";
  });
  function pickBrowse() {
    dirInput.click();
  }

  function relOf(f) {
    var rel = f.webkitRelativePath || f.name;
    var parts = rel.split("/");
    parts.shift(); // the picked folder's own name
    for (var i = 0; i < parts.length - 1; i++) if (SKIP[parts[i]]) return null;
    return parts.join("/");
  }

  /* The read-only picker hands over the whole tree at once: read the config,
     the vectors, and the markdown, then mount without a write path. */
  function openFileList(list) {
    var byPath = {};
    for (var i = 0; i < list.length; i++) {
      var rel = relOf(list[i]);
      if (rel) byPath[rel] = list[i];
    }
    var mdPaths = Object.keys(byPath).filter(function (p) { return MD.test(p); });
    if (!mdPaths.length) {
      showLanding("no markdown documents in that folder");
      return;
    }
    if (mdPaths.length > MAX_DOCS) {
      showLanding(String(tooMany().message));
      return;
    }
    function textOf(p) {
      return byPath[p] ? byPath[p].text() : Promise.resolve(null);
    }
    function jsonOf(p) {
      return textOf(p).then(function (t) {
        try { return t ? JSON.parse(t) : null; } catch (e) { return null; }
      });
    }
    setStatus("reading " + mdPaths.length + " documents…");
    jsonOf(CONFIG)
      .then(function (configJson) {
        var vecName = (configJson && configJson.embeddings) || "embeddings.json";
        return jsonOf(vecName).then(function (vectorsJson) {
          return Promise.all(
            mdPaths.map(function (p) {
              return textOf(p).then(function (t) { return { path: p, text: t }; });
            })
          ).then(function (docs) {
            var mem = {};
            docs.forEach(function (f) { mem[f.path] = f.text; });
            var data = AtlasPipeline.buildWireData(docs, {
              configJson: configJson,
              vectorsJson: vectorsJson,
              mode: "browse",
            });
            currentData = data;
            hideLanding();
            AtlasApp.mount(data, browseBackendFor(mem, data));
          });
        });
      })
      .catch(function (e) { showLanding(String((e && e.message) || e)); });
  }

  function browseBackendFor(mem, data) {
    var readOnly = function () {
      return Promise.reject(new Error("read only: this picker cannot write the folder"));
    };
    return {
      graph: function () { return Promise.resolve(data); },
      readDoc: function (p) { return Promise.resolve({ path: p, raw: mem[p] }); },
      writeDoc: readOnly,
      createDoc: readOnly,
      deleteDoc: readOnly,
    };
  }

  /* ── workspaces by path, when the local host serves the page ──────────────
     The `canon-atlas open` host owns a registry of projects by absolute path,
     which no in-browser picker can ever reveal. When the page detects that
     host, the landing and the folders panel offer the path door first: type a
     path, the host reads the corpus behind /w/<id>/api with the same
     confinement and mutability rules as canon-atlas serve, and the recents
     are real paths instead of guessed labels. On any other origin the fetch
     finds no host and none of this renders. */

  var hostList = null; // [{ id, path, exists }] when the canon-atlas host answers

  function hostApi(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    }).then(function (res) {
      return res.json().then(function (j) {
        if (!res.ok) throw new Error(j.error || res.statusText);
        return j;
      });
    });
  }
  function detectHost() {
    if (location.protocol !== "http:" && location.protocol !== "https:") return Promise.resolve(null);
    var name = location.hostname;
    if (name !== "127.0.0.1" && name !== "localhost" && name !== "[::1]") return Promise.resolve(null);
    return fetch("/api/workspaces", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok || r.headers.get("x-canon-atlas") !== "app") return null;
        return r.json().then(function (j) { return j.workspaces || []; });
      })
      .catch(function () { return null; });
  }
  function refreshHost() {
    return detectHost().then(function (l) { hostList = l; });
  }
  function hostBackend(prefix) {
    return {
      graph: function () { return hostApi("GET", prefix + "/graph"); },
      readDoc: function (p) { return hostApi("GET", prefix + "/doc?path=" + encodeURIComponent(p)); },
      writeDoc: function (p, c) { return hostApi("PUT", prefix + "/doc", { path: p, content: c }); },
      createDoc: function (p, c) { return hostApi("POST", prefix + "/doc", { path: p, content: c }); },
      deleteDoc: function (p) { return hostApi("DELETE", prefix + "/doc?path=" + encodeURIComponent(p)); },
    };
  }
  function openWorkspace(ws) {
    setStatus("reading " + ws.path + "…");
    var be = hostBackend("/w/" + ws.id + "/api");
    return be.graph()
      .then(function (data) {
        if (!data.nodes.length) throw new Error("no markdown documents in " + ws.path);
        currentData = data;
        handle = null;
        hideLanding();
        AtlasApp.mount(data, be);
        return refreshHost().then(renderFoldersPanel);
      })
      .catch(function (e) { showLanding(String((e && e.message) || e)); });
  }
  function openPath(path) {
    setStatus("opening " + path + "…");
    return hostApi("POST", "/api/workspace", { path: path })
      .then(openWorkspace)
      .catch(function (e) { showLanding(String((e && e.message) || e)); });
  }

  var MONO_ROW = "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;";

  /* The path door and the remembered workspaces, rendered into a landing box
     or the folders panel alike; mkHead styles the heading for its context and
     rerender repaints that context after a forget. */
  function hostSection(container, mkHead, rerender) {
    var row = el("div", "display:flex;gap:6px;margin-bottom:8px;align-items:stretch;");
    var input = el("input", CARD + "flex:1;min-width:0;padding:7px 10px;" + MONO_ROW);
    input.placeholder = "/absolute/path/to/project";
    var go = el("button", CARD + "color:#9aaa3a;border-color:#4a5220;padding:7px 12px;", "Open");
    function commit() {
      var p = input.value.trim();
      if (p) openPath(p);
    }
    go.addEventListener("click", commit);
    input.addEventListener("keydown", function (ev) { if (ev.key === "Enter") commit(); });
    row.appendChild(input);
    row.appendChild(go);
    container.appendChild(row);
    if (!hostList.length) return;
    container.appendChild(mkHead("workspaces"));
    hostList.forEach(function (w) {
      var r = el("div", "display:flex;gap:6px;margin-bottom:6px;align-items:stretch;");
      var pick = el("button",
        CARD + "flex:1;padding:7px 10px;min-width:0;word-break:break-all;" + MONO_ROW +
        (w.exists ? "" : "opacity:.45;"), w.path);
      pick.title = w.exists ? w.path : w.path + "  (folder is missing)";
      pick.addEventListener("click", function () { openWorkspace(w); });
      var forget = el("button", CARD + "color:#8a8775;padding:7px 10px;", "×");
      forget.title = "forget this workspace";
      forget.addEventListener("click", function () {
        hostApi("DELETE", "/api/workspace?id=" + encodeURIComponent(w.id))
          .then(refreshHost)
          .then(rerender)
          .catch(function () {});
      });
      r.appendChild(pick);
      r.appendChild(forget);
      container.appendChild(r);
    });
  }

  /* ── landing ─────────────────────────────────────────────────────────────── */

  var landing = null;
  var statusEl = null;

  /* Progress under the landing buttons, so a large folder reads as work
     happening rather than a hang. */
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || "";
  }

  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  var CARD = "background:#131409;border:1px solid #33341f;color:#d4cfc3;font:400 14px Outfit,system-ui,sans-serif;" +
    "padding:9px 14px;border-radius:8px;cursor:pointer;text-align:left;";

  function showLanding(message) {
    hideLanding();
    landing = el("div",
      "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
      "background:#090b09;z-index:5;");
    var box = el("div", "max-width:440px;width:100%;padding:24px;");
    var h = el("div",
      "font:500 22px Outfit,system-ui,sans-serif;color:#ede8db;margin-bottom:6px;", "canon-atlas");
    var sub = el("div", "font:300 14px Outfit,system-ui,sans-serif;color:#8a8775;margin-bottom:20px;",
      hostList
        ? "Open a project by its absolute path, or drop a folder anywhere on the page. The local host reads it; nothing leaves your computer."
        : "Open a folder of cross-referencing markdown to see it as a constellation, or drop one anywhere on the page. Nothing leaves your computer.");
    box.appendChild(h);
    box.appendChild(sub);

    var canEdit = supported && !isFile;
    if (hostList) {
      hostSection(box, function (text) {
        return el("div",
          "font:500 12px Outfit,system-ui,sans-serif;color:#8a8775;text-transform:uppercase;letter-spacing:.08em;margin:14px 0 10px;",
          text);
      }, function () { showLanding(); });
    }
    if (canEdit) {
      var open = el("button", CARD + "width:100%;font-size:15px;color:#9aaa3a;border-color:#4a5220;" +
        (hostList ? "margin-top:14px;font-size:14px;color:#8a8775;border-color:#33341f;" : ""), "Open a folder…");
      open.addEventListener("click", pickFolder);
      box.appendChild(open);
      var alt = el("button", CARD + "width:100%;margin-top:8px;color:#8a8775;", "Browse a folder read-only…");
      alt.addEventListener("click", pickBrowse);
      box.appendChild(alt);
    } else {
      var browse = el("button", CARD + "width:100%;" +
        (hostList ? "margin-top:14px;color:#8a8775;" : "font-size:15px;color:#9aaa3a;border-color:#4a5220;"),
        "Browse a folder…  (read only)");
      browse.addEventListener("click", pickBrowse);
      box.appendChild(browse);
      if (!hostList) {
        var why = isFile && supported
          ? "Editing needs this page served over http: browsers block the writable folder picker on file:// pages. Launch it with canon-atlas open and editing lights up."
          : "Editing needs the File System Access API: Chrome or Edge over http or https, or Brave with its file-system-access flag enabled.";
        box.appendChild(el("div", "color:#8a8775;font:300 13px Outfit,system-ui,sans-serif;line-height:1.5;margin-top:12px;", why));
      }
    }

    if (message) {
      box.appendChild(el("div", "color:#e08a6e;font:400 13px Outfit,system-ui,sans-serif;margin-top:12px;", message));
    }

    statusEl = el("div", "color:#9aaa3a;font:300 13px Outfit,system-ui,sans-serif;margin-top:12px;min-height:18px;", "");
    box.appendChild(statusEl);

    var recent = el("div", "margin-top:22px;");
    box.appendChild(recent);
    landing.appendChild(box);
    stage.appendChild(landing);

    if (!canEdit) return; // remembered handles need the rich API to reopen
    listFolders().then(function (folders) {
      if (!folders.length) return;
      recent.appendChild(el("div",
        "font:500 12px Outfit,system-ui,sans-serif;color:#8a8775;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;",
        "recent"));
      folders.forEach(function (f) {
        if (!f.handle) return;
        var row = el("div", "display:flex;gap:8px;margin-bottom:8px;align-items:stretch;");
        var pick = el("button", CARD + "flex:1;", f.name);
        pick.addEventListener("click", function () { openHandle(f.handle, f.name, f.manual); });
        var forget = el("button", CARD + "color:#8a8775;padding:9px 11px;", "×");
        forget.title = "forget this folder";
        forget.addEventListener("click", function () { forgetFolder(f.name).then(function () { showLanding(); }); });
        row.appendChild(pick);
        row.appendChild(forget);
        recent.appendChild(row);
      });
    });
  }

  function hideLanding() {
    if (landing && landing.parentNode) landing.parentNode.removeChild(landing);
    landing = null;
  }

  /* ── open flows ──────────────────────────────────────────────────────────── */

  function pickFolder() {
    window
      .showDirectoryPicker({ id: "canon-atlas", mode: "readwrite" })
      .then(function (h) { return openHandle(h, h.name); })
      .catch(function (e) {
        if (e && e.name === "AbortError") return; // the user dismissed the picker
        if (e && e.name === "SecurityError") {
          showLanding("the writable folder picker is blocked here; browse read-only, or serve this page from localhost to edit");
          return;
        }
        showLanding(String((e && e.message) || e));
      });
  }

  function openHandle(h, name, manual) {
    // A handle from the readwrite picker or a fresh drop already carries its
    // grant, so learn what it has before prompting at all; only a stale
    // remembered handle needs a request, and a request is never allowed to
    // hang the app on a prompt the browser fails to show.
    setStatus("checking permission…");
    return grantedMode(h)
      .then(function (mode) {
        if (mode) return mode;
        return raceMs(ensurePermission(h, "readwrite"), 12000)
          .then(function (ok) { return ok ? "fs" : null; }, function () { return null; })
          .then(function (m) {
            if (m) return m;
            return raceMs(ensurePermission(h, "read"), 12000).then(
              function (ok) {
                if (ok) return "browse";
                throw new Error("permission to read the folder was declined");
              },
              function () {
                throw new Error("the browser did not answer the permission request; try the read-only picker");
              }
            );
          });
      })
      .then(function (mode) {
        handle = h;
        handleMode = mode;
        setStatus("reading the folder…");
        return buildFromFolder(function (n) {
          if (n % 20 === 0) setStatus("reading the folder…  " + n + " documents");
        });
      })
      .then(function (data) {
        if (!data.nodes.length) throw new Error("no markdown documents in this folder");
        setStatus("drawing " + data.nodes.length + " documents…");
        // Remember writable folders under a label the corpus itself provides,
        // because every store is named ".canon" and the API never shows paths.
        // A name the user typed stays exactly as typed.
        var done = Promise.resolve();
        if (handleMode === "fs" && !manual) {
          var label = folderLabel(h, data);
          if (name && name !== label) done = forgetFolder(name);
          done = done.then(function () { return rememberFolder(label, h); });
        }
        return done.then(function () {
          hideLanding();
          AtlasApp.mount(data, fsBackend);
          renderFoldersPanel();
        });
      })
      .catch(function (e) { showLanding(String((e && e.message) || e)); });
  }

  /* The File System Access API never reveals a folder's path, so a remembered
     ".canon" is told apart by what it holds: the configured corpus title when
     canon-atlas.json names one, otherwise the hub document of the graph. */
  function folderLabel(h, data) {
    /* The configured title is the workspace's own name; without one, describe
       the workspace by its most common top-level address segments, which read
       like a directory listing rather than one arbitrary document's title. */
    var mark = data.title || "";
    if (!mark) {
      var counts = {};
      data.nodes.forEach(function (n) {
        if (!n.exists || !n.address) return;
        var seg = n.address.split("/")[0];
        counts[seg] = (counts[seg] || 0) + 1;
      });
      mark = Object.keys(counts)
        .sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); })
        .slice(0, 3)
        .join(" · ");
    }
    mark = mark.slice(0, 40);
    return mark && mark !== h.name ? h.name + " · " + mark : h.name;
  }

  /* ── drop a folder anywhere on the page ──────────────────────────────────────
     Dropping is its own door into the File System Access API: the drop gesture
     grants the handle, no picker involved. Where the handle API is absent the
     visible browse button already covers the folder, so the drop just points
     at it instead of duplicating that path. */

  function wireDrop() {
    window.addEventListener("dragover", function (e) { e.preventDefault(); });
    window.addEventListener("drop", function (e) {
      e.preventDefault();
      // A drag from a file manager can carry string items beside the file item.
      var items = (e.dataTransfer && e.dataTransfer.items) || [];
      var item = null;
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === "file") { item = items[i]; break; }
      }
      if (!item) return;
      if (typeof item.getAsFileSystemHandle !== "function") {
        showLanding("this browser cannot take a dropped folder; use the browse button instead");
        return;
      }
      item.getAsFileSystemHandle()
        .then(function (h) {
          if (h && h.kind === "directory") return openHandle(h, h.name);
          showLanding("drop a folder, not a file");
        })
        .catch(function (err) { showLanding(String((err && err.message) || err)); });
    });
  }

  /* The folders panel behind the rail's folder icon: open or browse another
     project, and reopen or forget remembered folders, without leaving the
     corpus. Each tab still holds one project at a time. */
  function renderFoldersPanel() {
    var btn = document.getElementById("rail-folders");
    var panel = document.getElementById("folders");
    if (!btn || !panel) return;
    btn.hidden = false;
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    var canEdit = supported && !isFile;
    var kind = el("p", "", "folders");
    kind.className = "side-kind";
    panel.appendChild(kind);
    if (hostList) {
      hostSection(panel, function (text) {
        var head = el("p", "", text);
        head.className = "side-sec";
        return head;
      }, renderFoldersPanel);
    }
    var open = el("button", CARD + "width:100%;" +
      (hostList ? "margin-top:8px;color:#8a8775;" : "color:#9aaa3a;border-color:#4a5220;"),
      canEdit ? "Open a folder…" : "Browse a folder…  (read only)");
    open.addEventListener("click", canEdit ? pickFolder : pickBrowse);
    panel.appendChild(open);
    if (canEdit) {
      var alt = el("button", CARD + "width:100%;margin-top:8px;color:#8a8775;", "Browse read-only…");
      alt.addEventListener("click", pickBrowse);
      panel.appendChild(alt);
    }
    if (!canEdit) return; // remembered handles need the rich API to reopen
    listFolders().then(function (folders) {
      folders = folders.filter(function (f) { return f.handle; });
      if (!folders.length) return;
      var head = el("p", "", "recent");
      head.className = "side-sec";
      panel.appendChild(head);
      folders.forEach(function (f) {
        var row = el("div", "display:flex;gap:6px;margin-bottom:6px;align-items:stretch;");
        var pick = el("button", CARD + "flex:1;padding:7px 10px;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;", f.name);
        pick.addEventListener("click", function () { openHandle(f.handle, f.name, f.manual); });
        /* The browser never reveals a folder's path, so a hand-typed name is
           the only way to see one; renamed rows keep their name forever. */
        var ren = el("button", CARD + "color:#8a8775;padding:7px 10px;", "✎");
        ren.title = "rename; a name you type here is kept as written";
        ren.addEventListener("click", function () {
          var input = el("input", CARD + "flex:1;padding:7px 10px;font-size:13px;min-width:0;");
          input.value = f.name;
          row.replaceChild(input, pick);
          input.focus();
          input.select();
          var settled = false;
          function commit() {
            if (settled) return;
            settled = true;
            var next = input.value.trim();
            if (!next || next === f.name) { renderFoldersPanel(); return; }
            forgetFolder(f.name)
              .then(function () { return rememberFolder(next, f.handle, true); })
              .then(renderFoldersPanel);
          }
          input.addEventListener("keydown", function (ev) {
            if (ev.key === "Enter") commit();
            if (ev.key === "Escape") { settled = true; renderFoldersPanel(); }
          });
          input.addEventListener("blur", commit);
        });
        var forget = el("button", CARD + "color:#8a8775;padding:7px 10px;", "×");
        forget.title = "forget this folder";
        forget.addEventListener("click", function () { forgetFolder(f.name).then(renderFoldersPanel); });
        row.appendChild(pick);
        row.appendChild(ren);
        row.appendChild(forget);
        panel.appendChild(row);
      });
    });
  }

  /* When the page comes from the local `canon-atlas open` host, every atlas tab
     beats it so the host can tell an idle day from a working one and exit
     itself instead of lingering forever. Anywhere else this never runs. */
  function heartbeat() {
    if (location.protocol !== "http:" && location.protocol !== "https:") return;
    var name = location.hostname;
    if (name !== "127.0.0.1" && name !== "localhost" && name !== "[::1]") return;
    var beat = function () { fetch("/ping", { cache: "no-store" }).catch(function () {}); };
    beat();
    setInterval(beat, 30000);
  }

  renderFoldersPanel();
  wireDrop();
  heartbeat();
  showLanding();
  /* The host answers in a round trip; when it does, the landing and the
     panel repaint with the path door and the remembered workspaces. */
  refreshHost().then(function () {
    if (!hostList) return;
    renderFoldersPanel();
    if (landing) showLanding();
  });
})();
