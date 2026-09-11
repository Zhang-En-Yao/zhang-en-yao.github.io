// Heading anchors and the collapsible Contents list. h2s are listed with their h3s folded
// beneath; h4s (one per attraction) get anchors but no entry.
import { esc } from '../shared/dom.js';

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
  });
}
