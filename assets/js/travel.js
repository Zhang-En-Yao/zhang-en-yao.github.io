// The travel page: a world map of every trip, and the same trips as a list underneath.
// Depends on ui.js (`esc`, `emptyState`), d3-geo, and topojson-client.
//
// The dots are the point of the page, but they are ~9px targets on a phone and invisible
// to a screen reader as geometry — so the list below is not a fallback, it is the other
// half of the same navigation.

const mapEl = document.getElementById('map');
const listEl = document.getElementById('list');
const statsEl = document.getElementById('stats');
const nextEl = document.getElementById('next');

const WORLD_SRC = 'assets/data/countries-50m.json';
const TRIPS_SRC = 'travel/index.json';
// The atlas carries a country's name and nothing else, so which continent it sits in has
// to come from somewhere: this is that lookup, keyed on the same names the atlas uses.
const CONTINENTS_SRC = 'assets/data/continents.json';

// Natural Earth 1 is the compromise: nothing is the right size and nothing is the right
// shape, but nothing is grotesque either — which is all a "places I've been" map needs.
// Mercator would put Greenland on the throne; equirectangular smears the poles.
const WIDTH = 960;
const PAD = 6; // Room for a dot's stroke at the very edge of the land.

// Antarctica is a fifth of the map's height, and nobody writes a travelogue about it.
// Dropping it before the fit is what lets the inhabited world fill the frame.
const OMIT = new Set(['Antarctica']);

const tripHref = (trip) => `trip.html?id=${encodeURIComponent(trip.id)}`;

// A trip is one journey and may have several cities in it, so "places" counts the
// distinct cities rather than the entries: Kyoto three times over is still one place.
function renderStats(trips) {
  const journeys = trips.length;
  const places = new Set(trips.flatMap((t) => (t.cities || []).map((c) => c.name))).size;
  const countries = new Set(trips.map((t) => t.country).filter(Boolean)).size;
  statsEl.textContent = [
    `${journeys} ${journeys === 1 ? 'trip' : 'trips'}`,
    `${places} ${places === 1 ? 'place' : 'places'}`,
    `${countries} ${countries === 1 ? 'country' : 'countries'}`,
  ].join(' · ');
}

// The map's unit is the city, but the page's unit is the trip: every dot of a six-city
// journey opens that one journey. Flattening once here keeps the marker, its tooltip and
// its link reading from the same record.
function stopsOf(trips) {
  return trips.flatMap((t) => (t.cities || []).map((city) => ({ trip: t, city })));
}

// The soonest trip that has not finished yet, or null when there is nothing booked.
// Keyed on the trip's *end* so a journey already under way is still the one you are on,
// and `trips` arrives newest-first, so the last one left is the soonest to start.
function nextTrip(trips) {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
  const upcoming = trips.filter((t) => {
    const { start, end } = splitDuration(tripDuration(t));
    return (end || start).slice(0, 7) >= thisMonth;
  });
  return upcoming.length ? upcoming[upcoming.length - 1] : null;
}

// Counts to the day the trip starts, at whatever precision that day is recorded: a start
// of `2026/02` is counted from the 1st, `2026/02/14` from the 14th. Past ~6 weeks the
// exact days stop meaning anything to a reader, so it switches to whole months.
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
    return `in ${months} ${months === 1 ? 'month' : 'months'}`;
  }

  // The start has been reached — but a start recorded as a bare month is only known to
  // the month, and today could fall either side of it. Say the month and claim nothing.
  if (months === 0 && !d) return 'this month';

  // Started before this month and not finished: that one really is under way.
  const thisMonth = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
  return (end || start).slice(0, 7) >= thisMonth ? 'under way' : '';
}

function renderNext(trips) {
  const trip = nextTrip(trips);
  if (!trip) return; // Nothing booked: the banner is absent rather than empty.

  nextEl.innerHTML = `
    <a class="travel-next" href="${tripHref(trip)}">
      <span class="travel-next-label">Next</span>
      <span class="travel-next-place">${esc(tripTitle(trip))}</span>
      <span class="travel-next-when">${esc(countdown(tripDuration(trip)))}</span>
    </a>`;
}

// How far in the map zooms, and how much of the frame the target is asked to fill once it
// gets there. The 12% margin is what stops a country from touching the edges.
const MAX_K = 40;
const FILL = 0.88;

// Where each continent is framed, as [[west, south], [east, north]].
//
// Not the extent of its countries, which is a different and much larger thing: the atlas
// files Russia under Europe, so the bounding box of Europe's members reaches Kamchatka and
// "zoom to Europe" would land you back on the world. A continent is drawn here at the size
// a reader means by the word — Europe is the Atlantic to the Urals — and the territory that
// falls outside stays on the map, tinted and clickable, just not framed.
const CONTINENT_BOX = {
  Africa: [[-19, -36], [52, 38]],
  Asia: [[26, -11], [147, 56]],
  Europe: [[-25, 34], [45, 71]],
  'North America': [[-168, 7], [-52, 72]],
  'South America': [[-82, -56], [-34, 13]],
  Oceania: [[112, -48], [179, -6]],
};

// The box as a feature the projection can measure. Its edges are walked a degree at a time
// rather than drawn corner to corner, because naturalEarth1 bends every line it is given
// and a four-point box would measure the chords instead of the curves.
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

// Every vertex of a feature, rings and islands alike, as plain [lon, lat] pairs.
function pointsOf(feature) {
  const g = feature.geometry;
  if (!g) return [];
  const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
  return polys.flatMap((poly) => poly.flat());
}

// The transform that brings `features` into the frame.
//
// Measured by projecting the vertices and taking their extent, rather than by asking
// d3.geoPath for bounds. Two reasons, both learned the hard way. A path's bounds treat a
// ring as spherical, so a box wound the wrong way silently measures the whole globe minus
// itself — that is, the whole map. And d3 cuts any polygon crossing the antimeridian and
// lays the far side down at the opposite edge, which is *inside* one ring for Russia: no
// amount of picking between pieces can undo it, because it never became two pieces.
//
// So anchor on the median vertex and drop whatever sits half a world from it. Russia loses
// Chukotka and keeps its bulk; the United States loses the far Aleutians but keeps Alaska.
function frameOf(features, projection, height) {
  const pts = features
    .flatMap(pointsOf)
    .map((c) => projection(c))
    .filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pts.length) return null;

  const median = pts.map((p) => p[0]).sort((a, b) => a - b)[pts.length >> 1];
  const near = pts.filter((p) => Math.abs(p[0] - median) < WIDTH / 2);

  const x0 = Math.min(...near.map((p) => p[0]));
  const y0 = Math.min(...near.map((p) => p[1]));
  const x1 = Math.max(...near.map((p) => p[0]));
  const y1 = Math.max(...near.map((p) => p[1]));

  // A single-island nation projects to almost nothing at this scale; the floor is what
  // keeps the division below from running away to an absurd zoom.
  const w = Math.max(x1 - x0, 1);
  const h = Math.max(y1 - y0, 1);
  const k = Math.min(MAX_K, FILL * Math.min(WIDTH / w, height / h));
  return { k, x: WIDTH / 2 - (k * (x0 + x1)) / 2, y: height / 2 - (k * (y0 + y1)) / 2 };
}

function renderMap(all, trips, continentOf) {
  const land = { type: 'FeatureCollection', features: all.filter((f) => !OMIT.has(f.properties.name)) };

  // fitWidth centres the land in a height it picks for itself, so measure where the land
  // actually landed and slide it up to the top edge — that measured height is the viewBox.
  const projection = d3.geoNaturalEarth1().fitWidth(WIDTH - PAD * 2, land);
  const path = d3.geoPath(projection);
  const [[, y0], [, y1]] = path.bounds(land);
  const height = Math.ceil(y1 - y0) + PAD * 2;

  const [tx, ty] = projection.translate();
  projection.translate([tx + PAD, ty - y0 + PAD]);

  const visited = new Set(trips.map((t) => t.country).filter(Boolean));
  const known = new Set(all.map((f) => f.properties.name));
  visited.forEach((c) => {
    // The tint is keyed on the country name in the atlas, so a typo fails silently on a
    // map. Say so here rather than leave it looking like a rendering bug.
    if (!known.has(c)) console.warn(`travel: "${c}" is not a country name in the atlas, so it will not be tinted.`);
  });

  const countries = land.features
    .map((f) => {
      const d = path(f);
      if (!d) return '';
      const name = f.properties.name;
      const cls = visited.has(name) ? 'map-country is-visited' : 'map-country';
      return `<path class="${cls}" d="${d}" data-country="${esc(name)}"
                    data-continent="${esc(continentOf.get(name) || '')}"><title>${esc(name)}</title></path>`;
    })
    .join('');

  // An <a> rather than a bare <circle>: it gets the click, the keyboard focus, and the
  // "open in new tab" that any other link on the site has, for free.
  const stops = stopsOf(trips);
  const markers = stops
    .map((s, i) => {
      const p = projection([s.city.lon, s.city.lat]);
      if (!p) return '';
      return `
        <a class="map-marker" href="${tripHref(s.trip)}" data-stop="${i}"
           aria-label="${esc(s.city.name)}, ${esc(fmtDuration(tripDuration(s.trip)))}">
          <circle class="map-marker-halo" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="9"/>
          <circle class="map-marker-dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4"/>
        </a>`;
    })
    .join('');

  mapEl.innerHTML = `
    <svg class="map-svg" viewBox="0 0 ${WIDTH} ${height}" role="img"
         aria-label="World map of the places listed below">
      <g class="map-scene">
        <g class="map-land">${countries}</g>
        <g class="map-markers">${markers}</g>
      </g>
    </svg>
    <div class="map-tip glass"></div>
    <div class="map-nav" hidden>
      <button class="map-back icon-btn glass" type="button" aria-label="Zoom back out">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
      </button>
      <span class="map-crumb glass" aria-live="polite"></span>
    </div>`;

  wireTooltip(stops);
  wireZoom(land.features, projection, height, continentOf);
}

// Click a country to zoom to its continent, click again to zoom to the country itself, and
// click the sea — or press Escape, or use the button — to come back out a step.
//
// Only the pointer gets this. The country shapes are not focusable and deliberately so:
// 177 tab stops between the reader and the list below is a worse map, not a better one,
// and the list is already the half of this page that a keyboard and a screen reader read.
// The one control that *does* appear, Back, is a real button for exactly that reason.
function wireZoom(features, projection, height, continentOf) {
  const svg = mapEl.querySelector('.map-svg');
  const scene = mapEl.querySelector('.map-scene');
  const nav = mapEl.querySelector('.map-nav');
  const crumb = mapEl.querySelector('.map-crumb');

  // Level 0 is the world, 1 a continent, 2 a country.
  let view = { level: 0, continent: null, country: null };

  function apply(frame, label) {
    const { k, x, y } = frame || { k: 1, x: 0, y: 0 };
    scene.setAttribute('transform', `translate(${x.toFixed(2)},${y.toFixed(2)}) scale(${k.toFixed(4)})`);
    // The dots and hairlines are drawn in map units, so the zoom would fatten them along
    // with the land. Every one of them is sized against this, and divides it back out.
    mapEl.style.setProperty('--map-k', k.toFixed(4));
    nav.hidden = view.level === 0;
    crumb.textContent = label || '';
  }

  function show(level, continent, country) {
    view = { level, continent, country };
    if (!level) return apply(null, '');

    // A country is framed on its own shape; a continent on its box, falling back to its
    // members if it is somewhere the box list doesn't name.
    const target =
      level === 2
        ? features.filter((f) => f.properties.name === country)
        : CONTINENT_BOX[continent]
          ? [boxFeature(CONTINENT_BOX[continent])]
          : features.filter((f) => continentOf.get(f.properties.name) === continent);
    apply(frameOf(target, projection, height), level === 2 ? `${continent} · ${country}` : continent);
  }

  const out = () => show(Math.max(0, view.level - 1), view.continent, null);

  svg.addEventListener('click', (e) => {
    if (e.target.closest('.map-marker')) return; // A dot is a link; let it be one.

    const shape = e.target.closest('.map-country');
    if (!shape) return out(); // The sea: the way back out.

    const { country, continent } = shape.dataset;
    if (!continent) return;
    // From the world, a country stands for its continent. Once inside that continent the
    // same click means the country itself — and a click on a country somewhere else means
    // that country's continent, so a misaimed click travels rather than stranding you.
    if (view.level === 0 || continent !== view.continent) show(1, continent, null);
    else show(2, continent, country);
  });

  mapEl.querySelector('.map-back').addEventListener('click', out);

  // On the document, because nothing inside the map holds focus for a keydown to reach.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && view.level) out();
  });
}

// One tooltip element reused by every marker: hover *and* focus raise it, so it appears
// for a tab through the map the same way it does for a mouse.
function wireTooltip(stops) {
  const svg = mapEl.querySelector('.map-svg');
  const tip = mapEl.querySelector('.map-tip');

  function show(marker) {
    const stop = stops[Number(marker.dataset.stop)];
    if (!stop) return;

    // The dot is one city, so the tooltip names that city — but the dates under it are
    // the whole journey's, which is what you get if you click through.
    tip.innerHTML = `
      <span class="map-tip-title">${esc(stop.city.name)}</span>
      <span class="map-tip-meta">${esc(fmtDuration(tripDuration(stop.trip)))}</span>`;

    // The SVG scales with the column, so the dot's on-screen position is only knowable
    // from the live geometry — not from the projected coordinates it was drawn at.
    const dot = marker.querySelector('.map-marker-dot').getBoundingClientRect();
    const host = mapEl.getBoundingClientRect();
    tip.style.left = `${dot.left - host.left + dot.width / 2}px`;
    tip.style.top = `${dot.top - host.top}px`;

    // A class rather than `hidden`: display:none cannot be transitioned, and this one
    // fades and lifts into place.
    tip.classList.add('is-on');
    marker.classList.add('is-active');
  }

  function hide() {
    tip.classList.remove('is-on');
    svg.querySelectorAll('.map-marker.is-active').forEach((m) => m.classList.remove('is-active'));
  }

  svg.addEventListener('pointerover', (e) => {
    const marker = e.target.closest('.map-marker');
    if (marker) show(marker);
  });
  svg.addEventListener('pointerout', (e) => {
    if (e.target.closest('.map-marker')) hide();
  });
  svg.addEventListener('focusin', (e) => {
    const marker = e.target.closest('.map-marker');
    if (marker) show(marker);
  });
  svg.addEventListener('focusout', hide);
}

// The card's thumbnail: the land the trip was on, filling the frame, with the stops marked.
// Mercator rather than the world map's Natural Earth — at this scale the job is to look
// like the shape you'd recognise, and a compromise projection buys nothing here.
const THUMB_W = 112;
const THUMB_H = 80;
const THUMB_PAD = 9;

// Framed on the landmass under the cities, not on the country. `country` is a filing label —
// the same reason the trip page frames its band on the cities. Two things follow from it.
//
// The atlas files a country's far territories under the country: the Netherlands reaches
// Bonaire, an ocean and 7000km from Amsterdam, so fitting the whole country frames the
// Atlantic and leaves Amsterdam a speck in the corner of its own card. And a country is
// often much larger than the trip — a week on Okinawa drawn as the whole of Japan is a map
// of everywhere you didn't go. Framing on the landmass answers both: Okinawa gets Okinawa,
// Fukuoka gets Kyushu, the Netherlands gets the Netherlands. The country's name is already
// on the card, a line above the picture.
//
// Which landmass a city is on is a question for the geometry, so there is no distance to
// tune here: the answer is the polygon the city is inside.
function landmassAt(polys, city) {
  const pt = [city.lon, city.lat];
  const inside = polys.findIndex((poly) => d3.geoContains({ type: 'Polygon', coordinates: poly }, pt));
  if (inside >= 0) return inside;

  // Unless it is inside none of them. A harbour reads as open sea at this resolution and a
  // city on a bay can sit a pixel offshore, so a miss takes the nearest land instead —
  // measured to the bounding box, which for a coordinate this close is the same answer.
  let best = -1;
  let bestGap = Infinity;
  polys.forEach((poly, i) => {
    const pts = poly.flat();
    const lons = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    const gap = Math.hypot(
      Math.max(0, Math.min(...lons) - pt[0], pt[0] - Math.max(...lons)),
      Math.max(0, Math.min(...lats) - pt[1], pt[1] - Math.max(...lats)),
    );
    if (gap < bestGap) { bestGap = gap; best = i; }
  });
  return best;
}

function thumbFeature(country, cities) {
  const g = country.geometry;
  if (!g) return null;
  const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
  // One piece, or nowhere to aim at: the country is the best answer available.
  if (polys.length < 2 || !cities.length) return country;

  const kept = new Set(cities.map((c) => landmassAt(polys, c)).filter((i) => i >= 0));
  if (!kept.size) return country;
  return {
    ...country,
    geometry: { type: 'MultiPolygon', coordinates: polys.filter((_, i) => kept.has(i)) },
  };
}

function thumbHtml(trip, byName) {
  const country = byName.get(trip.country);
  if (!country) return '';
  const cities = (trip.cities || []).filter((c) => Number.isFinite(c.lon) && Number.isFinite(c.lat));
  const feat = thumbFeature(country, cities);
  if (!feat) return '';

  const projection = d3.geoMercator()
    .fitExtent([[THUMB_PAD, THUMB_PAD], [THUMB_W - THUMB_PAD, THUMB_H - THUMB_PAD]], feat);
  const d = d3.geoPath(projection)(feat);
  if (!d) return '';

  // Every stop of the journey, so the thumbnail shows its shape: one dot for Fukuoka,
  // three strung across Hokkaido.
  const dots = cities
    .map((c) => {
      const p = projection([c.lon, c.lat]);
      return p ? `<circle class="trip-card-map-dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.6"/>` : '';
    })
    .join('');

  return `
    <svg class="trip-card-map" viewBox="0 0 ${THUMB_W} ${THUMB_H}" aria-hidden="true">
      <path class="trip-card-map-shape" d="${d}"/>
      ${dots}
    </svg>`;
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
            ${t.newYear ? '<span class="trip-card-tag">New Year</span>' : ''}
          </div>
          <h2 class="trip-card-title">${esc(tripTitle(t))}</h2>
          <p class="trip-card-duration">${esc(fmtDuration(tripDuration(t)))}</p>
        </div>
      </a>`)
    .join('');
}

Promise.all(
  [WORLD_SRC, TRIPS_SRC, CONTINENTS_SRC].map((src) =>
    fetch(src).then((r) => {
      if (!r.ok) throw new Error(`${src}: ${r.status}`);
      return r.json();
    }),
  ),
)
  .then(([world, trips, continents]) => {
    // Newest first. Not every trip carries flights to date it, but every `id` leads with a
    // zero-padded year and month, so comparing the raw ids orders the trips by when they
    // happened without parsing anything — and without depending on a duration to exist.
    const sorted = [...trips].sort((a, b) => String(b.id).localeCompare(String(a.id)));

    if (!sorted.length) {
      mapEl.innerHTML = emptyState({
        icon: 'file',
        title: 'No trips yet',
        description: 'Add an entry to <code>travel/index.json</code> and it will appear on the map.',
      });
      return;
    }

    // Decoded once: the world map draws these, and each card draws one of them again.
    const all = topojson.feature(world, world.objects.countries).features;
    const byName = new Map(all.map((f) => [f.properties.name, f]));
    const continentOf = new Map(Object.entries(continents));

    renderStats(sorted);
    renderNext(sorted);
    renderMap(all, sorted, continentOf);
    renderList(sorted, byName);
  })
  .catch((err) => {
    statsEl.textContent = '';
    mapEl.innerHTML = emptyState({
      icon: 'alert',
      title: 'Could not load the map',
      description: `${esc(err.message)}. ${SERVE_HINT}`,
      actions: '<button type="button" class="btn" onclick="location.reload()">Retry</button>',
    });
  });
