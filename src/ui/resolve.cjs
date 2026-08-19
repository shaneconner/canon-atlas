/* The one link resolver, shared verbatim by the server graph builder (required
   in Node) and the browser reader (inlined as a plain script, where the module
   guard is skipped). Two implementations would drift, and an edge that the
   graph drew would then dead-end in the reader.

   The contract:
     - An exact root-relative path always resolves.
     - An address, basename, or title alias resolves only when it is unique;
       a name two documents share is ambiguous, never a coin flip.
     - A relative markdown link resolves against its source document and is
       rejected if it walks above the corpus root, never silently clamped.
     - A leading slash means root-relative.
   Resolution returns the matched entry, the AMBIGUOUS sentinel, or null. */

var AtlasResolve = (function () {
  var AMBIGUOUS = { ambiguous: true };

  function stripExt(s) {
    return s.replace(/\.(md|markdown)$/i, "");
  }
  function safeDecode(s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  }

  /* Resolve target against a source directory. A leading slash is root-relative;
     otherwise walk from the source dir, and return null if a `..` escapes the
     root instead of clamping to it. */
  function relPath(baseDir, target) {
    if (target.charAt(0) === "/") return target.replace(/^\/+/, "");
    var out = baseDir ? baseDir.split("/") : [];
    out = out.slice();
    var parts = target.split("/");
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p || p === ".") continue;
      if (p === "..") {
        if (!out.length) return null;
        out.pop();
      } else out.push(p);
    }
    return out.join("/");
  }

  function buildIndex(entries) {
    var byPath = {};
    var byAddress = {};
    var byName = {};
    var byTitle = {};
    function claim(map, key, entry) {
      if (!key) return;
      if (!(key in map)) map[key] = entry;
      else if (map[key] !== entry) map[key] = AMBIGUOUS;
    }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      // Paths are unique, so byPath never becomes ambiguous.
      byPath[stripExt(e.path)] = e;
      claim(byAddress, e.address, e);
      claim(byName, e.address.split("/").pop().toLowerCase(), e);
      claim(byTitle, (e.title || "").toLowerCase(), e);
    }
    return { byPath: byPath, byAddress: byAddress, byName: byName, byTitle: byTitle };
  }

  /* index from buildIndex, sourcePath the root-relative path of the document the
     link is authored in, target the raw link text, via one of wikilink, mdlink,
     ref. */
  function resolveLink(index, sourcePath, target, via) {
    if (via === "mdlink") {
      var dir = sourcePath.indexOf("/") >= 0 ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
      var abs = relPath(dir, stripExt(safeDecode(target)));
      if (abs == null) return null; // walked above the root
      var hitP = index.byPath[abs];
      return hitP === AMBIGUOUS ? AMBIGUOUS : hitP || null;
    }
    var t = stripExt(target);
    var chain = [index.byPath[t], index.byAddress[t], index.byName[t.toLowerCase()], index.byTitle[t.toLowerCase()]];
    for (var i = 0; i < chain.length; i++) {
      var hit = chain[i];
      if (hit === AMBIGUOUS) return AMBIGUOUS;
      if (hit) return hit;
    }
    return null;
  }

  return { AMBIGUOUS: AMBIGUOUS, buildIndex: buildIndex, resolveLink: resolveLink };
})();

if (typeof module !== "undefined") module.exports = AtlasResolve;
