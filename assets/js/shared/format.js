const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

// A date range is `start-end`; parts use `/` ("2025/12/28 07:50") so the dash stays unambiguous.
export function splitDuration(duration) {
  const [start = '', end = ''] = String(duration || '').split('-');
  return { start, end };
}

// Keeps the precision it was given: "2025/12" → "December 2025", never an invented day.
export function fmtPart(part) {
  if (!part) return '';
  const [datePart, timePart] = String(part).split(' ');
  const [y, m, d] = datePart.split('/');
  if (!y) return '';
  if (!m) return y;
  const month = MONTHS[Number(m) - 1] || '';
  const date = d ? `${month} ${Number(d)}, ${y}` : `${month} ${y}`;
  return timePart ? `${date} ${timePart}` : date;
}

export function fmtDuration(duration) {
  const { start, end } = splitDuration(duration);
  if (!start) return '';
  return !end || end === start ? fmtPart(start) : `${fmtPart(start)} – ${fmtPart(end)}`;
}

// "YYYY/MM" for today, comparable as a string against a part's first 7 characters.
export function currentMonth(now = new Date()) {
  return `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
}
