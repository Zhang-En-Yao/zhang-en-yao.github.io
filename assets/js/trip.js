import { esc, fetchJson, emptyState, SERVE_HINT } from './shared/dom.js';
import { TRIPS_SRC, tripTitle } from './shared/trips.js';
import { loadCountries } from './shared/atlas.js';
import { SRC as PLACES_SRC } from './shared/places.js';
import { headerHtml, bodyHtml } from './trip/content.js';
import { galleryHtml, wireGallery } from './trip/gallery.js';
import { buildToc } from './trip/toc.js';
import { initLightbox } from './trip/lightbox.js';
import { initAmbient } from './trip/ambient.js';
import { initJumpback } from './trip/jumpback.js';
import { initTranslate } from './trip/translate.js';

const tripEl = document.getElementById('trip');
const tocEl = document.getElementById('toc');
const id = new URLSearchParams(location.search).get('id');
const BACK_TO_MAP = '<a class="btn" href="travel.html">Back to the map</a>';

initJumpback();
initTranslate();

async function render() {
  const [trips, countries] = await Promise.all([
    fetchJson(TRIPS_SRC),
    loadCountries().catch(() => []), // The region map is decoration; the trip still reads without it.
  ]);
  const trip = trips.find((t) => t.id === id);
  if (!trip) throw new Error(`No trip with id ${id}`);
  document.title = `${tripTitle(trip)} — Travels`;

  if (!trip.file) {
    tripEl.innerHTML = headerHtml(trip, countries) + emptyState({
      icon: 'file',
      title: 'Not written up yet',
      description: 'This trip is on the map, but there is no travelogue for it.',
      actions: BACK_TO_MAP,
    });
    return;
  }

  const [content, streets, places] = await Promise.all([
    fetchJson(`travel/${trip.file}`),
    fetchJson(`travel/streets/${trip.id}.json`).catch(() => ({})), // Optional; see build-streets.py.
    fetchJson(PLACES_SRC).catch(() => null), // Optional; see build-places.py.
  ]);
  const [gallery, photos] = galleryHtml(content, trip.id);
  tripEl.innerHTML = `${headerHtml(trip, countries)}<div class="prose">${bodyHtml(content, streets, places)}${gallery}</div>`;

  const prose = tripEl.querySelector('.prose');
  buildToc(prose, tocEl);
  wireGallery(prose);
  initLightbox(prose, photos, { title: tripTitle(trip) });
  initAmbient(prose);
}

if (!id) {
  tripEl.innerHTML = emptyState({
    icon: 'file',
    title: 'No trip specified',
    description: 'This page needs an <code>?id=</code> parameter to know which trip to open.',
    actions: BACK_TO_MAP,
  });
} else {
  render().catch((err) => {
    console.error(err);
    tripEl.innerHTML = emptyState({
      icon: 'search',
      title: 'Trip not found',
      description: `No trip matches <code>${esc(id)}</code>, or its file could not be fetched. ${SERVE_HINT}`,
      actions: BACK_TO_MAP,
    });
  });
}
