// The world map on the travel page: tinted countries and a dot per place visited. Drag,
// pinch or ⌘/Ctrl + scroll to explore; click a country to fly to it; click a dot for the
// trips that went there. Uses the global `d3` (d3-geo).
import { esc, plural } from '../shared/dom.js';
import { fmtRange } from '../shared/format.js';
import { tripDuration, tripHref, tripTitle } from '../shared/trips.js';
import { polygonsOf, hasCoords } from '../shared/atlas.js';
import { MapView } from './map-view.js';

const WIDTH = 960;
const PAD = 6;
const MAX_ZOOM = 40;
const SKY_REACH = 93; // degrees of sky each polar chart draws, measured from its pole
const SKY_SEAM = 0.22; // share of a star band that fades out where it meets the land
const HIT_RADIUS = 20; // px around a dot that still counts as clicking it
const EDGE_MARGIN = 48; // px a selected dot is kept away from the map's edges

const isApple = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform ?? navigator.platform);

const icon = (paths, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${paths}</svg>`;
const ICONS = {
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
  minus: icon('<path d="M5 12h14"/>'),
  home: icon('<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><circle cx="12" cy="12" r="2.5"/>'),
  close: icon('<path d="M18 6 6 18M6 6l12 12"/>'),
  chevron: icon('<path d="m9 6 6 6-6 6"/>', 'class="map-callout-chevron"'),
};

// Content-space bounds of a country, ignoring pieces cut across the antimeridian (Chukotka,
// the far Aleutians) by keeping vertices within half a map of the median.
function boundsOf(feature, projection) {
  const pts = polygonsOf(feature.geometry)
    .flatMap((poly) => poly.flat())
    .map((c) => projection(c))
    .filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pts.length) return null;
  const median = pts.map((p) => p[0]).sort((a, b) => a - b)[pts.length >> 1];
  const near = pts.filter((p) => Math.abs(p[0] - median) < WIDTH / 2);
  const xs = near.map((p) => p[0]);
  const ys = near.map((p) => p[1]);
  return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
}

// One place per city, however many trips went there (newest trip first).
function placesOf(trips, projection) {
  const places = [];
  trips.forEach((trip) => (trip.cities || []).filter(hasCoords).forEach((city) => {
    let place = places.find((p) => p.name === city.name
      && Math.abs(p.lon - city.lon) < 0.5 && Math.abs(p.lat - city.lat) < 0.5);
    if (!place) {
      const xy = projection([city.lon, city.lat]);
      if (!xy) return;
      place = { name: city.name, lon: city.lon, lat: city.lat, xy, country: trip.country, trips: [] };
      places.push(place);
    }
    if (!place.trips.includes(trip)) place.trips.push(trip);
  }));
  return places.sort((a, b) => a.xy[1] - b.xy[1]); // Lower dots paint over higher ones.
}

// A square map leaves a band above the Arctic and below Antarctica that the projection has
// nothing to put in. Each carries the real sky over that pole, drawn the way star atlases
// draw it: a stereographic projection — whose projection point is the opposite celestial
// pole — centred on the celestial pole, and reflected, because d3 projects a sphere as seen
// from outside while a star chart shows the sky as seen from under it. Right ascension 0h
// points at the map, which stands the vernal equinox over the Greenwich meridian.
//
// An azimuthal chart is a disc, so it only fills a band whose far corners are inside its
// rim: at a distance θ from the pole d3 puts a star at scale · tan(θ/2), which fixes the
// scale once the reach is chosen. Reaching just past the celestial equator gives each band
// its own hemisphere — together they hold the whole sky, once — and keeps the rim of the
// disc off the corners, where it would otherwise show as an arc.
function skyHtml(w, h, bandH, sky) {
  if (!sky || bandH < 24) return '';
  const scale = Math.hypot(w / 2, bandH / 2) / Math.tan((SKY_REACH / 2) * (Math.PI / 180));
  const magMax = sky.magMax || 6;

  const band = (sign, top, clip) => {
    const projection = d3.geoStereographic()
      .rotate([0, -90 * sign])
      .reflectX(true)
      .translate([w / 2, top + bandH / 2])
      .scale(scale)
      .clipAngle(SKY_REACH);
    const path = d3.geoPath(projection).digits(1);

    const figures = sky.lines
      .map((c) => path({ type: 'MultiLineString', coordinates: c.paths }))
      .filter(Boolean)
      .map((d) => `<path class="map-constellation" d="${d}"/>`)
      .join('');

    // `projection(point)` does not clip, and the band holds barely a third of the disc, so
    // drop the rest here rather than leave thousands of hidden circles in the document.
    const stars = sky.stars
      .filter(([, dec]) => 90 - dec * sign <= SKY_REACH)
      .map(([ra, dec, mag]) => {
        const p = projection([ra, dec]);
        if (!p || p[0] < -3 || p[0] > w + 3 || p[1] < top - 3 || p[1] > top + bandH + 3) return '';
        const bright = Math.min(1, (magMax - mag) / magMax);
        const r = 0.5 + (magMax - mag) * 0.45;
        return `<circle class="map-star" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}"`
          + ` r="${r.toFixed(2)}" opacity="${(0.3 + bright * 0.6).toFixed(2)}"/>`;
      })
      .join('');

    return `<g clip-path="url(#${clip})">${figures}${stars}</g>`;
  };

  // The sky is cut off square where it meets the ice; a band of the card's own colour over
  // the last of it turns that cut into the sky passing behind the earth.
  const seam = Math.round(bandH * SKY_SEAM);
  const fade = (id, y0, y1) => `
    <linearGradient id="${id}" x1="0" y1="${y0}" x2="0" y2="${y1}" gradientUnits="userSpaceOnUse">
      <stop offset="0" class="map-sky-clear"/><stop offset="1" class="map-sky-solid"/>
    </linearGradient>`;

  return `
    <defs>
      <clipPath id="map-sky-north"><rect x="0" y="0" width="${w}" height="${bandH}"/></clipPath>
      <clipPath id="map-sky-south"><rect x="0" y="${h - bandH}" width="${w}" height="${bandH}"/></clipPath>
      ${fade('map-sky-seam-north', bandH - seam, bandH)}${fade('map-sky-seam-south', h - bandH + seam, h - bandH)}
    </defs>
    <g class="map-sky" aria-hidden="true">
      ${band(1, 0, 'map-sky-north')}${band(-1, h - bandH, 'map-sky-south')}
      <rect x="0" y="${bandH - seam}" width="${w}" height="${seam}" fill="url(#map-sky-seam-north)"/>
      <rect x="0" y="${h - bandH}" width="${w}" height="${seam}" fill="url(#map-sky-seam-south)"/>
    </g>`;
}

// `data` carries the atlas (countries), the trips, the continent lookup, the named waters
// and the star charts. `loadDetail` is optional: called once, the first time someone zooms
// past DETAIL_AT, to swap the 1:50m coastlines for 1:10m.
export function renderWorldMap(mapEl, data) {
  const { countries, trips, continentOf, marine, sky, loadDetail } = data;
  const land = { type: 'FeatureCollection', features: countries };

  // Fit the land to WIDTH, then centre it vertically in a square content box, so the map card
  // is square however tall the projected world turns out to be.
  const projection = d3.geoNaturalEarth1().fitWidth(WIDTH - PAD * 2, land);
  const path = d3.geoPath(projection).digits(1);
  const [[, y0], [, y1]] = path.bounds(land);
  const height = WIDTH;
  const bandH = (height - (y1 - y0)) / 2; // empty sky above the Arctic and below Antarctica
  const [tx, ty] = projection.translate();
  projection.translate([tx + PAD, ty - y0 + bandH]);

  const visited = new Set(trips.map((t) => t.country).filter(Boolean));
  const byName = new Map(land.features.map((f) => [f.properties.name, f]));
  visited.forEach((c) => {
    if (!byName.has(c)) console.warn(`travel: "${c}" is not a country name in the atlas, so it will not be tinted.`);
  });

  const countryShapes = (features) => features
    .map((f) => {
      const d = path(f);
      const name = f.properties.name;
      return d ? `<path class="map-country${visited.has(name) ? ' is-visited' : ''}" d="${d}" data-country="${esc(name)}"/>` : '';
    })
    .join('');
  const shapes = countryShapes(land.features);

  // Ocean polygons reach the map's outer edge, which would draw a globe-shaped outline.
  // The smaller named waters supply the internal boundaries we want instead.
  const waterShapes = (marine?.areas ?? [])
    .filter((f) => f.properties.type !== 'ocean')
    .map((f) => {
      const d = path(f);
      return d ? `<path class="map-marine map-marine-${esc(f.properties.type)}" d="${d}"/>` : '';
    })
    .join('');

  // Where two countries' waters meet. Natural Earth draws these as indicators, not claims.
  const borderShapes = (marine?.borders ?? [])
    .map((f) => path(f))
    .filter(Boolean)
    .map((d) => `<path class="map-marine-border" d="${d}"/>`)
    .join('');

  const places = placesOf(trips, projection);
  const markers = places
    .map((p, i) => `
      <button class="map-marker" type="button" data-place="${i}"
              aria-label="${esc(p.name)}, ${plural(p.trips.length, 'trip')}"><span class="map-marker-dot"></span></button>`)
    .join('');

  mapEl.style.setProperty('--map-aspect', `${WIDTH} / ${height}`);
  mapEl.innerHTML = `
    <div class="map-viewport" tabindex="0" role="application"
         aria-label="World map of the places listed below. Arrow keys move the map; plus and minus zoom.">
      <svg class="map-svg" aria-hidden="true"><g class="map-scene">${skyHtml(WIDTH, height, bandH, sky)}<g class="map-marine-areas">${waterShapes}${borderShapes}</g><g class="map-land">${shapes}</g></g></svg>
      <div class="map-markers">${markers}</div>
    </div>
    <p class="map-crumb glass" hidden></p>
    <div class="map-controls">
      <div class="map-zoom glass">
        <button type="button" data-action="in" aria-label="Zoom in">${ICONS.plus}</button>
        <button type="button" data-action="out" aria-label="Zoom out">${ICONS.minus}</button>
      </div>
      <button class="map-home glass" type="button" data-action="home" aria-label="Show every place">${ICONS.home}</button>
    </div>
    <p class="map-tip glass" hidden></p>
    <div class="map-callout glass" role="dialog" hidden></div>
    <p class="map-hint glass" aria-hidden="true">Hold ${isApple ? '⌘' : 'Ctrl'} and scroll to zoom</p>`;

  const viewport = mapEl.querySelector('.map-viewport');
  const scene = mapEl.querySelector('.map-scene');
  const markerEls = [...mapEl.querySelectorAll('.map-marker')];
  const crumb = mapEl.querySelector('.map-crumb');
  const tip = mapEl.querySelector('.map-tip');
  const callout = mapEl.querySelector('.map-callout');
  const hint = mapEl.querySelector('.map-hint');
  const buttons = Object.fromEntries([...mapEl.querySelectorAll('[data-action]')].map((b) => [b.dataset.action, b]));

  let selected = -1;
  let hovered = -1;
  let focusedCountry = null;

  // Breathing room around a framed area, clear of the zoom controls on the right.
  const insets = (v) => {
    const pad = Math.min(40, v.w * 0.06);
    return { top: pad, bottom: pad, left: pad, right: pad + 44 };
  };

  const placeBounds = () => {
    const xs = places.map((p) => p.xy[0]);
    const ys = places.map((p) => p.xy[1]);
    return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
  };

  // 1:50m is indistinguishable from 1:10m at world zoom, so the finer atlas is fetched
  // only when the coastline starts to matter — and never for a visitor who does not zoom.
  const DETAIL_AT = 3;
  let detail = false;
  async function upgradeDetail() {
    if (detail || !loadDetail) return;
    detail = true;
    try {
      const features = await loadDetail();
      const box = mapEl.querySelector('.map-land');
      if (box) box.innerHTML = countryShapes(features);
    } catch (err) {
      detail = false;
      console.warn('travel: could not load the detailed atlas', err);
    }
  }

  const view = new MapView(viewport, {
    width: WIDTH,
    height,
    maxZoom: MAX_ZOOM,
    home: (v) => (places.length ? v.fitView(placeBounds(), { inset: insets(v), maxZoom: 8 }) : v.fitView([[0, 0], [WIDTH, height]])),
    onChange: update,
    onTap: tapAt,
    onHover: hoverAt,
    onGesture: () => { setCrumb(null); hideHint(); },
    onScrollHint: showHint,
  });

  // Called for every frame the view changes (and once while `view` is still being constructed).
  function update({ s, x, y }, v = view) {
    scene.setAttribute('transform', `translate(${x.toFixed(2)},${y.toFixed(2)}) scale(${s.toFixed(5)})`);
    places.forEach((p, i) => {
      markerEls[i].style.transform = `translate3d(${(p.xy[0] * s + x).toFixed(1)}px, ${(p.xy[1] * s + y).toFixed(1)}px, 0)`;
    });
    if (selected >= 0) positionPopover(callout, selected, 18);
    if (hovered >= 0) positionPopover(tip, hovered, 14);
    buttons.in.disabled = s >= v.maxScale * 0.999;
    buttons.out.disabled = s <= v.minScale * 1.001;
    buttons.home.disabled = v.isHome();
    if (s >= v.minScale * DETAIL_AT) upgradeDetail();
  }

  function nearestPlace(at) {
    let best = -1;
    let bestDistance = HIT_RADIUS;
    places.forEach((p, i) => {
      const [px, py] = view.toScreen(p.xy);
      const d = Math.hypot(px - at[0], py - at[1]);
      if (d < bestDistance) { bestDistance = d; best = i; }
    });
    return best;
  }

  // Above the dot when there is room, below it otherwise; kept inside the card horizontally.
  function positionPopover(el, index, gap) {
    const [px, py] = view.toScreen(places[index].xy);
    const inside = px >= 0 && px <= view.w && py >= 0 && py <= view.h;
    el.classList.toggle('is-offscreen', !inside);
    const { offsetWidth: w, offsetHeight: h } = el;
    const below = py - gap - h < -24; // May overhang the card's top a little, not more.
    const left = Math.max(8, Math.min(px - w / 2, view.w - w - 8));
    el.classList.toggle('is-below', below);
    el.style.setProperty('--arrow-x', `${Math.max(16, Math.min(w - 16, px - left))}px`);
    el.style.translate = `${left.toFixed(1)}px ${(below ? py + gap : py - gap - h).toFixed(1)}px`;
  }

  function openCallout(index) {
    if (selected === index) return closeCallout();
    closeCallout();
    void callout.offsetWidth; // Restart the pop-in animation.
    selected = index;
    const place = places[index];
    markerEls[index].classList.add('is-selected');
    callout.setAttribute('aria-label', place.name);
    callout.innerHTML = `
      <div class="map-callout-head">
        <div>
          <p class="map-callout-title">${esc(place.name)}</p>
          <p class="map-callout-meta">${esc(place.country || '')} · ${plural(place.trips.length, 'trip')}</p>
        </div>
        <button class="map-callout-close" type="button" aria-label="Close">${ICONS.close}</button>
      </div>
      <ul class="map-callout-trips">
        ${place.trips.map((t) => `
          <li><a href="${tripHref(t)}">
            <span class="map-callout-trip">${esc(tripTitle(t))}</span>
            <span class="map-callout-date">${esc(fmtRange(tripDuration(t)))}</span>
            ${ICONS.chevron}
          </a></li>`).join('')}
      </ul>`;
    callout.hidden = false;
    hideTip();
    positionPopover(callout, index, 18);

    // Bring a dot near the edge into view so its card has room.
    const [px, py] = view.toScreen(place.xy);
    const dx = Math.max(0, EDGE_MARGIN - px) - Math.max(0, px - (view.w - EDGE_MARGIN));
    const dy = Math.max(0, EDGE_MARGIN - py) - Math.max(0, py - (view.h - EDGE_MARGIN));
    if (dx || dy) view.panBy(dx, dy);
  }

  function closeCallout() {
    if (selected < 0) return;
    markerEls[selected].classList.remove('is-selected');
    selected = -1;
    callout.hidden = true;
  }

  function hoverAt(at) {
    const index = at ? nearestPlace(at) : -1;
    viewport.classList.toggle('is-over-marker', index >= 0);
    if (index === hovered) return;
    if (hovered >= 0) markerEls[hovered].classList.remove('is-hovered');
    hovered = index;
    if (index < 0 || index === selected) return hideTip();
    markerEls[index].classList.add('is-hovered');
    tip.textContent = places[index].name;
    tip.hidden = false;
    positionPopover(tip, index, 14);
  }

  function hideTip() {
    tip.hidden = true;
    if (hovered >= 0) markerEls[hovered].classList.remove('is-hovered');
    hovered = -1;
  }

  function tapAt(target, at) {
    const index = nearestPlace(at);
    if (index >= 0) return openCallout(index);
    if (selected >= 0) return closeCallout();
    const shape = target.closest?.('.map-country');
    if (shape) focusCountry(shape.dataset.country);
  }

  function focusCountry(name) {
    const bounds = byName.has(name) && boundsOf(byName.get(name), projection);
    if (!bounds || name === focusedCountry) return;
    view.flyTo(view.fitView(bounds, { inset: insets(view), maxZoom: 24 }));
    setCrumb(name);
  }

  function setCrumb(name) {
    focusedCountry = name;
    crumb.hidden = !name;
    // Antarctica is its own continent, so de-duplicate rather than read "Antarctica · Antarctica".
    if (name) crumb.textContent = [...new Set([continentOf.get(name), name].filter(Boolean))].join(' · ');
  }

  let hintTimer = 0;
  function showHint() {
    hint.classList.add('is-on');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, 1400);
  }
  function hideHint() {
    clearTimeout(hintTimer);
    hint.classList.remove('is-on');
  }

  // Keyboard activation of a dot (pointer taps are handled by the view).
  mapEl.querySelector('.map-markers').addEventListener('click', (e) => {
    const marker = e.target.closest('.map-marker');
    if (marker && e.detail === 0) openCallout(Number(marker.dataset.place));
  });

  callout.addEventListener('click', (e) => {
    if (e.target.closest('.map-callout-close')) {
      const index = selected;
      closeCallout();
      markerEls[index]?.focus({ preventScroll: true });
    }
  });

  mapEl.querySelector('.map-controls').addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    setCrumb(null);
    if (action === 'in') view.zoomBy(2);
    else if (action === 'out') view.zoomBy(0.5);
    else view.flyTo(view.homeView());
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (selected >= 0) closeCallout();
    else if (mapEl.contains(document.activeElement) && !view.isHome()) {
      setCrumb(null);
      view.flyTo(view.homeView());
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (selected >= 0 && !mapEl.contains(e.target)) closeCallout();
  });

}
