// The little country thumbnail that fronts a card — a trip's card on the travel page, a
// festival's card on the bucket list. Both pages draw the same shape the same way, so the
// drawing lives here once and neither page can disagree with the other about it.
//
// Depends on d3-geo and topojson-client being loaded first, and on the caller passing a
// `byName` map from country name to its atlas feature.
//
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

// `record` is anything with a `country` name and a `cities` array of {name, lat, lon}:
// a trip, or a festival's bucket-list entry. The dots mark every city on the record.
function thumbHtml(record, byName) {
  const country = byName.get(record.country);
  if (!country) return '';
  const cities = (record.cities || []).filter((c) => Number.isFinite(c.lon) && Number.isFinite(c.lat));
  const feat = thumbFeature(country, cities);
  if (!feat) return '';

  const projection = d3.geoMercator()
    .fitExtent([[THUMB_PAD, THUMB_PAD], [THUMB_W - THUMB_PAD, THUMB_H - THUMB_PAD]], feat);
  const d = d3.geoPath(projection)(feat);
  if (!d) return '';

  // Every stop, so the thumbnail shows its shape: one dot for Fukuoka, three strung across
  // Hokkaido.
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
