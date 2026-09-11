// The country thumbnail on travel and bucket-list cards. Uses the global `d3` (d3-geo).
import { polygonsOf, hasCoords } from './atlas.js';

const W = 112;
const H = 80;
const PAD = 9;

// Index of the polygon containing the city, or the nearest one by bounding box (a harbour
// city can fall just offshore at this resolution).
function landmassAt(polys, city) {
  const pt = [city.lon, city.lat];
  const inside = polys.findIndex((poly) => d3.geoContains({ type: 'Polygon', coordinates: poly }, pt));
  if (inside >= 0) return inside;

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

// Frame on the landmasses the cities are on, not the whole country: Okinawa rather than all
// of Japan, the Netherlands without Bonaire.
function framedFeature(country, cities) {
  const polys = polygonsOf(country.geometry);
  if (!polys.length) return null;
  if (polys.length < 2 || !cities.length) return country;

  const kept = new Set(cities.map((c) => landmassAt(polys, c)).filter((i) => i >= 0));
  if (!kept.size) return country;
  return {
    ...country,
    geometry: { type: 'MultiPolygon', coordinates: polys.filter((_, i) => kept.has(i)) },
  };
}

// `record` is anything with a `country` name and `cities` of {name, lat, lon}.
export function thumbHtml(record, byName) {
  const country = byName.get(record.country);
  if (!country) return '';
  const cities = (record.cities || []).filter(hasCoords);
  const feature = framedFeature(country, cities);
  if (!feature) return '';

  const projection = d3.geoMercator().fitExtent([[PAD, PAD], [W - PAD, H - PAD]], feature);
  const d = d3.geoPath(projection)(feature);
  if (!d) return '';

  const dots = cities
    .map((c) => {
      const p = projection([c.lon, c.lat]);
      return p ? `<circle class="trip-card-map-dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.6"/>` : '';
    })
    .join('');

  return `
    <svg class="trip-card-map" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      <path class="trip-card-map-shape" d="${d}"/>
      ${dots}
    </svg>`;
}
