export const TRIPS_SRC = 'travel/index.json';

export const tripTitle = (trip) => (trip.cities || []).map((c) => c.name).join(' · ');

export const tripHref = (trip) => `trip.html?id=${encodeURIComponent(trip.id)}`;

// Without an explicit `duration`, a trip spans its flights. Stamps are airport-local and
// zero-padded, so a string sort is chronological.
export function tripDuration(trip) {
  if (trip.duration) return trip.duration;
  const stamps = (trip.flights || [])
    .flatMap((f) => f.legs || [])
    .flatMap((leg) => [leg.depart, leg.arrive])
    .filter(Boolean)
    .sort();
  return stamps.length ? `${stamps[0]}-${stamps[stamps.length - 1]}` : '';
}

// Ids lead with a zero-padded timestamp, so sorting them sorts by date.
export const newestFirst = (trips) => [...trips].sort((a, b) => String(b.id).localeCompare(String(a.id)));
