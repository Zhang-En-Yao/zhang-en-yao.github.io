// Markdown → rendered document, shared by the trip page and the chat replies on it.
// Depends on marked, and on `esc` from ui.js.
//
// Travelogues are prose, tables and photos — no mathematics — so there is no KaTeX
// step here. (It lived here while the site also carried paper notes.)

// `breaks` is the one real difference between a document and a chat reply: prose wraps
// its own lines, but someone typing into a chat box means the newline they pressed.
function renderMarkdown(src, { breaks = false } = {}) {
  return marked.parse(src, { gfm: true, breaks });
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

  if (tocEl) {
    tocEl.innerHTML = items.length ? `<div class="toc-title">Contents</div>${items.join('')}` : '';
  }

  bodyEl.querySelectorAll('table').forEach((t) => {
    const box = document.createElement('div');
    box.className = 'table-scroll';
    t.replaceWith(box);
    box.appendChild(t);
  });
}
