// Selection translation for the trip page.
//
// Select a passage in a travelogue and a small "Translate" pill appears at the end of it;
// clicking it sends just that selection to the same Cloudflare Worker gateway the site
// used before, streams the translation into a sheet (from the right on desktop, up from
// the bottom on mobile). Small requests only — translating a whole travelogue in one call
// ran past the model's limits, which is what this replaces. Target language is remembered.
//
// Self-contained: it watches the document for selections inside `.prose` and needs no
// hook from trip.js. Depends on ui.js (`esc`).

const GATEWAY = 'https://large-language-models-proxy.enyaochang.workers.dev';
// Tried in order; the first that answers wins, so a busy upstream falls through.
// GPT-OSS 120B (on Workers AI) first, Mistral as the backstop.
const ENDPOINTS = [`${GATEWAY}/api/cloudflare-gpt-oss`, `${GATEWAY}/api/mistral`];

// `code` is the stored value and the <option> value; `native` is the menu label;
// `name` is what the model is told to translate into.
const LANGS = [
  { code: 'zh-Hant', native: '繁體中文', name: 'Taditional Chinese' },
  { code: 'ja', native: '日本語', name: 'Japanese' },
  { code: 'ko', native: '한국어', name: 'Korean' },
  { code: 'es', native: 'Español', name: 'Spanish' },
  { code: 'fr', native: 'Français', name: 'French' },
  { code: 'de', native: 'Deutsch', name: 'German' },
  { code: 'it', native: 'Italiano', name: 'Italian' },
  { code: 'pt', native: 'Português', name: 'Portuguese' },
];
const LANG_KEY = 'trip-tr-lang';

// A paragraph or two. Past this the request is refused rather than sent — the whole point
// of this feature is that each call stays small.
const MAX_CHARS = 1600;

const SYSTEM = 'You are a professional translator. Output only the translation of the passage the user gives you — no preamble, notes, quotes, or explanation.';
const buildPrompt = (lang, text) =>
  `Translate this passage into ${lang.name}. Keep proper nouns — place names, buildings, people — in their original form. Output only the translation.\n\n${text}`;

const byCode = (code) => LANGS.find((l) => l.code === code) || LANGS[0];
const read = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };

// ---------- the gateway ----------

// One streamed request. The gateway normalises every provider to `data: {"text":"…"}`
// frames separated by a blank line; `onChunk` gets the running text as it arrives.
async function askOne(endpoint, body, onChunk, signal) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let out = '';

  const take = (frame) => {
    const line = frame.split(/\r?\n/).find((l) => l.startsWith('data:'));
    if (!line) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      out += JSON.parse(payload).text || '';
      onChunk(out);
    } catch (e) { /* skip a bad frame */ }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop();
    frames.forEach(take);
  }
  take(buffer);
  return out.trim();
}

// Try each endpoint in turn; return the first non-empty answer.
async function translateText(lang, text, onChunk, signal) {
  const body = { system: SYSTEM, messages: [{ role: 'user', content: buildPrompt(lang, text) }] };
  let lastErr;
  for (const endpoint of ENDPOINTS) {
    try {
      const out = await askOne(endpoint, body, onChunk, signal);
      if (out) return out;
      lastErr = new Error('empty response');
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error('no endpoint answered');
}

// ---------- the selection UI ----------

const GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z"/></svg>';

function initSelectionTranslate() {
  const cache = new Map(); // `${code}\n${text}` -> translation, for the session
  let lang = byCode(read(LANG_KEY)).code;
  let range = null; // a cloned Range for the passage being translated
  let sourceText = '';
  let inflight = null; // AbortController

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tr-btn';
  btn.hidden = true;
  btn.innerHTML = `${GLOBE}<span>Translate</span>`;

  // A sheet: it slides in from the right on a wide screen, up from the bottom on a narrow
  // one (all in CSS). Toggled by `.is-open` rather than [hidden] so the slide animates.
  const sheet = document.createElement('aside');
  sheet.className = 'tr-sheet';
  sheet.setAttribute('aria-label', 'Translation');
  sheet.innerHTML = `
    <div class="tr-sheet-head">
      <select class="tr-sheet-lang" data-lang aria-label="Target language">
        ${LANGS.map((l) => `<option value="${l.code}">${esc(l.name)}</option>`).join('')}
      </select>
      <button type="button" class="tr-sheet-close" data-close aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
    <div class="tr-sheet-body" data-body></div>
    <p class="tr-sheet-note">Machine translation · GPT-OSS 120B</p>`;

  document.body.append(btn, sheet);

  const selectEl = sheet.querySelector('[data-lang]');
  const bodyEl = sheet.querySelector('[data-body]');
  selectEl.value = lang;

  const prose = () => document.querySelector('.prose');
  const isOpen = () => sheet.classList.contains('is-open');

  // The end of the selection: the last of its per-line rects, so the pill sits just after
  // where the passage stops rather than centred on the whole block.
  function endRect() {
    if (!range) return null;
    const rects = range.getClientRects();
    const r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    return r && (r.width || r.height) ? r : null;
  }

  function hideButton() { btn.hidden = true; }

  function placeButton() {
    const r = endRect();
    if (!r) { hideButton(); return; }
    btn.hidden = false;
    const b = btn.getBoundingClientRect();
    let left = r.right + 6;
    let top = r.top + r.height / 2 - b.height / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - b.width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - b.height - 8));
    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
  }

  function refreshButton() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { hideButton(); return; }
    const text = sel.toString().trim();
    const p = prose();
    if (!text || !p || !p.contains(sel.anchorNode) || !p.contains(sel.focusNode)) {
      hideButton();
      return;
    }
    range = sel.getRangeAt(0).cloneRange();
    sourceText = text;
    placeButton();
  }

  const showStatus = (html) => { bodyEl.className = 'tr-sheet-body is-status'; bodyEl.innerHTML = html; };
  const showText = (t) => { bodyEl.className = 'tr-sheet-body'; bodyEl.textContent = t; };

  async function run() {
    const l = byCode(lang);
    const key = `${l.code}\n${sourceText}`;

    if (sourceText.length > MAX_CHARS) {
      showStatus(emptyState({
        icon: 'alert',
        title: 'Selection too long',
        description: `That is ${sourceText.length} characters — translate a paragraph or two at a time (up to ${MAX_CHARS}).`,
      }));
      return;
    }
    if (cache.has(key)) { showText(cache.get(key)); return; }

    inflight?.abort();
    inflight = new AbortController();
    const mine = inflight;
    showStatus(emptyState({ icon: 'spinner', title: 'Translating', description: `Translating into ${l.native}..., please wait a moment.` }));

    try {
      const out = await translateText(l, sourceText, (partial) => {
        if (mine === inflight && partial) showText(partial);
      }, mine.signal);
      if (mine !== inflight) return;
      cache.set(key, out);
      showText(out);
    } catch (err) {
      if (err.name === 'AbortError') return;
      showStatus(emptyState({ icon: 'alert', title: "Couldn't translate", description: `${err.message || err}` }));
    } finally {
      if (mine === inflight) inflight = null;
    }
  }

  function openSheet() {
    if (!sourceText) return;
    hideButton();
    sheet.classList.add('is-open');
    run();
  }

  function closeSheet() {
    inflight?.abort();
    inflight = null;
    sheet.classList.remove('is-open');
  }

  // A mousedown on the pill would collapse the selection before the click lands; block it
  // so the highlight survives the sheet opening. (The sheet lets clicks through — you may
  // want to select the translation to copy it.)
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', openSheet);
  sheet.querySelector('[data-close]').addEventListener('click', closeSheet);
  selectEl.addEventListener('change', () => {
    lang = selectEl.value;
    save(LANG_KEY, lang);
    run();
  });

  // Debounce the pill: hide it the moment the selection moves, and only bring it back once
  // things have been still for a beat — so it settles at the end instead of chasing the
  // cursor across the paragraph.
  const SETTLE_MS = 300;
  let settleTimer = 0;
  const onSelectionActivity = () => {
    hideButton();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(refreshButton, SETTLE_MS);
  };
  document.addEventListener('selectionchange', onSelectionActivity);
  document.addEventListener('mouseup', onSelectionActivity);
  document.addEventListener('keyup', (e) => { if (!e.metaKey && !e.ctrlKey && !e.altKey) onSelectionActivity(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) closeSheet();
  });

  const reflow = () => { if (!btn.hidden) placeButton(); };
  window.addEventListener('scroll', reflow, true);
  window.addEventListener('resize', reflow);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSelectionTranslate, { once: true });
} else {
  initSelectionTranslate();
}
