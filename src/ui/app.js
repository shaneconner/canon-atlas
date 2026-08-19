/* canon-atlas front end: the constellation, the reader, and in live mode the
   editor. Runs against the globals d3 and DATA; DATA.mode is "chart" for a
   static build and "live" when a server is behind the page.

   The rendering is a port of the constellation view from the author's own
   knowledge-graph tooling: a perceptual ramp sampled per cluster, lit-sphere
   orbs over soft halos, per-edge gradients that fade from source hue to target
   hue, and force anchors that pull each cluster into its own region. */

(function () {
  "use strict";

  var C = {
    bg: "#090b09",
    elev: "#0c0d09",
    card: "#131409",
    text: "#d4cfc3",
    dim: "#8a8775",
    bright: "#ede8db",
    cream: "#e2dbc8",
    green: "#7a8a2a",
    greenBr: "#9aaa3a",
    border: "#22231a",
    borderL: "#33341f",
  };
  var FONT = "Outfit, system-ui, sans-serif";

  /* Batlow with its two darkest navy stops dropped: on a near-black ground
     they read as holes rather than nodes. */
  var RAMP = ["#2f7268", "#4a7a52", "#6a7d44", "#9b8a3e", "#c79248", "#e89a6e", "#f2a091", "#f0aec6", "#e6b0e4"];
  var rampScale = null;
  function rampAt(t) {
    if (!rampScale) {
      rampScale = d3
        .scaleLinear()
        .domain(RAMP.map(function (_, i) { return i / (RAMP.length - 1); }))
        .range(RAMP)
        .interpolate(d3.interpolateHcl)
        .clamp(true);
    }
    return t == null || isNaN(t) ? C.dim : rampScale(t);
  }
  function mix(base, top, alpha) {
    var a = d3.rgb(base), b = d3.rgb(top);
    return d3
      .rgb(
        Math.round(a.r + (b.r - a.r) * alpha),
        Math.round(a.g + (b.g - a.g) * alpha),
        Math.round(a.b + (b.b - a.b) * alpha)
      )
      .formatHex();
  }
  var NEUTRAL = "#3c3e33";

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clearHost(h) {
    while (h.firstChild) h.removeChild(h.firstChild);
  }
  function reduced() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  var EDGE = {
    wikilink: { dash: "7 5", dist: 118, strength: 0.3, base: 0.5, w: 1.1 },
    mdlink: { dash: "7 5", dist: 118, strength: 0.3, base: 0.5, w: 1.1 },
    ref: { dash: "3 3", dist: 56, strength: 0.6, base: 0.4, w: 1 },
  };
  var VERB = { wikilink: "links to", mdlink: "links to", ref: "refers to" };
  var INVERSE = { wikilink: "linked from", mdlink: "linked from", ref: "referred to by" };

  var stage = document.getElementById("stage");
  var side = document.getElementById("side");
  var app = null;

  function init(data, keepPos) {
    var G = shapeData(data, keepPos);
    var live = data.mode === "live";
    var cleanup = [];

    AtlasLabels.assignTiers(G.nodes);

    /* ── color modes ──────────────────────────────────────────────────── */

    var clusterPos = {};
    var clusterColor = {};
    data.clusters.forEach(function (c) {
      clusterPos[c.id] = c.pos;
      clusterColor[c.id] = rampAt(c.pos);
    });
    var colPos = {};
    data.collections.forEach(function (c, i) {
      colPos[c.name] = data.collections.length > 1 ? i / (data.collections.length - 1) : 0.5;
    });
    var tagRank = {};
    (function () {
      var votes = {};
      G.nodes.forEach(function (n) {
        (n.tags || []).forEach(function (t) { votes[t] = (votes[t] || 0) + 1; });
      });
      var ranked = Object.keys(votes).sort(function (a, b) { return votes[b] - votes[a] || a.localeCompare(b); }).slice(0, 24);
      ranked.forEach(function (t, i) {
        tagRank[t] = ranked.length > 1 ? i / (ranked.length - 1) : 0.5;
      });
    })();

    var colorMode = "cluster";
    function nodeHue(n) {
      if (!n.exists) return NEUTRAL;
      if (colorMode === "collection") return rampAt(colPos[n.collection]);
      if (colorMode === "tag") {
        for (var i = 0; i < (n.tags || []).length; i++) {
          if (tagRank[n.tags[i]] != null) return rampAt(tagRank[n.tags[i]]);
        }
        return mix(C.elev, C.dim, 0.75);
      }
      return n.cluster != null ? clusterColor[n.cluster] : mix(C.elev, C.dim, 0.75);
    }
    function recolor() {
      G.nodes.forEach(function (n) { n.color = nodeHue(n); });
    }
    recolor();

    /* ── svg scaffold ─────────────────────────────────────────────────── */

    var svg = d3.select(stage).append("svg").style("display", "block").style("font-family", FONT).attr("tabindex", 0);
    var defs = svg.append("defs");

    var glow = defs.append("filter").attr("id", "at-glow")
      .attr("x", "-80%").attr("y", "-80%").attr("width", "260%").attr("height", "260%");
    glow.append("feGaussianBlur").attr("stdDeviation", "2.4").attr("result", "b");
    var gm = glow.append("feMerge");
    gm.append("feMergeNode").attr("in", "b");
    gm.append("feMergeNode").attr("in", "SourceGraphic");
    defs.append("filter").attr("id", "at-soft")
      .attr("x", "-120%").attr("y", "-120%").attr("width", "340%").attr("height", "340%")
      .append("feGaussianBlur").attr("stdDeviation", "7");

    var wash = defs.append("radialGradient").attr("id", "at-wash")
      .attr("cx", "42%").attr("cy", "30%").attr("r", "86%");
    wash.append("stop").attr("offset", "0%").attr("stop-color", mix(C.elev, C.cream, 0.045));
    wash.append("stop").attr("offset", "55%").attr("stop-color", mix(C.elev, C.cream, 0.018));
    wash.append("stop").attr("offset", "100%").attr("stop-color", C.bg);
    var vig = defs.append("radialGradient").attr("id", "at-vignette")
      .attr("cx", "50%").attr("cy", "50%").attr("r", "74%");
    vig.append("stop").attr("offset", "58%").attr("stop-color", "rgba(0,0,0,0)");
    vig.append("stop").attr("offset", "100%").attr("stop-color", "rgba(0,0,0,0.42)");
    var dotp = defs.append("pattern").attr("id", "at-dots")
      .attr("width", 38).attr("height", 38).attr("patternUnits", "userSpaceOnUse");
    dotp.append("circle").attr("cx", 1.5).attr("cy", 1.5).attr("r", 1).attr("fill", C.borderL).attr("opacity", 0.5);

    /* One radial gradient per distinct color, built once and cached, so a node
       reads as a lit sphere rather than a flat disc. */
    var gradCache = {};
    function orbFill(hex) {
      var key = "atg" + hex.replace(/[^0-9a-z]/gi, "");
      if (!gradCache[key]) {
        var g = defs.append("radialGradient").attr("id", key)
          .attr("cx", "38%").attr("cy", "35%").attr("r", "72%");
        g.append("stop").attr("offset", "0%").attr("stop-color", d3.color(hex).brighter(1.05));
        g.append("stop").attr("offset", "60%").attr("stop-color", hex);
        g.append("stop").attr("offset", "100%").attr("stop-color", d3.color(hex).darker(0.55));
        gradCache[key] = 1;
      }
      return "url(#" + key + ")";
    }

    svg.append("rect").attr("width", "100%").attr("height", "100%").attr("fill", "url(#at-wash)");
    var world = svg.append("g");
    world.append("rect").attr("x", -8000).attr("y", -8000)
      .attr("width", 16000).attr("height", 16000).attr("fill", "url(#at-dots)");
    var linkLayer = world.append("g");
    var flowLayer = world.append("g");
    var haloLayer = world.append("g");
    var nodeLayer = world.append("g");
    var labelLayer = world.append("g");
    svg.append("rect").attr("width", "100%").attr("height", "100%")
      .attr("fill", "url(#at-vignette)").style("pointer-events", "none");

    var adj = {}, outOf = {}, inOf = {};
    G.nodes.forEach(function (n) { adj[n.id] = {}; adj[n.id][n.id] = 1; outOf[n.id] = []; inOf[n.id] = []; });
    G.edges.forEach(function (e) {
      adj[e.source][e.target] = 1;
      adj[e.target][e.source] = 1;
      outOf[e.source].push({ id: e.target, via: e.via });
      inOf[e.target].push({ id: e.source, via: e.via });
    });

    var state = { hover: null, pinned: null, off: {}, cluster: null, query: "", k: 1, W: 0, H: 0, warmed: false };

    function nodeVisible(n) {
      if (state.off[chipKey(n)]) return false;
      if (state.cluster != null && n.cluster !== state.cluster) return false;
      return true;
    }
    function edgeVisible(e) { return nodeVisible(e.source) && nodeVisible(e.target); }
    function chipKey(n) { return n.exists ? n.collection : "unwritten"; }

    function matches(n) {
      if (!state.query) return true;
      return n._search.indexOf(state.query) >= 0;
    }

    function radius(n) {
      var r = 5.5 + Math.sqrt(n.degree || 0) * 2.5;
      if (!n.exists) return Math.min(7, r * 0.8);
      return r;
    }

    /* Per-edge gradient, so a link fades from its source hue to its target hue. */
    G.edges.forEach(function (e, i) {
      var lg = defs.append("linearGradient").attr("id", "atl" + i).attr("gradientUnits", "userSpaceOnUse");
      e._s0 = lg.append("stop").attr("offset", "0%").node();
      e._s1 = lg.append("stop").attr("offset", "100%").node();
      e._g = lg.node();
      e._gid = "url(#atl" + i + ")";
      e._fo = (i * 0.6180339887) % 1;
    });

    var sim = d3.forceSimulation(G.nodes)
      .force("link", d3.forceLink(G.edges).id(function (d) { return d.id; })
        .distance(function (e) { return EDGE[e.via].dist; })
        .strength(function (e) { return EDGE[e.via].strength; }))
      .force("charge", d3.forceManyBody().strength(-320).distanceMax(560))
      .force("collide", d3.forceCollide().radius(function (n) { return radius(n) + 11; }).strength(0.86))
      .on("tick", tick)
      .stop();

    /* Each cluster gets an angle on a ring, so a theme becomes a region. An
       unclustered node is pulled gently to the middle instead. */
    var anchor = {};
    function computeAnchors() {
      var R = Math.min(state.W, state.H) * 0.34;
      data.clusters.forEach(function (c, i) {
        var a = (i / data.clusters.length) * 2 * Math.PI - Math.PI / 2;
        anchor[c.id] = [state.W / 2 + R * Math.cos(a), state.H / 2 + R * Math.sin(a)];
      });
    }
    function ax(d) { return d.cluster != null && anchor[d.cluster] ? anchor[d.cluster][0] : state.W / 2; }
    function ay(d) { return d.cluster != null && anchor[d.cluster] ? anchor[d.cluster][1] : state.H / 2; }
    function astr(d) { return d.cluster != null ? 0.06 : 0.02; }

    var linkSel = linkLayer.selectAll("path").data(G.edges).join("path")
      .attr("fill", "none")
      .attr("stroke", function (e) { return e._gid; })
      .attr("stroke-dasharray", function (e) { return EDGE[e.via].dash; });

    var flowSel = flowLayer.selectAll("circle").data(G.edges).join("circle")
      .attr("r", 1.5).style("opacity", 0).style("pointer-events", "none");

    var haloSel = haloLayer.selectAll("circle")
      .data(G.nodes.filter(function (n) { return n.exists && !n.immutable; })).join("circle")
      .attr("r", function (n) { return radius(n) * 2.1; })
      .attr("filter", "url(#at-soft)")
      .style("opacity", 0).style("pointer-events", "none");

    var dragMoved = false;
    var nodeSel = nodeLayer.selectAll("g").data(G.nodes).join("g")
      .attr("class", "node")
      .attr("tabindex", 0).attr("role", "button")
      .attr("aria-label", nodeAria)
      .on("mouseenter", function (e, n) { state.hover = n; paint(); })
      .on("mouseleave", function () { state.hover = null; paint(); })
      .on("focus", function (e, n) { state.hover = n; paint(); })
      .on("blur", function () { state.hover = null; paint(); })
      .on("click", function (e, n) { e.stopPropagation(); if (!dragMoved) pin(n); })
      .on("keydown", function (e, n) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pin(n); }
      })
      .call(d3.drag()
        .on("start", function (e, n) {
          dragMoved = false;
          if (!e.active) sim.alphaTarget(0.2).restart();
          n.fx = n.x; n.fy = n.y;
        })
        .on("drag", function (e, n) { dragMoved = true; n.fx = e.x; n.fy = e.y; })
        .on("end", function (e, n) {
          if (!e.active) sim.alphaTarget(0);
          n.fx = null; n.fy = null;
        }));

    function drawShapes() {
      nodeSel.each(function (n) {
        var g = d3.select(this);
        g.selectAll("*").remove();
        var r = radius(n);
        if (!n.exists) {
          g.append("circle").attr("class", "nd").attr("r", r)
            .attr("fill", mix(C.bg, NEUTRAL, 0.6))
            .attr("stroke", "#5c5e4d").attr("stroke-width", 1).attr("stroke-dasharray", "3 2.5");
        } else if (n.immutable) {
          g.append("circle").attr("class", "nd").attr("r", r)
            .attr("fill", d3.color(n.color).copy({ opacity: 0.16 }))
            .attr("stroke", n.color).attr("stroke-width", 1.8);
        } else {
          g.append("circle").attr("class", "nd").attr("r", r)
            .attr("fill", orbFill(n.color))
            .attr("stroke", d3.color(n.color).brighter(0.6)).attr("stroke-width", 1)
            .style("filter", "url(#at-glow)");
        }
      });
      haloSel.attr("fill", function (n) { return n.color; });
      flowSel.attr("fill", function (e) { return G.nodes[e.source.id != null ? e.source.id : e.source].color; });
    }
    drawShapes();

    var ring = nodeLayer.append("circle").attr("fill", "none").attr("stroke", C.cream)
      .attr("stroke-width", 1.2).attr("stroke-dasharray", "3 3")
      .style("opacity", 0).style("pointer-events", "none");

    var labelSel = labelLayer.selectAll("text").data(G.nodes).join("text")
      .attr("class", "lbl")
      .attr("text-anchor", "middle").attr("paint-order", "stroke")
      .attr("stroke", C.bg).attr("stroke-width", 2.4).attr("stroke-linejoin", "round")
      .text(function (n) { return n._label; });
    function tintLabels() {
      labelSel.attr("fill", function (n) {
        return n.exists ? d3.hcl(d3.color(n.color)).brighter(0.9) + "" : C.dim;
      });
    }
    tintLabels();

    svg.on("click", function () { clearPin(); });

    function measureLabels() {
      labelSel.each(function (n) {
        var fs = labelSize(n);
        this.style.fontSize = fs + "px";
        try { n._lw = this.getComputedTextLength(); } catch (e) { n._lw = n._label.length * fs * 0.5; }
      });
    }

    function nodeAria(n) {
      if (!n.exists) return "Unwritten reference " + n.title + ", named but not yet a document.";
      return n.collection + " " + n.title + ", " + n.degree + " connections.";
    }

    /* ── side panel ───────────────────────────────────────────────────── */

    function relRow(rel, dir) {
      var n = G.nodes[rel.id];
      var b = el("button", "rel");
      b.type = "button";
      var dot = el("span", "reldot");
      if (!n.exists) { dot.style.border = "1px dashed #5c5e4d"; dot.style.background = "none"; }
      else if (n.immutable) { dot.style.border = "1.5px solid " + n.color; dot.style.background = "none"; }
      else dot.style.background = n.color;
      b.appendChild(dot);
      b.appendChild(el("span", "relverb", dir === "out" ? VERB[rel.via] : INVERSE[rel.via]));
      b.appendChild(el("span", "relname", n.exists ? n.address : n.title));
      b.addEventListener("click", function (e) { e.stopPropagation(); pin(n); });
      return b;
    }

    function renderOverview() {
      clearHost(side);
      side.appendChild(el("p", "side-kind", "the corpus, entire"));
      var real = G.nodes.filter(function (n) { return n.exists; });
      side.appendChild(el("p", "side-title", real.length + " documents, " + G.edges.length + " references"));
      var basisLine = {
        embeddings: "Color is the semantic cluster a document belongs to, computed from its embedding, and the layout pulls each cluster into its own region.",
        links: "Color is the neighborhood a document belongs to in the link structure, and the layout pulls each neighborhood into its own region.",
        none: "No clusters yet: add links between documents, or provide embeddings, and regions will form.",
      }[data.basis];
      side.appendChild(el("p", "side-meta", basisLine + " Select a cluster to isolate it, or any node to read it."));
      if (data.clusters.length) {
        var key = el("div");
        data.clusters.forEach(function (c) {
          var row = el("button", "clrow" + (state.cluster === c.id ? " is-on" : ""));
          row.type = "button";
          var d = el("span", "reldot");
          d.style.background = clusterColor[c.id];
          row.appendChild(d);
          row.appendChild(el("span", null, c.label));
          row.appendChild(el("span", "clcount", String(c.size)));
          row.addEventListener("click", function (e) {
            e.stopPropagation();
            state.cluster = state.cluster === c.id ? null : c.id;
            state.pinned = null;
            sim.alpha(0.3).restart();
            paint();
            renderOverview();
            fitToView(true);
          });
          key.appendChild(row);
        });
        side.appendChild(el("p", "side-sec", "clusters"));
        side.appendChild(key);
      }
      side.appendChild(el("p", "side-sec", "key"));
      var shapes = el("div");
      var rows = [];
      data.collections.forEach(function (c) {
        rows.push([c.immutable ? "ring" : "orb", c.name, c.immutable ? "immutable, never rewritten" : "mutable, current ground truth", c.count]);
      });
      if (G.nodes.some(function (n) { return !n.exists; })) {
        rows.push(["dashed", "unwritten", "referenced but not yet a document", G.nodes.filter(function (n) { return !n.exists; }).length]);
      }
      rows.forEach(function (r) {
        var row = el("div", "clrow");
        row.style.cursor = "default";
        var d = el("span", "reldot");
        var neutral = mix(C.elev, C.cream, 0.62);
        if (r[0] === "orb") d.style.background = neutral;
        else if (r[0] === "ring") { d.style.border = "1.5px solid " + neutral; d.style.background = "none"; }
        else { d.style.border = "1px dashed #5c5e4d"; d.style.background = "none"; }
        row.appendChild(d);
        row.appendChild(el("span", null, r[1]));
        var note = el("span", "clcount", r[3] + "  " + r[2]);
        note.style.marginLeft = "auto";
        note.style.textAlign = "right";
        row.appendChild(note);
        shapes.appendChild(row);
      });
      side.appendChild(shapes);
      if (live) {
        var mk = el("div", "edit-row");
        var nb = el("button", "abtn", "new document");
        nb.addEventListener("click", function () { renderCreate(); });
        mk.appendChild(nb);
        side.appendChild(mk);
      }
    }

    function wireDocLinks(container) {
      container.querySelectorAll("a.wl").forEach(function (a) {
        var t = a.getAttribute("data-target") || "";
        var hit = G.resolve(t);
        if (hit) {
          a.addEventListener("click", function (e) { e.preventDefault(); pin(hit); });
        } else {
          a.classList.add("dead");
          a.title = "no document by this name";
        }
      });
    }

    function renderNode(n) {
      clearHost(side);
      var kind = n.exists ? n.collection + (n.immutable ? ", immutable" : "") : "unwritten reference";
      side.appendChild(el("p", "side-kind", kind));
      var t = el("p", "side-title", n.title);
      if (n.exists) t.style.color = d3.hcl(d3.color(n.color)).brighter(1.1) + "";
      side.appendChild(t);
      if (n.path) side.appendChild(el("p", "side-path", n.path + (n.date ? "  ·  " + n.date : "")));
      if (n.sourcePath) side.appendChild(el("p", "side-path", "source: " + n.sourcePath));
      if (!n.exists) {
        side.appendChild(el("p", "side-meta",
          "Named by " + inOf[n.id].length + " document" + (inOf[n.id].length === 1 ? "" : "s") +
          " but not yet written. The constellation keeps the empty seat visible."));
      }
      if (n.summary) {
        var cap = el("p", "side-capsule", n.summary);
        if (n.exists) cap.style.borderLeftColor = n.color;
        side.appendChild(cap);
      }
      if (n.tags && n.tags.length) {
        var tw = el("div", "tags");
        n.tags.forEach(function (tag) {
          var c = el("span", "tag", tag);
          if (n.exists) {
            c.style.borderColor = mix(C.elev, n.color, 0.55);
            c.style.color = mix(C.elev, n.color, 0.9);
          }
          tw.appendChild(c);
        });
        side.appendChild(tw);
      }
      if (live && n.exists) {
        var row = el("div", "edit-row");
        if (!n.immutable) {
          var eb = el("button", "abtn", "edit");
          eb.addEventListener("click", function () { renderEditor(n); });
          row.appendChild(eb);
          var db = el("button", "abtn danger", "delete");
          var armed = false;
          db.addEventListener("click", function () {
            if (!armed) { armed = true; db.textContent = "really delete?"; return; }
            api("DELETE", "/api/doc?path=" + encodeURIComponent(n.path)).then(function () {
              state.pinned = null;
              refresh();
            }).catch(showErr);
          });
          row.appendChild(db);
        } else {
          row.appendChild(el("span", "side-meta", "immutable: the tool never edits or deletes this collection"));
        }
        side.appendChild(row);
      }
      if (live && !n.exists) {
        var mkRow = el("div", "edit-row");
        var wb = el("button", "abtn", "write it");
        wb.addEventListener("click", function () { renderCreate(n.title); });
        mkRow.appendChild(wb);
        side.appendChild(mkRow);
      }
      if (n.html) {
        side.appendChild(el("p", "side-sec", "document"));
        var doc = el("div", "doc");
        doc.innerHTML = n.html;
        side.appendChild(doc);
        wireDocLinks(doc);
      }
      var outs = outOf[n.id], ins = inOf[n.id];
      if (outs.length) {
        side.appendChild(el("p", "side-sec", "points at " + outs.length));
        outs.forEach(function (r) { side.appendChild(relRow(r, "out")); });
      }
      if (ins.length) {
        side.appendChild(el("p", "side-sec", "pointed at by " + ins.length));
        ins.forEach(function (r) { side.appendChild(relRow(r, "in")); });
      }
    }

    function showErr(err) {
      var p = el("p", "err", String((err && err.message) || err));
      side.insertBefore(p, side.firstChild);
    }

    function api(method, url, body) {
      return fetch(url, {
        method: method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }).then(function (res) {
        return res.json().then(function (j) {
          if (!res.ok) throw new Error(j.error || res.statusText);
          return j;
        });
      });
    }

    function renderEditor(n) {
      api("GET", "/api/doc?path=" + encodeURIComponent(n.path)).then(function (doc) {
        clearHost(side);
        side.appendChild(el("p", "side-kind", "editing " + n.collection));
        side.appendChild(el("p", "side-path", n.path));
        var area = el("textarea", "edit-area");
        area.value = doc.raw;
        side.appendChild(area);
        var row = el("div", "edit-row");
        var save = el("button", "abtn", "save");
        save.addEventListener("click", function () {
          api("PUT", "/api/doc", { path: n.path, content: area.value }).then(function () {
            refresh(n.path);
          }).catch(showErr);
        });
        var cancel = el("button", "abtn", "cancel");
        cancel.addEventListener("click", function () { renderNode(n); });
        row.appendChild(save);
        row.appendChild(cancel);
        side.appendChild(row);
        area.focus();
      }).catch(showErr);
    }

    function renderCreate(seedTitle) {
      clearHost(side);
      side.appendChild(el("p", "side-kind", "new document"));
      var mutable = data.collections.filter(function (c) { return !c.immutable; });
      var prefix = mutable.length && data.preset !== "default" ? (mutable[0].match || "") : "";
      var path = el("input", "edit-path");
      path.value = prefix + (seedTitle ? seedTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "") + (seedTitle ? ".md" : "");
      path.placeholder = prefix + "name.md";
      side.appendChild(path);
      var area = el("textarea", "edit-area");
      area.value = seedTitle ? "# " + seedTitle + "\n\n" : "";
      side.appendChild(area);
      var row = el("div", "edit-row");
      var save = el("button", "abtn", "create");
      save.addEventListener("click", function () {
        api("POST", "/api/doc", { path: path.value.trim(), content: area.value }).then(function () {
          refresh(path.value.trim());
        }).catch(showErr);
      });
      var cancel = el("button", "abtn", "cancel");
      cancel.addEventListener("click", function () { renderOverview(); });
      row.appendChild(save);
      row.appendChild(cancel);
      side.appendChild(row);
      path.focus();
    }

    /* ── focus, zoom, fit ─────────────────────────────────────────────── */

    function pin(n) {
      state.pinned = n;
      paint();
      renderNode(n);
      centreOn(n);
    }
    function centreOn(n) {
      if (n.x == null) return;
      var k = Math.max(state.k || 1, 1.15);
      var t = d3.zoomIdentity.translate(state.W / 2 - k * n.x, state.H / 2 - k * n.y).scale(k);
      if (reduced()) svg.call(zoom.transform, t);
      else svg.transition().duration(650).ease(d3.easeCubicInOut).call(zoom.transform, t);
    }
    function clearPin() {
      if (!state.pinned) return;
      state.pinned = null;
      paint();
      renderOverview();
    }

    /* ── label placement ──────────────────────────────────────────────── */

    var CAND = [
      { dx: 0, dy: -1, anchor: "middle" }, { dx: 0, dy: 1, anchor: "middle" },
      { dx: 1, dy: 0, anchor: "start" }, { dx: -1, dy: 0, anchor: "end" },
      { dx: 1, dy: -1, anchor: "start" }, { dx: -1, dy: -1, anchor: "end" },
      { dx: 1, dy: 1, anchor: "start" }, { dx: -1, dy: 1, anchor: "end" },
    ];
    function labelSize(n) { return n.exists ? 10.5 : 8; }
    function offX(n, a, k) { var d = radius(n) + 5 / k; return a.dx * (a.dy ? d * 0.72 : d); }
    function offY(n, a, k) {
      var d = radius(n) + 5 / k, fs = labelSize(n) / k;
      if (!a.dy) return fs * 0.34;
      if (a.dy < 0) return -(a.dx ? d * 0.72 : d);
      return (a.dx ? d * 0.72 : d) + fs * 0.85;
    }
    function candBox(n, a, cx, cy, w, h, k) {
      var bx = cx + offX(n, a, k) * k, by = cy + offY(n, a, k) * k;
      var x0 = a.anchor === "middle" ? bx - w / 2 : a.anchor === "start" ? bx : bx - w;
      return [x0, by - h * 0.8, x0 + w, by + h * 0.2];
    }

    function paint() {
      var f = state.hover || state.pinned;
      if (f && !nodeVisible(f)) f = null;
      var k = state.k || 1;
      var near = f ? adj[f.id] : null;
      var q = !!state.query;

      function dimmed(n) {
        if (near && !near[n.id]) return true;
        if (q && !matches(n)) return true;
        return false;
      }

      nodeSel.style("display", function (n) { return nodeVisible(n) ? null : "none"; })
        .style("opacity", function (n) { return dimmed(n) ? 0.11 : 1; });
      haloSel.style("display", function (n) { return nodeVisible(n) ? null : "none"; })
        .style("opacity", function (n) { return dimmed(n) ? 0.02 : near ? 0.3 : 0.15; });

      linkSel.style("display", function (e) { return edgeVisible(e) ? null : "none"; })
        .attr("stroke-width", function (e) {
          var on = f && (e.source.id === f.id || e.target.id === f.id);
          return (on ? EDGE[e.via].w + 0.9 : EDGE[e.via].w) / k;
        })
        .attr("stroke-opacity", function (e) {
          var base = EDGE[e.via].base;
          if (q && (!matches(e.source) || !matches(e.target))) return 0.04;
          if (!f) return base;
          if (e.source.id === f.id || e.target.id === f.id) return Math.min(1, base + 0.36);
          return 0.04;
        });

      var show = {};
      var t = d3.zoomTransform(svg.node());
      var placed = [];
      var pool = G.nodes.filter(function (n) { return nodeVisible(n) && !dimmed(n); });
      pool.forEach(function (n) {
        var r = radius(n) * t.k;
        var sx = n.x * t.k + t.x, sy = n.y * t.k + t.y;
        placed.push([sx - r, sy - r, sx + r, sy + r]);
      });
      pool.slice().sort(function (a, b) {
        if (f) { if (a === f) return -1; if (b === f) return 1; }
        return b.degree - a.degree;
      }).forEach(function (n) {
        if (!f && !q && t.k < n._minK) return;
        /* Labels render at a screen-constant size (font-size is labelSize/k
           inside a group scaled by k), so the reservation box must be screen
           constant too, or zooming in blockades placement with phantom height. */
        var w = (n._lw || n._label.length * labelSize(n) * 0.5) + 9, h = labelSize(n) * 1.2 + 5;
        var cx = n.x * t.k + t.x, cy = n.y * t.k + t.y;
        for (var c = 0; c < CAND.length; c++) {
          var box = candBox(n, CAND[c], cx, cy, w, h, t.k);
          var clear = box[0] >= 3 && box[2] <= state.W - 3 && box[1] >= 3 && box[3] <= state.H - 3;
          for (var i = 0; clear && i < placed.length; i++) {
            var p = placed[i];
            if (box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1]) clear = false;
          }
          if (clear) { placed.push(box); show[n.id] = 1; n._at = CAND[c]; return; }
        }
        if (f === n) { show[n.id] = 1; n._at = CAND[0]; }
      });
      labelSel
        .style("display", function (n) { return nodeVisible(n) ? null : "none"; })
        .attr("text-anchor", function (n) { return (n._at || CAND[0]).anchor; })
        .attr("dx", function (n) { return offX(n, n._at || CAND[0], k); })
        .attr("dy", function (n) { return offY(n, n._at || CAND[0], k); })
        .style("font-size", function (n) { return labelSize(n) / k + "px"; })
        .style("stroke-width", 2.4 / k + "px")
        .style("opacity", function (n) { return show[n.id] ? (dimmed(n) ? 0.16 : 1) : 0; });

      G.edges.forEach(function (e) {
        if (!edgeVisible(e)) { e._flowOp = 0; return; }
        if (q && (!matches(e.source) || !matches(e.target))) { e._flowOp = 0; return; }
        if (!f) { e._flowOp = 0.22; return; }
        e._flowOp = e.source.id === f.id || e.target.id === f.id ? 0.85 : 0;
      });

      if (state.pinned && nodeVisible(state.pinned)) {
        ring.attr("cx", state.pinned.x).attr("cy", state.pinned.y)
          .attr("r", radius(state.pinned) + 5).attr("stroke-width", 1.2 / k).style("opacity", 0.9);
      } else ring.style("opacity", 0);
    }

    function curve(e) {
      var x1 = e.source.x, y1 = e.source.y, x2 = e.target.x, y2 = e.target.y;
      var dx = x2 - x1, dy = y2 - y1;
      return "M" + x1 + "," + y1 + "Q" + ((x1 + x2) / 2 - dy * 0.1) + "," + ((y1 + y2) / 2 + dx * 0.1) + " " + x2 + "," + y2;
    }
    function flowPoint(e, t) {
      var x1 = e.source.x, y1 = e.source.y, x2 = e.target.x, y2 = e.target.y;
      var dx = x2 - x1, dy = y2 - y1;
      var cx = (x1 + x2) / 2 - dy * 0.1, cy = (y1 + y2) / 2 + dx * 0.1;
      var u = 1 - t;
      return [u * u * x1 + 2 * u * t * cx + t * t * x2, u * u * y1 + 2 * u * t * cy + t * t * y2];
    }
    function tick() {
      linkSel.attr("d", curve);
      G.edges.forEach(function (e) {
        e._g.setAttribute("x1", e.source.x);
        e._g.setAttribute("y1", e.source.y);
        e._g.setAttribute("x2", e.target.x);
        e._g.setAttribute("y2", e.target.y);
        e._s0.setAttribute("stop-color", e.source.color);
        e._s1.setAttribute("stop-color", e.target.color);
      });
      haloSel.attr("cx", function (n) { return n.x; }).attr("cy", function (n) { return n.y; });
      nodeSel.attr("transform", function (n) { return "translate(" + n.x + "," + n.y + ")"; });
      labelSel.attr("x", function (n) { return n.x; }).attr("y", function (n) { return n.y; });
      if (state.pinned) ring.attr("cx", state.pinned.x).attr("cy", state.pinned.y);
    }

    var zoom = d3.zoom().scaleExtent([0.2, 5])
      .filter(function (e) { return e.type === "wheel" || !e.button; })
      .on("zoom", function (e) {
        world.attr("transform", e.transform);
        state.k = e.transform.k;
        paint();
      });
    svg.call(zoom).on("dblclick.zoom", null);

    function fitToView(animate) {
      var vis = G.nodes.filter(nodeVisible);
      if (!vis.length) return;
      var minX = d3.min(vis, function (n) { return n.x; }), maxX = d3.max(vis, function (n) { return n.x; });
      var minY = d3.min(vis, function (n) { return n.y; }), maxY = d3.max(vis, function (n) { return n.y; });
      var pad = 74;
      var s = Math.min(2.2, Math.max(0.25,
        Math.min((state.W - pad) / Math.max(maxX - minX, 1), (state.H - pad) / Math.max(maxY - minY, 1))));
      var t = d3.zoomIdentity
        .translate(state.W / 2 - s * (minX + maxX) / 2, state.H / 2 - s * (minY + maxY) / 2)
        .scale(s);
      if (animate && !reduced()) svg.transition().duration(650).ease(d3.easeCubicInOut).call(zoom.transform, t);
      else svg.call(zoom.transform, t);
    }

    var raf = null, PERIOD = 3400;
    function frame(now) {
      var phase = (now % PERIOD) / PERIOD, k = state.k || 1;
      flowSel.each(function (e) {
        var o = e._flowOp || 0;
        if (o <= 0.02 || e.source.x == null) { this.style.opacity = 0; return; }
        var t = (phase + e._fo) % 1, p = flowPoint(e, t);
        this.setAttribute("cx", p[0]);
        this.setAttribute("cy", p[1]);
        this.setAttribute("r", 1.5 / k);
        this.style.opacity = o * (0.3 + 0.7 * Math.sin(Math.PI * t));
      });
      raf = requestAnimationFrame(frame);
    }
    function startFlow() { if (reduced() || raf != null) return; raf = requestAnimationFrame(frame); }
    function stopFlow() { if (raf != null) { cancelAnimationFrame(raf); raf = null; } flowSel.style("opacity", 0); }

    /* ── header wiring ────────────────────────────────────────────────── */

    var chipsHost = document.getElementById("chips");
    clearHost(chipsHost);
    var chipDefs = data.collections.map(function (c) { return c.name; });
    if (G.nodes.some(function (n) { return !n.exists; })) chipDefs.push("unwritten");
    chipDefs.forEach(function (name) {
      var b = el("button", "chip is-on", name);
      b.setAttribute("aria-pressed", "true");
      b.addEventListener("click", function () {
        state.off[name] = !state.off[name];
        b.classList.toggle("is-on", !state.off[name]);
        b.setAttribute("aria-pressed", String(!state.off[name]));
        if (state.pinned && !nodeVisible(state.pinned)) clearPin();
        sim.alpha(0.4).restart();
        paint();
      });
      chipsHost.appendChild(b);
    });

    var colorSel = document.getElementById("colorby");
    colorSel.value = colorMode;
    function onColor() {
      colorMode = colorSel.value;
      recolor();
      drawShapes();
      tintLabels();
      tick();
      paint();
    }
    colorSel.addEventListener("change", onColor);
    cleanup.push(function () { colorSel.removeEventListener("change", onColor); });

    var search = document.getElementById("search");
    var countEl = document.getElementById("count");
    function onSearch() {
      state.query = search.value.trim().toLowerCase();
      if (state.query) {
        var hits = G.nodes.filter(function (n) { return nodeVisible(n) && matches(n); });
        countEl.textContent = hits.length + " match" + (hits.length === 1 ? "" : "es");
      } else countEl.textContent = "";
      paint();
    }
    function onSearchKey(e) {
      if (e.key === "Enter") {
        var hits = G.nodes.filter(function (n) { return nodeVisible(n) && matches(n); })
          .sort(function (a, b) { return b.rank - a.rank; });
        if (hits.length && state.query) pin(hits[0]);
      }
      if (e.key === "Escape") {
        search.value = "";
        onSearch();
        search.blur();
      }
    }
    search.addEventListener("input", onSearch);
    search.addEventListener("keydown", onSearchKey);
    cleanup.push(function () {
      search.removeEventListener("input", onSearch);
      search.removeEventListener("keydown", onSearchKey);
    });

    var refit = document.getElementById("refit");
    function onRefit() {
      state.pinned = null;
      state.cluster = null;
      paint();
      renderOverview();
      fitToView(true);
    }
    refit.addEventListener("click", onRefit);
    cleanup.push(function () { refit.removeEventListener("click", onRefit); });

    function onDocKey(e) {
      if (e.target === search || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === "/" || e.key === "f") { e.preventDefault(); search.focus(); }
      if (e.key === "Escape") clearPin();
    }
    document.addEventListener("keydown", onDocKey);
    cleanup.push(function () { document.removeEventListener("keydown", onDocKey); });

    /* ── live refresh ─────────────────────────────────────────────────── */

    function refresh(focusPath) {
      api("GET", "/api/graph").then(function (fresh) {
        var pos = {};
        G.nodes.forEach(function (n) { if (n.x != null) pos[n.exists ? n.path : "?" + n.title.toLowerCase()] = { x: n.x, y: n.y }; });
        destroy();
        app = init(fresh, pos);
        if (focusPath) {
          var hit = app.G.nodes.filter(function (n) { return n.path === focusPath; })[0];
          if (hit) app.pin(hit);
        }
      }).catch(showErr);
    }

    /* ── boot ─────────────────────────────────────────────────────────── */

    function size() {
      state.W = stage.clientWidth;
      state.H = stage.clientHeight;
      svg.attr("viewBox", "0 0 " + state.W + " " + state.H).attr("width", state.W).attr("height", state.H);
      computeAnchors();
      sim.force("x", d3.forceX(ax).strength(astr)).force("y", d3.forceY(ay).strength(astr));
    }
    function onResize() {
      size();
      fitToView(false);
      paint();
    }
    window.addEventListener("resize", onResize);
    cleanup.push(function () { window.removeEventListener("resize", onResize); });

    size();
    for (var i = 0; i < 520; i++) sim.tick();
    tick();
    measureLabels();
    renderOverview();
    fitToView(false);
    paint();
    startFlow();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { measureLabels(); paint(); });
    }

    function destroy() {
      stopFlow();
      sim.stop();
      cleanup.forEach(function (fn) { fn(); });
      svg.remove();
      clearHost(side);
    }

    return { G: G, pin: pin, destroy: destroy, refresh: refresh };
  }

  /* Turn the wire DATA into live structures: nodes get search text and a
     resolver for reader wikilinks, and previous positions carry over so a
     refresh does not reshuffle the sky. */
  function shapeData(data, keepPos) {
    var nodes = data.nodes;
    var strip = document.createElement("div");
    nodes.forEach(function (n) {
      strip.innerHTML = n.html || "";
      n._label = AtlasLabels.truncateLabel(n.title);
      n._search = (n.title + " " + (n.address || "") + " " + (n.sourcePath || "") + " " + (n.tags || []).join(" ") + " " + strip.textContent).toLowerCase();
      if (keepPos) {
        var p = keepPos[n.exists ? n.path : "?" + n.title.toLowerCase()];
        if (p) { n.x = p.x; n.y = p.y; }
      }
    });
    strip.innerHTML = "";
    var byPath = {}, byAddress = {}, byName = {}, byTitle = {};
    nodes.forEach(function (n) {
      if (!n.exists) return;
      var noExt = n.path.replace(/\.(md|markdown)$/i, "");
      if (byPath[noExt] == null) byPath[noExt] = n;
      if (byAddress[n.address] == null) byAddress[n.address] = n;
      var name = n.address.split("/").pop().toLowerCase();
      if (byName[name] == null) byName[name] = n;
      var title = n.title.toLowerCase();
      if (byTitle[title] == null) byTitle[title] = n;
    });
    function resolve(target) {
      var t = target.replace(/\.(md|markdown)$/i, "");
      return byPath[t] || byAddress[t] || byName[t.toLowerCase()] || byTitle[t.toLowerCase()] || null;
    }
    return { nodes: nodes, edges: data.edges, resolve: resolve };
  }

  document.getElementById("brand").innerHTML =
    (DATA.title ? DATA.title.replace(/[<>&]/g, "") : "canon-atlas") +
    "<small>" + (DATA.mode === "live" ? "live" : "chart") + "</small>";
  app = init(DATA, null);
})();
