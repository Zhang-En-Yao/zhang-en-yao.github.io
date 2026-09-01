// The trip page: renders one travelogue and turns its photos into a gallery. Depends on
// ui.js (`esc`, `fmtDate`, `emptyState`) and markdown.js (`renderMarkdown`, `decorateBody`).

const tripEl = document.getElementById('trip');
const tocEl = document.getElementById('toc');
const id = new URLSearchParams(location.search).get('id');

const WORLD_SRC = 'assets/data/countries-50m.json';

// Each trip's photos live in their own public GitHub repo, served through jsDelivr's CDN.
// One repo per trip keeps any single repo from ever hitting GitHub's size limit, and the
// files sit at the root of each repo. By default the repo is `<PHOTO_REPO_OWNER>/<id>`
// on branch main — so a photo listed as "DSCF0683.jpeg" on trip 202606191345 is fetched from
//   https://cdn.jsdelivr.net/gh/ZhangEnYao/202606191345@main/DSCF0683.jpeg
// A trip whose repo is owned or named differently sets `photoRepo` on its index.json entry
// to an "owner/repo" slug (optionally "owner/repo@branch"), used in place of that default.
// A `photos` entry that is already a full http(s) URL is used verbatim, so a one-off photo
// can live anywhere.
const PHOTO_CDN = 'https://cdn.jsdelivr.net/gh';
const PHOTO_REPO_OWNER = 'ZhangEnYao';
const PHOTO_REPO_BRANCH = 'main';

// The repo photos are full-resolution camera JPEGs — ~6000px wide, ~1.7MB each — but the
// page shows them at a fraction of that: a thumbnail in the strip, a windowful in the
// lightbox. Downloading the original for either wastes ~100x the bytes. So the originals
// stay untouched in their repo and the page loads them through wsrv.nl, a free image proxy
// that resizes, re-compresses, and converts to WebP on the fly, then caches the result on
// its own CDN. `PHOTO_THUMB_W` feeds the strip; `PHOTO_FULL_W` the lightbox — a 900px WebP
// thumbnail is ~15KB against the original's 1.7MB. A `photos` entry that is already a full
// http(s) URL is passed through verbatim, unresized.
const PHOTO_PROXY = 'https://wsrv.nl/';
const PHOTO_THUMB_W = 900;
const PHOTO_FULL_W = 2000;

// The band under the title: where this trip happened, at the scale of the region rather
// than the country. Mercator, like the cards on the travel page — at one region's scale the
// job is to look like the shape you'd recognise, and a compromise projection buys nothing.
// The band's shape is load-bearing, not taste. fitExtent scales to whichever axis is
// tighter, so a long letterbox over a tall region is scaled by the latitude and then has
// its leftover width filled with whatever longitude reaches — which is how a trip to
// Britain ends up showing Poland. A squarer band spends that budget on the region instead.
const REGION_W = 800;
const REGION_H = 380;
const REGION_PAD = 16;

// How much sea and neighbouring land to leave around the cities. A trip is often one city,
// which has no extent to grow from, so the span has a floor: something has to decide how
// much of the world a single dot is worth.
const REGION_MARGIN = 2.1;
const MIN_SPAN_LON = 13; // degrees

// A section's own spots (a city's attractions, a trail's stops) sit far closer together
// than the cities on the trip-wide band above — close enough that the bundled atlas, zoomed
// in this far, has no coastline left in view to draw. Without a basemap, the honest way to
// add detail is to shrink what the map is asked to cover: this box is framed per *cluster*
// (a neighbourhood's worth of spots), not per city, which is what actually buys back the
// resolution a flat vector fill can't — that, plus a scale bar and a north arrow, which are
// spatial facts a projection can draw correctly even with no map data under it.
//
// Square, and the same square for every one of them — a city's cluster and the Camino's
// ~115km route sit on the page one after another, and a reader flipping between them reads
// a run of consistent frames faster than a run of ones that keep resizing. The frame no
// longer chases each cluster's own aspect ratio to avoid "wasted" space; a route, whose
// spread is far wider than it is tall, now has real margin above and below it as the plain
// cost of that consistency — a trade-off made on purpose, not a bug to fix.
const AREA_SIZE = 700;
const AREA_PAD = 16;
const AREA_MARGIN = 1.6;
const AREA_MIN_SPAN_LON = 0.004; // degrees — a floor for a single spot or two right next to each other

// The largest span any legitimate single-map cluster actually reaches (measured on
// Barcelona's Waterfront tour, Port Vell to Poblenou, ~3.4km) — a JSON trip's own subsection
// isn't hand-split into several `area` entries the way the old Markdown-plus-index.json
// design needed; instead `clusterPoints` below groups a subsection's points by this cap at
// render time, and renders one map per resulting group. assets/data/build-streets.py's own
// `cluster_points` must compute the identical grouping, so the Nth map here and the Nth
// fetch there always agree on which points go together.
const CLUSTER_CAP_M = 3500;

function haversineM(a, b) {
  const R = 6371000;
  const [lat1, lon1, lat2, lon2] = [a.lat, a.lon, b.lat, b.lon].map((d) => (d * Math.PI) / 180);
  const [dlat, dlon] = [lat2 - lat1, lon2 - lon1];
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Union-find over the distance cap: two points end up in the same group the moment anything
// links them within CLUSTER_CAP_M, even through a chain of other points — a straight distance
// matrix would instead ask "are point 1 and point 9 close", which is the wrong question for a
// long, narrow cluster (a promenade, a run of plazas) where consecutive points are close but
// the two ends are not.
function clusterPoints(points, capM) {
  const parent = points.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const [ra, rb] = [find(a), find(b)]; if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (haversineM(points[i], points[j]) <= capM) union(i, j);
    }
  }
  const order = [];
  const groups = new Map();
  points.forEach((p, i) => {
    const r = find(i);
    if (!groups.has(r)) { groups.set(r, []); order.push(r); }
    groups.get(r).push(p);
  });
  return order.map((r) => groups.get(r));
}

// A round-number ruler, picked to land at a comfortable on-screen length rather than at a
// fixed real-world one — a 100m bar makes sense for a plaza's worth of spots and would be
// illegibly short for a cluster spanning a whole hillside.
const SCALE_BAR_STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000];

// Measured at the cluster's own centre, the one line of the map where degrees-to-metres is
// exactly what it claims to be: Mercator stretches east-west distances toward the poles, so
// a bar sized at the top edge would read short by the time it's compared to a dot near the
// bottom.
function scaleBarHtml(pts, projection, h) {
  const cx = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const p0 = projection([cx, cy]);
  if (!p0) return '';
  const metersPerDeg = 111_320 * Math.cos((cy * Math.PI) / 180);

  let meters = SCALE_BAR_STEPS[0];
  let barPx = 0;
  for (const m of SCALE_BAR_STEPS) {
    const p1 = projection([cx + m / metersPerDeg, cy]);
    if (!p1) continue;
    meters = m;
    barPx = Math.abs(p1[0] - p0[0]);
    if (barPx >= 70) break; // Wide enough to read; no need to grow it further.
  }
  if (!barPx) return '';

  const label = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
  return `
    <g class="region-scale" transform="translate(14, ${h - 16})">
      <line x1="0" y1="0" x2="${barPx.toFixed(1)}" y2="0"/>
      <line x1="0" y1="-4" x2="0" y2="4"/>
      <line x1="${barPx.toFixed(1)}" y1="-4" x2="${barPx.toFixed(1)}" y2="4"/>
      <text x="${(barPx / 2).toFixed(1)}" y="-7" text-anchor="middle">${label}</text>
    </g>`;
}

// North is "up" for free on an unrotated Mercator projection — its meridians run straight
// up the page — so this is a label, not a calculation.
function compassHtml(w) {
  return `
    <g class="region-compass" transform="translate(${w - 24}, 24)">
      <line x1="0" y1="8" x2="0" y2="-7"/>
      <path d="M0,-9 l4,7 l-4,-2 l-4,2 Z"/>
      <text x="0" y="20" text-anchor="middle">N</text>
    </g>`;
}

// Framed on the points, not on the country. `country` is a filing label — a week in Hong
// Kong is filed under China, and a map of China with one dot in the corner of it says
// nothing about where you went. Shared by both maps below — the trip-wide band and each
// section's own cluster map both fit their projection to this box, just at different
// margins and floors.
function pointsBox(points, { margin, minSpanLon, w, h }) {
  const lons = points.map((c) => c.lon);
  const lats = points.map((c) => c.lat);
  const [west, east] = [Math.min(...lons), Math.max(...lons)];
  const [south, north] = [Math.min(...lats), Math.max(...lats)];

  const spanLon = Math.max((east - west) * margin, minSpanLon);
  const spanLat = Math.max((north - south) * margin, (minSpanLon * h) / w);
  const [cx, cy] = [(west + east) / 2, (south + north) / 2];
  // A MultiPoint rather than a polygon of the box: a ring's orientation decides which side
  // of it d3 thinks is inside, and a box wound the wrong way measures the whole globe.
  // Four loose corners cannot be wound at all, and under Mercator — whose meridians and
  // parallels are both straight — the corners are the box exactly.
  return {
    type: 'MultiPoint',
    coordinates: [
      [cx - spanLon / 2, cy - spanLat / 2],
      [cx + spanLon / 2, cy - spanLat / 2],
      [cx - spanLon / 2, cy + spanLat / 2],
      [cx + spanLon / 2, cy + spanLat / 2],
    ],
  };
}

// The same box `pointsMapHtml` frames its dots to, reused to build its street layer with
// the identical projection — so the two land on the same pixels.
function clusterProjection(pts, { margin, minSpanLon, w, h, pad }) {
  return d3.geoMercator().fitExtent([[pad, pad], [w - pad, h - pad]], pointsBox(pts, { margin, minSpanLon, w, h }));
}

// ---------- streets, preloaded rather than fetched live ----------
//
// A cluster map's street geometry comes from OpenStreetMap via Overpass — but not live, not
// from this file: querying Overpass on every page view was both slow (a few seconds per
// cluster, easily the dominant cost of opening this page) and needless, since the streets
// around a fixed set of coordinates do not change between one visitor and the next. Instead
// assets/data/build-streets.py fetches each cluster once, offline, into
// travel/streets/<trip-id>.json — a plain `{ heading: [[[lon,lat], …], …] }` map, one
// coordinate array per way — and the trip's own `fetch` picks that up alongside its
// Markdown (see the bottom of this file). Re-run that script whenever a trip's `areas`
// change; nothing here talks to Overpass at all.

// One `<path>` for every way rather than one per node-to-node segment: a street is one
// continuous line, and `M...L...L...` is both the shorter markup and the one that lets the
// browser join its corners instead of drawing a chain of disconnected strokes.
function streetsPathHtml(ways, projection) {
  return ways
    .map((way) => {
      const pts = way.map(([lon, lat]) => projection([lon, lat])).filter(Boolean);
      if (pts.length < 2) return '';
      const d = `M${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}`;
      return `<path class="region-street" d="${d}" fill="none"/>`;
    })
    .filter(Boolean)
    .join('');
}

// A cluster/route map's own points, handed to Google Maps rather than re-solved here — this
// site has no routing engine of its own, and shouldn't grow one just to answer "how do I
// actually get between these dots". One point opens a pin; two or more open turn-by-turn
// directions through them in the same order the map draws its route line, so the link matches
// what's on screen. Never shown on the trip-wide band (see `scaleBar` at the call site) —
// a country-scale hop isn't "directions" in any useful sense.
function googleMapsUrl(points) {
  const all = (points || []).filter((c) => Number.isFinite(c.lon) && Number.isFinite(c.lat));
  // Consecutive duplicates collapsed: a day's "morning: town A → town B" stop and the very
  // next row landing on B are the same pin, and a leg from a point back to itself is not a
  // real leg of the route.
  const pts = all.filter((c, i) => i === 0 || c.lat !== all[i - 1].lat || c.lon !== all[i - 1].lon);
  if (!pts.length) return '';
  if (pts.length === 1) {
    return `https://www.google.com/maps/search/?api=1&query=${pts[0].lat},${pts[0].lon}`;
  }
  return `https://www.google.com/maps/dir/${pts.map((c) => `${c.lat},${c.lon}`).join('/')}`;
}

// The label's gap from its dot, the space one label needs to clear the next, and a rough
// px-per-character for 12px sans — enough to know whether two labels fight, which is all
// this needs, and it costs no layout pass to find out.
const LABEL_GAP = 11;
const LABEL_LINE = 15;
const LABEL_CHAR_W = 6.6;

// Osaka and Kyoto are a third of a degree apart — genuinely distinct dots that just happen
// to sit close together at this map's scale — and no framing should paper over that; the
// dots stay put there and only the labels move. But two spots can also be close enough in
// reality that their dots would otherwise render as one indistinguishable blob (a building
// on the avenue named after it, say): under DOT_MIN_SEP px apart is past the point where
// "the dots are the truth" is still useful, since there is no longer a visible dot to be
// truthful about. Only that case gets a small symmetric nudge, along the line already
// between the two points — the one direction that still points each dot roughly toward
// where it really is, rather than off in an arbitrary one.
const DOT_MIN_SEP = 9;
function declumpDots(placed) {
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const [a, b] = [placed[i], placed[j]];
      const [dx, dy] = [b.x - a.x, b.y - a.y];
      const dist = Math.hypot(dx, dy);
      if (dist >= DOT_MIN_SEP) continue;
      const push = (DOT_MIN_SEP - dist) / 2;
      const [ux, uy] = dist > 0.01 ? [dx / dist, dy / dist] : [1, 0]; // Coincident: pick an axis.
      a.x -= ux * push; a.y -= uy * push;
      b.x += ux * push; b.y += uy * push;
    }
  }
}

// Places each city's dot, then moves the labels — never the dots — until nothing collides.
//
// Labels dodge other cities' *dots* as well as their labels. A name is unreadable with a
// dot sitting in the middle of it, and the dot it collides with is never its own.
function layoutCities(cities, projection, { w, h }) {
  const placed = cities
    .map((c) => {
      const p = projection([c.lon, c.lat]);
      if (!p) return null;
      return { name: c.name, x: p[0], y: p[1], width: c.name.length * LABEL_CHAR_W };
    })
    .filter(Boolean);

  declumpDots(placed);

  placed.forEach((c) => {
    // A label near the right edge would run off it, so it changes sides instead.
    c.flip = c.x > w * 0.7;
    c.labelX = c.flip ? c.x - LABEL_GAP : c.x + LABEL_GAP;
    c.labelY = c.y;
  });
  placed.sort((a, b) => a.y - b.y); // Top down, so each label only has to clear the ones above.

  const box = (c) => (c.flip
    ? [c.labelX - c.width, c.labelX]
    : [c.labelX, c.labelX + c.width]);
  const hits = (c, x0, x1, y) => {
    const [b0, b1] = box(c);
    return Math.abs(c.labelY - y) < LABEL_LINE && b0 < x1 && x0 < b1;
  };

  placed.forEach((c, i) => {
    // Stack clear of the labels already placed above.
    for (const prev of placed.slice(0, i)) {
      const [a0, a1] = box(prev);
      if (hits(c, a0, a1, prev.labelY)) c.labelY = prev.labelY + LABEL_LINE;
    }
    c.labelY = Math.min(c.labelY, h - 8); // Never off the bottom of the band.

    // Then slide clear of anyone else's dot that ended up inside the name.
    for (const other of placed) {
      if (other === c) continue;
      if (!hits(c, other.x - 5, other.x + 5, other.y)) continue;
      c.labelX = c.flip ? Math.min(c.labelX, other.x - LABEL_GAP) : Math.max(c.labelX, other.x + LABEL_GAP);
    }
  });

  return placed;
}

// Both maps on this page — the trip-wide band and each section's own cluster map — go
// through here. `features`/`country` are only ever set for the trip-wide band, whose scale
// still has an atlas coastline worth drawing; a cluster map is small enough that the atlas
// has nothing left to show at that zoom, so it's left off and `scaleBar`/`route` (real
// facts a projection can still supply without any map data) stand in for it instead.
function pointsMapHtml(points, {
  w, h, pad, margin, minSpanLon, features = [], country = null, route = false, scaleBar = false, streetWays = null,
}) {
  const pts = (points || []).filter((c) => Number.isFinite(c.lon) && Number.isFinite(c.lat));
  if (!pts.length) return '';

  const projection = clusterProjection(pts, { margin, minSpanLon, w, h, pad });
  // Everything outside the band is cut here rather than drawn and overflowed: without it
  // Mercator hands back a path for every country on earth, and the far ones run to
  // coordinates in the millions.
  projection.clipExtent([[0, 0], [w, h]]);

  const land = features.length
    ? features
      .map((f) => {
        const d = d3.geoPath(projection)(f);
        if (!d) return ''; // Clipped away entirely: not in this part of the world.
        const cls = f.properties.name === country ? 'region-country is-here' : 'region-country';
        return `<path class="${cls}" d="${d}"/>`;
      })
      .join('')
    : '';

  const streets = streetWays ? streetsPathHtml(streetWays, projection) : '';

  // A cluster map draws its spots in list order as a line before the dots go down, so a
  // trail's day-by-day stops read as a route rather than a scatter. Order comes from `pts`,
  // not from `placed` below — that array gets sorted top-down for label placement.
  const routeLine = route ? pts.map((c) => projection([c.lon, c.lat])).filter(Boolean) : [];
  const routePath = routeLine.length > 1
    ? `<polyline class="region-route" points="${routeLine.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}" fill="none"/>`
    : '';

  // Two layers, not one group per city: every label has to sit above every dot, and in a
  // tight cluster the dot that would cover a name belongs to the city drawn after it.
  const placed = layoutCities(pts, projection, { w, h });
  const dots = placed
    .map((c) => `<circle class="region-city-dot" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="4"/>`)
    .join('');
  const labels = placed
    .map((c) => {
      // Pushed off its dot, the label needs to say which dot it belongs to.
      const moved = Math.abs(c.labelY - c.y) > 1 || Math.abs(c.labelX - c.x) > LABEL_GAP + 1;
      const leader = moved
        ? `<line class="region-city-leader" x1="${c.x.toFixed(1)}" y1="${c.y.toFixed(1)}"
                 x2="${c.labelX.toFixed(1)}" y2="${c.labelY.toFixed(1)}"/>`
        : '';
      return `
        <g class="region-city${c.flip ? ' is-flipped' : ''}">
          ${leader}
          <text class="region-city-label" x="${c.labelX.toFixed(1)}" y="${c.labelY.toFixed(1)}">${esc(c.name)}</text>
        </g>`;
    })
    .join('');

  // Gated on `scaleBar`, the same flag that already marks "this is a cluster/route map, not
  // the trip-wide band" at the call site — a Maps link and an OSM credit are both real facts
  // about *this* map's own points, not something the band above has an equivalent of.
  const osmCredit = streets
    ? 'Streets: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    : '';
  const credit = [osmCredit].filter(Boolean).join(' · ');

  // aria-hidden, and deliberately: every name on it is in the heading and the prose below,
  // so to a screen reader this band is decoration that would otherwise be read twice. The
  // credit line is its own element after the `<svg>`, not inside it, since a screen reader
  // does need to reach it even though the map itself is decoration.
  return `
    <svg class="region-map" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      ${land ? `<g class="region-land">${land}</g>` : ''}
      ${streets ? `<g class="region-streets">${streets}</g>` : ''}
      <g class="region-route-line">${routePath}</g>
      <g class="region-dots">${dots}</g>
      <g class="region-labels">${labels}</g>
      ${scaleBar ? scaleBarHtml(pts, projection, h) : ''}
      ${scaleBar ? compassHtml(w) : ''}
    </svg>
    ${credit ? `<p class="map-credit">${credit}</p>` : ''}`;
}

function regionMapHtml(meta, features) {
  return pointsMapHtml(meta.cities, {
    w: REGION_W, h: REGION_H, pad: REGION_PAD, margin: REGION_MARGIN, minSpanLon: MIN_SPAN_LON,
    features, country: meta.country,
  });
}

// ---------- legacy path: a Markdown travelogue with `meta.areas` in index.json ----------
//
// A trip whose `file` ends in `.md` still renders this way. No current trip does both — the
// one trip that ever used `areas` (see `renderTripContent` below for its replacement) has
// moved to a JSON content file — but a future Markdown-only trip that just wants a photo
// gallery and prose keeps working unchanged, so this stays rather than being ripped out.
//
// `meta.areas` pairs a section heading with the spots to plot under it — e.g. one
// neighbourhood's worth of a city's attractions, or a trail's day-by-day stops. Matched by
// exact heading text against the rendered headings, since that's the one thing both the
// data and the Markdown agree on. Both `<h2>` and `<h3>` are searched, since a dense city
// splits into several `<h3>` clusters under its own `<h2>` while a small one stays a single
// section.
//
// A heading's points aren't always one cluster: a section whose named spots span too far
// apart for one walkable-scale map (a day's theme that happens to visit two different cities,
// say) is split into several `area` entries that all share the same `heading` text —
// assets/data/check-areas.py's distance cap is what decides that split when the data is
// written, not anything here. This function's job is only to render every area under a given
// heading, in the order they're listed, as that many separate maps.
//
// `streets` is this trip's preloaded `travel/streets/<id>.json` (or `{}` if there isn't one).
// Its keys mostly are the heading text — see the comment above `streetsPathHtml` — except
// where a heading covers more than one area, where `streetsKey` below disambiguates them the
// same way assets/data/build-streets.py's `area_key()` does; the two must stay in step; if
// this drifts, streetWays will look up either the wrong area's ways or `undefined`, silently
// leaving one of two maps under the same heading blank rather than throwing. A route map
// (`area.route`) gets its streets too, but build-streets.py fetches those with a much lighter
// touch: the Camino spans ~100km, so it's queried down through tertiary roads only, over a
// tighter box than the map's own rendered frame — full street-level detail across that much
// of Galicia would dwarf every city cluster combined.
function streetsKey(areas, area) {
  const sameHeading = areas.filter((a) => a.heading === area.heading);
  if (sameHeading.length === 1) return area.heading;
  return `${area.heading} #${sameHeading.indexOf(area) + 1}`;
}

function insertAreaMaps(bodyEl, meta, streets) {
  const areas = meta.areas || [];
  if (!areas.length) return;

  const headings = [...bodyEl.querySelectorAll('h2, h3')];
  // Grouped by heading text first, so every area sharing one heading is inserted together in
  // one `insertAdjacentHTML` call — calling it once per area on the same heading element would
  // insert each new map right after the heading itself, pushing the previous one down and
  // rendering the group in reverse of the order `meta.areas` actually lists them in.
  const byHeading = new Map();
  areas.forEach((area) => {
    if (!byHeading.has(area.heading)) byHeading.set(area.heading, []);
    byHeading.get(area.heading).push(area);
  });

  byHeading.forEach((group, headingText) => {
    const heading = headings.find((h) => h.textContent.trim() === headingText);
    if (!heading) return;
    const html = group
      .map((area) => pointsMapHtml(area.points, {
        w: AREA_SIZE, h: AREA_SIZE, pad: AREA_PAD,
        margin: AREA_MARGIN, minSpanLon: AREA_MIN_SPAN_LON, route: !!area.route,
        scaleBar: true, streetWays: streets[streetsKey(areas, area)],
      }))
      .join('');
    if (html) heading.insertAdjacentHTML('afterend', html);
  });
}

// ---------- current path: a trip whose `file` is a JSON content document ----------
//
// The point of this format over the Markdown one above: a subsection's `points` are the
// map's data *and* the prose's data, the same array, so there is no heading text for the two
// to agree on and nothing for assets/data/check-areas.py to have needed to lint in the first
// place. A map is built straight from the object being rendered, not found afterwards by
// searching the DOM for a heading that happens to match a string stored somewhere else.

// One `<h4>` block per point — the closest thing this format has to the old Markdown's own
// `#### Name` / `*Kind*` / prose paragraphs, kept only because a point may not have a `body`
// yet (see the module-level note in travel/202610222105.json): a name and a kind alone still
// reads as an entry, not as a blank space where one is missing.
function pointHtml(point) {
  return `
    <h4>${esc(point.name)}</h4>
    ${point.kind ? `<p><em>${esc(point.kind)}</em></p>` : ''}
    ${(point.body || []).map((p) => `<p>${marked.parseInline(p)}</p>`).join('')}`;
}

// A subsection's own points, split by CLUSTER_CAP_M into however many maps that actually
// takes — almost always one. `keyBase` plus a `#N` suffix when there is more than one group
// is the exact key assets/data/build-streets.py's `cluster_points` output is cached under.
function subsectionMapsHtml(points, streets, keyBase) {
  const groups = clusterPoints(points, CLUSTER_CAP_M);
  return groups
    .map((group, i) => pointsMapHtml(group, {
      w: AREA_SIZE, h: AREA_SIZE, pad: AREA_PAD, margin: AREA_MARGIN, minSpanLon: AREA_MIN_SPAN_LON,
      scaleBar: true, streetWays: streets[groups.length === 1 ? keyBase : `${keyBase} #${i + 1}`],
    }))
    .join('');
}

function introHtml(paragraphs) {
  return (paragraphs || []).map((p) => `<p>${marked.parseInline(p)}</p>`).join('');
}

// Two points that end up this close together — a day's own cathedral and the hostel across
// its square, say, named in two different subsections — are one physical stop, not two: on a
// route map spanning a whole region they'd otherwise sit as overlapping dots with fighting
// labels at the one place the trail actually pauses for two days. `clusterPoints` at a small
// radius groups them the same way it groups a subsection's own points at the much larger
// CLUSTER_CAP_M; picking the first of each group keeps the earliest-named point (and the
// route line's order) rather than an arbitrary one.
const SAME_SITE_M = 300;

function dedupeSameSite(points) {
  return clusterPoints(points, SAME_SITE_M).map((group) => group[0]);
}

// `skipMap` is set for a subsection inside a `route` section — its points are already drawn
// on the one combined map `sectionHtml` renders for the whole section, so a second map here
// with the same points (or a same-day subset of them) would just repeat it.
function subsectionHtml(sub, streets, sectionHeading, skipMap) {
  const points = sub.points || [];
  return `
    <h3>${esc(sub.heading)}</h3>
    ${skipMap ? '' : subsectionMapsHtml(points, streets, `${sectionHeading} / ${sub.heading}`)}
    ${sub.lodging ? `<p>Lodging: ${esc(sub.lodging)}</p>` : ''}
    ${introHtml(sub.intro)}
    ${points.map(pointHtml).join('')}`;
}

// A `route` section (the Camino) draws one map for the whole section, under its own `<h2>`,
// pooling every subsection's points — a day-by-day narrative, one combined line on the map —
// rather than the CLUSTER_CAP_M split a city section's subsections get, since a route is
// deliberately the one kind of section meant to span a whole region. Its own key has no `/
// subheading` or `#N` suffix: there is exactly one map, so there is nothing to disambiguate.
function sectionHtml(section, streets) {
  const subs = section.subsections || [];
  const routeMap = section.route
    ? pointsMapHtml(dedupeSameSite(subs.flatMap((s) => s.points || [])), {
      w: AREA_SIZE, h: AREA_SIZE, pad: AREA_PAD, margin: AREA_MARGIN, minSpanLon: AREA_MIN_SPAN_LON,
      route: true, scaleBar: true, streetWays: streets[section.heading],
    })
    : '';
  return `
    <h2>${esc(section.heading)}</h2>
    ${routeMap}
    ${section.lodging ? `<p>Lodging: ${esc(section.lodging)}</p>` : ''}
    ${introHtml(section.intro)}
    ${subs.map((s) => subsectionHtml(s, streets, section.heading, !!section.route)).join('')}`;
}

// The day-by-day table and its Google Maps link are regenerated from `stops` every render —
// the link is never itself stored, so there is nothing in the data for it to go stale against.
function dailyItineraryHtml(days) {
  if (!days || !days.length) return '';
  const dayHtml = days.map((day) => {
    const rows = day.stops.map((s) => `
      <tr>
        <td>${esc(s.time)}</td>
        <td>${esc(s.place)}</td>
        <td>${Number.isFinite(s.lat) ? `${s.lat}, ${s.lon}` : '—'}</td>
      </tr>`).join('');
    const url = googleMapsUrl(day.stops);
    return `
      <h3>${esc(day.heading)}</h3>
      <table>
        <thead><tr><th>Time</th><th>Place</th><th>Coordinates</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${url ? `<p><a href="${url}" target="_blank" rel="noopener">Google Maps</a></p>` : ''}`;
  }).join('');
  return `<h2>Day-by-Day Itinerary</h2>${dayHtml}`;
}

function lodgingTableHtml(rows) {
  if (!rows || !rows.length) return '';
  const body = rows.map((r) => `
    <tr><td>${esc(r.date)}</td><td>${esc(r.name)}</td><td>${r.lat}, ${r.lon}</td></tr>`).join('');
  return `
    <h2>Lodging Coordinates</h2>
    <table>
      <thead><tr><th>Date</th><th>Lodging</th><th>Coordinates</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function renderTripContent(data, meta, streets) {
  const bodyEl = tripEl.querySelector('.prose');
  bodyEl.innerHTML = (data.sections || []).map((s) => sectionHtml(s, streets)).join('')
    + dailyItineraryHtml(data.dailyItinerary)
    + lodgingTableHtml(data.lodgingTable)
    + (data.note ? `<h2>Coordinate note</h2><p>${esc(data.note)}</p>` : '');
  decorateBody(bodyEl, tocEl);
  appendPhotoStrip(bodyEl, meta);
  tripPhotos = buildGalleries(bodyEl);
  return bodyEl;
}

function headerHtml(meta, features) {
  const where = [meta.country, meta.continent].filter(Boolean).join(' · ');
  const mapHtml = regionMapHtml(meta, features);
  return `
    <div class="trip-header">
      <h1>${esc(tripTitle(meta))}</h1>
      ${where ? `<p class="venue">${esc(where)}</p>` : ''}
      ${tripDuration(meta) ? `<p class="publish-date">${esc(fmtDuration(tripDuration(meta)))}</p>` : ''}
      <div class="tags">${(meta.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    </div>
    ${mapHtml ? `<div class="trip-map">${mapHtml}</div>` : ''}
    ${flightsHtml(meta)}`;
}

// ---------- the flights ----------
//
// A flight is its legs in order, and a transfer is only the seam between two of them —
// there is no separate thing to model. Every time is local to its own airport, which is
// what the boarding pass prints and the one form the reader can check against one, so
// nothing here converts a time into anywhere else's clock.
//
// Which is also why no leg shows how long it took. That needs a timezone for both of its
// airports, and this file has neither — it has a code and a city name. A layover is the
// one duration that survives: both of its clocks belong to the same airport, so the
// subtraction is real elapsed time without knowing which zone they are in.

// "2025/12/28 18:30" — the trip's own `/` date, then a 24-hour clock. The time is
// optional, and a leg with only a date shows only a date rather than an invented 00:00.
function splitStamp(stamp) {
  const [date = '', time = ''] = String(stamp || '').trim().split(/\s+/);
  return { date, time };
}

// `tripDuration` and `flightsDuration` live in ui.js — the travel page frames its cards on
// the same dates, so the derivation is shared rather than owned by this page.

// Minutes since an arbitrary epoch — a number to subtract another one from, meaningless
// alone. Through Date.UTC so the arithmetic cannot pick up the reader's own timezone or
// its summer time; null when there is no full stamp to measure.
function stampMinutes(stamp) {
  const { date, time } = splitStamp(stamp);
  const [y, m, d] = date.split('/').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  if (![y, m, d, hh, mm].every(Number.isFinite)) return null;
  return Date.UTC(y, m - 1, d, hh, mm) / 60000;
}

function fmtGap(mins) {
  if (!Number.isFinite(mins) || mins < 0) return '';
  const [h, m] = [Math.floor(mins / 60), mins % 60];
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// Whole days between two stamps' dates. Every time on a card is badged against the card's
// own date, the way a ticket badges an overnight arrival "+1" — and for the same reason:
// a transfer that sits over midnight leaves the next leg boarding at 01:55 on a day the
// card never names, and a bare "01:55" under a heading reading June 14 is a lie.
function dayShift(from, to) {
  const day = (stamp) => {
    const [y, m, d] = splitStamp(stamp).date.split('/').map(Number);
    return [y, m, d].every(Number.isFinite) ? Date.UTC(y, m - 1, d) / 86400000 : null;
  };
  const [a, b] = [day(from), day(to)];
  return a == null || b == null ? 0 : b - a;
}

// Rotated onto its side: the icon points north-east as drawn, and this line runs east.
const PLANE_ICON =
  '<svg class="leg-plane" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>';

// The code is the headline; the city name rides up into the card's head as the route
// ("Taipei to Osaka"), so an end here is just its code, its time, and — when a leg crosses
// midnight — the day it lands on. Given only a city and no code, the city is the headline.
// The full date rides its own line under the time, carried on every end, so a red-eye that
// lands the next morning shows that day plainly, and the two ends' times share a baseline.
function endHtml(place, stamp, cls) {
  const code = place.code || place.city || '';
  const { date, time } = splitStamp(stamp);
  const dateText = date ? fmtPart(date) : '';
  return `
    <div class="leg-end ${cls}">
      <span class="leg-code">${esc(code)}</span>
      <span class="leg-time">${esc(time)}</span>
      ${dateText ? `<span class="leg-day">${esc(dateText)}</span>` : ''}
    </div>`;
}

function legHtml(leg, origin) {
  const carrier = [leg.airline, leg.number].filter(Boolean).join(' ');
  return `
    <li class="flight-leg">
      ${endHtml(leg.from, leg.depart, 'is-depart')}
      <div class="leg-path">
        <span class="leg-line">${PLANE_ICON}</span>
        ${carrier ? `<p class="leg-carrier">${esc(carrier)}</p>` : ''}
      </div>
      ${endHtml(leg.to, leg.arrive, 'is-arrive')}
    </li>`;
}

function layoverHtml(leg, next) {
  if (!next) return '';
  const [a, b] = [stampMinutes(leg.arrive), stampMinutes(next.depart)];
  const gap = a == null || b == null ? '' : fmtGap(b - a);

  // Landing at one airport and leaving from another is a different afternoon from waiting
  // at a gate, and the two codes are the only place that difference shows.
  const moved = leg.to.code && next.from.code && leg.to.code !== next.from.code;
  const at = moved
    ? `changing airport, ${leg.to.code} → ${next.from.code}`
    : (next.from.city || next.from.code || '') && `in ${next.from.city || next.from.code}`;

  return `<li class="flight-layover">${esc([gap, at].filter(Boolean).join(' ') || 'Transfer')}</li>`;
}

function flightHtml(flight) {
  const legs = (flight.legs || []).filter((l) => l && l.from && l.to);
  if (!legs.length) return '';

  const origin = legs[0].depart;
  const rows = legs.flatMap((leg, i) => [legHtml(leg, origin), layoverHtml(leg, legs[i + 1])]);

  // The journey as its endpoints, city to city — the first leg's origin to the last leg's
  // destination, so a trip through a transfer still reads as where it began and where it
  // ended. This is the head's headline; the direction label sits beside it, quietened.
  const ends = [legs[0].from, legs[legs.length - 1].to].map((p) => p.city || p.code || '');
  const route = ends.every(Boolean) ? `${ends[0]} - ${ends[1]}` : '';
  const head = route ? `
    <p class="flight-head">
      ${route ? `<span class="flight-route">${esc(route)}</span>` : ''}
    </p>` : '';

  return `
    <div class="flight">
      ${head}
      <ol class="flight-legs">${rows.filter(Boolean).join('')}</ol>
    </div>`;
}

function flightsHtml(meta) {
  const flights = (meta.flights || []).map(flightHtml).filter(Boolean);
  if (!flights.length) return '';
  return `
    <section class="flights" aria-label="Flights">
      ${flights.join('<br />')}
    </section>`;
}

// A run of images becomes one of two things. By default each photo stands on its own down
// the page as a captioned figure. Wrap the run in `<div class="photo-strip">` in the
// Markdown — a plain element with a class, which marked passes straight through — and it
// becomes one horizontal filmstrip that scrolls instead. A photo with a sentence beside it
// is prose, and is left exactly as written.
//
// (The images inside a `<div class="photo-strip">` need a blank line before and after them,
// or marked treats the whole block as raw HTML and never parses them into images.)
function buildGalleries(bodyEl) {
  const photos = [];

  // One <img> → a button the lightbox can open, registered in `photos` in document order.
  // The grid cell keeps the small thumbnail `src`; the lightbox gets the larger `data-full`
  // when one is set (repo photos), falling back to the same src for plain markdown images.
  const cellFor = (img) => {
    const i = photos.push({ src: img.dataset.full || img.src, alt: img.alt }) - 1;
    return `
        <button class="photo" type="button" data-photo="${i}" aria-label="${esc(img.alt || 'Open photo')}">
          <img src="${esc(img.src)}" alt="${esc(img.alt)}" loading="lazy">
        </button>`;
  };

  // `.photo-strip` wrappers and bare image paragraphs in one document-ordered pass, so the
  // lightbox steps through every photo in the order it appears. Replacing a strip whole
  // detaches the <p> marked nested inside it, so that <p> is skipped when the loop reaches it.
  bodyEl.querySelectorAll('.photo-strip, p').forEach((el) => {
    if (!bodyEl.contains(el)) return; // Already consumed as part of a strip above.

    if (el.classList.contains('photo-strip')) {
      const imgs = [...el.querySelectorAll('img')];
      if (!imgs.length) return;

      // The filmstrip: captions would outweigh the pictures here, so they live in the
      // lightbox instead. Each photo's real aspect ratio sets its width against the shared
      // row height — the markdown only gave a src, so the ratio is read off the image once
      // it has loaded and written back as `--ar`; until then the CSS fallback (1.5) holds.
      const box = document.createElement('div');
      box.className = 'photo-grid';
      box.innerHTML = imgs.map(cellFor).join('');
      el.replaceWith(box);

      box.querySelectorAll('.photo').forEach((btn) => {
        const im = btn.querySelector('img');
        // Each cell holds a skeleton until its thumbnail arrives; loading it also reports the
        // true ratio, so both are cleared in one pass. `is-loading` is set before first paint.
        const done = () => {
          if (im.naturalWidth && im.naturalHeight) {
            btn.style.setProperty('--ar', (im.naturalWidth / im.naturalHeight).toFixed(4));
          }
          btn.classList.remove('is-loading');
        };
        btn.classList.add('is-loading');
        if (im.complete) done();
        else {
          im.addEventListener('load', done, { once: true });
          im.addEventListener('error', () => btn.classList.remove('is-loading'), { once: true });
        }
      });
      return;
    }

    // A bare paragraph of images and nothing else: each photo stacks down the page as its
    // own captioned figure.
    const imgs = [...el.children].filter((c) => c.tagName === 'IMG');
    if (!imgs.length || imgs.length !== el.children.length) return;
    if (el.textContent.trim()) return;

    const frag = document.createDocumentFragment();
    imgs.forEach((img) => {
      const fig = document.createElement('figure');
      fig.className = 'photo-figure';
      fig.innerHTML = cellFor(img) + (img.alt ? `<figcaption>${esc(img.alt)}</figcaption>` : '');
      frag.appendChild(fig);
    });
    el.replaceWith(frag);
  });

  return photos;
}

// The trip's own photos, declared in index.json instead of the travelogue: a `photos` array
// on the trip's entry, each item a filename served from the root of that trip's photo repo
// (or an object with `file` and optional `alt`, or a full http(s) URL to override the
// repo). They render as one filmstrip at the foot of the note by building the same
// `<div class="photo-strip">` the Markdown hack used to spell out by hand, then letting
// buildGalleries turn it into a grid — so the lightbox and aspect-ratio fitting come for
// free and there is no marked quirk.
function photoUrl(file, meta) {
  if (/^https?:\/\//.test(file)) return file; // A full URL is used as written.
  // `photoRepo` overrides the id-named default, and may pin a branch with "…@branch".
  const slug = meta.photoRepo || `${PHOTO_REPO_OWNER}/${meta.id}`;
  const [repo, branch = PHOTO_REPO_BRANCH] = slug.split('@');
  return `${PHOTO_CDN}/${repo}@${branch}/${encodeURIComponent(file)}`;
}

// A repo photo routed through the resize proxy at a target width, as WebP. The proxy caches
// per distinct URL, so the same width is fetched once and served from its CDN thereafter.
function sizedUrl(url, width, quality) {
  const params = new URLSearchParams({ url, w: String(width), q: String(quality), output: 'webp' });
  return `${PHOTO_PROXY}?${params.toString()}`;
}

function appendPhotoStrip(bodyEl, meta) {
  const names = meta.photos || [];
  if (!names.length) return;

  const strip = document.createElement('div');
  strip.className = 'photo-strip';
  strip.innerHTML = names
    .map((p) => {
      const file = typeof p === 'string' ? p : p.file;
      if (!file) return '';
      const alt = typeof p === 'string' ? file.replace(/\.[^.]+$/, '') : (p.alt || '');
      const raw = photoUrl(file, meta);
      // A one-off full URL is left as written; a repo photo is loaded small for the strip,
      // with the larger lightbox size carried on `data-full` for buildGalleries to pick up.
      if (/^https?:\/\//.test(file)) return `<img src="${esc(raw)}" alt="${esc(alt)}">`;
      const thumb = sizedUrl(raw, PHOTO_THUMB_W, 75);
      const full = sizedUrl(raw, PHOTO_FULL_W, 80);
      return `<img src="${esc(thumb)}" data-full="${esc(full)}" alt="${esc(alt)}">`;
    })
    .join('');
  bodyEl.appendChild(strip);
}

// Wired once, against `.prose` and the module-level `tripPhotos` array that renderProse
// fills, so the lightbox reads whatever is currently in the gallery.
function initLightbox(bodyEl) {
  if (!tripPhotos.length) return; // No photos in this travelogue.

  const box = document.createElement('div');
  box.className = 'lightbox';
  box.hidden = true;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', 'Photo');
  box.innerHTML = `
    <button class="lightbox-btn lightbox-close" type="button" data-close aria-label="Close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>
    <button class="lightbox-btn lightbox-prev" type="button" data-step="-1" aria-label="Previous photo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
    </button>
    <figure class="lightbox-figure">
      <img class="lightbox-img" alt="">
      <figcaption class="lightbox-caption"></figcaption>
    </figure>
    <button class="lightbox-btn lightbox-next" type="button" data-step="1" aria-label="Next photo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
    </button>`;
  document.body.appendChild(box);

  const imgEl = box.querySelector('.lightbox-img');
  const capEl = box.querySelector('.lightbox-caption');
  const closeEl = box.querySelector('[data-close]');
  const stepEls = [...box.querySelectorAll('[data-step]')];

  let at = 0;
  let opener = null; // Where focus came from, and where it has to go back to.

  function show(i) {
    const photos = tripPhotos;
    at = (i + photos.length) % photos.length; // Wraps, so the arrows never dead-end.
    capEl.textContent = photos[at].alt || '';
    capEl.hidden = !photos[at].alt;
    imgEl.alt = photos[at].alt;
    imgEl.src = photos[at].src;
  }

  function open(i, from) {
    opener = from;
    // A single photo has nowhere to step to.
    stepEls.forEach((el) => { el.hidden = tripPhotos.length < 2; });
    show(i);
    box.hidden = false;
    document.body.classList.add('is-locked');
    closeEl.focus();
  }

  function close() {
    box.hidden = true;
    document.body.classList.remove('is-locked');
    opener?.focus();
    opener = null;
  }

  bodyEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-photo]');
    if (btn) open(Number(btn.dataset.photo), btn);
  });

  box.addEventListener('click', (e) => {
    const step = e.target.closest('[data-step]');
    if (step) return show(at + Number(step.dataset.step));
    // The backdrop is the dialog itself; a click that lands on the photo is not a miss.
    if (e.target.closest('[data-close]') || !e.target.closest('.lightbox-figure')) close();
  });

  document.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft' && tripPhotos.length > 1) show(at - 1);
    else if (e.key === 'ArrowRight' && tripPhotos.length > 1) show(at + 1);
  });
}

// ---------- render ----------
//
// The section maps and the photo strip are driven by `meta`, not by the Markdown, so they
// are stitched in here after the prose is laid down.
let tripStreets = {};
let tripPhotos = [];

function renderProse(markdown, meta) {
  const bodyEl = tripEl.querySelector('.prose');
  bodyEl.innerHTML = renderMarkdown(markdown);
  decorateBody(bodyEl, tocEl);
  insertAreaMaps(bodyEl, meta, tripStreets);
  appendPhotoStrip(bodyEl, meta);
  tripPhotos = buildGalleries(bodyEl);
  return bodyEl;
}

if (!id) {
  tripEl.innerHTML = emptyState({
    icon: 'file',
    title: 'No trip specified',
    description: 'This page needs an <code>?id=</code> parameter to know which trip to open.',
    actions: '<a class="btn" href="travel.html">Back to the map</a>',
  });
} else {
  Promise.all([
    fetch('travel/index.json').then((r) => r.json()),
    // The band under the title is the one thing on this page that is decoration. If the
    // atlas will not load, the trip still reads — so this failure resolves to no map
    // rather than joining the rejection below and taking the travelogue with it.
    fetch(WORLD_SRC)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ])
    .then(([trips, world]) => {
      const meta = trips.find((t) => t.id === id);
      if (!meta) throw new Error('not found');

      const features = world ? topojson.feature(world, world.objects.countries).features : [];
      document.title = `${tripTitle(meta)} — Travels`;

      // An entry with no `file` is a place and a date on the map and nothing more —
      // it has been logged, not written up. Show what there is rather than 404ing.
      if (!meta.file) {
        tripEl.innerHTML = headerHtml(meta, features) + emptyState({
          icon: 'file',
          title: 'Not written up yet',
          description: 'This trip is on the map, but there is no travelogue for it.',
          actions: '<a class="btn" href="travel.html">Back to the map</a>',
        });
        return;
      }

      // `.json` is the current content format (see `renderTripContent`); `.md` is the older
      // Markdown-plus-index.json-areas one, still served as-is for any trip that hasn't been
      // migrated yet.
      const isJson = meta.file.endsWith('.json');

      return Promise.all([
        fetch(`travel/${meta.file}`).then((r) => {
          if (!r.ok) throw new Error(r.status);
          return isJson ? r.json() : r.text();
        }),
        // Preloaded street geometry for this trip's cluster maps (assets/data/build-streets.py),
        // fetched alongside the travelogue rather than after it renders: this is data the
        // page already has on disk, not a live query, so there's no reason for the maps to
        // wait on it in series. Its own absence is normal, not an error — a trip with no
        // cluster maps, or one whose streets haven't been generated yet, just gets plain dot
        // maps instead.
        fetch(`travel/streets/${meta.id}.json`)
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({})),
      ])
        .then(([content, streets]) => {
          tripStreets = streets;
          tripEl.innerHTML = `${headerHtml(meta, features)}<div class="prose"></div>`;
          if (isJson) renderTripContent(content, meta, streets);
          else renderProse(content, meta);
          initLightbox(tripEl.querySelector('.prose'));
        });
    })
    .catch(() => {
      tripEl.innerHTML = emptyState({
        icon: 'search',
        title: 'Trip not found',
        description: `No trip matches <code>${esc(id)}</code>, or its file could not be fetched. ${SERVE_HINT}`,
        actions: '<a class="btn" href="travel.html">Back to the map</a>',
      });
    });
}
