// The bucket list page: festivals worth crossing a border for, grouped by the reason you'd
// go — a faith's high day, a new year, or a country's own once-a-year strangeness — each
// with the same little country map the travel page draws, so an entry reads like a trip that
// hasn't happened yet.
//
// Depends on ui.js (`esc`, `emptyState`), thumb.js (`thumbHtml`), d3-geo and topojson-client.

const listEl = document.getElementById('list');
const statsEl = document.getElementById('stats');
const nextEl = document.getElementById('next');

const WORLD_SRC = 'assets/data/countries-50m.json';
const BUCKET_SRC = 'bucket-list/index.json';
const TRIPS_SRC = 'travel/index.json';

// The order the sections read in, and the words over each. Religion, then the year's turning,
// then everything a single country keeps to itself.
const SECTIONS = [
  { key: 'religion', label: 'Religion', lede: 'High days of the faiths — a lamp, a fast broken, a week of candlelight.' },
  { key: 'newyear', label: 'New Year', lede: 'How midnight is met around the world — grapes, bells, burnt effigies, empty suitcases.' },
  { key: 'festival', label: 'Festivals', lede: "Each country's own once-a-year strangeness, kept for its own reasons." },
];

// A festival recurs every year, so its "when" is the next time it comes round: this year's
// date if it is still ahead, otherwise next year's. Day is optional — a festival known only
// to the month is counted from the 1st, the same precision-in-precision-out the trips use.
function nextOccurrence(item, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let d = new Date(now.getFullYear(), (item.month || 1) - 1, item.day || 1);
  if (d < today) d = new Date(now.getFullYear() + 1, (item.month || 1) - 1, item.day || 1);
  return d;
}

function renderStats(items, done) {
  const total = items.length;
  const seen = items.filter((i) => done.has(i.id)).length;
  const countries = new Set(items.map((i) => i.country).filter(Boolean)).size;
  statsEl.textContent = [
    `${total} ${total === 1 ? 'festival' : 'festivals'}`,
    `${countries} ${countries === 1 ? 'country' : 'countries'}`,
    `${seen} done`,
  ].join(' · ');
}

function cardHtml(item, byName, done, visited, now) {
  const city = item.cities?.[0]?.name;
  const wasVisited = item.wasVisited ?? false;
  const isDone = done.has(item.id);
  return `
    <article class="bucket-card" data-id="${esc(item.id)}">
      ${thumbHtml(item, byName)}
      <div class="trip-card-body">
        <div class="trip-card-meta">
          ${item.country ? `<span>${esc(item.country)}</span>` : ''}
          ${city && city !== item.country ? `<span>${esc(city)}</span>` : ''}
          ${isDone ? '<span class="trip-card-tag">Done</span>' : ''}
          ${wasVisited ? '<span class="trip-card-tag">Been</span>' : ''}
        </div>
        <h3 class="trip-card-title">${esc(item.name)}</h3>
        <p class="bucket-card-when">${esc(item.when || '')}</p>
        <p class="bucket-card-note">${esc(item.note || '')}</p>
      </div>
    </article>`;
}

function render(items, byName, done, visited) {
  const now = new Date();
  renderStats(items, done);

  listEl.innerHTML = SECTIONS.map((section) => {
    const inSection = items
      .filter((i) => i.category === section.key)
      .sort((a, b) => nextOccurrence(a, now) - nextOccurrence(b, now));
    if (!inSection.length) return '';
    return `
      <section class="bucket-section">
        <header class="bucket-section-head">
          <h2 class="bucket-section-title">${esc(section.label)}</h2>
          <p class="bucket-section-lede">${esc(section.lede)}</p>
        </header>
        <div class="bucket-grid">
          ${inSection.map((i) => cardHtml(i, byName, done, visited, now)).join('')}
        </div>
      </section>`;
  }).join('');
}

Promise.all(
  [WORLD_SRC, BUCKET_SRC, TRIPS_SRC].map((src) =>
    fetch(src).then((r) => {
      if (!r.ok) throw new Error(`${src}: ${r.status}`);
      return r.json();
    }),
  ),
)
  .then(([world, items, trips]) => {
    if (!items.length) {
      listEl.innerHTML = emptyState({
        icon: 'file',
        title: 'No entries yet',
        description: 'Add an entry to <code>bucket-list/index.json</code> and it will appear here.',
      });
      return;
    }

    const all = topojson.feature(world, world.objects.countries).features;
    const byName = new Map(all.map((f) => [f.properties.name, f]));
    // Countries already stamped in a passport, so an entry in one of them can say so — the
    // easiest goals on the list are the places you already know the way back to.
    const visited = new Set((trips || []).map((t) => t.country).filter(Boolean));
    // Which entries are ticked off is a property of the file itself: `done: true` in the index.
    const done = new Set(items.filter((i) => i.done).map((i) => i.id));

    render(items, byName, done, visited);
  })
  .catch((err) => {
    statsEl.textContent = '';
    listEl.innerHTML = emptyState({
      icon: 'alert',
      title: 'Could not load the bucket list',
      description: `${esc(err.message)}. ${SERVE_HINT}`,
      actions: '<button type="button" class="btn" onclick="location.reload()">Retry</button>',
    });
  });
