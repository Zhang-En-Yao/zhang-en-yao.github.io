// The world map on the travel page: tinted countries, a dot per city, click-to-zoom.
// Uses the global `d3` (d3-geo).
import { esc } from '../shared/dom.js';
import { fmtDuration } from '../shared/format.js';
import { tripDuration, tripHref } from '../shared/trips.js';
import { polygonsOf } from '../shared/atlas.js';

const WIDTH = 960;
const PAD = 6;
const OMIT = new Set(['Antarctica']);
const MAX_K = 40;
const FILL = 0.88;

// [[west, south], [east, north]] — a continent as a reader means it, not the extent of the
// countries filed under it (the atlas puts all of Russia in Europe).
const CONTINENT_BOX = {
  Africa: [[-19, -36], [52, 38]],
  Asia: [[26, -11], [147, 56]],
  Europe: [[-25, 34], [45, 71]],
  'North America': [[-168, 7], [-52, 72]],
  'South America': [[-82, -56], [-34, 13]],
  Oceania: [[112, -48], [179, -6]],
};

const BACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>';

// Walked one degree at a time: naturalEarth1 curves the edges, so four corners would
// measure the chords.
function boxFeature([[w, s], [e, n]]) {
  const ring = [];
  const step = (a, b) => Math.sign(b - a);
  for (let x = w; x !== e; x += step(w, e)) ring.push([x, s]);
  for (let y = s; y !== n; y += step(s, n)) ring.push([e, y]);
  for (let x = e; x !== w; x += step(e, w)) ring.push([x, n]);
  for (let y = n; y !== s; y += step(n, s)) ring.push([w, y]);
  ring.push(ring[0]);
  return { geometry: { type: 'Polygon', coordinates: [ring] } };
}

// The zoom transform that fits `features`. Measured from projected vertices rather than
// path.bounds(), and anchored on the median x so pieces cut across the antimeridian
// (Chukotka, the Aleutians) don't stretch the frame across the whole map.
function frameOf(features, projection, height) {
  const pts = features
    .flatMap((f) => polygonsOf(f.geometry).flatMap((poly) => poly.flat()))
    .map((c) => projection(c))
    .filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pts.length) return null;

  const median = pts.map((p) => p[0]).sort((a, b) => a - b)[pts.length >> 1];
  const near = pts.filter((p) => Math.abs(p[0] - median) < WIDTH / 2);
  const xs = near.map((p) => p[0]);
  const ys = near.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];

  const k = Math.min(MAX_K, FILL * Math.min(WIDTH / Math.max(x1 - x0, 1), height / Math.max(y1 - y0, 1)));
  return { k, x: WIDTH / 2 - (k * (x0 + x1)) / 2, y: height / 2 - (k * (y0 + y1)) / 2 };
}

export function renderWorldMap(mapEl, countries, trips, continentOf) {
  const land = { type: 'FeatureCollection', features: countries.filter((f) => !OMIT.has(f.properties.name)) };

  // fitWidth centres vertically in a height of its own choosing; shift the land to the top
  // edge and use its measured height as the viewBox.
  const projection = d3.geoNaturalEarth1().fitWidth(WIDTH - PAD * 2, land);
  const path = d3.geoPath(projection);
  const [[, y0], [, y1]] = path.bounds(land);
  const height = Math.ceil(y1 - y0) + PAD * 2;
  const [tx, ty] = projection.translate();
  projection.translate([tx + PAD, ty - y0 + PAD]);

  const visited = new Set(trips.map((t) => t.country).filter(Boolean));
  const known = new Set(countries.map((f) => f.properties.name));
  visited.forEach((c) => {
    if (!known.has(c)) console.warn(`travel: "${c}" is not a country name in the atlas, so it will not be tinted.`);
  });

  const shapes = land.features
    .map((f) => {
      const d = path(f);
      if (!d) return '';
      const name = f.properties.name;
      const cls = visited.has(name) ? 'map-country is-visited' : 'map-country';
      return `<path class="${cls}" d="${d}" data-country="${esc(name)}"
                    data-continent="${esc(continentOf.get(name) || '')}"><title>${esc(name)}</title></path>`;
    })
    .join('');

  const stops = trips.flatMap((trip) => (trip.cities || []).map((city) => ({ trip, city })));
  const markers = stops
    .map(({ trip, city }, i) => {
      const p = projection([city.lon, city.lat]);
      if (!p) return '';
      const [cx, cy] = [p[0].toFixed(1), p[1].toFixed(1)];
      return `
        <a class="map-marker" href="${tripHref(trip)}" data-stop="${i}"
           aria-label="${esc(city.name)}, ${esc(fmtDuration(tripDuration(trip)))}">
          <circle class="map-marker-halo" cx="${cx}" cy="${cy}" r="9"/>
          <circle class="map-marker-dot" cx="${cx}" cy="${cy}" r="4"/>
        </a>`;
    })
    .join('');

  mapEl.innerHTML = `
    <svg class="map-svg" viewBox="0 0 ${WIDTH} ${height}" role="img"
         aria-label="World map of the places listed below">
      <g class="map-scene">
        <g class="map-land">${shapes}</g>
        <g class="map-markers">${markers}</g>
      </g>
    </svg>
    <div class="map-tip glass"></div>
    <div class="map-nav" hidden>
      <button class="map-back icon-btn glass" type="button" aria-label="Zoom back out">${BACK_ICON}</button>
      <span class="map-crumb glass" aria-live="polite"></span>
    </div>`;

  wireTooltip(mapEl, stops);
  wireZoom(mapEl, land.features, projection, height, continentOf);
}

// Click a country to zoom to its continent, again for the country; the sea, Back or Escape
// step out. Pointer-only by design: the list below is the keyboard path.
function wireZoom(mapEl, features, projection, height, continentOf) {
  const svg = mapEl.querySelector('.map-svg');
  const scene = mapEl.querySelector('.map-scene');
  const nav = mapEl.querySelector('.map-nav');
  const crumb = mapEl.querySelector('.map-crumb');

  let view = { level: 0, continent: null }; // 0 world, 1 continent, 2 country

  function apply(frame, label) {
    const { k, x, y } = frame || { k: 1, x: 0, y: 0 };
    scene.setAttribute('transform', `translate(${x.toFixed(2)},${y.toFixed(2)}) scale(${k.toFixed(4)})`);
    mapEl.style.setProperty('--map-k', k.toFixed(4)); // CSS divides strokes and dots by it.
    nav.hidden = view.level === 0;
    crumb.textContent = label || '';
  }

  function show(level, continent, country) {
    view = { level, continent };
    if (!level) return apply(null, '');
    let target;
    if (level === 2) target = features.filter((f) => f.properties.name === country);
    else if (CONTINENT_BOX[continent]) target = [boxFeature(CONTINENT_BOX[continent])];
    else target = features.filter((f) => continentOf.get(f.properties.name) === continent);
    apply(frameOf(target, projection, height), level === 2 ? `${continent} · ${country}` : continent);
  }

  const out = () => show(Math.max(0, view.level - 1), view.continent, null);

  svg.addEventListener('click', (e) => {
    if (e.target.closest('.map-marker')) return;
    const shape = e.target.closest('.map-country');
    if (!shape) return out();
    const { country, continent } = shape.dataset;
    if (!continent) return;
    if (view.level === 0 || continent !== view.continent) show(1, continent, null);
    else show(2, continent, country);
  });

  mapEl.querySelector('.map-back').addEventListener('click', out);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && view.level) out();
  });
}

function wireTooltip(mapEl, stops) {
  const svg = mapEl.querySelector('.map-svg');
  const tip = mapEl.querySelector('.map-tip');

  function show(marker) {
    const stop = stops[Number(marker.dataset.stop)];
    if (!stop) return;
    tip.innerHTML = `
      <span class="map-tip-title">${esc(stop.city.name)}</span>
      <span class="map-tip-meta">${esc(fmtDuration(tripDuration(stop.trip)))}</span>`;

    // The SVG scales with its column, so position from live geometry.
    const dot = marker.querySelector('.map-marker-dot').getBoundingClientRect();
    const host = mapEl.getBoundingClientRect();
    tip.style.left = `${dot.left - host.left + dot.width / 2}px`;
    tip.style.top = `${dot.top - host.top}px`;
    tip.classList.add('is-on');
    marker.classList.add('is-active');
  }

  function hide() {
    tip.classList.remove('is-on');
    svg.querySelectorAll('.map-marker.is-active').forEach((m) => m.classList.remove('is-active'));
  }

  const onMarker = (e) => {
    const marker = e.target.closest('.map-marker');
    if (marker) show(marker);
  };
  svg.addEventListener('pointerover', onMarker);
  svg.addEventListener('focusin', onMarker);
  svg.addEventListener('pointerout', (e) => { if (e.target.closest('.map-marker')) hide(); });
  svg.addEventListener('focusout', hide);
}
