import { esc, fetchJson, emptyState, plural, SERVE_HINT, RETRY_BUTTON } from './shared/dom.js';
import { TRIPS_SRC } from './shared/trips.js';
import { loadCountries, byCountryName } from './shared/atlas.js';
import { thumbHtml } from './shared/thumb.js';

const BUCKET_SRC = 'bucket-list/index.json';

const listEl = document.getElementById('list');
const statsEl = document.getElementById('stats');

const SECTIONS = [
  { key: 'religion', label: 'Religion', lede: 'High days of the faiths — a lamp, a fast broken, a week of candlelight.' },
  { key: 'newyear', label: 'New Year', lede: 'How midnight is met around the world — grapes, bells, burnt effigies, empty suitcases.' },
  { key: 'festival', label: 'Festivals', lede: "Each country's own once-a-year strangeness, kept for its own reasons." },
];

// The next time a yearly festival comes round; a month-only entry counts from the 1st.
function nextOccurrence(item, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const on = (year) => new Date(year, (item.month || 1) - 1, item.day || 1);
  const d = on(now.getFullYear());
  return d < today ? on(now.getFullYear() + 1) : d;
}

function renderStats(items) {
  const done = items.filter((i) => i.done).length;
  const countries = new Set(items.map((i) => i.country).filter(Boolean)).size;
  statsEl.textContent = [
    plural(items.length, 'festival'),
    plural(countries, 'country', 'countries'),
    `${done} done`,
  ].join(' · ');
}

function cardHtml(item, byName, visited) {
  const city = item.cities?.[0]?.name;
  return `
    <article class="bucket-card${item.done ? ' is-done' : ''}" data-id="${esc(item.id)}">
      ${thumbHtml(item, byName)}
      <div class="trip-card-body">
        <div class="trip-card-meta">
          ${item.country ? `<span>${esc(item.country)}</span>` : ''}
          ${city && city !== item.country ? `<span>${esc(city)}</span>` : ''}
          ${item.done ? '<span class="trip-card-tag">Done</span>' : ''}
          ${visited.has(item.country) ? '<span class="trip-card-tag">Been</span>' : ''}
        </div>
        <h3 class="trip-card-title">${esc(item.name)}</h3>
        <p class="bucket-card-when">${esc(item.when || '')}</p>
        <p class="bucket-card-note">${esc(item.note || '')}</p>
      </div>
    </article>`;
}

function render(items, byName, visited) {
  const now = new Date();
  renderStats(items);
  listEl.innerHTML = SECTIONS.map((section) => {
    const entries = items
      .filter((i) => i.category === section.key)
      .sort((a, b) => nextOccurrence(a, now) - nextOccurrence(b, now));
    if (!entries.length) return '';
    return `
      <section class="bucket-section">
        <header class="bucket-section-head">
          <h2 class="bucket-section-title">${esc(section.label)}</h2>
          <p class="bucket-section-lede">${esc(section.lede)}</p>
        </header>
        <div class="bucket-grid">
          ${entries.map((i) => cardHtml(i, byName, visited)).join('')}
        </div>
      </section>`;
  }).join('');
}

Promise.all([loadCountries(), fetchJson(BUCKET_SRC), fetchJson(TRIPS_SRC)])
  .then(([countries, items, trips]) => {
    if (!items.length) {
      listEl.innerHTML = emptyState({
        icon: 'file',
        title: 'No entries yet',
        description: `Add an entry to <code>${BUCKET_SRC}</code> and it will appear here.`,
      });
      return;
    }
    const visited = new Set(trips.map((t) => t.country).filter(Boolean));
    render(items, byCountryName(countries), visited);
  })
  .catch((err) => {
    statsEl.textContent = '';
    listEl.innerHTML = emptyState({
      icon: 'alert',
      title: 'Could not load the bucket list',
      description: `${esc(err.message)}. ${SERVE_HINT}`,
      actions: RETRY_BUTTON,
    });
  });
