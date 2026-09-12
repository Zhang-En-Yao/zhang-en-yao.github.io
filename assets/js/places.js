// places.html: every visited place indexed by the themes behind it — religion, period,
// architectural style, heritage status — so one thread can be followed across trips.
import { esc, fetchJson, emptyState, plural, SERVE_HINT } from './shared/dom.js';
import { SRC, FACETS, facetsOf, term, era } from './shared/places.js';

const themesEl = document.getElementById('themes');
const resultsEl = document.getElementById('results');
const statsEl = document.getElementById('stats');

const parseHash = () => {
  const [facet, id] = decodeURIComponent(location.hash.replace(/^#/, '')).split('=');
  return facet && id ? { facet, id } : null;
};

// facet key → id → { label, points }
function buildIndex(data) {
  const index = new Map(FACETS.map((f) => [f.key, new Map()]));
  for (const point of data.points) {
    const place = data.places[point.q];
    if (!place) continue;
    for (const { facet, id, label } of facetsOf(place)) {
      const bucket = index.get(facet);
      if (!bucket.has(id)) bucket.set(id, { label, points: [] });
      bucket.get(id).points.push(point);
    }
  }
  return index;
}

const sortKey = (key) => (key === 'era'
  ? (a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1))
  : (a, b) => b[1].points.length - a[1].points.length || a[1].label.localeCompare(b[1].label, 'zh-Hant'));

const SHOWN = 18; // Tags past this fold only once the reader asks for them.

function themesHtml(index) {
  return FACETS.map(({ key, label }) => {
    const entries = [...index.get(key)].sort(sortKey(key));
    if (!entries.length) return '';
    const tag = ([id, v], i) => `
      <button class="facet" type="button" data-facet="${key}" data-id="${esc(id)}"
              ${i >= SHOWN ? 'data-extra hidden' : ''}>
        ${esc(v.label)}<span>${v.points.length}</span>
      </button>`;
    const rest = entries.length - SHOWN;
    return `
      <div class="theme">
        <h2>${label}</h2>
        <div class="theme-tags">
          ${entries.map(tag).join('')}
          ${rest > 0 ? `<button class="theme-more" type="button" data-more>還有 ${rest} 個</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

function resultsHtml(data, index, sel) {
  const bucket = index.get(sel.facet);
  const hit = bucket && bucket.get(sel.id);
  if (!hit) {
    return emptyState({ icon: 'search', title: '找不到這個主題', description: '這個標籤在目前的遊記裡沒有對應的景點。' });
  }
  const rows = hit.points.map((point) => {
    const place = data.places[point.q];
    const e = era(place);
    const bits = [
      place.zh && place.zh !== point.n ? place.zh : '',
      e ? e.label : '',
      (place.type || []).slice(0, 1).map((t) => term(t).label).join(''),
    ].filter(Boolean);
    return `
      <a class="place-row" href="trip.html?id=${encodeURIComponent(point.t)}">
        <span class="place-name">${esc(point.n)}</span>
        <span class="place-meta">${esc(bits.join('・'))}</span>
        <span class="place-trip">${esc(data.trips[point.t] || point.t)}${point.s ? ` · ${esc(point.s)}` : ''}</span>
      </a>`;
  }).join('');
  return `
    <h2 class="results-title">${esc(hit.label)}<span>${plural(hit.points.length, 'place')}</span></h2>
    <div class="place-rows">${rows}</div>`;
}

function render(data, index) {
  const sel = parseHash();
  themesEl.querySelectorAll('.facet').forEach((b) => {
    b.classList.toggle('is-on', !!sel && b.dataset.facet === sel.facet && b.dataset.id === sel.id);
  });
  resultsEl.innerHTML = sel ? resultsHtml(data, index, sel) : '';
  if (sel) resultsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

fetchJson(SRC).then((data) => {
  const index = buildIndex(data);
  const themes = FACETS.reduce((n, f) => n + index.get(f.key).size, 0);
  statsEl.innerHTML = `<b>${data.points.length}</b> places · <b>${Object.keys(data.places).length}</b> Wikidata entities · <b>${themes}</b> themes`;
  themesEl.innerHTML = themesHtml(index);
  themesEl.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) {
      more.parentElement.querySelectorAll('[data-extra]').forEach((el) => { el.hidden = false; });
      more.remove();
      return;
    }
    const btn = e.target.closest('.facet');
    if (!btn) return;
    const next = `${btn.dataset.facet}=${btn.dataset.id}`;
    location.hash = btn.classList.contains('is-on') ? '' : next;
    if (btn.classList.contains('is-on')) render(data, index);
  });
  addEventListener('hashchange', () => render(data, index));
  render(data, index);
}).catch((err) => {
  console.error(err);
  themesEl.innerHTML = emptyState({
    icon: 'search',
    title: 'Could not load the places',
    description: `<code>assets/data/places.json</code> is missing or could not be fetched. ${SERVE_HINT}`,
  });
});
