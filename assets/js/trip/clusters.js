// Grouping of map points. Keep in step with assets/data/build-streets.py, which fetches
// street geometry per group and caches it under the same keys.

// Largest span one cluster map may cover (Barcelona's waterfront, ~3.4 km, fits).
export const CLUSTER_CAP_M = 3500;

// Points closer than this on a route map are the same stop.
export const SAME_SITE_M = 300;

function haversineM(a, b) {
  const R = 6371000;
  const [lat1, lon1, lat2, lon2] = [a.lat, a.lon, b.lat, b.lon].map((d) => (d * Math.PI) / 180);
  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Single-linkage via union-find: points chain into one group through neighbours, so a long
// promenade stays together even when its ends are far apart. Groups keep input order.
export function clusterPoints(points, capM) {
  const parent = points.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (haversineM(points[i], points[j]) > capM) continue;
      const [ri, rj] = [find(i), find(j)];
      if (ri !== rj) parent[ri] = rj;
    }
  }
  const groups = new Map();
  points.forEach((p, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(p);
  });
  return [...groups.values()];
}

export const dedupeSameSite = (points) => clusterPoints(points, SAME_SITE_M).map((group) => group[0]);
