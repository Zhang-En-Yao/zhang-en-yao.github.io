// Renders a trip's header and its JSON travelogue (sections → subsections → points).
// Uses the global `marked` for inline Markdown in prose strings.
import { esc } from '../shared/dom.js';
import { fmtRange } from '../shared/format.js';
import { tripTitle, tripDuration } from '../shared/trips.js';
import { regionMapHtml, areaMapHtml } from './maps.js';
import { flightsHtml } from './flights.js';
import { clusterPoints, dedupeSameSite, CLUSTER_CAP_M } from './clusters.js';
import { factsHtml } from '../shared/places.js';

export function headerHtml(trip, countries) {
  const where = [trip.country, trip.continent].filter(Boolean).join(' · ');
  const when = fmtRange(tripDuration(trip));
  const map = regionMapHtml(trip, countries);
  return `
    <div class="trip-header">
      ${where ? `<p class="trip-eyebrow">${esc(where)}</p>` : ''}
      <h1>${esc(tripTitle(trip))}</h1>
      ${when ? `<p class="trip-dates">${esc(when)}</p>` : ''}
    </div>
    ${map ? `<div class="trip-map">${map}</div>` : ''}
    ${flightsHtml(trip)}`;
}

const paragraphs = (list) => (list || []).map((p) => `<p>${marked.parseInline(p)}</p>`).join('');

const BED_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Lodging"><path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/></svg>';

const lodgingHtml = (item) => (item.lodging ? `<p class="lodging">${BED_ICON}<span>${esc(item.lodging)}</span></p>` : '');

const pointHtml = (point, places) => `
    <h4>${esc(point.name)}</h4>
    ${point.kind ? `<p class="point-kind">${esc(point.kind)}</p>` : ''}
    ${point.wikidata ? factsHtml(point.wikidata, places) : ''}
    ${paragraphs(point.body)}`;

// Street keys match build-streets.py: "Section / Subsection", plus " #N" when split.
function subsectionMapsHtml(points, streets, key) {
  const groups = clusterPoints(points, CLUSTER_CAP_M);
  return groups
    .map((group, i) => areaMapHtml(group, { streets: streets[groups.length === 1 ? key : `${key} #${i + 1}`] }))
    .join('');
}

// A `route` section (the Camino) gets one map of all its stops, keyed by the section
// heading, instead of a map per subsection.
function sectionHtml(section, streets, places) {
  const subs = section.subsections || [];
  const routeMap = section.route
    ? areaMapHtml(dedupeSameSite(subs.flatMap((s) => s.points || [])), { streets: streets[section.heading], route: true })
    : '';
  const subsHtml = subs.map((sub) => `
    <h3>${esc(sub.heading)}</h3>
    ${section.route ? '' : subsectionMapsHtml(sub.points || [], streets, `${section.heading} / ${sub.heading}`)}
    ${lodgingHtml(sub)}
    ${paragraphs(sub.intro)}
    ${(sub.points || []).map((p) => pointHtml(p, places)).join('')}`);

  return `
    <h2>${esc(section.heading)}</h2>
    ${routeMap}
    ${lodgingHtml(section)}
    ${paragraphs(section.intro)}
    ${subsHtml.join('')}`;
}

export const bodyHtml = (content, streets, places) =>
  (content.sections || []).map((s) => sectionHtml(s, streets, places)).join('');
