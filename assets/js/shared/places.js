// The Wikidata record behind an itinerary point: places.json, keyed by QID. Nothing here
// interprets the data — it picks the fields to show and prints the labels Wikidata gave
// them.
//
// A point's `wikidata` key has three states, and each renders differently, because a gap
// you cannot see is a gap nobody fills:
//
//   "wikidata": "Q17158"   linked      — the fact card below
//   "wikidata": null       checked     — nothing; no Wikidata item exists, and that is settled
//   key absent             unchecked   — a marker saying so, until content.json says otherwise
//
// Nothing guesses the missing one. The build scripts do not search by name either; the
// marker is the whole mechanism.
import { esc } from './dom.js';

export const SRC = 'assets/data/places.json';

const ROWS = [
  ['type', 'Type'],
  ['religion', 'Religion'],
  ['style', 'Style'],
  ['architect', 'Architect'],
  ['founder', 'Founded by'],
  ['heritage', 'Heritage'],
];

const labels = (values) => (values || []).map((t) => esc(t.label)).join(' · ');

function dates(place) {
  const parts = [];
  if (place.inception) parts.push(`Founded ${place.inception.join(' / ')}`);
  if (place.opened && place.opened.join() !== (place.inception || []).join()) {
    parts.push(`Opened ${place.opened.join(' / ')}`);
  }
  if (place.ended) parts.push(`Ended ${place.ended.join(' / ')}`);
  return esc(parts.join(' · '));
}

function heritageSiteHtml(place, sites) {
  const link = place.heritageSite;
  if (!link) return '';
  const site = (sites || {})[link.id] || {};
  const meta = [
    site.inscribed ? `inscribed ${site.inscribed}` : '',
    site.criteria && site.criteria.length ? `criteria ${site.criteria.join('')}` : '',
  ].filter(Boolean).join(', ');
  const number = link.ref.replace(/\D.*$/, '');
  return `<a class="whs" href="https://whc.unesco.org/en/list/${encodeURIComponent(number)}"
    target="_blank" rel="noopener"><b>UNESCO World Heritage</b><span>${esc(site.label || link.id)}${meta ? ` (${esc(meta)})` : ''}</span></a>`;
}

const row = (label, body) => (body ? `<div class="fact"><dt>${label}</dt><dd>${body}</dd></div>` : '');

// What goes under a point's heading, decided by which of the three states its key is in.
// `data` is the parsed places.json.
export function sourceHtml(point, data) {
  if (!('wikidata' in point)) return '<p class="facts-unchecked">No source linked yet</p>';
  if (point.wikidata === null) return '';
  return factsHtml(point.wikidata, data);
}

// The card itself.
export function factsHtml(qid, data) {
  const place = data && data.places && data.places[qid];
  if (!place) return '';
  const links = [];
  if (place.wikipedia) {
    links.push(`<a href="https://en.wikipedia.org/wiki/${encodeURIComponent(place.wikipedia.replace(/ /g, '_'))}"
      target="_blank" rel="noopener">Wikipedia</a>`);
  }
  links.push(`<a href="https://www.wikidata.org/wiki/${qid}" target="_blank" rel="noopener">Wikidata</a>`);
  return `
    <aside class="facts">
      ${place.label ? `<p class="facts-name">${esc(place.label)}</p>` : ''}
      ${place.description ? `<p class="facts-desc">${esc(place.description)}</p>` : ''}
      ${heritageSiteHtml(place, data.heritageSites)}
      <dl>
        ${row('Dates', dates(place))}
        ${ROWS.map(([key, label]) => row(label, labels(place[key]))).join('')}
      </dl>
      <p class="facts-links">${links.join('')}</p>
    </aside>`;
}
