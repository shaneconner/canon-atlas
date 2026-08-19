/* A small markdown renderer for the reader panel: headings, lists, quotes,
   fenced and inline code, emphasis, rules, and links. Everything is escaped
   first, so a document can never inject markup into the page. Wikilinks and
   relative markdown links become internal anchors the app wires to the graph. */

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  out = out.replace(
    /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g,
    (_, t, alias) => `<a class="wl" data-target="${t.trim()}">${alias ? alias.trim() : t.trim()}</a>`
  );
  out = out.replace(/(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, text, href) => {
    if (/^https?:/i.test(href)) return `<a href="${href}" target="_blank" rel="noopener">${text || href}</a>`;
    if (/\.(md|markdown)(#|$)/i.test(href)) return `<a class="wl" data-target="${href.split("#")[0]}">${text || href}</a>`;
    return text || href;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, "<em>$1</em>");
  return out;
}

export function renderMarkdown(md) {
  const lines = md.split("\n");
  const out = [];
  let list = null; // "ul" | "ol"
  let para = [];
  let quote = [];
  let code = null;

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const raw of lines) {
    if (code !== null) {
      if (/^```/.test(raw)) {
        out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
        code = null;
      } else code.push(raw);
      continue;
    }
    const line = raw.replace(/\s+$/, "");
    const fence = /^```/.exec(line);
    if (fence) {
      flushAll();
      code = [];
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushAll();
      const level = Math.min(h[1].length + 1, 6); // corpus h1 renders as page h2
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushAll();
      out.push("<hr>");
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      flushList();
      quote.push(q[1]);
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      flushQuote();
      const want = ul ? "ul" : "ol";
      if (list !== want) {
        flushList();
        out.push(`<${want}>`);
        list = want;
      }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    flushList();
    flushQuote();
    para.push(line.trim());
  }
  if (code !== null) out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
  flushAll();
  return out.join("\n");
}
