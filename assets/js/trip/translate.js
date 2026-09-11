// Select a passage in the travelogue to get a "Translate" pill; the translation streams into
// a sheet (right on desktop, bottom on mobile). One selection per request keeps calls small.
import { esc, emptyState } from '../shared/dom.js';

const GATEWAY = 'https://large-language-models-proxy.enyaochang.workers.dev';
const ENDPOINTS = [`${GATEWAY}/api/cloudflare-gpt-oss`, `${GATEWAY}/api/mistral`]; // Tried in order.

// `native` labels the menu; `name` goes into the prompt.
const LANGS = [
  { code: 'zh-Hant', native: '繁體中文', name: 'Traditional Chinese' },
  { code: 'ja', native: '日本語', name: 'Japanese' },
  { code: 'ko', native: '한국어', name: 'Korean' },
  { code: 'es', native: 'Español', name: 'Spanish' },
  { code: 'fr', native: 'Français', name: 'French' },
  { code: 'de', native: 'Deutsch', name: 'German' },
  { code: 'it', native: 'Italiano', name: 'Italian' },
  { code: 'pt', native: 'Português', name: 'Portuguese' },
];
const LANG_KEY = 'trip-tr-lang';
const MAX_CHARS = 1600;
const SETTLE_MS = 300;

const SYSTEM = 'You are a professional translator. Output only the translation of the passage the user gives you — no preamble, notes, quotes, or explanation.';
const buildPrompt = (lang, text) =>
  `Translate this passage into ${lang.name}. Keep proper nouns — place names, buildings, people — in their original form. Output only the translation.\n\n${text}`;

const GLOBE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

const langByCode = (code) => LANGS.find((l) => l.code === code) || LANGS[0];
const storage = {
  get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
};

// The gateway streams `data: {"text": "…"}` frames; `onChunk` receives the text so far.
async function streamOne(endpoint, body, onChunk, signal) {
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
    const payload = line?.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      out += JSON.parse(payload).text || '';
      onChunk(out);
    } catch (e) { /* skip a malformed frame */ }
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

async function translate(lang, text, onChunk, signal) {
  const body = { system: SYSTEM, messages: [{ role: 'user', content: buildPrompt(lang, text) }] };
  let lastErr;
  for (const endpoint of ENDPOINTS) {
    try {
      const out = await streamOne(endpoint, body, onChunk, signal);
      if (out) return out;
      lastErr = new Error('empty response');
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error('no endpoint answered');
}

export function initTranslate() {
  const cache = new Map();
  let lang = langByCode(storage.get(LANG_KEY)).code;
  let range = null;
  let sourceText = '';
  let inflight = null;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tr-btn';
  btn.hidden = true;
  btn.innerHTML = `${GLOBE_ICON}<span>Translate</span>`;

  const sheet = document.createElement('aside');
  sheet.className = 'tr-sheet';
  sheet.setAttribute('aria-label', 'Translation');
  sheet.innerHTML = `
    <div class="tr-sheet-head">
      <select class="tr-sheet-lang" data-lang aria-label="Target language">
        ${LANGS.map((l) => `<option value="${l.code}">${esc(l.native)}</option>`).join('')}
      </select>
      <button type="button" class="tr-sheet-close" data-close aria-label="Close">${CLOSE_ICON}</button>
    </div>
    <div class="tr-sheet-body" data-body></div>
    <p class="tr-sheet-note">Machine translation · GPT-OSS 120B</p>`;
  document.body.append(btn, sheet);

  const selectEl = sheet.querySelector('[data-lang]');
  const bodyEl = sheet.querySelector('[data-body]');
  selectEl.value = lang;

  const hideButton = () => { btn.hidden = true; };

  // Pin the pill just after the last line of the selection, kept inside the viewport.
  function placeButton() {
    const rects = range?.getClientRects();
    const r = rects?.length ? rects[rects.length - 1] : range?.getBoundingClientRect();
    if (!r || !(r.width || r.height)) return hideButton();
    btn.hidden = false;
    const b = btn.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right + 6, window.innerWidth - b.width - 8));
    const top = Math.max(8, Math.min(r.top + r.height / 2 - b.height / 2, window.innerHeight - b.height - 8));
    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
  }

  function refreshButton() {
    const sel = window.getSelection();
    const prose = document.querySelector('.prose');
    const text = sel?.toString().trim();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !text || !prose
      || !prose.contains(sel.anchorNode) || !prose.contains(sel.focusNode)) {
      return hideButton();
    }
    range = sel.getRangeAt(0).cloneRange();
    sourceText = text;
    placeButton();
  }

  const showStatus = (html) => { bodyEl.className = 'tr-sheet-body is-status'; bodyEl.innerHTML = html; };
  const showText = (t) => { bodyEl.className = 'tr-sheet-body'; bodyEl.textContent = t; };

  async function run() {
    const l = langByCode(lang);
    const key = `${l.code}\n${sourceText}`;
    if (sourceText.length > MAX_CHARS) {
      return showStatus(emptyState({
        icon: 'alert',
        title: 'Selection too long',
        description: `That is ${sourceText.length} characters — translate a paragraph or two at a time (up to ${MAX_CHARS}).`,
      }));
    }
    if (cache.has(key)) return showText(cache.get(key));

    inflight?.abort();
    const mine = new AbortController();
    inflight = mine;
    showStatus(emptyState({ icon: 'spinner', title: 'Translating', description: `Into ${esc(l.name)}…` }));

    try {
      const out = await translate(l, sourceText, (partial) => {
        if (mine === inflight && partial) showText(partial);
      }, mine.signal);
      if (mine !== inflight) return;
      cache.set(key, out);
      showText(out);
    } catch (err) {
      if (err.name !== 'AbortError') {
        showStatus(emptyState({ icon: 'alert', title: "Couldn't translate", description: esc(err.message || err) }));
      }
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

  btn.addEventListener('mousedown', (e) => e.preventDefault()); // Keep the selection alive.
  btn.addEventListener('click', openSheet);
  sheet.querySelector('[data-close]').addEventListener('click', closeSheet);
  selectEl.addEventListener('change', () => {
    lang = selectEl.value;
    storage.set(LANG_KEY, lang);
    run();
  });

  // Hide while the selection is changing; show again once it has settled.
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
    if (e.key === 'Escape' && sheet.classList.contains('is-open')) closeSheet();
  });

  const reflow = () => { if (!btn.hidden) placeButton(); };
  window.addEventListener('scroll', reflow, true);
  window.addEventListener('resize', reflow);
}
