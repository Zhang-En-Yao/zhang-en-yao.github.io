import { esc, fetchJson, emptyState, plural, statsHtml, SERVE_HINT, RETRY_BUTTON } from './shared/dom.js';
import { fmtRange, splitDuration, currentMonth } from './shared/format.js';
import { TRIPS_SRC, tripTitle, tripHref, tripDuration, newestFirst } from './shared/trips.js';
import { loadCountries, loadDetailedCountries, loadCoarseCountries, loadMarine, byCountryName, CONTINENTS_SRC } from './shared/atlas.js';
import { CORE } from './shared/assets.js';
import { thumbHtml } from './shared/thumb.js';
import { renderWorldMap } from './travel/world-map.js';

const STARS_SRC = `${CORE}/sky/stars.json`;
const MOON_FEATURES_SRC = 'assets/data/moon-features.json';

const mapEl = document.getElementById('map');
const listEl = document.getElementById('list');
const statsEl = document.getElementById('stats');
const nextEl = document.getElementById('next');

function renderStats(trips) {
  const places = new Set(trips.flatMap((t) => (t.cities || []).map((c) => c.name))).size;
  const countries = new Set(trips.map((t) => t.country).filter(Boolean)).size;
  statsEl.innerHTML = statsHtml([[trips.length, 'trip'], [places, 'place'], [countries, 'country', 'countries']]);
}

// The soonest trip that hasn't ended. `trips` is newest-first, so that's the last match.
function nextTrip(trips) {
  const thisMonth = currentMonth();
  const upcoming = trips.filter((t) => {
    const { start, end } = splitDuration(tripDuration(t));
    return (end || start).slice(0, 7) >= thisMonth;
  });
  return upcoming.at(-1) ?? null;
}

// Days until the start for the next ~6 weeks, months after that. A month-only start can't
// claim more than "this month".
function countdown(duration) {
  const { start, end } = splitDuration(duration);
  const [y, m, d] = start.split('/').map(Number);
  if (!y || !m) return '';

  const now = new Date();
  const months = (y - now.getFullYear()) * 12 + (m - 1 - now.getMonth());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((new Date(y, m - 1, d || 1) - today) / 86400000);

  if (days > 0) {
    if (days === 1) return 'tomorrow';
    if (days < 45) return `in ${days} days`;
    return `in ${plural(months, 'month')}`;
  }
  if (months === 0 && !d) return 'this month';
  return (end || start).slice(0, 7) >= currentMonth(now) ? 'under way' : '';
}

function renderNext(trips) {
  const trip = nextTrip(trips);
  if (!trip) return;
  nextEl.innerHTML = `
    <a class="travel-next" href="${tripHref(trip)}">
      <span class="travel-next-label">Next</span>
      <span class="travel-next-place">${esc(trip.country ?? '')}</span>
      <span class="travel-next-when">${esc(countdown(tripDuration(trip)))}</span>
    </a>`;
}

function renderList(trips, byName) {
  listEl.innerHTML = trips
    .map((t) => `
      <a class="trip-card" href="${tripHref(t)}">
        ${thumbHtml(t, byName)}
        <div class="trip-card-body">
          <div class="trip-card-meta">
            ${t.country ? `<span>${esc(t.country)}</span>` : ''}
            ${t.continent ? `<span>${esc(t.continent)}</span>` : ''}
            ${t.newYear ? '<span class="tag">New Year</span>' : ''}
            ${t.pilgrimage ? '<span class="tag">Pilgrimage</span>' : ''}
          </div>
          <h2 class="trip-card-title">${esc(tripTitle(t))}</h2>
          <p class="trip-card-duration">${esc(fmtRange(tripDuration(t)))}</p>
        </div>
      </a>`)
    .join('');
}

Promise.all([
  loadCountries(),
  fetchJson(TRIPS_SRC),
  fetchJson(CONTINENTS_SRC),
  loadMarine().catch(() => null), // Named waters enhance the map but are not required for it.
  fetchJson(STARS_SRC).catch(() => null), // The star chart is decoration; the map works without it.
  loadCoarseCountries().catch(() => null), // Falls back to the 50m atlas for the ghost hemisphere too.
  fetchJson(MOON_FEATURES_SRC).catch(() => null), // Real crater/mare data for the moon; also just decoration.
])
  .then(([countries, trips, continents, marine, sky, coarseCountries, moonFeatures]) => {
    const sorted = newestFirst(trips);
    if (!sorted.length) {
      mapEl.innerHTML = emptyState({
        icon: 'file',
        title: 'No trips yet',
        description: `Add an entry to <code>${TRIPS_SRC}</code> and it will appear on the map.`,
      });
      return;
    }
    renderStats(sorted);
    renderNext(sorted);
    renderWorldMap(mapEl, {
      countries,
      ghostCountries: coarseCountries || countries,
      trips: sorted,
      continentOf: new Map(Object.entries(continents)),
      marine,
      sky,
      moonFeatures,
      loadDetail: loadDetailedCountries,
    });
    renderList(sorted, byCountryName(countries));
  })
  .catch((err) => {
    statsEl.textContent = '';
    mapEl.innerHTML = emptyState({
      icon: 'alert',
      title: 'Could not load the map',
      description: `${esc(err.message)}. ${SERVE_HINT}`,
      actions: RETRY_BUTTON,
    });
  });
