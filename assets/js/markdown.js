// Markdown → rendered document, shared by the note page, the trip page, and the chat
// replies on both. Depends on marked, and on `esc` from ui.js.
//
// KaTeX is optional. The note page loads it because papers are full of mathematics;
// the trip page does not, because travelogues are not, and it is 300KB. So the math
// path here degrades to plain text rather than assuming the library is present.

// Math must be pulled out before marked runs: otherwise `_` becomes emphasis and
// `\\` is eaten as an escape, so KaTeX would receive already-corrupted TeX.
// Inline `$…$` additionally requires a non-space char on both inner edges, so prose
// like "it costs $5 and $10 total" is left alone.
const MATH_SCAN =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$(?!\s)((?:\\.|[^\\$\n])*?[^\s\\$])\$|\\\(([\s\S]+?)\\\)/g;

function extractMath(src) {
  const math = [];
  const hold = (tex, display) => `@@MATH${math.push({ tex, display }) - 1}@@`;

  const text = src.replace(MATH_SCAN, (m, code, block, bracket, inline, paren) => {
    if (code != null) return code;
    if (block != null) return hold(block, true);
    if (bracket != null) return hold(bracket, true);
    if (inline != null) return hold(inline, false);
    if (paren != null) return hold(paren, false);
    return m;
  });

  return { text, math };
}

function restoreMath(html, math) {
  return html.replace(/@@MATH(\d+)@@/g, (m, i) => {
    const { tex, display } = math[Number(i)];
    const verbatim = () => esc(display ? `$$${tex}$$` : `$${tex}$`);

    if (typeof katex === 'undefined') return verbatim();
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false });
    } catch (e) {
      return verbatim();
    }
  });
}

// `breaks` is the one real difference between a document and a chat reply: prose wraps
// its own lines, but someone typing into a chat box means the newline they pressed.
function renderMarkdown(src, { breaks = false } = {}) {
  const { text, math } = extractMath(src);
  return restoreMath(marked.parse(text, { gfm: true, breaks }), math);
}

function slug(text, used) {
  let base = text.trim().toLowerCase().replace(/[^\w一-鿿]+/g, '-').replace(/^-|-$/g, '');
  if (!base) base = 'section';
  let s = base;
  let i = 2;
  while (used.has(s)) s = `${base}-${i++}`;
  used.add(s);
  return s;
}

// Post-render decoration of a rendered body: anchor the headings, build the table of
// contents from them, and let wide tables scroll instead of blowing out the column.
function decorateBody(bodyEl, tocEl) {
  const used = new Set();
  const items = [];

  bodyEl.querySelectorAll('h2, h3').forEach((h) => {
    h.id = slug(h.textContent, used);
    items.push(`<a class="level-${h.tagName[1]}" href="#${h.id}">${esc(h.textContent)}</a>`);
  });

  if (tocEl && items.length) {
    tocEl.innerHTML = `<div class="toc-title">Contents</div>${items.join('')}`;
  }

  bodyEl.querySelectorAll('table').forEach((t) => {
    const box = document.createElement('div');
    box.className = 'table-scroll';
    t.replaceWith(box);
    box.appendChild(t);
  });
}
