const listEl = document.getElementById('list');
const searchEl = document.getElementById('search');
const tagsEl = document.getElementById('tags');
const modeEl = document.getElementById('search-mode');
const statusEl = document.getElementById('search-status');

// Two ways to search the same list. Exact is the substring match this page has always
// done: instant, local, and blind to anything the note does not literally say.
// Semantic ranks by meaning instead, which costs a model download and a moment of
// compute — so it stays behind the toggle rather than replacing exact search.
const MODE_KEY = 'note-search-mode';
const PLACEHOLDER = {
  exact: 'Search titles, authors, keywords…',
  semantic: 'Describe what the paper is about…',
};

// The semantic pass is async, so a burst of keystrokes would otherwise race: the
// query typed first can resolve last. `runId` is the ticket that lets a stale result
// be dropped when a newer query has already been issued.
const DEBOUNCE_MS = 250;

let notes = [];
let activeTag = null;
let mode = 'exact';
let loaded = false;

// The semantic result currently on screen, tagged with the query it answers.
let semantic = null; // { query, results: [{ note, score }], error? }
let runId = 0;
let debounce;

const inTag = (note) => !activeTag || (note.tags || []).includes(activeTag);

function matches(note) {
  if (!inTag(note)) return false;
  const q = searchEl.value.trim().toLowerCase();
  if (!q) return true;
  const hay = [note.title, note.authors, note.venue, note.summary, (note.tags || []).join(' ')]
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

// The spinner is a CSS animation on an element, so replacing that element restarts the
// animation. Download progress ticks arrive several times a second, and rebuilding the
// status line on each one reset the spinner to frame zero every time — it looked frozen
// for exactly as long as the weights were downloading, then span up once the ticks
// stopped. So the nodes are minted once here and only their text changes below.
const statusSpinner = document.createElement('span');
statusSpinner.className = 'spinner';
statusSpinner.setAttribute('aria-hidden', 'true');
statusSpinner.hidden = true; // The status line starts empty, and so must its spinner.
const statusText = document.createElement('span');
statusEl.append(statusSpinner, statusText);
statusEl.hidden = true;

function setStatus(text, state = '') {
  statusEl.className = `search-status${state ? ` is-${state}` : ''}`;
  statusEl.hidden = !text; // Nothing to say: collapse the line rather than reserve it.
  statusSpinner.hidden = state !== 'busy';
  statusText.textContent = text;
}

// The rows to show, as [{ note, score? }] — or null when a semantic search for the
// current query is still in flight, which leaves the previous list on screen rather
// than blanking it under the user.
function visibleRows() {
  if (mode === 'exact') return notes.filter(matches).map((note) => ({ note }));

  const q = searchEl.value.trim();
  if (!q) return notes.filter(inTag).map((note) => ({ note }));
  if (!semantic || semantic.query !== q) return null;

  // The tag filter still applies, and still narrows rather than reorders: semantic
  // rank decides the order, the tag only decides who is in the running.
  return semantic.results.filter((r) => inTag(r.note));
}

function render() {
  if (!loaded) return;

  if (semantic && semantic.error && mode === 'semantic' && searchEl.value.trim()) {
    listEl.innerHTML = emptyState({
      icon: 'alert',
      title: 'Semantic search failed',
      description: esc(semantic.error),
      actions: '<button type="button" class="btn" id="retry-semantic">Try again</button>',
    });
    return;
  }

  const rows = visibleRows();
  if (!rows) return;

  if (!rows.length) {
    listEl.innerHTML = emptyState({
      icon: 'search',
      title: 'No matching notes',
      description: mode === 'semantic'
        ? 'Nothing is close enough in meaning to this query.'
        : 'Nothing here matches the current search or tag filter.',
      actions: activeTag || searchEl.value.trim()
        ? '<button type="button" class="btn" id="clear-filters">Clear filters</button>'
        : '',
    });
    return;
  }

  listEl.innerHTML = rows
    .map(({ note: n, score }) => `
      <a class="note-card" href="note.html?id=${encodeURIComponent(n.id)}">
        ${n.year || score != null ? `
          <div class="note-card-meta">
            ${n.year ? `<span>${esc(n.year)}</span>` : ''}
            ${score != null ? `<span class="note-card-score" title="Cosine similarity to the query">${score.toFixed(2)}</span>` : ''}
          </div>` : ''}
        <h2 class="note-card-title">${esc(n.title)}</h2>
        ${n.authors ? `<p class="note-card-authors">${esc(n.authors)}</p>` : ''}
        ${n.summary ? `<p class="note-card-summary">${esc(n.summary)}</p>` : ''}
        <div class="tags">
          ${(n.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
        </div>
      </a>`)
    .join('');
}

function renderTags() {
  const all = [...new Set(notes.flatMap((n) => n.tags || []))].sort();
  tagsEl.innerHTML = all
    .map((t) => `<span class="tag${t === activeTag ? ' active' : ''}" data-tag="${esc(t)}">${esc(t)}</span>`)
    .join('');
}

async function runSemantic(query) {
  const ticket = ++runId;
  setStatus('Searching by meaning…', 'busy');

  try {
    const results = await semanticSearch(query, notes, (pct) => {
      if (ticket === runId) setStatus(`Loading the embedding model… ${pct}%`, 'busy');
    });
    if (ticket !== runId) return; // A newer query has already been issued.

    semantic = { query, results };
    const n = results.length;
    setStatus(`${n} note${n === 1 ? '' : 's'} ranked by meaning`);
  } catch (err) {
    if (ticket !== runId) return;
    semantic = { query, results: [], error: err.message };
    setStatus('Semantic search failed', 'error');
  }

  render();
}

function scheduleSemantic() {
  clearTimeout(debounce);
  const q = searchEl.value.trim();

  // An empty query is not a search — show everything, and cancel whatever is running.
  if (!q) {
    runId++;
    semantic = null;
    setStatus('');
    render();
    return;
  }

  setStatus('Searching by meaning…', 'busy');
  debounce = setTimeout(() => runSemantic(q), DEBOUNCE_MS);
}

// The switch is a single control with one bit of state: on means semantic. The icons
// carry the meaning visually, so the accessible name has to carry it in words.
function applyMode() {
  const semanticOn = mode === 'semantic';
  modeEl.setAttribute('aria-checked', String(semanticOn));
  modeEl.setAttribute('aria-label', 'Semantic search');
  modeEl.title = semanticOn
    ? 'Semantic search: ranked by meaning. Click for exact matching.'
    : 'Exact search: literal matching. Click to rank by meaning.';
  searchEl.placeholder = PLACEHOLDER[mode];
}

function setMode(next) {
  mode = next;
  runId++; // Drop any semantic result still in flight.
  clearTimeout(debounce);
  semantic = null;
  setStatus('');
  applyMode();

  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch (e) {
    // Private mode: the choice just does not survive the reload.
  }

  if (mode === 'semantic' && searchEl.value.trim()) scheduleSemantic();
  else render();
}

modeEl.addEventListener('click', () => {
  setMode(mode === 'semantic' ? 'exact' : 'semantic');
});

searchEl.addEventListener('input', () => {
  if (mode === 'semantic') scheduleSemantic();
  else render();
});

tagsEl.addEventListener('click', (e) => {
  const el = e.target.closest('.tag');
  if (!el) return;
  activeTag = el.dataset.tag === activeTag ? null : el.dataset.tag;
  renderTags();
  render(); // Semantic rank is unaffected by the tag, so nothing has to be recomputed.
});

listEl.addEventListener('click', (e) => {
  if (e.target.closest('#retry-semantic')) {
    runSemantic(searchEl.value.trim());
    return;
  }
  if (!e.target.closest('#clear-filters')) return;

  activeTag = null;
  searchEl.value = '';
  semantic = null;
  setStatus('');
  renderTags();
  render();
});

try {
  if (localStorage.getItem(MODE_KEY) === 'semantic') mode = 'semantic';
} catch (e) {
  // Private mode: fall back to exact.
}
applyMode();

fetch('notes/index.json')
  .then((r) => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  })
  .then((data) => {
    notes = data;
    loaded = true;
    renderTags();
    render();
  })
  .catch(() => {
    listEl.innerHTML = emptyState({
      icon: 'alert',
      title: 'Could not load the notes index',
      description: `Fetching <code>notes/index.json</code> failed. ${SERVE_HINT}`,
      actions: '<button type="button" class="btn" onclick="location.reload()">Retry</button>',
    });
  });
