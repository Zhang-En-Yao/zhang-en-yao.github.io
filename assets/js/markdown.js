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
//
// `h4` gets an id too, but no Contents entry — the table of contents is a map of sections, and
// a point-by-point trip page can carry dozens of h4s, one per attraction. Giving each an id
// anyway is what lets a trip page link a day's itinerary stop straight to that attraction's
// own write-up higher on the page (assets/js/trip.js's `dailyItineraryHtml`), without the
// Contents list itself growing to match.
function decorateBody(bodyEl, tocEl) {
  const used = new Set();
  // One entry per `h2`, each carrying whichever `h3`s came after it and before the next
  // `h2` — a trip with a couple of dozen attractions and a full day-by-day table behind them
  // can carry a Contents list past what fits one screen (this one now runs to over 40 `h3`s),
  // and a flat list has no unit smaller than "the whole page" to collapse. Grouped by section
  // instead, each `h2` folds its own `h3`s away independently — collapsed by default, since a
  // reader opens the Contents to jump into one section, not to see all of them expanded at
  // once.
  const groups = [];
  let current = null;

  bodyEl.querySelectorAll('h2, h3, h4').forEach((h) => {
    h.id = slug(h.textContent, used);
    if (h.tagName === 'H4') return; // Anchorable (see the module comment above) but not listed.
    const link = `<a class="level-${h.tagName[1]}" href="#${h.id}">${esc(h.textContent)}</a>`;
    if (h.tagName === 'H2') {
      current = { link, subs: [] };
      groups.push(current);
    } else if (current) {
      current.subs.push(link);
    } else {
      groups.push({ link: null, subs: [link] }); // An `h3` with no `h2` yet above it.
    }
  });

  if (tocEl) {
    const html = groups.map((g) => {
      const toggle = g.subs.length
        ? `<button type="button" class="toc-h2-toggle" aria-expanded="false" aria-label="Toggle subsections">
             <svg class="toc-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
           </button>`
        : '';
      const subList = g.subs.length ? `<div class="toc-h3-list" hidden>${g.subs.join('')}</div>` : '';
      return `<div class="toc-h2">${g.link || ''}${toggle}</div>${subList}`;
    }).join('');

    tocEl.innerHTML = groups.length ? `<div class="toc-title">Contents</div>${html}` : '';

    tocEl.querySelectorAll('.toc-h2-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!expanded));
        btn.closest('.toc-h2').nextElementSibling.hidden = expanded;
      });
    });
  }

  bodyEl.querySelectorAll('table').forEach((t) => {
    const box = document.createElement('div');
    box.className = 'table-scroll';
    t.replaceWith(box);
    box.appendChild(t);
  });
}
