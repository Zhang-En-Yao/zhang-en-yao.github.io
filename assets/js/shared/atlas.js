import { fetchJson } from './dom.js';
import { CORE } from './assets.js';

const WORLD_SRC = `${CORE}/atlas/countries-50m.json`;
const WORLD_DETAIL_SRC = `${CORE}/atlas/countries-10m.json`;
const MARINE_SRC = `${CORE}/atlas/marine-areas.json`;
export const CONTINENTS_SRC = `${CORE}/atlas/continents.json`;

// Uses the global `topojson` (topojson-client, loaded as a classic script).
const objects = async (src, ...names) => {
  const topo = await fetchJson(src);
  return names.map((name) => (topo.objects[name] ? topojson.feature(topo, topo.objects[name]).features : []));
};

// 1:50m — what every page paints first.
export async function loadCountries() {
  const [countries] = await objects(WORLD_SRC, 'countries');
  return countries;
}

// 1:10m — six times the detail and four times the bytes, so the world map fetches it only
// once someone zooms far enough in for the difference to show.
export async function loadDetailedCountries() {
  const [countries] = await objects(WORLD_DETAIL_SRC, 'countries');
  return countries;
}

// Named waters and the maritime boundaries between them.
export async function loadMarine() {
  const [areas, borders] = await objects(MARINE_SRC, 'areas', 'borders');
  return { areas, borders };
}

export const byCountryName = (features) => new Map(features.map((f) => [f.properties.name, f]));

export function polygonsOf(geometry) {
  if (!geometry) return [];
  return geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
}

export const hasCoords = (p) => Number.isFinite(p.lon) && Number.isFinite(p.lat);

export const fmtPoint = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
