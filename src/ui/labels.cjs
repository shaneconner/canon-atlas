/* Pure label helpers, shared verbatim by the browser page (inlined as a plain
   script, where the module guard below is skipped) and the gate suite (loaded
   with require). Kept dependency-free and side-effect-free on purpose. */

var AtlasLabels = (function () {
  /* A long title drawn in full is a banner across the sky. Cut on the last word
     boundary that still leaves a readable name, hard otherwise, and never
     through the middle of a surrogate pair. The panel and the search text keep
     the whole title. */
  function truncateLabel(s) {
    if (s.length <= 46) return s;
    var sp = s.lastIndexOf(" ", 44);
    var cut = sp > 24 ? sp : 44;
    var cc = s.charCodeAt(cut - 1);
    if (cc >= 0xd800 && cc <= 0xdbff) cut--;
    return s.slice(0, cut) + "…";
  }

  /* Label level of detail. Every node earns a zoom at which its label becomes
     eligible, ranked once and never recomputed: the biggest documents (by
     degree, the size the eye sees) keep their names at any distance, the rest
     arrive as you close in, so the fit view reads as a sky rather than a wall
     of text. Rank breaks ties, and carries corpora whose degrees are flat. */
  function assignTiers(nodes) {
    var real = nodes.filter(function (n) { return n.exists; })
      .sort(function (a, b) { return ((b.degree || 0) - (a.degree || 0)) || (b.rank - a.rank); });
    var near = 8 + Math.round(real.length * 0.2);
    var mid = near + Math.round(real.length * 0.4);
    nodes.forEach(function (n) { n._minK = 1.7; });
    real.forEach(function (n, i) {
      n._minK = i < 8 ? 0 : i < near ? 0.75 : i < mid ? 1.2 : 1.7;
    });
  }

  return { truncateLabel: truncateLabel, assignTiers: assignTiers };
})();

if (typeof module !== "undefined") module.exports = AtlasLabels;
