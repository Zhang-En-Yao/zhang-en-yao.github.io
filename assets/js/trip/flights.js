// Flight cards. Every time is local to its own airport, as printed on the boarding pass, so
// nothing converts between zones and no leg shows a duration. A layover can: both of its
// clocks belong to the same airport.
import { esc } from '../shared/dom.js';
import { fmtPart } from '../shared/format.js';

const PLANE_ICON =
  '<svg class="leg-plane" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>';

// "2025/12/28 18:30" → { date: "2025/12/28", time: "18:30" }; the time is optional.
function splitStamp(stamp) {
  const [date = '', time = ''] = String(stamp || '').trim().split(/\s+/);
  return { date, time };
}

// Minutes on a zone-free clock (via Date.UTC), for subtracting two stamps at one airport.
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

function endHtml(place, stamp, cls) {
  const { date, time } = splitStamp(stamp);
  return `
    <div class="leg-end ${cls}">
      <span class="leg-code">${esc(place.code || place.city || '')}</span>
      <span class="leg-time">${esc(time)}</span>
      ${date ? `<span class="leg-day">${esc(fmtPart(date, { short: true }))}</span>` : ''}
    </div>`;
}

function legHtml(leg) {
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
  const [a, b] = [stampMinutes(leg.arrive), stampMinutes(next.depart)];
  const gap = a == null || b == null ? '' : fmtGap(b - a);
  const changesAirport = leg.to.code && next.from.code && leg.to.code !== next.from.code;
  const place = next.from.city || next.from.code;
  const where = changesAirport ? `changing airport, ${leg.to.code} → ${next.from.code}` : place && `in ${place}`;
  return `<li class="flight-layover">${esc([gap, where].filter(Boolean).join(' ') || 'Transfer')}</li>`;
}

function flightHtml(flight) {
  const legs = (flight.legs || []).filter((l) => l && l.from && l.to);
  if (!legs.length) return '';

  const rows = legs.map((leg, i) => legHtml(leg) + (legs[i + 1] ? layoverHtml(leg, legs[i + 1]) : ''));
  const ends = [legs[0].from, legs.at(-1).to].map((p) => p.city || p.code || '');
  const head = ends.every(Boolean)
    ? `<p class="flight-head">${esc(`${ends[0]} → ${ends[1]}`)}</p>`
    : '';

  return `
    <div class="flight">
      ${head}
      <ol class="flight-legs">${rows.join('')}</ol>
    </div>`;
}

export function flightsHtml(trip) {
  const flights = (trip.flights || []).map(flightHtml).filter(Boolean);
  return flights.length ? `<section class="flights" aria-label="Flights">${flights.join('')}</section>` : '';
}
