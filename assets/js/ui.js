// Small helpers shared by every page: escaping, date display, and the shadcn-style
// Empty block. `emptyState` fields are trusted HTML — call sites escape anything
// coming from data.

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Dates are stored ISO so they sort as plain strings, and are never shown that way.
// Spelled out from a table rather than through toLocaleString: the month names are part
// of the page's design, not something to hand to whatever locale the browser is in.
function fmtDate(iso) {
  const [y, m] = String(iso || '').split('-');
  return m ? `${MONTHS[Number(m) - 1] || ''} ${y}`.trim() : y || '';
}

// A trip's dates are one string: `-` divides the range, `/` divides the parts. That is
// what lets the same field hold "2019/06-2019/06" now and "2025/12/28-2026/01/03" later —
// an ISO range ("2025-12-28-2026-01-03") has no dividing `-` left to split on.
function splitDuration(duration) {
  const [start = '', end = ''] = String(duration || '').split('-');
  return { start, end };
}

// "2025/12" → "Dec 2025", "2025/12/28" → "Dec 28, 2025". Precision in, precision out:
// a month never gets a made-up day attached to it.
function fmtPart(part) {
  // support inputs like "2023/12", "2023/12/28", or "2023/12/28 07:50"
  if (!part) return '';
  const [datePart, timePart] = String(part).split(' ');
  const [y, m, d] = String(datePart || '').split('/');
  if (!y) return '';
  if (!m) return y;
  const month = MONTHS[Number(m) - 1] || '';
  const dateStr = d ? `${month} ${Number(d)}, ${y}` : `${month} ${y}`;
  return timePart ? `${dateStr} ${timePart}` : dateStr;
}

function fmtDuration(duration) {
  const { start, end } = splitDuration(duration);
  if (!start) return '';
  return !end || end === start ? fmtPart(start) : `${fmtPart(start)} – ${fmtPart(end)}`;
}

// A trip has no name of its own: it is the places it went, in the order it went to them.
function tripTitle(trip) {
  return (trip.cities || []).map((c) => c.name).join(' · ');
}

// A trip's dates, when not written down, are the flights': the earliest departure to the
// latest arrival. Both are the airport-local date already printed on the card, so this is
// the range a reader reads off the boarding passes, not one computed across zones. The
// stamps are zero-padded `YYYY/MM/DD`, so a plain string sort is already chronological.
function flightsDuration(trip) {
  const stamps = (trip.flights || [])
    .flatMap((f) => f.legs || [])
    .flatMap((leg) => [leg.depart, leg.arrive])
    .filter(Boolean)
    .sort();
  return stamps.length ? `${stamps[0]}-${stamps[stamps.length - 1]}` : '';
}

// The written range wins when it exists; otherwise fall back to the flights. The map, the
// cards and the trip page all read a trip's "when" through here, so none of them recompute
// it and they cannot disagree.
function tripDuration(trip) {
  return trip.duration || flightsDuration(trip);
}

const ICONS = {
  spinner: '<span class="spinner" aria-hidden="true"></span>',
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m13.5 8.5-5 5"/><path d="m8.5 8.5 5 5"/><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  file:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 17h.01"/><path d="M9.1 12a2.5 2.5 0 1 1 3.5 2.3c-.4.2-.6.6-.6 1"/></svg>',
  alert:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
};

function emptyState({ icon = 'search', title, description = '', actions = '' }) {
  return `
    <div class="empty">
      <div class="empty-header">
        <div class="empty-media">${ICONS[icon] || ''}</div>
        <p class="empty-title">${title}</p>
        ${description ? `<p class="empty-description">${description}</p>` : ''}
      </div>
      ${actions ? `<div class="empty-content">${actions}</div>` : ''}
    </div>`;
}

const SERVE_HINT =
  'If you opened this file directly, serve the folder with <code>python3 -m http.server</code> instead.';
