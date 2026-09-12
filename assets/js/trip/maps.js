// The trip page's maps: the region band under the title and the per-section cluster maps.
// Uses the global `d3` (d3-geo). Sizes and margins are mirrored in build-streets.py.
import { esc, plural } from '../shared/dom.js';
import { hasCoords, fmtPoint } from '../shared/atlas.js';

const REGION = { w: 800, h: 800, pad: 16, margin: 2.1, minSpanLon: 13 };
const AREA = { w: 700, h: 700, pad: 16, margin: 1.6, minSpanLon: 0.004 };

const LABEL_GAP = 11;
const LABEL_LINE = 15;
const LABEL_CHAR_W = 6.6; // Rough advance of 12px sans; enough to detect collisions.
const DOT_MIN_SEP = 9;
const SCALE_STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000];

// The box to frame, as four loose corners: a MultiPoint has no winding for d3 to misread,
// and under Mercator the corners are the box.
function framingBox(points, { margin, minSpanLon, w, h }) {
  const lons = points.map((c) => c.lon);
  const lats = points.map((c) => c.lat);
  const [west, east, south, north] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const spanLon = Math.max((east - west) * margin, minSpanLon);
  const spanLat = Math.max((north - south) * margin, (minSpanLon * h) / w);
  const [cx, cy] = [(west + east) / 2, (south + north) / 2];
  const [dx, dy] = [spanLon / 2, spanLat / 2];
  return {
    type: 'MultiPoint',
    coordinates: [[cx - dx, cy - dy], [cx + dx, cy - dy], [cx - dx, cy + dy], [cx + dx, cy + dy]],
  };
}

// Nudge apart dots that would render as one blob, along the line between them.
function declumpDots(placed) {
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const [a, b] = [placed[i], placed[j]];
      const [dx, dy] = [b.x - a.x, b.y - a.y];
      const dist = Math.hypot(dx, dy);
      if (dist >= DOT_MIN_SEP) continue;
      const push = (DOT_MIN_SEP - dist) / 2;
      const [ux, uy] = dist > 0.01 ? [dx / dist, dy / dist] : [1, 0];
      a.x -= ux * push; a.y -= uy * push;
      b.x += ux * push; b.y += uy * push;
    }
  }
}

// Projects the cities, then moves labels (never dots) until none overlaps another label or dot.
function layoutCities(cities, projection, { w, h }) {
  const placed = cities
    .map((c) => {
      const p = projection([c.lon, c.lat]);
      return p && { name: c.name, x: p[0], y: p[1], width: c.name.length * LABEL_CHAR_W };
    })
    .filter(Boolean);

  declumpDots(placed);
  placed.forEach((c) => {
    c.flip = c.x > w * 0.7; // Near the right edge, put the label on the left.
    c.labelX = c.flip ? c.x - LABEL_GAP : c.x + LABEL_GAP;
    c.labelY = c.y;
  });
  placed.sort((a, b) => a.y - b.y);

  const span = (c) => (c.flip ? [c.labelX - c.width, c.labelX] : [c.labelX, c.labelX + c.width]);
  const hits = (c, x0, x1, y) => {
    const [b0, b1] = span(c);
    return Math.abs(c.labelY - y) < LABEL_LINE && b0 < x1 && x0 < b1;
  };

  placed.forEach((c, i) => {
    for (const prev of placed.slice(0, i)) {
      const [a0, a1] = span(prev);
      if (hits(c, a0, a1, prev.labelY)) c.labelY = prev.labelY + LABEL_LINE;
    }
    c.labelY = Math.min(c.labelY, h - 8);
    for (const other of placed) {
      if (other === c || !hits(c, other.x - 5, other.x + 5, other.y)) continue;
      c.labelX = c.flip ? Math.min(c.labelX, other.x - LABEL_GAP) : Math.max(c.labelX, other.x + LABEL_GAP);
    }
  });
  return placed;
}

// A round-number bar at least 70px long, measured at the cluster's centre latitude.
function scaleBarHtml(pts, projection, h) {
  const cx = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const p0 = projection([cx, cy]);
  if (!p0) return '';
  const metersPerDeg = 111_320 * Math.cos((cy * Math.PI) / 180);

  let meters = SCALE_STEPS[0];
  let px = 0;
  for (const m of SCALE_STEPS) {
    const p1 = projection([cx + m / metersPerDeg, cy]);
    if (!p1) continue;
    meters = m;
    px = Math.abs(p1[0] - p0[0]);
    if (px >= 70) break;
  }
  if (!px) return '';

  const x = px.toFixed(1);
  const label = meters >= 1000 ? plural(meters / 1000, 'kilometre') : plural(meters, 'metre');
  return `
    <g class="region-scale" transform="translate(14, ${h - 16})">
      <line x1="0" y1="0" x2="${x}" y2="0"/>
      <line x1="0" y1="-4" x2="0" y2="4"/>
      <line x1="${x}" y1="-4" x2="${x}" y2="4"/>
      <text x="${(px / 2).toFixed(1)}" y="-7" text-anchor="middle">${label}</text>
    </g>`;
}

const compassHtml = (w) => `
    <g class="region-compass" transform="translate(${w - 24}, 24)">
      <line x1="0" y1="8" x2="0" y2="-7"/>
      <path d="M0,-9 l4,7 l-4,-2 l-4,2 Z"/>
      <text x="0" y="20" text-anchor="middle">N</text>
    </g>`;

function streetsHtml(ways, projection) {
  return ways
    .map((way) => {
      const pts = way.map((c) => projection(c)).filter(Boolean);
      return pts.length < 2 ? '' : `<path class="region-street" d="M${pts.map(fmtPoint).join('L')}" fill="none"/>`;
    })
    .join('');
}

function landHtml(countries, projection, here) {
  const path = d3.geoPath(projection);
  return countries
    .map((f) => {
      const d = path(f);
      if (!d) return '';
      const cls = f.properties.name === here ? 'region-country is-here' : 'region-country';
      return `<path class="${cls}" d="${d}"/>`;
    })
    .join('');
}

function mapHtml(points, frame, { countries = [], here = null, route = false, detail = false, streets = null } = {}) {
  const pts = (points || []).filter(hasCoords);
  if (!pts.length) return '';

  const { w, h, pad } = frame;
  const projection = d3.geoMercator().fitExtent([[pad, pad], [w - pad, h - pad]], framingBox(pts, frame));
  projection.clipExtent([[0, 0], [w, h]]); // Otherwise every country on earth gets a path.

  const land = countries.length ? landHtml(countries, projection, here) : '';
  const streetPaths = streets ? streetsHtml(streets, projection) : '';

  // In list order, before `layoutCities` re-sorts the points for labelling.
  const routePts = route ? pts.map((c) => projection([c.lon, c.lat])).filter(Boolean) : [];
  const routeLine = routePts.length > 1
    ? `<polyline class="region-route" points="${routePts.map(fmtPoint).join(' ')}" fill="none"/>`
    : '';

  // Dots and labels in separate layers so every label paints above every dot.
  const placed = layoutCities(pts, projection, { w, h });
  const dots = placed
    .map((c) => `<circle class="region-city-dot" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="4"/>`)
    .join('');
  const labels = placed
    .map((c) => {
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

  // Decorative for screen readers: every name is repeated in the text.
  return `
    <svg class="region-map" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      ${land ? `<g class="region-land">${land}</g>` : ''}
      ${streetPaths ? `<g class="region-streets">${streetPaths}</g>` : ''}
      <g class="region-route-line">${routeLine}</g>
      <g class="region-dots">${dots}</g>
      <g class="region-labels">${labels}</g>
      ${detail ? scaleBarHtml(pts, projection, h) + compassHtml(w) : ''}
    </svg>
    ${streetPaths ? '<p class="map-credit">Streets: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors</p>' : ''}`;
}

// Framed on the cities rather than the country: Hong Kong, not all of China.
export const regionMapHtml = (trip, countries) =>
  mapHtml(trip.cities, REGION, { countries, here: trip.country });

export const areaMapHtml = (points, { streets, route = false } = {}) =>
  mapHtml(points, AREA, { streets, route, detail: true });
