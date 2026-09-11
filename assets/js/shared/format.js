const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

// A date range is `start-end`; parts use `/` ("2025/12/28 07:50") so the dash stays unambiguous.
export function splitDuration(duration) {
  const [start = '', end = ''] = String(duration || '').split('-');
  return { start, end };
}

// Keeps the precision it was given: "2025/12" → "December 2025", never an invented day.
export function fmtPart(part, { short = false } = {}) {
  if (!part) return '';
  const [datePart, timePart] = String(part).split(' ');
  const [y, m, d] = datePart.split('/');
  if (!y) return '';
  if (!m) return y;
  const month = (MONTHS[Number(m) - 1] || '').slice(0, short ? 3 : undefined);
  const date = d ? `${month} ${Number(d)}, ${y}` : `${month} ${y}`;
  return timePart ? `${date} ${timePart}` : date;
}

// A date range without times, sharing what the two ends have in common:
// "Jun 19–23, 2026", "Oct 22 – Nov 9, 2026", "Dec 31, 2025 – Jan 3, 2026", "June 2019".
export function fmtRange(duration, { short = false } = {}) {
  const { start, end } = splitDuration(duration);
  if (!start) return '';
  const parse = (part) => {
    const [y, m, d] = part.split(' ')[0].split('/');
    return { y, m: Number(m) || 0, d: Number(d) || 0 };
  };
  const a = parse(start);
  const b = end ? parse(end) : a;
  const mon = ({ m }) => (MONTHS[m - 1] || '').slice(0, short ? 3 : undefined);
  const full = (p) => (p.d ? `${mon(p)} ${p.d}, ${p.y}` : p.m ? `${mon(p)} ${p.y}` : p.y);

  if (a.y === b.y && a.m === b.m && a.d === b.d) return full(a);
  if (a.y !== b.y || !a.m || !b.m || !a.d !== !b.d) return `${full(a)} – ${full(b)}`;
  if (!a.d) return `${mon(a)} – ${mon(b)} ${a.y}`;
  if (a.m === b.m) return `${mon(a)} ${a.d}–${b.d}, ${a.y}`;
  return `${mon(a)} ${a.d} – ${mon(b)} ${b.d}, ${a.y}`;
}

// "YYYY/MM" for today, comparable as a string against a part's first 7 characters.
export function currentMonth(now = new Date()) {
  return `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
}
