// Heading anchors and the collapsible Contents list. h2s are listed with their h3s folded
// beneath; h4s (one per attraction) get anchors but no entry. The entry for the section being
// read is marked with aria-current.
import { esc } from '../shared/dom.js';

const READING_LINE = 120; // px from the top of the viewport

const CHEVRON = '<svg class="toc-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

function slug(text, used) {
  const base = text.trim().toLowerCase().replace(/[^\w一-鿿]+/g, '-').replace(/^-|-$/g, '') || 'section';
  let s = base;
  for (let i = 2; used.has(s); i++) s = `${base}-${i}`;
  used.add(s);
  return s;
}

export function buildToc(root, tocEl) {
  const used = new Set();
  const groups = [];

  root.querySelectorAll('h2, h3, h4').forEach((h) => {
    h.id = slug(h.textContent, used);
    if (h.tagName === 'H4') return;
    const link = `<a class="level-${h.tagName[1]}" href="#${h.id}">${esc(h.textContent)}</a>`;
    if (h.tagName === 'H2') groups.push({ link, subs: [] });
    else if (groups.length) groups.at(-1).subs.push(link);
    else groups.push({ link: null, subs: [link] });
  });

  if (!tocEl || !groups.length) return;

  tocEl.innerHTML = '<div class="toc-title">Contents</div>' + groups.map(({ link, subs }) => {
    const toggle = subs.length
      ? `<button type="button" class="toc-h2-toggle" aria-expanded="false" aria-label="Toggle subsections">${CHEVRON}</button>`
      : '';
    const list = subs.length ? `<div class="toc-h3-list" hidden>${subs.join('')}</div>` : '';
    return `<div class="toc-h2">${link || ''}${toggle}</div>${list}`;
  }).join('');

  tocEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.toc-h2-toggle');
    if (!btn) return;
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!expanded));
    btn.parentElement.nextElementSibling.hidden = expanded;
    markCurrent();
  });

  const headings = [...root.querySelectorAll('h2, h3')];
  const links = new Map([...tocEl.querySelectorAll('a')].map((a) => [a.getAttribute('href').slice(1), a]));
  let raf = 0;

  // The last heading above the reading line, or its h2 when that h3 is folded away.
  function markCurrent() {
    raf = 0;
    let h2 = null;
    let h3 = null;
    for (const h of headings) {
      if (h.getBoundingClientRect().top > READING_LINE) break;
      if (h.tagName === 'H2') [h2, h3] = [h, null];
      else h3 = h;
    }
    const sub = h3 && links.get(h3.id);
    const link = sub && sub.offsetParent ? sub : h2 && links.get(h2.id);
    tocEl.querySelectorAll('a[aria-current]').forEach((a) => a !== link && a.removeAttribute('aria-current'));
    link?.setAttribute('aria-current', 'true');
  }

  window.addEventListener('scroll', () => { raf ||= requestAnimationFrame(markCurrent); }, { passive: true });
  markCurrent();
}
