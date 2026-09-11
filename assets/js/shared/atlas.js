import { fetchJson } from './dom.js';

const WORLD_SRC = 'assets/data/countries-50m.json';

// Uses the global `topojson` (topojson-client, loaded as a classic script).
export async function loadCountries() {
  const world = await fetchJson(WORLD_SRC);
  return topojson.feature(world, world.objects.countries).features;
}

export const byCountryName = (features) => new Map(features.map((f) => [f.properties.name, f]));

export function polygonsOf(geometry) {
  if (!geometry) return [];
  return geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
}

export const hasCoords = (p) => Number.isFinite(p.lon) && Number.isFinite(p.lat);

export const fmtPoint = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
