// The Wikidata facts behind an itinerary point: assets/data/places.json, built by
// assets/data/build-places.py. Terms are packed as "QID~English~Chinese".
import { esc } from './dom.js';

export const SRC = 'assets/data/places.json';

export const term = (packed) => {
  const [id, en = '', zh = ''] = packed.split('~');
  return { id, en, zh, label: zh || en || id };
};

// Facets are the fields worth browsing across trips.
export const FACETS = [
  { key: 'religion', label: '宗教' },
  { key: 'style', label: '建築風格' },
  { key: 'era', label: '年代' },
  { key: 'type', label: '類型' },
  { key: 'architect', label: '建築師' },
  { key: 'founder', label: '創建者' },
  { key: 'heritage', label: '文化資產' },
];

const CENTURY = (year) => {
  const n = Number(year);
  if (!Number.isFinite(n)) return null;
  const c = n > 0 ? Math.ceil(n / 100) : Math.floor(n / 100);
  return { id: `c${c}`, label: c > 0 ? `${c} 世紀` : `西元前 ${-c} 世紀`, sort: c };
};

// The century a place dates from — its own facet, derived from the earliest date on it.
export function era(place) {
  const years = [...(place.inception || []), ...(place.opened || [])]
    .map(Number).filter(Number.isFinite);
  if (!years.length) return null;
  return CENTURY(Math.min(...years));
}

export function facetsOf(place) {
  const out = [];
  for (const { key } of FACETS) {
    if (key === 'era') {
      const e = era(place);
      if (e) out.push({ facet: 'era', id: e.id, label: e.label });
      continue;
    }
    for (const packed of place[key] || []) {
      const t = term(packed);
      out.push({ facet: key, id: t.id, label: t.label });
    }
  }
  return out;
}

export const facetHref = (facet, id) => `places.html#${facet}=${id}`;

const years = (place) => {
  const bits = [];
  if (place.inception) bits.push(`創建 ${place.inception.join(' / ')}`);
  if (place.opened && place.opened.join() !== (place.inception || []).join()) bits.push(`啟用 ${place.opened.join(' / ')}`);
  if (place.ended) bits.push(`終於 ${place.ended.join(' / ')}`);
  return bits.join('・');
};

const WIKI_LABEL = { zh: '中文', en: 'English', ja: '日本語', es: 'Español', ca: 'Català', vi: 'Tiếng Việt', gl: 'Galego' };

function linksHtml(qid, place) {
  const links = [];
  for (const [key, value] of Object.entries(place.w || {})) {
    const [lang, title] = key === 'loc' ? value.split(/:(.*)/s) : [key, value];
    links.push(`<a href="https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}"
      target="_blank" rel="noopener">Wikipedia ${esc(WIKI_LABEL[lang] || lang)}</a>`);
  }
  links.push(`<a href="https://www.wikidata.org/wiki/${qid}" target="_blank" rel="noopener">Wikidata</a>`);
  return links.join('');
}

const row = (label, body) => (body ? `<div class="fact"><dt>${label}</dt><dd>${body}</dd></div>` : '');

const tags = (place, key) => (place[key] || [])
  .map((packed) => {
    const t = term(packed);
    return `<a class="facet" href="${facetHref(key, t.id)}">${esc(t.label)}</a>`;
  })
  .join('');

const plain = (place, key) => (place[key] || []).map((packed) => esc(term(packed).label)).join('、');

function whsHtml(place, sites) {
  if (!place.whs) return '';
  const [id, ref] = place.whs.split('~');
  const site = (sites || {})[id] || {};
  const name = site.zh || site.en || id;
  const meta = [site.year ? `${site.year} 年登錄` : '', site.crit && site.crit.length ? `準則 ${site.crit.join('')}` : '']
    .filter(Boolean).join('・');
  return `<a class="whs" href="https://whc.unesco.org/en/list/${encodeURIComponent(ref.replace(/\D.*$/, ''))}"
    target="_blank" rel="noopener"><b>UNESCO 世界遺產</b><span>${esc(name)}${meta ? `（${esc(meta)}）` : ''}</span></a>`;
}

// The card under a point's heading. `data` is the parsed places.json.
export function factsHtml(qid, data) {
  const place = data && data.places && data.places[qid];
  if (!place) return '';
  const e = era(place);
  const heading = [place.zh, place.en].filter(Boolean);
  return `
    <aside class="facts">
      ${heading.length ? `<p class="facts-name">${heading.map(esc).join(' · ')}</p>` : ''}
      ${place.desc ? `<p class="facts-desc">${esc(place.desc)}</p>` : ''}
      ${whsHtml(place, data.whs)}
      <dl>
        ${row('類型', tags(place, 'type'))}
        ${row('年代', years(place) + (e ? ` <a class="facet" href="${facetHref('era', e.id)}">${esc(e.label)}</a>` : ''))}
        ${row('宗教', tags(place, 'religion'))}
        ${row('建築風格', tags(place, 'style'))}
        ${row('建築師', tags(place, 'architect'))}
        ${row('創建者', tags(place, 'founder'))}
        ${row('文化資產', tags(place, 'heritage'))}
      </dl>
      <p class="facts-links">${linksHtml(qid, place)}</p>
    </aside>`;
}

export const placeLabel = (place) => place.zh || place.en || '';
export { plain };
