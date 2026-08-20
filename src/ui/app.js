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
  /* Authored links draw solid, the primary thread of the constellation; a
     frontmatter ref stays dashed so the two relations read apart at a glance. */
  var EDGE = {
    link: { dash: null, dist: 118, strength: 0.3, base: 0.5, w: 1.1 },
    ref: { dash: "3 3", dist: 56, strength: 0.6, base: 0.4, w: 1 },
  };
  var VERB = { link: "links to", ref: "refers to" };
  var INVERSE = { link: "linked from", ref: "referred to by" };

  var stage = document.getElementById("stage");
  /* The reader body; #side is the surrounding panel that also holds the tabs. */
  var side = document.getElementById("reader");
  var app = null;
  /* Open documents, as paths, in the order opened. They live at module scope
     so a live refresh or a remount keeps the tab row; stale paths are pruned
     when a corpus loads. */
  var openTabs = [];
  var activeTab = null;
  /* Opens a named sidebar panel; wireChrome installs the real function. */
  var openPanel = function () {};

  /* Editing and refresh go through a backend, so the same reader and editor
     drive both the serve API and the pure-client File System Access adapter.
     Each method returns a promise; graph() resolves to fresh wire data, the
     doc methods to { path, raw } or nothing. A page that provides its own
     window.AtlasBackend (the folder app does, once a directory is picked) swaps
     it in at mount; otherwise the built-in HTTP backend talks to the server. */
  function httpApi(method, url, body) {
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
  var httpBackend = {
    graph: function () { return httpApi("GET", "/api/graph"); },
    readDoc: function (path) { return httpApi("GET", "/api/doc?path=" + encodeURIComponent(path)); },
    writeDoc: function (path, content) { return httpApi("PUT", "/api/doc", { path: path, content: content }); },
    createDoc: function (path, content) { return httpApi("POST", "/api/doc", { path: path, content: content }); },
    deleteDoc: function (path) { return httpApi("DELETE", "/api/doc?path=" + encodeURIComponent(path)); },
  };
  var backend = httpBackend;

  function init(data, keepPos) {
    var G = shapeData(data, keepPos);
    // Editing needs a writable backend: the server ("live") or a picked folder
    // ("fs"). A built chart and a read-only folder browse ("browse") are static.
    var live = data.mode === "live" || data.mode === "fs";
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
    var addr = {};
    G.nodes.forEach(function (n) { adj[n.id] = {}; adj[n.id][n.id] = 1; outOf[n.id] = []; inOf[n.id] = []; });
    G.nodes.forEach(function (n) { if (n.exists && n.address) addr[n.address] = n; });
    G.edges.forEach(function (e) {
      adj[e.source][e.target] = 1;
      adj[e.target][e.source] = 1;
      outOf[e.source].push({ id: e.target, via: e.via });
      inOf[e.target].push({ id: e.source, via: e.via });
    });

    var state = { hover: null, pinned: null, mode: {}, cluster: null, query: "", k: 1, W: 0, H: 0, warmed: false };

    /* Visibility is the key row, nothing else: a collection is on the map
       exactly when its row in the key is on. No reveal-on-select, no
       reveal-by-search, nothing lingering; a hidden tier is out of the layout
       too, so it claims no empty space. A collection configured reveal "off"
       or "focus" starts hidden. */
    var revealDefault = { unwritten: "always" };
    data.collections.forEach(function (c) { revealDefault[c.name] = c.reveal || "always"; });
    Object.keys(revealDefault).forEach(function (k) {
      state.mode[k] = revealDefault[k] === "always" ? "on" : "off";
    });

    function chipKey(n) { return n.exists ? n.collection : "unwritten"; }
    function nodeVisible(n) {
      if ((state.mode[chipKey(n)] || "on") === "off") return false;
      if (!n.exists) {
        /* An unwritten name shows only while a visible document names it. */
        var lists = outOf[n.id].concat(inOf[n.id]);
        var anyVisible = lists.some(function (l) {
          var d = G.nodes[l.id];
          if ((state.mode[chipKey(d)] || "on") === "off") return false;
          return state.cluster == null || d.cluster === state.cluster;
        });
        if (!anyVisible) return false;
      }
      if (state.cluster != null && n.cluster !== state.cluster) return false;
      return true;
    }
    function edgeVisible(e) { return nodeVisible(e.source) && nodeVisible(e.target); }
    /* The simulation holds exactly what the map shows. */
    function simActive(n) { return nodeVisible(n); }
    /* A soft node is a whole revealed tier shown at once: present, lower weight. */
    function soft(n) {
      var k = chipKey(n);
      return revealDefault[k] !== "always" && state.mode[k] === "on";
    }

    function matches(n) {
      if (!state.query) return true;
      return n._search.indexOf(state.query) >= 0;
    }

    function radius(n) {
      var r = 5.5 + Math.sqrt(n.degree || 0) * 2.5;
      if (!n.exists) return Math.min(7, r * 0.8);
      return r;
    }

    /* Per-edge gradient, so a link fades from its source hue to its target
       hue. Past a few thousand edges the gradient defs and their per-tick
       endpoint updates dominate the mount (30,011 defs measured at 10k docs),
       so a dense corpus draws flat source-tinted strokes instead. */
    var FLAT_EDGES = G.edges.length > 4000;
    G.edges.forEach(function (e, i) {
      if (!FLAT_EDGES) {
        var lg = defs.append("linearGradient").attr("id", "atl" + i).attr("gradientUnits", "userSpaceOnUse");
        e._s0 = lg.append("stop").attr("offset", "0%").node();
        e._s1 = lg.append("stop").attr("offset", "100%").node();
        e._g = lg.node();
        e._gid = "url(#atl" + i + ")";
      }
      e._fo = (i * 0.6180339887) % 1;
    });

    var linkForce = d3.forceLink(G.edges).id(function (d) { return d.id; })
      .distance(function (e) { return EDGE[e.via].dist; })
      .strength(function (e) { return EDGE[e.via].strength; });
    var sim = d3.forceSimulation(G.nodes)
      .force("link", linkForce)
      .force("charge", d3.forceManyBody().strength(-320).distanceMax(560))
      .force("collide", d3.forceCollide().radius(function (n) { return radius(n) + 11; }).strength(0.86))
      .on("tick", tick)
      .stop();

    /* Rebind the simulation to the active set. Hidden tiers must not tug the
       layout, or four articles would float in the empty space their hundred
       hidden satellites reserve. */
    function rebindSim(alpha) {
      sim.nodes(G.nodes.filter(simActive));
      linkForce.links(G.edges.filter(function (e) { return simActive(e.source) && simActive(e.target); }));
      if (alpha) sim.alpha(alpha).restart();
    }

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
      .attr("stroke", function (e) { return e._gid || null; })
      .attr("stroke-dasharray", function (e) { return EDGE[e.via].dash; });

    var flowSel = flowLayer.selectAll("circle").data(G.edges).join("circle")
      .attr("r", 2.6).style("opacity", 0).style("pointer-events", "none");

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
        .filter(function (e, n) { return !e.ctrlKey && !e.button && simActive(n); })
        /* The simulation heats on the first actual movement, never on the
           press: heating at mousedown lurched the whole sky, the node drifted
           out from under the cursor before mouseup, and the browser resolved
           the click to the background, which cleared the selection. */
        .on("start", function (e, n) {
          dragMoved = false;
          n.fx = n.x; n.fy = n.y;
        })
        .on("drag", function (e, n) {
          if (!dragMoved) {
            dragMoved = true;
            sim.alphaTarget(0.2).restart();
          }
          n.fx = e.x; n.fy = e.y;
        })
        .on("end", function (e, n) {
          if (dragMoved) sim.alphaTarget(0);
          /* A pinned node stays held where the drag left it. */
          if (state.pinned === n) { n.fx = n.x; n.fy = n.y; }
          else { n.fx = null; n.fy = null; }
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
      if (FLAT_EDGES) {
        linkSel.attr("stroke", function (e) {
          return G.nodes[e.source.id != null ? e.source.id : e.source].color;
        });
      }
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

    /* The documents panel: the search box (the one search: it filters this
       list and lights the matches on the map), an order select, and every
       document, click to read. */
    var WIKI_ROWS = 400;
    var wikiSearch = null;
    var wikiOrder = "rank";
    function renderWiki() {
      var host = document.getElementById("wiki");
      if (!host) return;
      clearHost(host);
      var all = G.nodes.filter(function (n) { return n.exists; });
      var input = el("input", "wk-filter");
      input.type = "search";
      input.placeholder = "search " + all.length + " documents  ( / )";
      wikiSearch = input;
      host.appendChild(input);
      var bar = el("div", "wk-bar");
      var order = el("select", "abtn");
      order.setAttribute("aria-label", "order documents by");
      [["rank", "order: rank"], ["recent", "order: recent"], ["title", "order: title"]].forEach(function (o) {
        var opt = el("option", null, o[1]);
        opt.value = o[0];
        order.appendChild(opt);
      });
      order.value = wikiOrder;
      bar.appendChild(order);
      var countNote = el("span", "wk-note", "");
      bar.appendChild(countNote);
      host.appendChild(bar);
      var listHost = el("div");
      host.appendChild(listHost);
      var ORDERS = {
        rank: function (a, b) { return b.rank - a.rank; },
        recent: function (a, b) { return (b.date || "").localeCompare(a.date || "") || b.rank - a.rank; },
        title: function (a, b) { return a.title.localeCompare(b.title); },
      };
      function renderList() {
        clearHost(listHost);
        state.query = input.value.trim().toLowerCase();
        paint();
        var q = state.query;
        var ranked = all.slice().sort(ORDERS[wikiOrder] || ORDERS.rank);
        var hits = q ? ranked.filter(function (n) { return n._search.indexOf(q) >= 0; }) : ranked;
        countNote.textContent = q ? hits.length + " match" + (hits.length === 1 ? "" : "es") : "";
        hits.slice(0, WIKI_ROWS).forEach(function (n) {
          var row = el("button", "wk-row");
          row.type = "button";
          var d = el("span", "reldot");
          d.style.background = n.color;
          row.appendChild(d);
          var t = el("span", "wk-title", n.title);
          t.title = n.address;
          row.appendChild(t);
          row.appendChild(el("span", "wk-rank", wikiOrder === "recent" && n.date ? String(n.date).slice(0, 10) : n.collection));
          row.addEventListener("click", function () { pin(n); });
          listHost.appendChild(row);
        });
        if (hits.length > WIKI_ROWS) {
          listHost.appendChild(el("div", "wk-note",
            "top " + WIKI_ROWS + " of " + hits.length + "; search to reach the rest"));
        }
        if (q && !hits.length) listHost.appendChild(el("div", "wk-note", "no documents match"));
      }
      input.addEventListener("input", renderList);
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && state.query) {
          var q = state.query;
          var pool = all.filter(function (n) { return n._search.indexOf(q) >= 0; })
            .sort(function (a, b) { return b.rank - a.rank; });
          var top = pool.filter(nodeVisible)[0] || pool[0];
          if (top) pin(top);
        }
        if (e.key === "Escape") {
          input.value = "";
          renderList();
          input.blur();
        }
      });
      order.addEventListener("change", function () { wikiOrder = order.value; renderList(); });
      renderList();
    }

    /* The map panel: corpus stats, color mode, cluster isolation, and the key,
       whose rows double as each collection's on/off switch. */
    function renderOverview() {
      var ov = document.getElementById("overview");
      if (!ov) return;
      clearHost(ov);
      ov.appendChild(el("p", "side-kind", (data.title || "canon-atlas") + "  ·  " + modeLabel(data.mode)));
      var real = G.nodes.filter(function (n) { return n.exists; });
      ov.appendChild(el("p", "side-title", real.length + " documents, " + G.edges.length + " references"));
      var basisLine = {
        embeddings: "Color is the semantic cluster a document belongs to, computed from its embedding, and the layout pulls each cluster into its own region.",
        paths: "Color is the top of a document's address, so each first-level path is a region of the map.",
        links: "Color is the neighborhood a document belongs to in the link structure, and the layout pulls each neighborhood into its own region.",
        none: "No clusters yet: add links between documents, or provide embeddings, and regions will form.",
      }[data.basis];
      ov.appendChild(el("p", "side-meta", basisLine + " Select a cluster to isolate it, or any node to read it."));
      /* A schema the owner believes is enforced while a typo disabled it is
         the worst state, so declaration problems surface here, loud. */
      if (data.schemaProblems && data.schemaProblems.length) {
        ov.appendChild(el("p", "err", data.schemaProblems.join("\n")));
      }
      data.collections.forEach(function (c) {
        if (state.mode[c.name] === "off" && c.count) {
          ov.appendChild(el("p", "side-meta",
            c.count + " " + c.name + " document" + (c.count === 1 ? " is" : "s are") +
            " off the map; the " + c.name + " row in the key turns them on."));
        }
      });
      var crow = el("div", "edit-row");
      var csel = el("select", "abtn");
      csel.setAttribute("aria-label", "color by");
      [["cluster", "color: cluster"], ["collection", "color: collection"], ["tag", "color: tag"]].forEach(function (o) {
        var opt = el("option", null, o[1]);
        opt.value = o[0];
        csel.appendChild(opt);
      });
      // A corpus without tags has nothing for tag color to say; the option
      // disables rather than painting everything the same grey.
      var anyTags = G.nodes.some(function (n) { return n.exists && n.tags && n.tags.length; });
      csel.querySelector('option[value="tag"]').disabled = !anyTags;
      if (!anyTags && colorMode === "tag") colorMode = "cluster";
      csel.value = colorMode;
      csel.addEventListener("change", function () {
        colorMode = csel.value;
        recolor();
        drawShapes();
        tintLabels();
        tick();
        paint();
      });
      crow.appendChild(csel);
      ov.appendChild(crow);
      if (data.clusters.length) {
        var key = el("div");
        data.clusters.forEach(function (c) {
          var row = el("button", "clrow" + (state.cluster === c.id ? " is-on" : ""));
          row.type = "button";
          var d = el("span", "reldot");
          d.style.background = clusterColor[c.id];
          row.appendChild(d);
          row.appendChild(el("span", null, AtlasLabels.truncateLabel(c.label)));
          row.appendChild(el("span", "clcount", String(c.size)));
          row.addEventListener("click", function (e) {
            e.stopPropagation();
            state.cluster = state.cluster === c.id ? null : c.id;
            releasePin();
            rebindSim(0.3);
            paint();
            renderOverview();
            fitToView(true);
          });
          key.appendChild(row);
        });
        ov.appendChild(el("p", "side-sec", "clusters"));
        ov.appendChild(key);
      }
      ov.appendChild(el("p", "side-sec", "key"));
      var shapes = el("div");
      var rows = [];
      data.collections.forEach(function (c) {
        rows.push([c.immutable ? "ring" : "orb", c.name, c.immutable ? "immutable, never rewritten" : "mutable, current ground truth", c.count]);
      });
      if (G.nodes.some(function (n) { return !n.exists; })) {
        rows.push(["dashed", "unwritten", "referenced but not yet a document", G.nodes.filter(function (n) { return !n.exists; }).length]);
      }
      rows.forEach(function (r) {
        var name = r[1];
        var on = state.mode[name] === "on";
        var row = el("button", "clrow keyrow" + (on ? "" : " is-off"));
        row.type = "button";
        row.title = name + (on ? ": on the map, click to hide" : ": hidden, click to show");
        row.setAttribute("aria-pressed", String(on));
        var d = el("span", "reldot");
        var neutral = mix(C.elev, C.cream, 0.62);
        if (r[0] === "orb") d.style.background = neutral;
        else if (r[0] === "ring") { d.style.border = "1.5px solid " + neutral; d.style.background = "none"; }
        else { d.style.border = "1px dashed #5c5e4d"; d.style.background = "none"; }
        row.appendChild(d);
        row.appendChild(el("span", null, name));
        var note = el("span", "clcount", r[3] + "  " + r[2]);
        note.style.marginLeft = "auto";
        note.style.textAlign = "right";
        row.appendChild(note);
        row.addEventListener("click", function () {
          state.mode[name] = state.mode[name] === "on" ? "off" : "on";
          rebindSim(0.4);
          paint();
          renderOverview();
          fitToView(true);
        });
        shapes.appendChild(row);
      });
      ov.appendChild(shapes);
      if (live) {
        var mk = el("div", "edit-row");
        var nb = el("button", "abtn", "new document");
        nb.addEventListener("click", function () { showReader(); renderCreate(); });
        mk.appendChild(nb);
        ov.appendChild(mk);
      }
    }

    function wireDocLinks(container, sourceNode) {
      container.querySelectorAll("a.wl").forEach(function (a) {
        var t = a.getAttribute("data-target") || "";
        var via = a.getAttribute("data-via") || "wikilink";
        var hit = G.resolve(t, sourceNode ? sourceNode.path : "", via);
        if (hit) {
          a.addEventListener("click", function (e) { e.preventDefault(); pin(hit); });
        } else {
          a.classList.add("dead");
          a.title = "no document by this name";
        }
      });
    }

    /* ── reader tabs ──────────────────────────────────────────────────── */

    function byPath(p) {
      return G.nodes.filter(function (n) { return n.exists && n.path === p; })[0] || null;
    }
    var tabsHost = document.getElementById("tabs");
    function showReader() {
      document.getElementById("grid").classList.remove("side-off");
      window.dispatchEvent(new Event("resize"));
    }
    function hideReader() {
      document.getElementById("grid").classList.add("side-off");
      window.dispatchEvent(new Event("resize"));
    }
    function renderTabs() {
      if (!tabsHost) return;
      clearHost(tabsHost);
      openTabs.forEach(function (p) {
        var n = byPath(p);
        if (!n) return;
        var t = el("button", "tab" + (activeTab === p ? " is-on" : ""));
        t.type = "button";
        t.title = n.address || n.title;
        var d = el("span", "reldot");
        if (n.immutable) { d.style.border = "1.5px solid " + n.color; d.style.background = "none"; }
        else d.style.background = n.color;
        t.appendChild(d);
        t.appendChild(el("span", "tab-title", n.title));
        var x = el("span", "tab-x", "×");
        x.title = "close";
        x.addEventListener("click", function (e) { e.stopPropagation(); closeTab(p); });
        t.appendChild(x);
        t.addEventListener("click", function () { pin(n); });
        t.addEventListener("auxclick", function (e) {
          if (e.button === 1) { e.preventDefault(); closeTab(p); }
        });
        tabsHost.appendChild(t);
      });
      var on = tabsHost.querySelector(".tab.is-on");
      if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    /* Every document opens into its own tab; opening again just activates it.
       A node that is not a document (an unwritten name) shows in the reader
       without claiming a tab. */
    function openDocTab(n) {
      if (!n.exists || !n.path) {
        activeTab = null;
        renderTabs();
        renderNode(n);
        showReader();
        return;
      }
      if (openTabs.indexOf(n.path) < 0) openTabs.push(n.path);
      activeTab = n.path;
      renderTabs();
      renderNode(n);
      showReader();
    }
    function closeTab(p) {
      var i = openTabs.indexOf(p);
      if (i >= 0) openTabs.splice(i, 1);
      if (activeTab !== p) { renderTabs(); return; }
      var next = openTabs[Math.min(i, openTabs.length - 1)];
      var n = next && byPath(next);
      if (n) { pin(n); return; }
      activeTab = null;
      renderTabs();
      clearHost(side);
      hideReader();
      clearPin();
    }
    /* Back to the active tab after a transient view (create form, an error). */
    function showActive() {
      var n = activeTab && byPath(activeTab);
      if (n) { renderNode(n); return; }
      clearHost(side);
      hideReader();
    }

    function renderNode(n) {
      clearHost(side);
      /* Breadcrumbs for structured addresses: each parent segment is a step
         up, landing on the document at that address when one exists and
         otherwise filtering the search to everything under it. */
      if (n.exists && n.address && n.address.indexOf("/") > 0) {
        var crumbs = el("p", "crumbs");
        var segs = n.address.split("/");
        var acc = "";
        segs.forEach(function (seg, i) {
          if (i) crumbs.appendChild(el("span", "crumb-sep", "/"));
          acc = acc ? acc + "/" + seg : seg;
          if (i === segs.length - 1) { crumbs.appendChild(el("span", "crumb-here", seg)); return; }
          var target = acc;
          var b = el("button", "crumb", seg);
          b.addEventListener("click", function () {
            var hit = addr[target];
            if (hit) { pin(hit); return; }
            openPanel("wiki");
            if (wikiSearch) {
              wikiSearch.value = target + "/";
              wikiSearch.dispatchEvent(new Event("input"));
              wikiSearch.focus();
            }
          });
          crumbs.appendChild(b);
        });
        side.appendChild(crumbs);
      }
      var kind = n.exists ? n.collection + (n.immutable ? ", immutable" : "") : "unwritten reference";
      side.appendChild(el("p", "side-kind", kind));
      /* A document in violation of the store's schema reads fine; the notes
         say what an edit would heal. */
      if (n.schemaNotes && n.schemaNotes.length) {
        side.appendChild(el("p", "schema-note", n.schemaNotes.join("\n")));
      }
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
          var armed = false, disarm = 0;
          db.addEventListener("click", function () {
            if (!armed) {
              /* Two clicks to delete, and the arming wears off, so a stray
                 click minutes later cannot land on a loaded button. */
              armed = true;
              db.textContent = "really delete?";
              disarm = setTimeout(function () { armed = false; db.textContent = "delete"; }, 4000);
              return;
            }
            clearTimeout(disarm);
            backend.deleteDoc(n.path).then(function () {
              state.pinned = null;
              pushHash(null);
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
        wireDocLinks(doc, n);
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
      /* Replace any standing error: a corrected retry must not stack lines. */
      var old = side.querySelector(".err");
      if (old) old.parentNode.removeChild(old);
      var p = el("p", "err", String((err && err.message) || err));
      side.insertBefore(p, side.firstChild);
    }

    function renderEditor(n) {
      backend.readDoc(n.path).then(function (doc) {
        clearHost(side);
        side.appendChild(el("p", "side-kind", "editing " + n.collection));
        side.appendChild(el("p", "side-path", n.path));
        var area = el("textarea", "edit-area");
        area.value = doc.raw;
        side.appendChild(area);
        var row = el("div", "edit-row");
        var save = el("button", "abtn", "save");
        save.addEventListener("click", function () {
          backend.writeDoc(n.path, area.value).then(function () {
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

    /* The collection a path would land in: longest matching prefix claims it,
       the same rule the pipeline sorts files by. */
    function collFor(p) {
      var best = null;
      data.collections.forEach(function (c) {
        if (p.indexOf(c.match) === 0 && (!best || c.match.length > best.match.length)) best = c;
      });
      return best;
    }

    /* A new document should read like its siblings: frontmatter keys the
       collection's documents actually carry (under the corpus's own names),
       and a title heading. Majority rules; a bare notes folder stays bare. */
    function templateFor(coll, seedTitle) {
      var f = (coll && coll.fields) || {};
      var sibs = coll
        ? G.nodes.filter(function (n) { return n.exists && n.collection === coll.name; })
        : [];
      function most(has) {
        var c = 0;
        sibs.forEach(function (n) { if (has(n)) c++; });
        return c * 2 > sibs.length;
      }
      var lines = [];
      if (sibs.length) {
        if (most(function (n) { return n.summary; })) lines.push((f.summary || "summary") + ": ");
        if (most(function (n) { return n.date; })) {
          lines.push((f.date || "date") + ": " + new Date().toISOString().slice(0, 10));
        }
        if (most(function (n) { return n.tags && n.tags.length; })) lines.push((f.tags || "tags") + ": []");
        /* Only a corpus that renamed the refs key (journal's "subject") writes
           refs in frontmatter; the default name means body links carry them. */
        if (f.refs && f.refs !== "refs") lines.push(f.refs + ": []");
      }
      var fm = lines.length ? "---\n" + lines.join("\n") + "\n---\n\n" : "";
      return fm + "# " + (seedTitle || "") + "\n";
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
      area.value = templateFor(collFor(path.value.trim()) || mutable[0] || null, seedTitle);
      var touched = false;
      area.addEventListener("input", function () { touched = true; });
      path.addEventListener("input", function () {
        if (!touched) area.value = templateFor(collFor(path.value.trim()) || mutable[0] || null, seedTitle);
      });
      side.appendChild(area);
      var row = el("div", "edit-row");
      var save = el("button", "abtn", "create");
      save.addEventListener("click", function () {
        backend.createDoc(path.value.trim(), area.value).then(function () {
          refresh(path.value.trim());
        }).catch(showErr);
      });
      var cancel = el("button", "abtn", "cancel");
      cancel.addEventListener("click", function () { showActive(); });
      row.appendChild(save);
      row.appendChild(cancel);
      side.appendChild(row);
      path.focus();
    }

    /* ── focus, zoom, fit ─────────────────────────────────────────────── */

    function pin(n) {
      if (state.pinned && state.pinned !== n) { state.pinned.fx = null; state.pinned.fy = null; }
      state.pinned = n;
      /* Hold the selected node still: what you are reading must not drift. */
      if (n.x != null) { n.fx = n.x; n.fy = n.y; }
      paint();
      openDocTab(n);
      if (nodeVisible(n)) centreOn(n);
      if (n.exists && n.path) pushHash(n.path);
    }
    function centreOn(n) {
      if (n.x == null) return;
      var k = Math.max(state.k || 1, 1.15);
      var target = function () {
        return d3.zoomIdentity.translate(state.W / 2 - k * n.x, state.H / 2 - k * n.y).scale(k);
      };
      if (reduced()) { svg.call(zoom.transform, target()); return; }
      /* The pinned node is held still, so the flight's aim is stable; the end
         snap re-reads position and stage size, covering anything that moved
         or resized mid-flight. (Never re-apply zoom.transform per frame from
         inside a tween: on a plain selection it interrupts its own flight.) */
      svg.transition().duration(650).ease(d3.easeCubicInOut).call(zoom.transform, target)
        .on("end", function () { svg.call(zoom.transform, target()); });
    }
    function releasePin() {
      if (state.pinned) { state.pinned.fx = null; state.pinned.fy = null; }
      state.pinned = null;
    }
    function clearPin() {
      if (!state.pinned) return;
      releasePin();
      paint();
      pushHash(null);
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
        .style("opacity", function (n) { return dimmed(n) ? 0.11 : soft(n) ? 0.68 : 1; });
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
        /* The focused node and the sky's anchors (tier zero, the biggest)
           keep their names even when crowded; later labels avoid their box. */
        if (f === n || n._minK === 0) {
          placed.push(candBox(n, CAND[0], cx, cy, w, h, t.k));
          show[n.id] = 1;
          n._at = CAND[0];
        }
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

      /* The sky can be dragged or zoomed clean out of view; when no visible
         node is on screen, offer the way back where the eye is looking. */
      var lostBtn = document.getElementById("lost");
      if (lostBtn) {
        var anyOn = false;
        for (var li = 0; li < G.nodes.length && !anyOn; li++) {
          var ln = G.nodes[li];
          if (ln.x == null || !nodeVisible(ln)) continue;
          var lx = ln.x * t.k + t.x, ly = ln.y * t.k + t.y;
          if (lx > -20 && lx < state.W + 20 && ly > -20 && ly < state.H + 20) anyOn = true;
        }
        lostBtn.hidden = anyOn;
      }
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
      if (!FLAT_EDGES) {
        G.edges.forEach(function (e) {
          e._g.setAttribute("x1", e.source.x);
          e._g.setAttribute("y1", e.source.y);
          e._g.setAttribute("x2", e.target.x);
          e._g.setAttribute("y2", e.target.y);
          e._s0.setAttribute("stop-color", e.source.color);
          e._s1.setAttribute("stop-color", e.target.color);
        });
      }
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
    /* Double-clicking the sky reframes it: the always-there way home. */
    svg.on("dblclick", function () { fitToView(true); });

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

    var raf = null, PERIOD = 3400, BREATH = 5200;
    function frame(now) {
      var phase = (now % PERIOD) / PERIOD, k = state.k || 1;
      /* The sky breathes: one slow opacity swell over the whole link layer,
         a single write per frame whatever the corpus size. */
      linkLayer.attr("opacity", 0.9 + 0.1 * Math.sin(((now % BREATH) / BREATH) * 2 * Math.PI));
      flowSel.each(function (e) {
        var o = e._flowOp || 0;
        if (o <= 0.02 || e.source.x == null) { this.style.opacity = 0; return; }
        var t = (phase + e._fo) % 1, p = flowPoint(e, t);
        this.setAttribute("cx", p[0]);
        this.setAttribute("cy", p[1]);
        this.setAttribute("r", 2.6 / k);
        this.style.opacity = o * (0.3 + 0.7 * Math.sin(Math.PI * t));
      });
      raf = requestAnimationFrame(frame);
    }
    function startFlow() { if (reduced() || raf != null) return; raf = requestAnimationFrame(frame); }
    function stopFlow() {
      if (raf != null) { cancelAnimationFrame(raf); raf = null; }
      flowSel.style("opacity", 0);
      linkLayer.attr("opacity", 1);
    }

    /* ── header wiring ────────────────────────────────────────────────── */

    var refit = document.getElementById("refit");
    function onRefit() {
      state.cluster = null;
      releasePin();
      paint();
      renderOverview();
      fitToView(true);
      pushHash(null);
    }
    refit.addEventListener("click", onRefit);
    cleanup.push(function () { refit.removeEventListener("click", onRefit); });

    var lost = document.getElementById("lost");
    function onLost() { fitToView(true); paint(); }
    if (lost) {
      lost.addEventListener("click", onLost);
      cleanup.push(function () { lost.removeEventListener("click", onLost); });
    }

    function onDocKey(e) {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === "/" || e.key === "f") {
        e.preventDefault();
        openPanel("wiki");
        if (wikiSearch) wikiSearch.focus();
      }
      if (e.key === "Escape") clearPin();
    }
    document.addEventListener("keydown", onDocKey);
    cleanup.push(function () { document.removeEventListener("keydown", onDocKey); });

    /* ── live refresh ─────────────────────────────────────────────────── */

    function refresh(focusPath) {
      backend.graph().then(function (fresh) {
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
    /* A panel opening or a grip drag resizes the stage; the camera holds its
       place instead of snapping to fit, so opening a panel never yanks the sky
       out from under you. Refit stays a deliberate act. */
    function onResize() {
      size();
      paint();
    }
    window.addEventListener("resize", onResize);
    cleanup.push(function () { window.removeEventListener("resize", onResize); });

    size();
    rebindSim();
    /* Warm-up cost is ticks times nodes; a dense corpus converges enough in
       fewer passes, and the ticks saved are the difference between a mount
       and a coffee break. */
    var active = sim.nodes().length;
    var WARM = active > 6000 ? 180 : active > 2000 ? 300 : 520;
    for (var i = 0; i < WARM; i++) sim.tick();
    /* A tier waiting on reveal never warmed, so park each such document beside
       a settled neighbor it will bloom from; physics takes over on reveal. Two
       passes let a satellite whose only neighbor is another satellite park
       beside that neighbor's parked position, not its pre-warm one. The golden
       angle keeps every parking spot distinct, because a search reveal shows
       these positions verbatim with no collision force to separate stacks. */
    (function () {
      var parked = {};
      var GOLDEN = 2.39996322972865;
      for (var pass = 0; pass < 2; pass++) {
        G.nodes.forEach(function (n) {
          if (simActive(n) || parked[n.id]) return;
          var lists = outOf[n.id].concat(inOf[n.id]);
          var host = null;
          for (var i = 0; i < lists.length && !host; i++) {
            var m = G.nodes[lists[i].id];
            if (simActive(m) || parked[m.id]) host = m;
          }
          if (!host && pass === 0) return;
          var a = n.id * GOLDEN;
          var r = 34 + (n.id % 9) * 6;
          n.x = (host && host.x != null ? host.x : state.W / 2) + Math.cos(a) * r;
          n.y = (host && host.y != null ? host.y : state.H / 2) + Math.sin(a) * r;
          parked[n.id] = 1;
        });
      }
    })();
    tick();
    measureLabels();
    renderOverview();
    renderWiki();
    /* Restore the tab row: stale paths (a deleted document, another corpus)
       drop out, and the reader shows only when something is open. */
    openTabs = openTabs.filter(function (p) { return byPath(p); });
    if (activeTab && !byPath(activeTab)) activeTab = openTabs.length ? openTabs[openTabs.length - 1] : null;
    renderTabs();
    if (activeTab) { renderNode(byPath(activeTab)); showReader(); }
    else { clearHost(side); hideReader(); }
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
      ["wiki", "overview", "tabs"].forEach(function (id) {
        var h = document.getElementById(id);
        if (h) clearHost(h);
      });
    }

    return {
      G: G,
      pin: pin,
      clearPin: clearPin,
      destroy: destroy,
      refresh: refresh,
      byPath: byPath,
      pinnedPath: function () { return (state.pinned && state.pinned.path) || null; },
    };
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
    /* The same resolver the server built the edges with, so a reader link
       lands exactly where its edge points, or is dead where the edge is. */
    var index = AtlasResolve.buildIndex(nodes.filter(function (n) { return n.exists; }));
    function resolve(target, sourcePath, via) {
      var hit = AtlasResolve.resolveLink(index, sourcePath || "", target, via || "wikilink");
      return hit && hit !== AtlasResolve.AMBIGUOUS ? hit : null;
    }
    return { nodes: nodes, edges: data.edges, resolve: resolve };
  }

  /* Reading history: every document you open becomes a browser history entry
     (a hash on the page URL), so the browser's own back and forward walk the
     trail of articles you read, and a reloaded tab reopens where it was.
     Hash-only navigation works in every mode, including a chart on file://. */
  var applyingHash = false;
  function hashDoc() {
    return location.hash.indexOf("#d=") === 0 ? decodeURIComponent(location.hash.slice(3)) : null;
  }
  function pushHash(path) {
    if (applyingHash) return;
    var want = path ? "#d=" + encodeURIComponent(path) : "";
    if (location.hash === want || (!want && !location.hash)) return;
    location.hash = want;
  }
  function onHashChange() {
    if (!app) return;
    var p = hashDoc();
    applyingHash = true;
    if (p) {
      var hit = app.byPath(p);
      if (hit && app.pinnedPath() !== p) app.pin(hit);
    } else app.clearPin();
    applyingHash = false;
  }

  /* Panel chrome: the rail's icon buttons own the sidebar panels (click to
     open, click again to close), the reader appears when a document opens,
     and both regions resize by their grips. Wired once; geometry survives
     refresh and remount. Everything starts closed: the constellation is the
     opening view. */
  function wireChrome() {
    var grid = document.getElementById("grid");
    if (!grid || grid._wired) return;
    grid._wired = true;
    grid.classList.add("sb-off");
    grid.classList.add("side-off");
    var panels = { wiki: "rail-wiki", overview: "rail-map", folders: "rail-folders" };
    var active = null;
    function setPanel(name) {
      active = name;
      Object.keys(panels).forEach(function (k) {
        var p = document.getElementById(k);
        if (p) p.style.display = k === name ? "" : "none";
        var b = document.getElementById(panels[k]);
        if (b) {
          b.classList.toggle("is-on", k === name);
          b.setAttribute("aria-pressed", String(k === name));
        }
      });
      grid.classList.toggle("sb-off", !name);
      window.dispatchEvent(new Event("resize"));
    }
    Object.keys(panels).forEach(function (k) {
      var b = document.getElementById(panels[k]);
      if (b) b.addEventListener("click", function () { setPanel(active === k ? null : k); });
    });
    setPanel(null);
    openPanel = setPanel;
    function grip(id, varName, fromLeft, min, max) {
      var g = document.getElementById(id);
      if (!g) return;
      g.addEventListener("mousedown", function (e) {
        e.preventDefault();
        g.classList.add("dragging");
        /* Live resize, one update per animation frame: the panels and their
           text adapt while you hold, and the expensive svg refit waits for
           release so the drag stays smooth on a busy machine. */
        var pendingW = null, rafId = null;
        function width(ev) {
          var w = fromLeft ? ev.clientX - 44 : window.innerWidth - ev.clientX;
          var mx = typeof max === "function" ? max() : max;
          return Math.max(min, Math.min(mx, w));
        }
        function apply() {
          rafId = null;
          if (pendingW != null) grid.style.setProperty(varName, pendingW + "px");
        }
        pendingW = width(e);
        apply();
        function move(ev) {
          pendingW = width(ev);
          if (rafId == null) rafId = requestAnimationFrame(apply);
        }
        function up() {
          g.classList.remove("dragging");
          if (rafId != null) cancelAnimationFrame(rafId);
          apply();
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          window.dispatchEvent(new Event("resize"));
        }
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      });
    }
    grip("sbgrip", "--sb-w", true, 190, 560);
    /* The reader can take up to half the screen: reading and editing want room. */
    grip("sidegrip", "--side-w", false, 240, function () { return Math.round(window.innerWidth / 2); });
  }

  /* Mount point: the chart and serve pages carry a global DATA and boot at once;
     the folder app has no DATA until a directory is picked, so it sets its own
     backend and calls AtlasApp.mount with the data the shared pipeline built.
     A second mount (switching folders in place) tears the first one down. */
  function modeLabel(mode) {
    return mode === "live" ? "live" : mode === "chart" ? "chart" : mode === "browse" ? "folder, read only" : "folder";
  }
  window.AtlasApp = {
    mount: function (data, be) {
      if (be) backend = be;
      else if (typeof AtlasBackend !== "undefined") backend = AtlasBackend;
      if (app) app.destroy();
      app = init(data, null);
      /* A hash carried into the mount reopens that document: a reloaded tab
         lands where it was, and a stale hash from another corpus is dropped. */
      var p = hashDoc();
      if (p) {
        var hit = app.byPath(p);
        applyingHash = true;
        if (hit) app.pin(hit);
        else {
          try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
        }
        applyingHash = false;
      }
      return app;
    },
  };
  wireChrome();
  window.addEventListener("hashchange", onHashChange);
  if (typeof DATA !== "undefined") window.AtlasApp.mount(DATA);
})();
