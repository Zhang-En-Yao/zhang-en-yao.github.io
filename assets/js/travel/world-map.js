// The world map on the travel page: a draggable globe with a tinted country per country and
// a dot per place visited. Drag to spin it, pinch or ⌘/Ctrl + scroll to zoom; click a country
// to face it; click a dot for the trips that went there. Uses the global `d3` (d3-geo).
import { esc, plural } from '../shared/dom.js';
import { fmtRange } from '../shared/format.js';
import { tripDuration, tripHref, tripTitle } from '../shared/trips.js';
import { hasCoords } from '../shared/atlas.js';
import { MapView, easeInOutCubic } from './map-view.js';

const WIDTH = 960;
const PAD = 6;
const GLOBE_MARGIN = 110; // shrinks the globe within the card, so sky shows all the way around it, not just the corners
const MAX_ZOOM = 40;
const FOCUS_ZOOM = 6; // how far a clicked country zooms in, relative to the fitted globe
const SKY_SOFT = 8; // magnitudes past the limit where a star's radius stops growing linearly
const SKY_INSIDE_DIM = 0.5; // stars seen through the glass globe, rather than around it
const ROTATE_MS = 650; // duration of a "fly to" rotation (home, or a clicked country)
const HIT_RADIUS = 20; // px around a dot that still counts as clicking it
const EDGE_MARGIN = 48; // px a selected dot is kept away from the map's edges
const HALF_PI = Math.PI / 2; // a point past this great-circle distance from view centre is on the far side

const isApple = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform ?? navigator.platform);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const icon = (paths, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${paths}</svg>`;
const ICONS = {
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
  minus: icon('<path d="M5 12h14"/>'),
  home: icon('<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><circle cx="12" cy="12" r="2.5"/>'),
  close: icon('<path d="M18 6 6 18M6 6l12 12"/>'),
  chevron: icon('<path d="m9 6 6 6-6 6"/>', 'class="map-callout-chevron"'),
};

// The shortest way from one longitude to another, in degrees, wrapped to [-180, 180] — so
// flying from 170° to -170° turns 20° eastward instead of 340° the other way around.
function shortestTurn(from, to) {
  return (((to - from + 180) % 360) + 360) % 360 - 180;
}

// One place per city, however many trips went there (newest trip first). Screen position
// and near/far-hemisphere state are set later, per frame, by `redraw` — they depend on the
// live rotation, not anything fixed at load.
function placesOf(trips) {
  const places = [];
  trips.forEach((trip) => (trip.cities || []).filter(hasCoords).forEach((city) => {
    let place = places.find((p) => p.name === city.name
      && Math.abs(p.lon - city.lon) < 0.5 && Math.abs(p.lat - city.lat) < 0.5);
    if (!place) {
      place = { name: city.name, lon: city.lon, lat: city.lat, xy: [0, 0], front: true, country: trip.country, trips: [] };
      places.push(place);
    }
    if (!place.trips.includes(trip)) place.trips.push(trip);
  }));
  return places;
}

// `data` carries the atlas (countries), the trips, the continent lookup, the named waters
// and the star charts. `ghostCountries` — a coarser 1:110m atlas — is optional, falling
// back to `countries` itself if it didn't load, since the far hemisphere redraws every
// rotation frame and a tenth the vertices matters far more there than precision (it's
// never clicked, and always seen faintly through the glass). `loadDetail` is optional too:
// called once, the first time someone zooms past DETAIL_AT, to swap the front hemisphere's
// 1:50m coastlines for 1:10m.
export function renderWorldMap(mapEl, data) {
  const { countries, ghostCountries, trips, continentOf, marine, sky, loadDetail } = data;
  const land = { type: 'FeatureCollection', features: countries };
  const ghostFeatures = ghostCountries || countries;
  const height = WIDTH; // the globe is a circle inscribed in a square, so this never varies

  // Face the globe toward the spherical mean of every visited place (d3's own centroid,
  // fed a MultiPoint of every city, rather than a hand-rolled average).
  const placeCoords = trips.flatMap((t) => (t.cities || []).filter(hasCoords).map((c) => [c.lon, c.lat]));
  const homeCenter = placeCoords.length ? d3.geoCentroid({ type: 'MultiPoint', coordinates: placeCoords }) : [0, 0];
  const homeRotate = [-homeCenter[0], -homeCenter[1], 0];
  let rotate = homeRotate.slice();

  // `projection` (clipped to the near hemisphere) draws the crisp, interactive globe and
  // answers every bare point lookup (clipAngle only limits `d3.geoPath`, never a direct
  // call, so it still returns a correct position for a far-side point). `wideProjection`
  // shares the same rotation, scale and translate but is clipped just short of the full
  // sphere, so `d3.geoPath` draws far-side geometry too — faint, seen through the near
  // side. Both are mutated in place each frame (`.rotate(rotate)`) rather than rebuilt —
  // `fitExtent` below only has to run once, since zoom is a CSS transform on `.map-scene`,
  // never a change to the projection's own scale.
  //
  // The globe is fit to a smaller, inset box than the card itself (`box`, used below for
  // the sky's own reach) — leaving a ring of visible sky all the way around the globe,
  // not just in the four corners a circle-in-a-square would otherwise leave bare.
  const box = [[PAD, PAD], [WIDTH - PAD, WIDTH - PAD]];
  const globeBox = [[GLOBE_MARGIN, GLOBE_MARGIN], [WIDTH - GLOBE_MARGIN, WIDTH - GLOBE_MARGIN]];
  const projection = d3.geoOrthographic().rotate(rotate).clipAngle(90).fitExtent(globeBox, { type: 'Sphere' });
  const wideProjection = d3.geoOrthographic().rotate(rotate).clipAngle(179.9)
    .scale(projection.scale()).translate(projection.translate());
  const path = d3.geoPath(projection).digits(1);
  const wpath = d3.geoPath(wideProjection).digits(1);

  // The real sky lives outside the glass globe, the way a planet floats in space — which an
  // orthographic projection can never draw (every point on a sphere projects inside its own
  // unit circle, always: x²+y² ≤ 1). Stereographic has no such limit, so it's used for the
  // sky instead, scaled so its own horizon (90° from view centre) lands exactly on the
  // globe's edge — d3's raw stereographic radius is `r(θ) = k·tan(θ/2)` (not the "2k tan"
  // form some cartography texts use), so `k = globeRadius` alone already makes
  // `r(90°) = globeRadius` — then clipped just past the box's own corners, so the sky
  // reaches the edges of the card and no further.
  const globeRadius = projection.scale();
  const cornerReach = Math.hypot((WIDTH - 2 * PAD) / 2, (WIDTH - 2 * PAD) / 2);
  const skyScale = globeRadius;
  const skyClipAngle = Math.min(178, 2 * Math.atan(cornerReach / globeRadius) * (180 / Math.PI) + 3);
  const skyProjection = d3.geoStereographic().rotate(rotate).clipAngle(skyClipAngle)
    .scale(skyScale).translate(projection.translate());
  const skyPath = d3.geoPath(skyProjection).digits(1);

  const visited = new Set(trips.map((t) => t.country).filter(Boolean));
  const byName = new Map(land.features.map((f) => [f.properties.name, f]));
  visited.forEach((c) => {
    if (!byName.has(c)) console.warn(`travel: "${c}" is not a country name in the atlas, so it will not be tinted.`);
  });

  // Every builder below emits exactly one element per feature/star/line, even when it's
  // currently invisible (`path(f)` returns null on the far side, at load) — `redraw`
  // binds DOM elements to geometry by array index, so a feature quietly skipped here
  // would desync every binding after it, not just go missing itself.
  const countryShapes = (features, pathFn) => features
    .map((f) => {
      const name = f.properties.name;
      return `<path class="map-country${visited.has(name) ? ' is-visited' : ''}" d="${pathFn(f) || ''}" data-country="${esc(name)}"/>`;
    })
    .join('');

  // The far hemisphere, ghosted, seen through the glass globe — decorative only, so it
  // skips marine detail, interactivity, and any later coastline-detail upgrade.
  const ghostShapes = (features) => features
    .map((f) => `<path class="map-country-ghost${visited.has(f.properties.name) ? ' is-visited' : ''}" d="${wpath(f) || ''}"/>`)
    .join('');

  // Ocean polygons reach the map's outer edge, which would draw a globe-shaped outline.
  // The smaller named waters supply the internal boundaries we want instead.
  const waterFeatures = (marine?.areas ?? []).filter((f) => f.properties.type !== 'ocean');
  const waterShapes = (features) => features
    .map((f) => `<path class="map-marine map-marine-${esc(f.properties.type)}" d="${path(f) || ''}"/>`)
    .join('');

  // Where two countries' waters meet. Natural Earth draws these as indicators, not claims.
  const borderFeatures = marine?.borders ?? [];
  const borderShapes = (features) => features
    .map((f) => `<path class="map-marine-border" d="${path(f) || ''}"/>`)
    .join('');

  // The whole sky, drawn once: every constellation figure, and every star with its own
  // magnitude-scaled radius and brightness (star atlas convention — logarithmic past
  // SKY_SOFT, so the Sun's absurd magnitude doesn't draw a 15px disc).
  const starRadius = (mag, magMax) => {
    const over = Math.max(0, magMax - mag);
    return 0.5 + 0.45 * (over <= SKY_SOFT ? over : SKY_SOFT + Math.log1p(over - SKY_SOFT));
  };
  const skyHtml = () => {
    if (!sky) return '';
    const magMax = sky.magMax || 6;
    const figures = sky.lines
      .map((c) => `<path class="map-constellation" d="${skyPath({ type: 'MultiLineString', coordinates: c.paths }) || ''}"/>`)
      .join('');
    const stars = sky.stars
      .map(([ra, dec, mag]) => {
        const bright = Math.min(1, (magMax - mag) / magMax);
        const r = starRadius(mag, magMax);
        return `<circle class="map-star" data-ra="${ra}" data-dec="${dec}" r="${r.toFixed(2)}"`
          + ` data-opacity="${(0.3 + bright * 0.6).toFixed(2)}"/>`;
      })
      .join('');
    return `<g class="map-sky" aria-hidden="true">${figures}${stars}</g>`;
  };

  const markerHtml = (places) => places
    .map((p, i) => `
      <button class="map-marker" type="button" data-place="${i}"
              aria-label="${esc(p.name)}, ${plural(p.trips.length, 'trip')}"><span class="map-marker-dot"></span></button>`)
    .join('');

  const allPlaces = placesOf(trips);

  mapEl.style.setProperty('--map-aspect', `${WIDTH} / ${height}`);
  mapEl.innerHTML = `
    <div class="map-viewport" tabindex="0" role="application"
         aria-label="World map of the places listed below. Arrow keys rotate the globe; plus and minus zoom.">
      <svg class="map-svg" aria-hidden="true"><g class="map-scene">${skyHtml()}<path class="map-globe"/><g class="map-land-ghost">${ghostShapes(ghostFeatures)}</g><g class="map-marine-areas">${waterShapes(waterFeatures)}${borderShapes(borderFeatures)}</g><g class="map-land">${countryShapes(land.features, path)}</g></g></svg>
      <div class="map-markers">${markerHtml(allPlaces)}</div>
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
  const globeEl = mapEl.querySelector('.map-globe');
  const markerEls = [...mapEl.querySelectorAll('.map-marker')];
  const crumb = mapEl.querySelector('.map-crumb');
  const tip = mapEl.querySelector('.map-tip');
  const callout = mapEl.querySelector('.map-callout');
  const hint = mapEl.querySelector('.map-hint');
  const buttons = Object.fromEntries([...mapEl.querySelectorAll('[data-action]')].map((b) => [b.dataset.action, b]));

  // Bindings between rendered elements and the geometry that produced them, one element
  // per feature/star/line in the same order the html builders above emitted them, so
  // `redraw` can update `d`/`cx`/`cy` on every drag frame without ever touching innerHTML
  // (which, for ~5,000 stars, would be far too slow).
  const ghostLandEls = [...mapEl.querySelectorAll('.map-land-ghost path')].map((el, i) => ({ el, feature: ghostFeatures[i] }));
  const waterEls = [...mapEl.querySelectorAll('.map-marine')].map((el, i) => ({ el, feature: waterFeatures[i] }));
  const borderEls = [...mapEl.querySelectorAll('.map-marine-border')].map((el, i) => ({ el, feature: borderFeatures[i] }));
  const starEls = sky ? [...mapEl.querySelectorAll('.map-star')].map((el) => ({
    el, point: [+el.dataset.ra, +el.dataset.dec], opacity: +el.dataset.opacity,
  })) : [];
  const lineEls = sky ? [...mapEl.querySelectorAll('.map-constellation')].map((el, i) => ({ el, coords: sky.lines[i].paths })) : [];

  let frontFeatures = land.features;
  let frontLandEls = [...mapEl.querySelectorAll('.map-land path')].map((el, i) => ({ el, feature: frontFeatures[i] }));

  let selected = -1;
  let hovered = -1;
  let focusedCountry = null;
  let view; // assigned below, once `redraw` has run once to compute the home framing

  // Breathing room around a framed area, clear of the zoom controls on the right.
  const insets = (v) => {
    const pad = Math.min(40, v.w * 0.06);
    return { top: pad, bottom: pad, left: pad, right: pad + 44 };
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
      if (box) {
        box.innerHTML = countryShapes(features, path);
        frontFeatures = features;
        frontLandEls = [...box.querySelectorAll('path')].map((el, i) => ({ el, feature: frontFeatures[i] }));
        redraw(true);
      }
    } catch (err) {
      detail = false;
      console.warn('travel: could not load the detailed atlas', err);
    }
  }

  // Re-walking every country's coastline is, empirically, the expensive part of a redraw —
  // not the DOM writes (a few ms for ~240 paths) but `d3.geoPath` itself, and unevenly so:
  // Canada, Russia, the US and Indonesia's coastlines alone used to be nearly a third of
  // the cost, just from how many vertices they carry. The ghost hemisphere now draws from
  // a 1:110m atlas — a tenth the vertices of the front hemisphere's 1:50m, since it's
  // faint decoration seen through the glass and never clicked — so both redraw on the
  // same budget without ghost dragging front down the way it used to. A single discrete
  // action (a keypress, a click) still repaints immediately, since it will always be well
  // past LAND_THROTTLE_MS since the last update.
  const LAND_THROTTLE_MS = 50;
  let lastLandUpdate = 0;

  // Repaints every rotation-dependent thing in place: the globe's own silhouette, land
  // (both hemispheres), marine detail, the sky, and every marker's position and
  // near/far-hemisphere state. Called on every drag frame, every step of a "fly to"
  // rotation, and once up front to establish the initial view. `force` bypasses the land
  // throttle, for moments (an animation's last frame, a detail-atlas swap) where a stale
  // coastline would be visible rather than just a dropped mid-motion frame.
  function redraw(force = false) {
    projection.rotate(rotate);
    wideProjection.rotate(rotate);
    skyProjection.rotate(rotate);
    const center = [-rotate[0], -rotate[1]]; // the geographic point currently facing the viewer

    const now = performance.now();
    if (force || now - lastLandUpdate > LAND_THROTTLE_MS) {
      lastLandUpdate = now;
      globeEl.setAttribute('d', path({ type: 'Sphere' }) || '');
      frontLandEls.forEach(({ el, feature }) => el.setAttribute('d', path(feature) || ''));
      waterEls.forEach(({ el, feature }) => el.setAttribute('d', path(feature) || ''));
      borderEls.forEach(({ el, feature }) => el.setAttribute('d', path(feature) || ''));
      ghostLandEls.forEach(({ el, feature }) => el.setAttribute('d', wpath(feature) || ''));
    }

    if (sky) {
      const [cx, cy] = projection.translate();
      const limit = (skyClipAngle - 2) * (Math.PI / 180);
      lineEls.forEach(({ el, coords }) => el.setAttribute('d', skyPath({ type: 'MultiLineString', coordinates: coords }) || ''));
      starEls.forEach(({ el, point, opacity }) => {
        if (d3.geoDistance(point, center) > limit) { el.setAttribute('opacity', 0); return; }
        const p = skyProjection(point);
        if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) { el.setAttribute('opacity', 0); return; }
        const inside = Math.hypot(p[0] - cx, p[1] - cy) <= globeRadius;
        el.setAttribute('cx', p[0].toFixed(1));
        el.setAttribute('cy', p[1].toFixed(1));
        el.setAttribute('opacity', (opacity * (inside ? SKY_INSIDE_DIM : 1)).toFixed(2));
      });
    }

    allPlaces.forEach((p) => {
      p.xy = projection([p.lon, p.lat]) || p.xy;
      p.front = d3.geoDistance([p.lon, p.lat], center) <= HALF_PI;
    });
    markerEls.forEach((el, i) => {
      const front = allPlaces[i].front;
      el.classList.toggle('is-back', !front);
      el.tabIndex = front ? 0 : -1;
    });

    // `view` doesn't exist yet the very first time `redraw` runs (see below) — the
    // `MapView` constructor triggers its own initial `update` once it's built.
    if (view) update(view.view);
  }

  // Called for every frame the CSS pan/zoom view changes (and once while `view` is still
  // being constructed) — separate from `redraw`, which handles rotation. Both end here,
  // since a marker's screen position always depends on both.
  function update({ s, x, y }, v = view) {
    scene.setAttribute('transform', `translate(${x.toFixed(2)},${y.toFixed(2)}) scale(${s.toFixed(5)})`);
    allPlaces.forEach((p, i) => {
      markerEls[i].style.transform = `translate3d(${(p.xy[0] * s + x).toFixed(1)}px, ${(p.xy[1] * s + y).toFixed(1)}px, 0)`;
    });
    if (selected >= 0) positionPopover(callout, selected, 18);
    if (hovered >= 0) positionPopover(tip, hovered, 14);
    buttons.in.disabled = s >= v.maxScale * 0.999;
    buttons.out.disabled = s <= v.minScale * 1.001;
    buttons.home.disabled = v.isHome() && Math.abs(shortestTurn(rotate[0], homeRotate[0])) < 0.5 && Math.abs(rotate[1] - homeRotate[1]) < 0.5;
    if (s >= v.minScale * DETAIL_AT) upgradeDetail();
  }

  redraw(true); // establish xy/front for every place before computing the home framing below

  // Every place lives on the globe's own surface, so its content-space position is always
  // within `globeRadius` of centre — fitting "home" to the globe's bounding box therefore
  // always shows at least as much as fitting to the visited places would, and never
  // crops tighter than the whole globe, keeping the sky margin around it visible by
  // default rather than auto-zooming past it into a tight cluster of trips.
  const [globeCx, globeCy] = projection.translate();
  const homeBounds = [[globeCx - globeRadius, globeCy - globeRadius], [globeCx + globeRadius, globeCy + globeRadius]];

  view = new MapView(viewport, {
    width: WIDTH,
    height,
    maxZoom: MAX_ZOOM,
    home: (v) => v.fitView(homeBounds, { inset: insets(v), maxZoom: 8 }),
    onDrag: rotateBy,
    onChange: update,
    onTap: tapAt,
    onHover: hoverAt,
    onGesture: () => { setCrumb(null); hideHint(); },
    onScrollHint: showHint,
  });

  // A drag turns the globe as if the surface under the pointer were being pushed: `k`
  // converts a screen-pixel delta into a rotation delta (the small-angle approximation
  // arc ≈ chord/radius is the standard, widely-used technique for this — a literal
  // grab-a-point drag needs solving the full rotation and isn't worth it here). Latitude
  // is clamped to the poles; longitude wraps freely, like spinning a desk globe.
  function rotateBy(dx, dy) {
    const k = (180 / Math.PI) / projection.scale();
    rotate = [rotate[0] + dx * k, Math.max(-90, Math.min(90, rotate[1] - dy * k)), 0];
    redraw();
  }

  // Animates `rotate` toward `target`, the short way around in longitude.
  let rotateRaf = 0;
  function flyRotateTo(target) {
    cancelAnimationFrame(rotateRaf);
    const from = rotate.slice();
    const to = [from[0] + shortestTurn(from[0], target[0]), target[1], 0];
    if (reduceMotion.matches) { rotate = to; redraw(true); return; }
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / ROTATE_MS);
      const e = easeInOutCubic(t);
      rotate = [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e, 0];
      redraw(t >= 1); // force the last frame, so the rest position always shows crisp land
      if (t < 1) rotateRaf = requestAnimationFrame(step);
    };
    rotateRaf = requestAnimationFrame(step);
  }

  function goHome() {
    setCrumb(null);
    flyRotateTo(homeRotate);
    view.flyTo(view.homeView());
  }

  function nearestPlace(at) {
    let best = -1;
    let bestDistance = HIT_RADIUS;
    allPlaces.forEach((p, i) => {
      if (!p.front) return;
      const [px, py] = view.toScreen(p.xy);
      const d = Math.hypot(px - at[0], py - at[1]);
      if (d < bestDistance) { bestDistance = d; best = i; }
    });
    return best;
  }

  // Above the dot when there is room, below it otherwise; kept inside the card horizontally.
  function positionPopover(el, index, gap) {
    const [px, py] = view.toScreen(allPlaces[index].xy);
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
    if (!allPlaces[index].front) return;
    if (selected === index) return closeCallout();
    closeCallout();
    void callout.offsetWidth; // Restart the pop-in animation.
    selected = index;
    const place = allPlaces[index];
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

    // Bring a dot near the edge into view: a direct CSS-view shift, not `view.panBy` —
    // that now rotates the globe (see `onDrag` above), which isn't what "make room for
    // the callout" means here.
    const [px, py] = view.toScreen(place.xy);
    const dx = Math.max(0, EDGE_MARGIN - px) - Math.max(0, px - (view.w - EDGE_MARGIN));
    const dy = Math.max(0, EDGE_MARGIN - py) - Math.max(0, py - (view.h - EDGE_MARGIN));
    if (dx || dy) view.flyTo({ ...view.view, x: view.view.x + dx, y: view.view.y + dy });
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
    tip.textContent = allPlaces[index].name;
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

  // Rotates the globe to face the country, and zooms in a fixed amount — zoom no longer
  // tracks a feature's own bounds (there's nothing to fit a box to once "where you're
  // looking" is a rotation, not a pan), just a pleasant fixed level.
  function focusCountry(name) {
    const feature = byName.get(name);
    if (!feature || name === focusedCountry) return;
    const [lon, lat] = d3.geoCentroid(feature);
    flyRotateTo([-lon, -lat, 0]);
    // The country lands at `projection.translate()` (content space) once rotated to face
    // it; centre that content point on the viewport's own screen centre, same as `zoomBy`.
    const [px, py] = projection.translate();
    const s = view.clampScale(view.minScale * FOCUS_ZOOM);
    view.flyTo({ s, x: view.w / 2 - px * s, y: view.h / 2 - py * s });
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
    if (action === 'in') { setCrumb(null); view.zoomBy(2); }
    else if (action === 'out') { setCrumb(null); view.zoomBy(0.5); }
    else goHome();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (selected >= 0) closeCallout();
    else if (mapEl.contains(document.activeElement) && !buttons.home.disabled) goHome();
  });

  document.addEventListener('pointerdown', (e) => {
    if (selected >= 0 && !mapEl.contains(e.target)) closeCallout();
  });

}
