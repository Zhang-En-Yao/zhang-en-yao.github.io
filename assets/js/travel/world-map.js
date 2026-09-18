// The world map on the travel page: a draggable globe with a tinted country per country and
// a dot per place visited. Drag to spin it, pinch or ⌘/Ctrl + scroll to zoom; click a country
// to face it; click a dot for the trips that went there. Uses the global `d3` (d3-geo).
import { esc, plural } from '../shared/dom.js';
import { fmtRange } from '../shared/format.js';
import { tripDuration, tripHref, tripTitle } from '../shared/trips.js';
import { hasCoords, polygonsOf } from '../shared/atlas.js';
import { MapView, easeInOutCubic } from './map-view.js';
import {
  galileanMoons, gmstDegrees, jupiterRotation, moonEquatorial, moonPhase, MOON_RADIUS_KM,
  PLANET_NAMES, planetEquatorial, positionAngle, saturnRings, sunEquatorial,
  sunPhysicalEphemeris, SUN_RADIUS_KM,
} from './astro.js';

const WIDTH = 960;
const PAD = 6;
const GLOBE_MARGIN = 110; // shrinks the globe within the card, so sky shows all the way around it, not just the corners
const FOCUS_MAX_ZOOM = 20; // a clicked country's fitted zoom is capped here, relative to the fitted globe
const SKY_SOFT = 8; // magnitudes past the limit where a star's radius stops growing linearly
const SKY_INSIDE_DIM = 0.3; // stars seen through the glass globe, rather than around it
// Nothing in the sky is enlarged. Every body goes through the same projection as the stars and
// the coastlines, at the angular size it really had — so the sun and the moon come out a little
// over half a degree wide, the planets a few tens of arcseconds, and at the default view all of
// them are under a pixel. That is not a failure of the drawing; it is what half a degree is
// against a whole sky. Zoom in and they resolve, in the order a telescope resolves them: the
// moon and the sun first, into discs that carry their craters and their spots, then Jupiter and
// Venus, and never Neptune. The one thing the true scale buys that no magnification could is
// that every ratio in the picture is now a fact — the moon 3% wider than the sun, Jupiter's
// moons strung eight times the planet's own width across the sky, the moon's 22° halo eighty
// times the moon.

// The sky is frozen to this one real moment — Sept 9, 1994, 16:50 Taipei time — rather than
// live "now": the star field's orientation, and the moon's own position and phase, are all
// computed for it once, below, and never move on their own. Dragging the globe still spins
// this fixed sky along with the geography, the same as ever; it just now starts out true.
const SKY_MOMENT = new Date('1994-09-09T08:50:00Z');
const SKY_GMST = gmstDegrees(SKY_MOMENT); // Greenwich sidereal time, in degrees, at that moment
const REAL_MOON = moonEquatorial(SKY_MOMENT);
const REAL_MOON_PHASE = moonPhase(SKY_MOMENT);
const REAL_SUN = sunEquatorial(SKY_MOMENT);
// How the sun's own globe was turned toward Earth that morning: the tilt of its axis on the
// sky, how far its equator was tipped toward us, and which Carrington longitude faced us.
// Between them they decide where on the drawn disc a sunspot of a given latitude and longitude
// belongs — see `sunPhysicalEphemeris`.
const SUN_AXIS = sunPhysicalEphemeris(SKY_MOMENT);
// Every planet's apparent place, size and phase that morning, worked out once and keyed by name.
const REAL_PLANETS = Object.fromEntries(
  PLANET_NAMES.map((name) => [name, planetEquatorial(name, SKY_MOMENT)]),
);
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

// `data` carries the atlas (countries), the trips and the continent lookup — required, and
// already resolved by the time this is called. Everything else is purely decorative and
// optional, and arrives as a Promise still in flight rather than a resolved value:
// `ghostCountries` (a coarser 1:110m atlas for the far hemisphere), `marine` (named waters
// and their borders), `sky` (the star atlas), `moonFeatures` (real lunar craters/maria) and
// `sunFeatures` (the sunspots measured on the morning the sky is frozen to).
// None of the four gate the first paint — the globe renders immediately without them, and
// each hydrates its own slice of the already-live scene the moment it resolves, in place,
// without a re-render — the same way `loadDetail` (also called lazily, on demand rather
// than up front) later upgrades the front hemisphere's coastline once someone zooms in far
// enough to need it. A slow or failing decorative fetch this way never holds up the trip
// list or a working globe from appearing.
export function renderWorldMap(mapEl, data) {
  const { countries, ghostCountries, trips, continentOf, marine, sky, moonFeatures, sunFeatures, loadDetail } = data;
  const land = { type: 'FeatureCollection', features: countries };
  let ghostFeatures = countries; // upgraded to the coarser atlas once `ghostCountries` resolves
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

  // How big a body of a given angular radius draws in this projection: stereographic puts a
  // point θ from the centre of view at `scale·tan(θ/2)`, and that is the whole of it. No factor,
  // no floor, no special case — the same function the star field and the graticule go through.
  const skyDiscRadius = (semidiameterDeg) => skyScale * Math.tan(semidiameterDeg * (Math.PI / 360));

  // A halo behind every body the map draws individually — the sun, the moon, the seven planets
  // and Jupiter's four moons — covering `GLOW_AREA` times the area of the body inside it. Area
  // rather than radius, so a halo stays in proportion to the thing it marks instead of swamping
  // the small ones; the radius it works out to is the square root of it. This is the one thing
  // in the sky not drawn to a real size, and it is not pretending to be: it is a marker, the way
  // a star atlas rings what is worth looking at, and everything inside it is still the size it
  // really was.
  //
  // Two tones. The sun, which is the light here, keeps the page's accent; everything the sun
  // lights takes the pale one. Two whole gradients rather than one with a swappable colour,
  // because a custom property is inherited down the document and does not travel through the
  // `url(...)` that points at a gradient — a single shared copy would see no colour at all.
  const GLOW_AREA = 1000;
  const GLOW_SCALE = Math.sqrt(GLOW_AREA);
  const GLOW_STOPS = [[0, 0.5], [20, 0.45], [42, 0.22], [68, 0.08], [100, 0]];
  const glowHtml = (radius, { warm = false, cx = 0, cy = 0 } = {}) =>
    `<circle class="map-body-glow${warm ? ' is-warm' : ''}" r="${len(radius * GLOW_SCALE)}"`
    + (cx || cy ? ` cx="${len(cx)}" cy="${len(cy)}"` : '') + '/>';
  const glowDefs = () => `
    <defs>
      ${['pale', 'warm'].map((tone) => `
      <radialGradient id="map-body-glow-${tone}" cx="50%" cy="50%" r="50%">
        ${GLOW_STOPS.map(([offset, opacity]) =>
          `<stop offset="${offset}%" class="map-body-glow-${tone}-stop" stop-opacity="${opacity}"/>`).join('')}
      </radialGradient>`).join('')}
    </defs>`;

  // Every length drawn on a body in the sky goes out through this. At true angular size those
  // run from the moon's 22° halo, seventy units across, down to Neptune's thousandth of one, and
  // a fixed number of decimal places cannot serve both ends: rounded to three, Mercury's disc
  // comes out a fifth too narrow and Neptune's vanishes. Significant figures hold the proportion
  // at any size, which — now that nothing is magnified — is the only thing keeping the sky true.
  const len = (value) => value.toPrecision(6);
  const MOON_RADIUS = skyDiscRadius(REAL_MOON.semidiameter);
  const SUN_RADIUS = skyDiscRadius(REAL_SUN.semidiameter);

  // Both the star field and the moon are plotted in right-ascension/declination — coordinates
  // fixed to the celestial sphere, not to the Earth turning underneath it. Treating RA directly
  // as a longitude (as `rotate` expects) would only be correct at the instant Greenwich sidereal
  // time hits zero; at any other moment the sky has visibly turned relative to the ground. The
  // fix is the standard one: a star's sub-stellar point (where it's directly overhead) sits at
  // geographic longitude (RA − GST), latitude Dec — so shifting every RA by −`SKY_GMST` converts
  // the catalog into "where on Earth each star was overhead at `SKY_MOMENT`," which is exactly
  // the frame `rotate` already works in.
  const toSkyLon = (raDeg) => (((raDeg - SKY_GMST) % 360) + 540) % 360 - 180;
  const moonPoint = [toSkyLon(REAL_MOON.ra), REAL_MOON.dec];
  const sunPoint = [toSkyLon(REAL_SUN.ra), REAL_SUN.dec];

  // A real 22° halo — moonlight refracted by hexagonal ice crystals in high cirrus cloud —
  // traced as an actual small circle on the celestial sphere around `moonPoint`, at its true
  // angular radius: about 81× the moon's own, so against the moon's true disc
  // it would swallow a huge stretch of the sky, while against the sky's own real field of view
  // it is unremarkable. So it is plotted in the same real RA/Dec frame as the stars rather
  // than scaled off the moon's disc — the one thing around the moon drawn life size. Built
  // once, since `moonPoint` never moves — only the view rotates under it.
  function destinationPoint([lon, lat], bearingDeg, distDeg) {
    const rad = Math.PI / 180;
    const phi1 = lat * rad;
    const lambda1 = lon * rad;
    const theta = bearingDeg * rad;
    const delta = distDeg * rad;
    const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
    const lambda2 = lambda1 + Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );
    return [((lambda2 / rad + 540) % 360) - 180, phi2 / rad];
  }
  const HALO_ANGLE = 22; // degrees — the classic ice-crystal halo radius
  const HALO_POINTS = 48;
  const moonHaloRing = Array.from({ length: HALO_POINTS + 1 },
    (_, i) => destinationPoint(moonPoint, (i % HALO_POINTS) * (360 / HALO_POINTS), HALO_ANGLE));
  const HALO_BASE_OPACITY = 0.15 + 0.35 * REAL_MOON_PHASE.illuminatedFraction; // fainter around a thin crescent, more moonlight to refract near full

  // Turns a position angle into a drawing frame. A position angle is measured at the body,
  // starting from the direction of celestial north and turning toward celestial east — but
  // neither of those is simply "up" and "left" here: the whole sky turns as the globe is
  // dragged, and this projection looks at the celestial sphere from the outside, which flips its
  // handedness. So both are read off the live projection, by stepping a little north and a
  // little east of the body and seeing which way that moved on screen. Stereographic projection
  // is conformal, so the two come back exactly perpendicular, and the matrix built from them is
  // a plain rotation (mirrored, in this view) with no scaling. `axisAngle` is whichever
  // direction should end up pointing "up" on the drawn face: the sun's rotation axis, Jupiter's,
  // the pole of Saturn's ring plane, or — for a planet showing a phase — a quarter turn from the
  // sun, which puts the lit edge on +x and the night side opposite it. Position angles run north
  // → east → south → west, so the +x axis is a quarter turn back from the one asked for.
  const AXIS_STEP = 0.5; // degrees: far enough to be numerically stable, near enough to be local
  function faceTransform(skyPoint, [sx, sy], axisAngle) {
    const unit = (point) => {
      const q = skyProjection(point);
      if (!q || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) return null;
      const [dx, dy] = [q[0] - sx, q[1] - sy];
      const len = Math.hypot(dx, dy);
      return len > 1e-6 ? [dx / len, dy / len] : null;
    };
    const north = unit([skyPoint[0], skyPoint[1] + AXIS_STEP]);
    const east = unit([skyPoint[0] + AXIS_STEP / Math.cos(skyPoint[1] * (Math.PI / 180)), skyPoint[1]]);
    if (!north || !east) return ''; // right at the clip edge, where a step off the body leaves the sky
    const towards = (angleDeg) => {
      const a = angleDeg * (Math.PI / 180);
      return [north[0] * Math.cos(a) + east[0] * Math.sin(a), north[1] * Math.cos(a) + east[1] * Math.sin(a)];
    };
    const [ux, uy] = towards(axisAngle);
    const [rx, ry] = towards(axisAngle - 90);
    return `matrix(${rx.toFixed(4)},${ry.toFixed(4)},${(-ux).toFixed(4)},${(-uy).toFixed(4)},0,0)`;
  }

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
  // The smaller named waters supply the internal boundaries we want instead. Both start
  // empty and are filled in once `marine` resolves — see the hydration block below.
  let waterFeatures = [];
  let borderFeatures = []; // where two countries' waters meet; Natural Earth draws these as indicators, not claims
  const waterShapes = (features) => features
    .map((f) => `<path class="map-marine map-marine-${esc(f.properties.type)}" d="${path(f) || ''}"/>`)
    .join('');
  const borderShapes = (features) => features
    .map((f) => `<path class="map-marine-border" d="${path(f) || ''}"/>`)
    .join('');

  // Every constellation figure, and every star with its own magnitude-scaled radius and
  // brightness (star atlas convention — logarithmic past SKY_SOFT, so the Sun's absurd
  // magnitude doesn't draw a 15px disc) — built once `sky` resolves (see the hydration
  // block below), from a payload of raw RA/Dec, not the ground-fixed longitude `toSkyLon`
  // converts it to for `redraw`.
  const starRadius = (mag, magMax) => {
    const over = Math.max(0, magMax - mag);
    return 0.7 + 0.5 * (over <= SKY_SOFT ? over : SKY_SOFT + Math.log1p(over - SKY_SOFT));
  };
  function skyContent(skyData) {
    const magMax = skyData.magMax || 6;
    const lines = skyData.lines.map((c) => ({
      ...c,
      paths: c.paths.map((line) => line.map(([ra, dec]) => [toSkyLon(ra), dec])),
    }));
    const stars = skyData.stars.map(([ra, dec, mag]) => [toSkyLon(ra), dec, mag]);
    const figures = lines
      .map((c) => `<path class="map-constellation" d="${skyPath({ type: 'MultiLineString', coordinates: c.paths }) || ''}"/>`)
      .join('');
    const starMarkup = stars
      .map(([ra, dec, mag]) => {
        const bright = Math.min(1, (magMax - mag) / magMax);
        const r = starRadius(mag, magMax);
        return `<circle class="map-star" data-ra="${ra}" data-dec="${dec}" r="${r.toFixed(2)}"`
          + ` data-opacity="${(0.45 + bright * 0.55).toFixed(2)}"/>`;
      })
      .join('');
    return { html: figures + starMarkup, lines };
  }

  // Drawn independently of `sky` (it needs no star-atlas data): a single moon at a fixed
  // point in the same sky frame as the stars, so it drifts and dims behind the glass globe
  // exactly as they do. `MOON_RADIUS` comes from its real angular size that night — it was
  // near perigee, so it is drawn a few percent wider than an average moon, and wider than the
  // sun beside it. Lit on the right for waxing, left for waning — the usual northern-hemisphere
  // convention — clipped to `REAL_MOON_PHASE`'s true illuminated fraction, over a faint
  // always-visible outline of the full disc (so a thin crescent still reads as "a circle,
  // mostly dark" rather than a stray sliver).
  //
  // `moonFeatures` (optional — the moon still draws fine without it, just as a bare phase —
  // and, being a Promise, isn't resolved yet at this point; see the hydration block below)
  // is every IAU-named near-side crater and "sea" (mare/oceanus/lacus/palus/sinus, all the
  // dark-plain types) from the USGS Gazetteer of Planetary Nomenclature's official dataset:
  // real selenographic centre and diameter, not invented. Every crater is included; only ones
  // under `CRATER_MIN_FRACTION` of the moon's own width end up not drawn below, which keeps the
  // level of detail the same whatever the moon is drawn at rather than emptying the disc when
  // it is small — the underlying data isn't filtered either way.
  const CRATER_MIN_FRACTION = 0.0133; // of the moon's own radius: below this a crater isn't drawn at all
  const CRATER_PROMINENT_KM = 150; // real diameter above which a crater gets the shadow+highlight treatment, not a flat dot
  // Orthographic near-side projection assuming zero libration (the Moon shows Earth its exact
  // mean face) and no position-angle rotation — simplified, but every position and size below
  // is real. `foreshorten` (the view-direction component of the surface normal) both places
  // the feature and shrinks it the way foreshortening really would toward the limb.
  function featureToDisc([lat, lon, km], moonRadius) {
    const rad = Math.PI / 180;
    const foreshorten = Math.cos(lat * rad) * Math.cos(lon * rad);
    const x = Math.cos(lat * rad) * Math.sin(lon * rad) * moonRadius;
    const y = -Math.sin(lat * rad) * moonRadius;
    const angularRadius = Math.asin(Math.min(0.98, (km / 2) / MOON_RADIUS_KM));
    const r = moonRadius * Math.sin(angularRadius) * Math.max(0.2, foreshorten);
    return { x, y, r };
  }
  // The illuminated region's outline: the limb (the true circle, lit side) on one edge and the
  // terminator (an ellipse whose horizontal radius shrinks to 0 at half-lit, then grows again
  // curving the other way past it) on the other — the standard construction for a phase icon.
  function moonPhasePath(r, illuminatedFraction) {
    const termRx = r * (1 - 2 * illuminatedFraction); // signed: >0 crescent-side, <0 gibbous-side
    const termSweep = termRx < 0 ? 1 : 0;
    return `M 0 ${len(-r)} A ${len(r)} ${len(r)} 0 0 1 0 ${len(r)}`
      + ` A ${len(Math.abs(termRx))} ${len(r)} 0 0 ${termSweep} 0 ${len(-r)} Z`;
  }
  // Built once `moonFeatures` resolves (see the hydration block below) and dropped into
  // the otherwise-empty `.map-moon-surface` group below.
  function moonSurfaceHtml(mf, moonRadius) {
    const craters = (mf.craters ?? [])
      .map((f) => ({ ...featureToDisc(f, moonRadius), km: f[2] }))
      .filter(({ r }) => r >= moonRadius * CRATER_MIN_FRACTION)
      .map(({ x, y, r, km }) => {
        if (km < CRATER_PROMINENT_KM) return `<circle class="map-moon-crater-shadow" cx="${len(x)}" cy="${len(y)}" r="${len(r)}"/>`;
        const [lx, ly, lr] = [x - r * 0.3, y - r * 0.3, r * 0.55];
        return `<circle class="map-moon-crater-shadow" cx="${len(x)}" cy="${len(y)}" r="${len(r)}"/>`
          + `<circle class="map-moon-crater-light" cx="${len(lx)}" cy="${len(ly)}" r="${len(lr)}"/>`;
      })
      .join('');
    const maria = (mf.seas ?? [])
      .map((f) => {
        const { x, y, r } = featureToDisc(f, moonRadius);
        return `<circle class="map-moon-mare" cx="${len(x)}" cy="${len(y)}" r="${len(r)}"/>`;
      })
      .join('');
    return maria + craters;
  }
  const moonHtml = () => {
    const moonRadius = MOON_RADIUS;
    // The lit and dark regions are complementary phase shapes (illuminated fraction k, and
    // 1−k mirrored to the other side) — rather than clip the surface texture to just the lit
    // one (which left the dark majority, at this date's 15%-lit crescent, a featureless blank),
    // the craters and maria are drawn once across the whole disc and a dim overlay darkens
    // only the night side, the way earthshine leaves it faintly visible rather than blank.
    const k = REAL_MOON_PHASE.illuminatedFraction;
    const darkTransform = REAL_MOON_PHASE.waxing ? ' transform="scale(-1,1)"' : '';
    return `
      <defs>
        <radialGradient id="map-moon-shade" cx="32%" cy="30%" r="75%">
          <stop offset="0%" class="map-moon-grad-hi"/>
          <stop offset="55%" class="map-moon-grad-mid"/>
          <stop offset="100%" class="map-moon-grad-lo"/>
        </radialGradient>
        <clipPath id="map-moon-clip"><circle r="${len(moonRadius)}"/></clipPath>
      </defs>
      <g class="map-moon" aria-hidden="true">
        ${glowHtml(moonRadius)}
        <g clip-path="url(#map-moon-clip)">
          <circle class="map-moon-disc" r="${len(moonRadius)}"/>
          <g class="map-moon-surface"></g>
          <circle class="map-moon-shade" r="${len(moonRadius)}"/>
          <path class="map-moon-nightside" d="${moonPhasePath(moonRadius, 1 - k)}"${darkTransform}/>
        </g>
      </g>`;
  };

  // A single decorative sun, fixed in the sky at its true position for `SKY_MOMENT` — plotted
  // the same way as the moon (RA/Dec, dimmed the same way when seen through the glass globe),
  // but with no phase to model, since as the light source it always shows its full lit disc.
  //
  // Unlike the moon, whose craters are permanent, the sun has a different face every day — so
  // everything drawn on it is either a measurement from that particular day or a physical law:
  //   · the sunspots are the 33 spots the Debrecen observatory measured on a white-light plate
  //     taken at 06:05 UT that morning (`assets/data/sun-features.json`) — a heliographic
  //     latitude, a Carrington longitude and umbra/whole-spot areas for each, turned to where
  //     they stood at 08:50 by `SUN_AXIS`, rather than left where the plate caught them;
  //   · the disc's brightness profile is the measured limb-darkening law, not a stylized
  //     highlight: the sun is its own light source, so it darkens symmetrically toward its
  //     edge, where the line of sight skims out through higher, cooler photosphere;
  //   · faculae brighten toward the limb the way real ones do, rather than uniformly;
  //   · the corona follows the Baumbach–Allen density profile outward, and its streamer belt is
  //     as wide as the heliospheric current sheet really was that rotation, with helmet
  //     streamers standing over that day's own active longitudes.
  // Granulation is the one thing with no true positions to plot — convection cells that live
  // about ten minutes each and never repeat — so `feTurbulence` stands in, at their real size.
  const RAD = Math.PI / 180;
  const GRANULE_KM = 1000; // a convection cell, about 1 Mm across and gone in ten minutes
  const SUPERGRANULE_KM = 30000; // the network of ~30 Mm flows the cells are organised into
  const LIMB_DARKENING_U = 0.65; // linear coefficient, as measured on SDO/HMI's 617.3 nm disc
  const PLUME_KM = 25000; // a polar plume is a few tens of Mm wide at its base
  const SPOT_FLOOR = SUN_RADIUS * 0.005; // a real pore is far smaller than a pixel here, but not nothing
  const PLAGE_PAD = 4; // degrees — plage spills this much past the spots it surrounds
  const FACULA_PEAK = 0.4; // how bright a facular patch gets at its best angle, against the disc
  const CORONA_REACH = 3; // solar radii, roughly as far as an eclipse photograph carries

  // Heliographic latitude and Carrington longitude → a position on the drawn disc, in units of
  // the solar radius, in the frame `.map-sun-face` puts on screen (solar north up, west right).
  // `mu` is the cosine of the angle between the surface normal and the line of sight: 1 at the
  // centre of the disc, 0 at the limb, negative round the far side. Limb darkening, facular
  // contrast and foreshortening are all functions of it, so every feature below is built on it.
  function helioToDisc(latDeg, lonDeg) {
    const b = latDeg * RAD;
    const cmd = (lonDeg - SUN_AXIS.l0) * RAD; // how far round from the central meridian
    const b0 = SUN_AXIS.b0 * RAD; // how far the sun's equator is tipped toward us
    return {
      x: Math.cos(b) * Math.sin(cmd),
      y: -(Math.sin(b) * Math.cos(b0) - Math.cos(b) * Math.cos(cmd) * Math.sin(b0)),
      mu: Math.sin(b) * Math.sin(b0) + Math.cos(b) * Math.cos(cmd) * Math.cos(b0),
    };
  }

  // Areas arrive as millionths of the solar hemisphere, which is the unit every sunspot
  // catalogue since Greenwich has counted in. A spot of `area` millionths is a cap of area
  // 2πR²·area/10⁶, so it has a true radius of R·√(2·area/10⁶) — a tenth of a percent of the
  // disc for a pore, a couple of percent for the big one that crossed the meridian that day.
  const spotRadius = (area) => SUN_RADIUS * Math.sqrt(2 * Math.max(area, 0) / 1e6);

  // Every feature on the photosphere is a circular patch on a sphere, so it draws as an ellipse:
  // its full width across the line back to the centre of the disc, squashed by μ along it. The
  // rotation to that radial direction is what makes spots near the limb look properly flattened
  // into slivers rather than merely small.
  function patch(cls, { x, y, mu }, r, extra = '') {
    const cx = x * SUN_RADIUS;
    const cy = y * SUN_RADIUS;
    const angle = Math.atan2(cy, cx) / RAD;
    return `<ellipse class="${cls}" rx="${len(r * mu)}" ry="${len(r)}"${extra}`
      + ` transform="translate(${len(cx)},${len(cy)}) rotate(${angle.toFixed(1)})"/>`;
  }

  // I(μ)/I(centre) = 1 − u(1 − μ), the standard linear limb-darkening law, with u = 0.65 as
  // measured on SDO/HMI's images: the limb comes out around 35% as bright as the centre, which
  // is what a white-light photograph of the sun actually shows. It is drawn as a darkening
  // overlay rather than baked into the disc's fill, so the colour itself stays with the
  // stylesheet and only the profile comes from here. That veil is not pure black — the limb is
  // genuinely redder than disc centre, so `.map-sun-limb-stop` keeps `LIMB_TINT` of the disc's
  // own colour in it — and a tinted veil darkens by less than its own opacity, so each stop is
  // divided back up by how much of the veil is actually dark. Without that the drawn profile
  // would be the right shape at the wrong depth. The sampling crowds toward the edge, where the
  // law bends sharply; evenly spaced stops flatten the last tenth of the radius, which is the
  // part the eye reads as roundness.
  const LIMB_TINT = 0.3; // must match the `--accent` share in `.map-sun-limb-stop`
  const LIMB_SAMPLES = [0, 0.3, 0.5, 0.65, 0.78, 0.86, 0.92, 0.96, 0.985, 1];
  const limbStops = LIMB_SAMPLES.map((rho) => {
    const mu = Math.sqrt(Math.max(0, 1 - rho * rho));
    const veil = LIMB_DARKENING_U * (1 - mu) / (1 - LIMB_TINT);
    return `<stop offset="${(rho * 100).toFixed(1)}%" class="map-sun-limb-stop"`
      + ` stop-opacity="${Math.min(1, veil).toFixed(3)}"/>`;
  }).join('');

  // Baumbach and Allen's fit to eclipse photometry: the corona's electron density runs
  // n(ρ) = 10⁸(0.036ρ^−1.5 + 1.55ρ^−6 + 2.99ρ^−16) cm⁻³ at ρ solar radii, three regimes
  // summed — a steep inner one, a middle one, and the shallow tail that still scatters light
  // several radii out. Scattered brightness tracks that density, so the gradient's stops are
  // the profile itself. Raw, it spans four orders of magnitude and would render as a hairline
  // rim and nothing else; the square root is the same compression an eclipse photographer's
  // radial gradient filter applies to fit the whole corona into one exposure.
  const coronaDensity = (rho) => 0.036 * rho ** -1.5 + 1.55 * rho ** -6 + 2.99 * rho ** -16;
  const CORONA_SAMPLES = [1, 1.03, 1.06, 1.1, 1.15, 1.22, 1.3, 1.4, 1.52, 1.66, 1.82, 2, 2.2, 2.4, 2.6, 2.8, 3];
  const coronaStops = CORONA_SAMPLES.map((rho) => {
    const relative = Math.sqrt(coronaDensity(rho) / coronaDensity(1));
    return `<stop offset="${((rho / CORONA_REACH) * 100).toFixed(1)}%" class="map-sun-corona-stop"`
      + ` stop-opacity="${relative.toFixed(3)}"/>`;
  }).join('') + '<stop offset="100%" class="map-sun-corona-stop" stop-opacity="0"/>';

  // A streamer: anchored on the limb across `spread` degrees and narrowing as it reaches out to
  // `reach` solar radii, because the closed magnetic loops holding it in are pulled open by the
  // wind as they rise. It narrows rather than closing to a point — beyond the cusp the field is
  // open and the stalk runs on out of frame, so a spike would be the one shape it never makes.
  // Nothing ends it either: `map-sun-streamer-fade` dims every streamer with height, the way
  // the corona itself dims, so the blunt end dissolves instead of stopping at a drawn edge.
  function streamer(cls, angleDeg, reach, spreadDeg, opacity) {
    const at = (deg, r) => [Math.cos(deg * RAD) * r * SUN_RADIUS, Math.sin(deg * RAD) * r * SUN_RADIUS];
    const tip = spreadDeg / 5;
    const waist = 1 + (reach - 1) * 0.5;
    const pt = ([x, y]) => `${len(x)},${len(y)}`;
    return `<path class="${cls}" opacity="${opacity.toFixed(2)}"`
      + ` d="M${pt(at(angleDeg - spreadDeg / 2, 1))}`
      + ` Q${pt(at(angleDeg - spreadDeg / 3, waist))} ${pt(at(angleDeg - tip, reach))}`
      + ` L${pt(at(angleDeg + tip, reach))}`
      + ` Q${pt(at(angleDeg + spreadDeg / 3, waist))} ${pt(at(angleDeg + spreadDeg / 2, 1))} Z"/>`;
  }

  // Built once `sunFeatures` resolves, and dropped into the empty groups `sunHtml` leaves
  // behind. Spots and faculae go on the disc; streamers and plumes go outside it.
  function sunSurfaceHtml(sf) {
    const spots = [];
    const faculae = [];
    (sf.groups ?? []).forEach((group) => {
      const seen = group.spots.map(([lat, lon]) => helioToDisc(lat, lon));
      if (!seen.some((at) => at.mu > 0)) return; // the whole group has rotated round the back

      group.spots.forEach(([lat, lon, umbra, whole], i) => {
        const at = seen[i];
        if (at.mu <= 0.01) return;
        // A negative area is the catalogue saying this spot shares its penumbra (or its umbra)
        // with a neighbour, which carries the shared area itself — so only the owner draws it,
        // and the sharers draw just their own dark cores inside it. A spot with no area at all
        // is a pore: real, resolved, and simply smaller than the catalogue's rounding.
        if (whole > 0) spots.push(patch('map-sun-penumbra', at, Math.max(spotRadius(whole), SPOT_FLOOR)));
        const core = umbra > 0 ? Math.max(spotRadius(umbra), SPOT_FLOOR * 0.6) : SPOT_FLOOR * 0.6;
        spots.push(patch('map-sun-umbra', at, core));
      });

      // The plage around the group: faculae — the bright magnetic network that both precedes
      // and outlives the spots — spread well past them, so the patch is the group's own extent
      // padded out. Their contrast is the interesting part: at the centre of the disc they are
      // all but invisible, and they brighten toward the limb, peaking around μ ≈ ⅓, because
      // what is being seen is the hot wall of a magnetic flux tube, side-on. μ(1 − μ)² has its
      // maximum in exactly that place, so it stands in for the measured curve.
      const lats = group.spots.map(([lat]) => lat);
      const lons = group.spots.map(([, lon]) => lon);
      const spread = (Math.max(...lats) - Math.min(...lats) + Math.max(...lons) - Math.min(...lons)) / 4;
      const centre = helioToDisc(group.lat, group.lon);
      if (centre.mu <= 0.01) return;
      const contrast = FACULA_PEAK * (centre.mu * (1 - centre.mu) ** 2) / (4 / 27);
      faculae.push(patch('map-sun-facula', centre, (spread + PLAGE_PAD) * RAD * SUN_RADIUS,
        ` opacity="${contrast.toFixed(3)}"`));
    });
    return { spots: spots.join(''), faculae: faculae.join('') };
  }

  // The structure of the corona, as opposed to its overall glow. Two things shape it, and both
  // are real: the heliospheric current sheet, which that rotation reached ±23° of latitude
  // (WSO's potential-field model for CR 1886) and which the bright streamer belt straddles, and
  // the day's own active regions, each of which holds a helmet streamer above it. A streamer is
  // only seen as a structure when its region is near the limb and it stands side-on — near the
  // centre of the disc it points straight at us and reads as nothing — so its opacity follows
  // 1 − μ. Above and below the belt sit the polar coronal holes, where the field is open and
  // the corona thins out to plumes; B0 tips the north pole 7.25° toward us that week, so the
  // northern fan is drawn from just inside the limb rather than on it.
  function sunCoronaHtml(sf) {
    const tilt = sf.currentSheetTilt ?? 20;
    const belt = [0, 180].map((angle) => streamer('map-sun-streamer', angle, 1.75, tilt * 2, 0.5)).join('');
    const helmets = (sf.groups ?? []).map((group) => {
      const at = helioToDisc(group.lat, group.lon);
      if (at.mu <= 0) return '';
      const angle = Math.atan2(at.y, at.x) / RAD;
      const size = Math.min(1, Math.sqrt(group.area / 400)); // bigger regions hold up bigger streamers
      return streamer('map-sun-helmet', angle, 1.3 + 0.7 * size, 18 + 18 * size, (1 - at.mu) * 0.7);
    }).join('');
    const PLUMES = 9;
    const plumes = [-1, 1].map((pole) => {
      const base = Math.cos(SUN_AXIS.b0 * RAD) * pole; // the projected pole, just inside the limb
      return Array.from({ length: PLUMES }, (_, i) => {
        const fan = (i / (PLUMES - 1) - 0.5) * 70 * RAD; // opening out over the polar hole
        const x1 = Math.sin(fan) * SUN_RADIUS;
        const y1 = base * Math.cos(fan) * SUN_RADIUS;
        return `<line class="map-sun-plume" x1="${len(x1)}" y1="${len(y1)}"`
          + ` x2="${len(x1 * 1.4)}" y2="${len(y1 * 1.4)}"/>`;
      }).join('');
    }).join('');
    return belt + helmets + plumes;
  }

  // Turbulence at a real physical size: `baseFrequency` counts cycles per svg unit, and the
  // disc is `SUN_RADIUS` units for `SUN_RADIUS_KM` kilometres, so a cell `km` across lands at
  // its true scale on the drawn sun. Granulation comes out finer than a pixel at rest — which
  // is honest, since it is finer than the eye can resolve on the real sun too — and only
  // separates out once the globe is zoomed well in.
  const cellFrequency = (km) => (SUN_RADIUS_KM / km / SUN_RADIUS).toFixed(3);

  const sunHtml = () => `
    <defs>
      <radialGradient id="map-sun-limb" cx="50%" cy="50%" r="50%">${limbStops}</radialGradient>
      <radialGradient id="map-sun-glow" cx="50%" cy="50%" r="50%">${coronaStops}</radialGradient>
      <filter id="map-sun-granulation" x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency="${cellFrequency(GRANULE_KM)}" numOctaves="1" seed="7" result="noise"/>
        <feColorMatrix in="noise" type="matrix"
          values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.4 0.4 0.4 0 0" result="mask"/>
        <feComposite in="SourceGraphic" in2="mask" operator="in"/>
      </filter>
      <filter id="map-sun-network" x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency="${cellFrequency(SUPERGRANULE_KM)}" numOctaves="2" seed="3" result="noise"/>
        <feColorMatrix in="noise" type="matrix"
          values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.5 0.5 0.5 0 -0.1" result="mask"/>
        <feComposite in="SourceGraphic" in2="mask" operator="in"/>
      </filter>
      <radialGradient id="map-sun-streamer-fade" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${len(SUN_RADIUS * 2)}">
        <stop offset="50%" class="map-sun-streamer-stop" stop-opacity="0.32"/>
        <stop offset="62%" class="map-sun-streamer-stop" stop-opacity="0.24"/>
        <stop offset="80%" class="map-sun-streamer-stop" stop-opacity="0.11"/>
        <stop offset="100%" class="map-sun-streamer-stop" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="map-sun-plage" cx="50%" cy="50%" r="50%">
        <stop offset="0%" class="map-sun-plage-stop" stop-opacity="0.9"/>
        <stop offset="40%" class="map-sun-plage-stop" stop-opacity="0.62"/>
        <stop offset="72%" class="map-sun-plage-stop" stop-opacity="0.26"/>
        <stop offset="100%" class="map-sun-plage-stop" stop-opacity="0"/>
      </radialGradient>
      <filter id="map-sun-diffuse" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="${len(SUN_RADIUS * 0.05)}"/>
      </filter>
      <clipPath id="map-sun-clip"><circle r="${len(SUN_RADIUS)}"/></clipPath>
    </defs>
    <g class="map-sun" aria-hidden="true" style="--sun-plume-width:${len(SUN_RADIUS * PLUME_KM / SUN_RADIUS_KM)}">
      ${glowHtml(SUN_RADIUS, { warm: true })}
      <g class="map-sun-face">
        <circle class="map-sun-glow" r="${len(SUN_RADIUS * CORONA_REACH)}"/>
        <g class="map-sun-corona" filter="url(#map-sun-diffuse)"></g>
        <g clip-path="url(#map-sun-clip)">
          <circle class="map-sun-disc" r="${len(SUN_RADIUS)}"/>
          <rect class="map-sun-supergranules" filter="url(#map-sun-network)"
                x="${(-SUN_RADIUS).toFixed(1)}" y="${(-SUN_RADIUS).toFixed(1)}"
                width="${(SUN_RADIUS * 2).toFixed(1)}" height="${(SUN_RADIUS * 2).toFixed(1)}"/>
          <rect class="map-sun-granules" filter="url(#map-sun-granulation)"
                x="${(-SUN_RADIUS).toFixed(1)}" y="${(-SUN_RADIUS).toFixed(1)}"
                width="${(SUN_RADIUS * 2).toFixed(1)}" height="${(SUN_RADIUS * 2).toFixed(1)}"/>
          <g class="map-sun-spots"></g>
          <circle class="map-sun-limb" r="${len(SUN_RADIUS)}"/>
          <g class="map-sun-faculae"></g>
        </g>
      </g>
    </g>`;

  // The seven planets, at their true places and true sizes for `SKY_MOMENT`, through the same
  // `skyDiscRadius` as the sun and the moon. Nothing here is scaled to be convenient: Jupiter
  // and Venus are the widest discs among them because they were, and Neptune is a speck because
  // it is one. What the planets do have that the sun and moon do not is a set of markings that
  // only make sense once the frame is turned the right way round — a crescent leaning toward
  // the sun, belts running along an equator, rings tipped by the angle they were really tipped
  // by — so each one carries a `faceTransform` built from its own axis.
  const JUPITER_POLE = { ra: 268.057, dec: 64.495 }; // IAU north pole of rotation

  // Jupiter's belts and zones, by their real planetographic latitudes and their real names: the
  // dark belts are where gas is sinking, the bright zones between them where it is rising, and
  // the whole system is held in place by winds that run along the latitude circles rather than
  // across them. Only the belts are drawn; the zones are the disc showing through between them.
  const JUPITER_BANDS = [
    [-90, -57, 'polar'], // south polar region, dusky rather than banded
    [-53, -44, 'belt'], // south south temperate belt
    [-36, -27, 'belt'], // south temperate belt
    [-20, -7, 'belt'], // south equatorial belt, the broadest of them
    [7, 17, 'belt'], // north equatorial belt, usually the darkest
    [24, 31, 'belt'], // north temperate belt
    [35, 43, 'belt'], // north north temperate belt
    [57, 90, 'polar'], // north polar region
  ];
  // Saturn has the same machinery under a deep haze, and it is deliberately left off: the belt
  // latitudes here would have been my impression of them rather than anyone's measurement, and
  // Saturn's disc is six tenths of a pixel wide even zoomed all the way in. Its rings and its
  // flattening are measured, and those are the two things about Saturn worth drawing anyway.
  // Comet Shoemaker-Levy 9 broke up and fell into Jupiter over six days in July 1994, seven
  // weeks before this sky. What is real here is the impact times — Yeomans and Chodas's accepted
  // values, to the minute — and the latitude, 44° south, which every fragment shared because
  // they arrived strung out along one orbit. The longitudes are not tabulated but they do not
  // have to be: each fragment struck 6.5° beyond the limb and rotated into view eleven minutes
  // later, so its impact point stood 96.5° short of the central meridian, and Jupiter's own
  // rotation turns an impact time into a longitude. Six days of that, at 870° a day, scattered
  // the scars right around the planet.
  //
  // They lasted about five months. A month on they had faded; by the end of the year the winds
  // had drawn them out into one dark band. This sky catches them in between — still separate,
  // already smeared, which is why they are drawn wide, faint and all the same size: their
  // positions are measured, but how big each one still was on 9 September is not something the
  // record gives, and inventing nineteen different sizes would be inventing.
  const SL9_LATITUDE = -44;
  const SL9_BEHIND_LIMB = 96.5; // degrees short of the central meridian, from the 11-minute delay
  const SL9_IMPACTS = [
    ['A', '1994-07-16T20:11:00Z'], ['B', '1994-07-17T02:50:00Z'], ['C', '1994-07-17T07:12:00Z'],
    ['D', '1994-07-17T11:54:00Z'], ['E', '1994-07-17T15:11:00Z'], ['F', '1994-07-18T00:33:00Z'],
    ['G', '1994-07-18T07:32:00Z'], ['H', '1994-07-18T19:31:59Z'], ['K', '1994-07-19T10:21:00Z'],
    ['L', '1994-07-19T22:16:48Z'], ['N', '1994-07-20T10:31:00Z'], ['P2', '1994-07-20T15:23:00Z'],
    ['Q2', '1994-07-20T19:44:00Z'], ['Q1', '1994-07-20T20:12:00Z'], ['R', '1994-07-21T05:33:00Z'],
    ['S', '1994-07-21T15:15:00Z'], ['T', '1994-07-21T18:10:00Z'], ['U', '1994-07-21T21:55:00Z'],
    ['W', '1994-07-22T08:06:00Z'],
  ];
  const SL9_SIZE = [0.19, 0.075]; // half-width and half-height in Jupiter radii, after seven weeks of wind

  const REAL_JUPITER_ROTATION = jupiterRotation(SKY_MOMENT);
  const REAL_GALILEAN_MOONS = galileanMoons(SKY_MOMENT);
  // Io, Europa, Ganymede, Callisto, as fractions of Jupiter's own equatorial radius.
  const GALILEAN_RADII = [1821.6 / 71492, 1560.8 / 71492, 2634.1 / 71492, 2410.3 / 71492];

  // How far from a sphere each one is, as (equatorial − polar) / equatorial. These two spin fast
  // enough to be visibly out of round — Saturn by a tenth, which is obvious at a glance in any
  // telescope — and since their poles are already pointing up in the drawn frame, squashing the
  // disc along that axis costs nothing and is one of the first things the eye recognises.
  const PLANET_FLATTENING = { jupiter: 0.0649, saturn: 0.0980 };
  // Ring radii in Saturn radii: the C ring, the two halves of the bright B ring, the Cassini
  // division as the gap between B and A, the A ring, and the Encke gap near its outer edge.
  const SATURN_RING_BANDS = [
    ['c', 1.239, 1.526], ['b-inner', 1.526, 1.750], ['b-outer', 1.750, 1.950],
    ['a-inner', 2.030, 2.214], ['a-outer', 2.219, 2.269],
  ];
  const SATURN_RING_OUTER = 2.269;
  const PHASE_FLOOR = 0.995; // past this a planet is full, and a drawn terminator is a lie about pixels

  const REAL_SATURN_RINGS = saturnRings(SKY_MOMENT);

  // Which way each planet's face has to be turned. `faceTransform` builds a frame from a
  // position angle that should point "up" on the drawn disc, so each planet asks for whichever
  // direction its own markings are governed by: the inner planets by the sun (a crescent has to
  // lean toward what is lighting it), Jupiter by its rotation axis (its belts run along its
  // equator, and its flattening squashes it along that axis), Saturn by the pole of its ring
  // plane, which its own axis is bolted to. The three that show neither a phase nor a marking
  // need no frame at all, and are left alone.
  function planetAxisAngle(name, planet) {
    if (name === 'jupiter') return positionAngle(planet, JUPITER_POLE);
    if (name === 'saturn') return REAL_SATURN_RINGS.axisAngle;
    if (planet.illuminatedFraction >= PHASE_FLOOR) return null;
    return (planet.brightLimbAngle + 90) % 360; // bright limb to +x, so the night side falls to −x
  }

  const planets = PLANET_NAMES.map((name) => {
    const planet = REAL_PLANETS[name];
    const radius = skyDiscRadius(planet.semidiameter);
    const flattening = PLANET_FLATTENING[name] ?? 0;
    return {
      name,
      planet,
      radius,
      flattening,
      polarRadius: radius * (1 - flattening),
      point: [toSkyLon(planet.ra), planet.dec],
      axisAngle: planetAxisAngle(name, planet),
    };
  });

  // Where a parallel of latitude lands on the drawn disc. Belt latitudes are quoted
  // planetographic — the angle of the local vertical, which on a flattened planet is not the
  // angle from the centre — and the ellipse the planet projects to is parametrised by yet a
  // third angle. Both conversions collapse into one: the eccentric angle whose tangent is
  // `(1 − f)` times the planetographic one. It matters. On Jupiter it shifts a belt at 20° by
  // more than two degrees, and the whole point of using the real latitudes is that they land
  // in the real places.
  function bandEdge(latDeg, { polarRadius, flattening }) {
    const eccentric = Math.atan((1 - flattening) * Math.tan(latDeg * RAD));
    return -polarRadius * Math.sin(eccentric);
  }

  // The belts, as bands across the disc. Each is filled with a gradient that fades out top and
  // bottom rather than ending at a line, because a belt has no edge — it is where one wind
  // regime gives way to the next. The gradient is in the rect's own units, so every belt gets a
  // fade proportional to its own width, and unlike a blur it holds at any zoom: at the size
  // these discs are actually drawn, a filter has barely one pixel to work in.
  function bandsHtml(bands, planet) {
    return bands.map(([from, to, kind]) => {
      const y1 = bandEdge(Math.max(from, to), planet);
      const y2 = bandEdge(Math.min(from, to), planet);
      return `<rect class="map-planet-${kind}" x="${len(-planet.radius)}" y="${len(y1)}"`
        + ` width="${len(planet.radius * 2)}" height="${len(y2 - y1)}"/>`;
    }).join('');
  }

  // The unlit side. Venus is the only one of the three that shows a phase whose terminator is
  // soft: its atmosphere is thick enough to carry sunlight well round past the geometric edge,
  // and at a thin crescent it carries it right round the cusps into a ring. Mercury has
  // essentially no air and Mars very little, so theirs stay knife-sharp, which is how they
  // really look through a telescope. The soft one is built by stacking a few phase shapes
  // whose terminators straddle the true one — the same ramp a blur would give, but drawn
  // rather than rasterised, so it survives being a third of a pixel wide.
  const TERMINATOR_STEPS = 9; // enough that the stack reads as a ramp rather than as steps
  const TERMINATOR_SPREAD = 0.06; // in illuminated fraction, either side of the true one
  function nightHtml(radius, lit, soft) {
    const shape = (dark) => moonPhasePath(radius, Math.min(1, Math.max(0, dark)));
    if (!soft) return `<path class="map-planet-night" d="${shape(1 - lit)}" transform="scale(-1,1)"/>`;
    return Array.from({ length: TERMINATOR_STEPS }, (_, i) => {
      const offset = TERMINATOR_SPREAD * (2 * (i / (TERMINATOR_STEPS - 1)) - 1);
      return `<path class="map-planet-night" opacity="${(1 / TERMINATOR_STEPS).toFixed(3)}"`
        + ` d="${shape(1 - lit + offset)}" transform="scale(-1,1)"/>`;
    }).join('');
  }

  // The impact scars, placed from the impact times. `bandEdge` already knows how to turn a
  // planetographic latitude into a height on the drawn ellipse; across the disc a point at
  // that latitude sits on a parallel whose half-width is the disc's own at that height, so the
  // scar's distance from the meridian is that half-width times the sine of how far round it has
  // turned. Jupiter's axis leans 3° and tips its equator less than that toward us, so the
  // parallels stay near enough to straight for this to be exact where it matters.
  function scarsHtml(planet) {
    const cm = REAL_JUPITER_ROTATION.cm2;
    const y = bandEdge(SL9_LATITUDE, planet);
    const halfWidth = planet.radius * Math.cos(Math.asin(-y / planet.polarRadius));
    const [rx, ry] = SL9_SIZE.map((v, i) => v * planet.radius * (i === 0 ? 1 : 1 - planet.flattening));
    return SL9_IMPACTS.map(([fragment, iso]) => {
      const longitude = (jupiterRotation(new Date(iso)).cm2 + SL9_BEHIND_LIMB) % 360;
      const fromMeridian = (((cm - longitude) % 360) + 540) % 360 - 180; // + is west of it
      if (Math.abs(fromMeridian) >= 88) return ''; // round the back, or edge-on at the limb
      const x = halfWidth * Math.sin(fromMeridian * RAD);
      // Foreshortened toward the limb the same way a sunspot is, and never quite to nothing.
      const squash = Math.max(0.12, Math.cos(fromMeridian * RAD));
      return `<ellipse class="map-planet-scar" data-fragment="${fragment}"`
        + ` cx="${len(x)}" cy="${len(y)}"`
        + ` rx="${len(rx * squash)}" ry="${len(ry)}"/>`;
    }).join('');
  }

  // The four moons Galileo saw, at their true separations from Jupiter and their true sizes
  // relative to it — which is to say tiny, since even Ganymede is a twenty-seventh of Jupiter's
  // width. What carries them is not their size but their spacing: Callisto stands 26 Jupiter
  // radii out, so the four of them string across a stretch of sky twenty times wider than the
  // planet itself, and that spacing is the thing a real eye at a real telescope picks up first.
  function galileanHtml(planet, wanted) {
    return REAL_GALILEAN_MOONS
      .map((moon, i) => ({ moon, r: GALILEAN_RADII[i] * planet.radius }))
      .filter(({ moon }) => moon.front === wanted)
      .map(({ moon, r }) => {
        const [cx, cy] = [moon.x * planet.radius, moon.y * planet.radius];
        return glowHtml(r, { cx, cy })
          + `<circle class="map-planet-satellite" data-moon="${moon.name}"`
          + ` cx="${len(cx)}" cy="${len(cy)}" r="${len(r)}"/>`;
      })
      .join('');
  }

  // Saturn's rings, opened by however much the ring plane was tipped toward Earth that night —
  // 6.9°, on its way down to the edge-on crossing of May 1995, so they show as a narrow blade
  // rather than the wide-open ellipse of the postcards. A circle tipped by that angle projects
  // to an ellipse: full width across, squashed to `sin` of the opening angle up and down. Each
  // named band sits at its true radius, and the gaps between them are real gaps — the Cassini
  // division between B and A wide enough to see, the Encke gap near A's outer edge a hairline.
  // The half of the ring in front of the planet is drawn again over the disc.
  function ringsHtml(planet) {
    const squash = Math.abs(Math.sin(REAL_SATURN_RINGS.openingAngle * RAD));
    const ellipse = (radii) => {
      const rx = radii * planet.radius;
      const ry = rx * squash;
      return `M${len(-rx)},0a${len(rx)},${len(ry)} 0 1,0 ${len(rx * 2)},0`
        + `a${len(rx)},${len(ry)} 0 1,0 ${len(-rx * 2)},0`;
    };
    // Even-odd filling turns each outer-plus-inner pair into an annulus, which is what a ring is.
    const rings = SATURN_RING_BANDS
      .map(([name, inner, outer]) => `<path class="map-planet-ring-${name}" fill-rule="evenodd"`
        + ` d="${ellipse(outer)}${ellipse(inner)}"/>`)
      .join('');
    return { back: rings, front: `<g clip-path="url(#map-saturn-front)">${rings}</g>` };
  }

  // The planets get no limb darkening. They do darken toward the limb, and the sun above them
  // is drawn with the law that governs it — but the sun's coefficient is a published measurement
  // at a stated wavelength, and there is no single number that does the same job for seven
  // planets: it runs differently on each of them, and differently again by wavelength and
  // latitude. Drawing them flat is a smaller lie than drawing them with a coefficient I made up.
  const planetHtml = () => {
    const saturn = planets.find((p) => p.name === 'saturn');
    const saturnFront = saturn.radius * SATURN_RING_OUTER * 1.1;
    // Which half of the ring passes in front of the planet depends on which face of the ring
    // plane is turned toward us: tipped north toward Earth, as it was that night, the near edge
    // swings below the disc; tipped the other way, it crosses above instead.
    const frontBelow = REAL_SATURN_RINGS.openingAngle >= 0;
    return `
    <defs>
      <clipPath id="map-saturn-front">
        <rect x="${len(-saturnFront)}" y="${len(frontBelow ? 0 : -saturnFront)}"
              width="${len(saturnFront * 2)}" height="${len(saturnFront)}"/>
      </clipPath>
      ${planets.map(({ name, radius, polarRadius }) =>
        `<clipPath id="map-planet-clip-${name}"><ellipse rx="${len(radius)}" ry="${len(polarRadius)}"/></clipPath>`).join('')}
      <linearGradient id="map-planet-band" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" class="map-planet-band-stop" stop-opacity="0"/>
        <stop offset="28%" class="map-planet-band-stop" stop-opacity="1"/>
        <stop offset="72%" class="map-planet-band-stop" stop-opacity="1"/>
        <stop offset="100%" class="map-planet-band-stop" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${planets.map((planet) => {
      const { name, radius, polarRadius } = planet;
      const clip = `clip-path="url(#map-planet-clip-${name})"`;
      const rings = name === 'saturn' ? ringsHtml(planet) : null;
      const bands = name === 'jupiter' ? JUPITER_BANDS : null;
      const lit = planet.planet.illuminatedFraction;
      const night = lit < PHASE_FLOOR
        ? `<g class="map-planet-nightside" ${clip}>${nightHtml(radius, lit, name === 'venus')}</g>`
        : '';
      const moons = name === 'jupiter' ? galileanHtml(planet, false) : '';
      const moonsInFront = name === 'jupiter' ? galileanHtml(planet, true) : '';
      return `<g class="map-planet map-planet-${name}" aria-hidden="true">`
        + glowHtml(radius)
        + '<g class="map-planet-face">'
        + moons // the ones round the far side of their orbits go under the planet
        + (rings ? rings.back : '')
        + `<ellipse class="map-planet-disc" rx="${len(radius)}" ry="${len(polarRadius)}"/>`
        + (bands
          ? `<g ${clip}>${bandsHtml(bands, planet)}`
            + (name === 'jupiter' ? scarsHtml(planet) : '') + '</g>'
          : '')
        + night
        + moonsInFront
        + (rings ? rings.front : '')
        + '</g></g>';
    }).join('')}`;
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
      <svg class="map-svg" aria-hidden="true"><g class="map-scene"><g class="map-sky" aria-hidden="true"></g><path class="map-moon-halo" aria-hidden="true"/>${glowDefs()}${moonHtml()}${sunHtml()}${planetHtml()}<path class="map-globe"/><g class="map-land-ghost">${ghostShapes(ghostFeatures)}</g><g class="map-marine-areas">${waterShapes(waterFeatures)}${borderShapes(borderFeatures)}</g><g class="map-land">${countryShapes(land.features, path)}</g></g></svg>
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
  const moonEl = mapEl.querySelector('.map-moon');
  const moonHaloEl = mapEl.querySelector('.map-moon-halo');
  const sunEl = mapEl.querySelector('.map-sun');
  const sunFaceEl = mapEl.querySelector('.map-sun-face');
  const planetEls = planets.map((planet) => ({
    ...planet,
    el: mapEl.querySelector(`.map-planet-${planet.name}`),
    faceEl: mapEl.querySelector(`.map-planet-${planet.name} .map-planet-face`),
  })).filter(({ el }) => el);
  const markerEls = [...mapEl.querySelectorAll('.map-marker')];
  const crumb = mapEl.querySelector('.map-crumb');
  const tip = mapEl.querySelector('.map-tip');
  const callout = mapEl.querySelector('.map-callout');
  const hint = mapEl.querySelector('.map-hint');
  const buttons = Object.fromEntries([...mapEl.querySelectorAll('[data-action]')].map((b) => [b.dataset.action, b]));

  // Bindings between rendered elements and the geometry that produced them, one element
  // per feature/star/line in the same order the html builders above emitted them, so
  // `redraw` can update `d`/`cx`/`cy` on every drag frame without ever touching innerHTML
  // (which, for ~5,000 stars, would be far too slow). Marine and sky start with nothing
  // to bind to (both groups are still empty at this point) and are populated for real once
  // `marine`/`sky` resolve, below — `redraw` iterates whatever's here on every frame
  // regardless, so an empty array in the meantime is simply a no-op, not a special case.
  let ghostLandEls = [...mapEl.querySelectorAll('.map-land-ghost path')].map((el, i) => ({ el, feature: ghostFeatures[i] }));
  let waterEls = [];
  let borderEls = [];
  let starEls = [];
  let lineEls = [];

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

  // The home framing alone uses extra breathing room, well past what a focused country
  // needs — that's what leaves open sky (and the moon) visible around the globe by default,
  // rather than the globe filling the card edge-to-edge.
  const homeInsets = (v) => {
    const pad = Math.min(84, v.w * 0.14);
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

    if (moonEl) {
      const p = d3.geoDistance(moonPoint, center) <= limit ? skyProjection(moonPoint) : null;
      const visible = p && Number.isFinite(p[0]) && Number.isFinite(p[1]);
      const inside = visible && Math.hypot(p[0] - cx, p[1] - cy) <= globeRadius;
      const dim = visible ? (inside ? SKY_INSIDE_DIM : 1) : 0;
      moonEl.setAttribute('opacity', dim);
      if (visible) moonEl.setAttribute('transform', `translate(${p[0].toFixed(1)},${p[1].toFixed(1)})`);
      if (moonHaloEl) {
        moonHaloEl.setAttribute('d', skyPath({ type: 'Polygon', coordinates: [moonHaloRing] }) || '');
        moonHaloEl.setAttribute('opacity', (dim * HALO_BASE_OPACITY).toFixed(2));
      }
    }

    if (sunEl) {
      const p = d3.geoDistance(sunPoint, center) <= limit ? skyProjection(sunPoint) : null;
      const visible = p && Number.isFinite(p[0]) && Number.isFinite(p[1]);
      const inside = visible && Math.hypot(p[0] - cx, p[1] - cy) <= globeRadius;
      sunEl.setAttribute('opacity', visible ? (inside ? SKY_INSIDE_DIM : 1) : 0);
      if (visible) {
        sunEl.setAttribute('transform', `translate(${p[0].toFixed(1)},${p[1].toFixed(1)})`);
        if (sunFaceEl) sunFaceEl.setAttribute('transform', faceTransform(sunPoint, p, SUN_AXIS.p));
      }
    }

    // The planets ride the same sky as the stars behind them: same clipping, same dimming when
    // they pass behind the glass globe. Only the four with something directional drawn on them —
    // a crescent, belts, rings — pay for a frame each time round.
    planetEls.forEach(({ el, faceEl, point, axisAngle }) => {
      const p = d3.geoDistance(point, center) <= limit ? skyProjection(point) : null;
      const visible = p && Number.isFinite(p[0]) && Number.isFinite(p[1]);
      const inside = visible && Math.hypot(p[0] - cx, p[1] - cy) <= globeRadius;
      el.setAttribute('opacity', visible ? (inside ? SKY_INSIDE_DIM : 1) : 0);
      if (!visible) return;
      el.setAttribute('transform', `translate(${p[0].toFixed(1)},${p[1].toFixed(1)})`);
      if (faceEl && axisAngle !== null) faceEl.setAttribute('transform', faceTransform(point, p, axisAngle));
    });

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

  // The four decorative extras hydrate the already-live scene in place, in whatever order
  // they happen to resolve, each patching just the DOM group it owns and rebinding that
  // group's `redraw` array before repainting — never a full re-render, so none of this
  // resets the current rotation/zoom or touches anything the visitor is already looking at.
  ghostCountries?.then((features) => {
    if (!features) return;
    ghostFeatures = features;
    const box = mapEl.querySelector('.map-land-ghost');
    if (!box) return;
    box.innerHTML = ghostShapes(ghostFeatures);
    ghostLandEls = [...box.querySelectorAll('path')].map((el, i) => ({ el, feature: ghostFeatures[i] }));
    redraw(true);
  });

  marine?.then((m) => {
    if (!m) return;
    waterFeatures = (m.areas ?? []).filter((f) => f.properties.type !== 'ocean');
    borderFeatures = m.borders ?? [];
    const box = mapEl.querySelector('.map-marine-areas');
    if (!box) return;
    box.innerHTML = waterShapes(waterFeatures) + borderShapes(borderFeatures);
    waterEls = [...box.querySelectorAll('.map-marine')].map((el, i) => ({ el, feature: waterFeatures[i] }));
    borderEls = [...box.querySelectorAll('.map-marine-border')].map((el, i) => ({ el, feature: borderFeatures[i] }));
    redraw(true);
  });

  sky?.then((skyData) => {
    if (!skyData) return;
    const box = mapEl.querySelector('.map-sky');
    if (!box) return;
    const { html, lines } = skyContent(skyData);
    box.innerHTML = html;
    lineEls = [...box.querySelectorAll('.map-constellation')].map((el, i) => ({ el, coords: lines[i].paths }));
    starEls = [...box.querySelectorAll('.map-star')].map((el) => ({
      el, point: [+el.dataset.ra, +el.dataset.dec], opacity: +el.dataset.opacity,
    }));
    redraw(true);
  });

  moonFeatures?.then((mf) => {
    if (!mf) return;
    const surface = mapEl.querySelector('.map-moon-surface');
    if (surface) surface.innerHTML = moonSurfaceHtml(mf, MOON_RADIUS);
  });

  // The sun draws fine without this — a limb-darkened disc and its corona, which is all the
  // naked eye ever gets anyway — so a slow or failed fetch just leaves it spotless.
  sunFeatures?.then((sf) => {
    if (!sf) return;
    const { spots, faculae } = sunSurfaceHtml(sf);
    const spotsEl = mapEl.querySelector('.map-sun-spots');
    const faculaeEl = mapEl.querySelector('.map-sun-faculae');
    const coronaEl = mapEl.querySelector('.map-sun-corona');
    if (spotsEl) spotsEl.innerHTML = spots;
    if (faculaeEl) faculaeEl.innerHTML = faculae;
    if (coronaEl) coronaEl.innerHTML = sunCoronaHtml(sf);
  });

  redraw(true); // establish xy/front for every place before computing the home framing below

  // Every place lives on the globe's own surface, so its content-space position is always
  // within `globeRadius` of centre — fitting "home" to the globe's bounding box therefore
  // always shows at least as much as fitting to the visited places would, and never
  // crops tighter than the whole globe, keeping the sky margin around it visible by
  // default rather than auto-zooming past it into a tight cluster of trips.
  // How far in the map will zoom. The default view sits at exactly the scale that fits the whole
  // card, so a body reaches the size the globe has there once the view is magnified by the ratio
  // of their radii — and now that nothing in the sky is drawn larger than it really is, that
  // ratio is the honest reason for the number. The sun is the smaller of the two big discs, so
  // it sets the ceiling; the moon, slightly wider, gets there a little sooner. Past about 3× the
  // finer coastline atlas loads, and past a hundred the country outlines are being stretched far
  // beyond the detail they hold — but by then what is on screen is a disc in the sky, not land.
  const maxZoom = Math.ceil(globeRadius / SUN_RADIUS);

  const [globeCx, globeCy] = projection.translate();
  const homeBounds = [[globeCx - globeRadius, globeCy - globeRadius], [globeCx + globeRadius, globeCy + globeRadius]];

  view = new MapView(viewport, {
    width: WIDTH,
    height,
    maxZoom,
    home: (v) => v.fitView(homeBounds, { inset: homeInsets(v), maxZoom: 8 }),
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

  // Content-space bounds of a country once rotated to face the viewer, ignoring vertices
  // that land far from the rest (an overseas territory near the antipode of the mainland,
  // or a piece cut across the antimeridian) — a bare point projection never clips (only
  // `d3.geoPath`'s stream does), so a stray vertex would otherwise blow the box out to
  // the whole globe instead of just the country actually being focused.
  function countryBounds(feature, rotateTo) {
    const scratch = d3.geoOrthographic().rotate(rotateTo).scale(projection.scale()).translate(projection.translate());
    const pts = polygonsOf(feature.geometry).flatMap((poly) => poly.flat())
      .map((c) => scratch(c))
      .filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (!pts.length) return null;
    const median = pts.map((p) => p[0]).sort((a, b) => a - b)[pts.length >> 1];
    const near = pts.filter((p) => Math.abs(p[0] - median) < WIDTH / 2);
    const xs = near.map((p) => p[0]);
    const ys = near.map((p) => p[1]);
    return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
  }

  // Rotates the globe to face the country, and zooms to fit however big it actually is —
  // a fixed zoom level overshoots a small country and undershoots a large one.
  function focusCountry(name) {
    const feature = byName.get(name);
    if (!feature || name === focusedCountry) return;
    const [lon, lat] = d3.geoCentroid(feature);
    const rotateTo = [-lon, -lat, 0];
    flyRotateTo(rotateTo);
    const bounds = countryBounds(feature, rotateTo);
    if (bounds) view.flyTo(view.fitView(bounds, { inset: insets(view), maxZoom: FOCUS_MAX_ZOOM }));
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
