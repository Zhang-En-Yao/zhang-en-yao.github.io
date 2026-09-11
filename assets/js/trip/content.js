// Renders a trip's header and its JSON travelogue (sections → subsections → points).
// Uses the global `marked` for inline Markdown in prose strings.
import { esc } from '../shared/dom.js';
import { fmtDuration } from '../shared/format.js';
import { tripTitle, tripDuration } from '../shared/trips.js';
import { regionMapHtml, areaMapHtml } from './maps.js';
import { flightsHtml } from './flights.js';
import { clusterPoints, dedupeSameSite, CLUSTER_CAP_M } from './clusters.js';

export function headerHtml(trip, countries) {
  const where = [trip.country, trip.continent].filter(Boolean).join(' · ');
  const when = fmtDuration(tripDuration(trip));
  const map = regionMapHtml(trip, countries);
  return `
    <div class="trip-header">
      <h1>${esc(tripTitle(trip))}</h1>
      ${where ? `<p class="venue">${esc(where)}</p>` : ''}
      ${when ? `<p class="publish-date">${esc(when)}</p>` : ''}
    </div>
    ${map ? `<div class="trip-map">${map}</div>` : ''}
    ${flightsHtml(trip)}`;
}

const paragraphs = (list) => (list || []).map((p) => `<p>${marked.parseInline(p)}</p>`).join('');

const lodgingHtml = (item) => (item.lodging ? `<p>Lodging: ${esc(item.lodging)}</p>` : '');

const pointHtml = (point) => `
    <h4>${esc(point.name)}</h4>
    ${point.kind ? `<p><em>${esc(point.kind)}</em></p>` : ''}
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
function sectionHtml(section, streets) {
  const subs = section.subsections || [];
  const routeMap = section.route
    ? areaMapHtml(dedupeSameSite(subs.flatMap((s) => s.points || [])), { streets: streets[section.heading], route: true })
    : '';
  const subsHtml = subs.map((sub) => `
    <h3>${esc(sub.heading)}</h3>
    ${section.route ? '' : subsectionMapsHtml(sub.points || [], streets, `${section.heading} / ${sub.heading}`)}
    ${lodgingHtml(sub)}
    ${paragraphs(sub.intro)}
    ${(sub.points || []).map(pointHtml).join('')}`);

  return `
    <h2>${esc(section.heading)}</h2>
    ${routeMap}
    ${lodgingHtml(section)}
    ${paragraphs(section.intro)}
    ${subsHtml.join('')}`;
}

export const bodyHtml = (content, streets) => (content.sections || []).map((s) => sectionHtml(s, streets)).join('');
