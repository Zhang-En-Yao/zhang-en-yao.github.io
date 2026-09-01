// One-click translation for the trip page — run entirely in the browser.
//
// The travelogues are written in English. This adds a language menu to the header that
// swaps the prose for a machine translation produced locally by NLLB-200 (distilled,
// 600M) through transformers.js. The model is pulled from the Hugging Face CDN the first
// time a language is picked — ~300 MB, quantised — then served from the browser's own
// Cache storage on every later visit. Nothing is ever sent to a server. trip.js owns
// rendering and hands this file a `render(markdown, meta)` callback on `trip:loaded`.
//
// NLLB translates plain prose, so the Markdown is first taken apart into a skeleton of
// markup with numbered holes plus the list of prose strings that fill them; only the
// strings go to the model, and the skeleton — headings, lists, tables, links, code — is
// stitched back around the translations untouched. A finished translation is cached in
// localStorage per trip + language, and the chosen language is remembered across trips.
//
// Depends on ui.js (`esc`) and markdown.js (`renderMarkdown`) being loaded first.

// transformers.js is a ~1 MB ES module; it and the model are only fetched once a language
// is actually chosen, so the default English view pays nothing for any of this.
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
const MODEL_ID = 'Xenova/nllb-200-distilled-600M';

// NLLB speaks FLORES-200 codes (`<language>_<script>`). `code` is the storage key and the
// menu row; `flores` is the target handed to the model. English (`eng_Latn`) is the
// source — the "off" position.
const SRC_FLORES = 'eng_Latn';
const LANGS = [
  { code: 'original', label: 'Original', native: 'English' },
  { code: 'zh-Hant', label: 'Chinese', native: '繁體中文', flores: 'zho_Hant' },
  { code: 'ja', label: 'Japanese', native: '日本語', flores: 'jpn_Jpan' },
  { code: 'ko', label: 'Korean', native: '한국어', flores: 'kor_Hang' },
  { code: 'es', label: 'Spanish', native: 'Español', flores: 'spa_Latn' },
  { code: 'fr', label: 'French', native: 'Français', flores: 'fra_Latn' },
  { code: 'de', label: 'German', native: 'Deutsch', flores: 'deu_Latn' },
  { code: 'it', label: 'Italian', native: 'Italiano', flores: 'ita_Latn' },
  { code: 'pt', label: 'Portuguese', native: 'Português', flores: 'por_Latn' },
];

const LANG_KEY = 'trip-lang';
const cacheKey = (id, code) => `trip-tr:${id}:${code}`;
const tripId = new URLSearchParams(location.search).get('id');

// How many prose strings are handed to the model at once. NLLB on the WASM backend is the
// slow path; a bigger batch mostly just delays the first progress tick.
const BATCH = 8;

// A paragraph in a travelogue is one long unwrapped line. Anything past this many
// characters is split into sentences before translating, so a long paragraph never runs
// past the model's output limit and comes back half-missing.
const SPLIT_OVER = 240;

// ---------- the model, loaded on demand ----------

let pipePromise = null;

// `onProgress` receives transformers.js's own progress events; it is only wired on the
// first load, which is the only one that downloads anything.
function getTranslator(onProgress) {
  if (!pipePromise) {
    pipePromise = import(TRANSFORMERS_URL)
      .then(({ pipeline, env }) => {
        env.allowLocalModels = false; // Don't probe this site's origin for a local copy.
        return pipeline('translation', MODEL_ID, { dtype: 'q8', progress_callback: onProgress });
      })
      .catch((err) => { pipePromise = null; throw err; });
  }
  return pipePromise;
}

// transformers.js reports one `progress` event per file per chunk, and only for files it
// has started — so the total climbs by a step each time a new file (there are two big
// ONNX ones) begins. The megabyte read-out is the honest signal; the bar tracks
// loaded-so-far over known-so-far and jumps once when the second file registers.
const MB = (n) => (n / 1048576).toFixed(0);
function downloadProgress(bar) {
  const files = new Map();
  return (e) => {
    if ((e.status === 'progress' || e.status === 'done') && e.file && e.total) {
      const loadedNow = e.status === 'done' ? e.total : e.loaded;
      files.set(e.file, { loaded: Math.max(loadedNow || 0, files.get(e.file)?.loaded || 0), total: e.total });
    } else {
      return;
    }
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    bar(`Downloading the translation model — ${MB(loaded)} / ${MB(total)} MB (first time only)`,
      total ? (loaded / total) * 100 : 0);
  };
}

// ---------- Markdown-aware segmentation ----------

// `@@n@@` marks where prose was lifted out. The skeleton carries these markers through
// unchanged and they are filled back in before any Markdown is parsed, so they never
// reach the model or the renderer, and `@@` never occurs in a travelogue anyway.
const HOLE = (n) => `@@${n}@@`;
const HOLE_RX = /@@(\d+)@@/g;

const stripEmphasis = (s) => s.replace(/\*\*\*|\*\*|\*|___|__|_|~~/g, '');
const splitSentences = (t) =>
  (t.match(/[^.!?]+(?:[.!?]+["')\]]*|\s*$)/g) || [t]).map((s) => s.trim()).filter(Boolean);

// Breaks `md` into `{ skeleton, pieces }`. `skeleton` is the document with every run of
// translatable prose replaced by an `@@n@@` hole; `pieces[n]` is the English that belongs
// in hole n. Only `pieces` is ever sent to the model.
function segmentMarkdown(md) {
  const pieces = [];
  const out = [];
  const lines = md.split('\n');
  let fenced = false;

  // Push one run of prose (already clear of block markup). Emphasis that wraps the whole
  // run is peeled off and put back around the hole; a long run is split into sentences so
  // each stays well inside the model's output limit.
  const pushRun = (run) => {
    const lead = run.match(/^\s*/)[0];
    const tail = run.match(/\s*$/)[0];
    let core = run.slice(lead.length, run.length - tail.length || undefined);
    if (!core) return run;

    let wrap = '';
    const w = core.match(/^(\*\*\*|\*\*|\*|___|__|_)([\s\S]+)\1$/);
    if (w) { wrap = w[1]; core = w[2]; }

    const inner = stripEmphasis(core).replace(/\s+/g, ' ').trim();
    if (!inner) return run;

    const parts = inner.length > SPLIT_OVER ? splitSentences(inner) : [inner];
    const holes = parts
      .map((p) => { pieces.push(p); return HOLE(pieces.length - 1); })
      .join(' ');
    return `${lead}${wrap}${holes}${wrap}${tail}`;
  };

  // Walk one line of inline content: links and images keep their target and translate
  // their label, inline code and autolinks are kept verbatim, everything else is prose.
  const inlineSegment = (text) => {
    if (!text.trim()) return text;
    const rx = /(!?\[[^\]]*\]\([^)]*\)|`[^`]+`|<[^>\s]+>)/g;
    let last = 0;
    let m;
    let res = '';
    while ((m = rx.exec(text))) {
      if (m.index > last) res += pushRun(text.slice(last, m.index));
      const link = m[0].match(/^(!?)\[([^\]]*)\]\(([^)]*)\)$/);
      if (link) {
        const label = link[2].trim();
        res += `${link[1]}[${label ? pushRun(label).trim() : ''}](${link[3]})`;
      } else {
        res += m[0]; // inline code / autolink
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) res += pushRun(text.slice(last));
    return res;
  };

  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; out.push(raw); continue; }
    if (fenced || !raw.trim()) { out.push(raw); continue; }

    // Table separator row: |---|:--:|
    if (raw.includes('-') && /^\s*\|?[\s:|-]+\|?\s*$/.test(raw)) { out.push(raw); continue; }

    // Table body row: | a | b |
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      const cells = raw.split('|');
      out.push(cells
        .map((c, i) => (i === 0 || i === cells.length - 1 ? c : inlineSegment(c)))
        .join('|'));
      continue;
    }

    // Heading: ###<space>text
    let m = raw.match(/^(\s*#{1,6}\s+)([\s\S]*)$/);
    if (m) { out.push(m[1] + inlineSegment(m[2])); continue; }

    // Any blockquote / list markers, then the content (the prefix is empty for a plain line).
    m = raw.match(/^(\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?)([\s\S]*)$/);
    out.push(m[1] + inlineSegment(m[2]));
  }

  return { skeleton: out.join('\n'), pieces };
}

const fillHoles = (skeleton, translated) =>
  skeleton.replace(HOLE_RX, (m, n) => (translated[+n] == null ? m : translated[+n]));

// ---------- running a translation ----------

// Translate `texts` into `flores`, de-duplicating first (the "*Sight · Visit …*" lines
// repeat dozens of times) and reporting progress over the unique count.
async function translateAll(texts, flores, translator, onCount) {
  const uniq = [...new Set(texts)];
  const map = new Map();
  for (let i = 0; i < uniq.length; i += BATCH) {
    const batch = uniq.slice(i, i + BATCH);
    const res = await translator(batch, { src_lang: SRC_FLORES, tgt_lang: flores });
    const arr = Array.isArray(res) ? res : [res];
    batch.forEach((s, k) => map.set(s, (arr[k] && arr[k].translation_text) || s));
    onCount(Math.min(i + BATCH, uniq.length), uniq.length);
  }
  return texts.map((s) => map.get(s) || s);
}

function translatedMeta(meta, headings) {
  const areas = meta && meta.areas;
  if (!areas || !areas.length || headings.length !== areas.length) return meta;
  return { ...meta, areas: areas.map((a, i) => ({ ...a, heading: headings[i] || a.heading })) };
}

const GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z"/></svg>';

function initTranslate({ markdown, meta, render }) {
  const proseEl = document.querySelector('.prose');
  if (!proseEl || !tripId) return; // Nothing to translate (an error state, or no ?id=).

  // The header keeps its controls together at the right end; make the group if it's absent.
  let tools = document.querySelector('.header-tools');
  if (!tools) {
    const themeBtn = document.getElementById('theme-toggle');
    if (!themeBtn) return;
    tools = document.createElement('div');
    tools.className = 'header-tools';
    themeBtn.parentNode.insertBefore(tools, themeBtn);
    tools.appendChild(themeBtn);
  }

  const areaHeadings = (meta && meta.areas ? meta.areas : []).map((a) => a.heading);

  const root = document.createElement('div');
  root.className = 'lang';
  root.innerHTML = `
    <button class="lang-trigger" type="button" data-trigger aria-haspopup="listbox" aria-expanded="false" aria-label="Language">
      ${GLOBE}<span data-code>EN</span>
    </button>
    <div class="lang-menu" data-menu role="listbox" aria-label="Language" hidden>
      ${LANGS.map((l) => `
        <button class="lang-option" type="button" role="option" aria-selected="false" data-lang="${l.code}">
          <span>${esc(l.label)}</span><span class="lang-option-native">${esc(l.native)}</span>
        </button>`).join('')}
    </div>`;
  tools.prepend(root);

  const triggerEl = root.querySelector('[data-trigger]');
  const codeEl = root.querySelector('[data-code]');
  const menuEl = root.querySelector('[data-menu]');
  const optionEls = [...root.querySelectorAll('[data-lang]')];

  const banner = document.createElement('p');
  banner.className = 'lang-note';
  banner.hidden = true;
  proseEl.parentNode.insertBefore(banner, proseEl);

  let current = 'original';
  let run = 0; // Bumped on every change; an in-flight translation checks it and bails if stale.

  const byCode = (code) => LANGS.find((l) => l.code === code);

  function paint(code) {
    const lang = byCode(code) || LANGS[0];
    codeEl.textContent = code === 'original' ? 'EN' : lang.native;
    triggerEl.setAttribute('aria-label', `Language: ${lang.label}`);
    optionEls.forEach((el) => el.setAttribute('aria-selected', String(el.dataset.lang === code)));
  }

  function say(html) {
    banner.hidden = !html;
    banner.innerHTML = html || '';
  }

  // A labelled progress bar in the same banner. `pct` null → an indeterminate sweep, for
  // the stretch before any byte count is in (loading the library) or after it (spinning
  // up the model on the first tokens).
  function bar(label, pct) {
    banner.hidden = false;
    const indeterminate = pct == null;
    const w = indeterminate ? 100 : Math.max(0, Math.min(100, pct));
    banner.innerHTML = `
      <span class="lang-progress-text">${esc(label)}</span>
      <span class="lang-progress${indeterminate ? ' is-indeterminate' : ''}" role="progressbar"
        aria-valuemin="0" aria-valuemax="100"${indeterminate ? '' : ` aria-valuenow="${Math.round(w)}"`}>
        <span class="lang-progress-bar" style="width:${w}%"></span>
      </span>`;
  }

  function toOriginal(persist) {
    run++;
    current = 'original';
    if (persist) save(LANG_KEY, 'original');
    triggerEl.classList.remove('is-working');
    paint('original');
    say('');
    render(markdown, meta);
  }

  function apply(lang, doc, headings) {
    current = lang.code;
    triggerEl.classList.remove('is-working');
    paint(lang.code);
    say(`Machine translation, in your browser · ${esc(lang.native)} — <button type="button" data-revert>show the original</button>`);
    render(doc, translatedMeta(meta, headings));
  }

  async function translate(lang) {
    const ticket = ++run;
    current = lang.code;
    paint(lang.code);

    const hit = readCache(tripId, lang.code);
    if (hit) { apply(lang, hit.doc, hit.headings || []); return; }

    triggerEl.classList.add('is-working');
    bar('Loading the translator…', null);

    try {
      const translator = await getTranslator(downloadProgress((label, pct) => {
        if (ticket === run) bar(label, pct);
      }));
      if (ticket !== run) return;

      const { skeleton, pieces } = segmentMarkdown(markdown);
      const total = new Set(pieces).size;
      bar(`Translating… 0 / ${total}`, null);

      const [translated, headings] = await Promise.all([
        translateAll(pieces, lang.flores, translator, (done, n) => {
          if (ticket === run) bar(`Translating… ${done} / ${n}`, (done / n) * 100);
        }),
        areaHeadings.length
          ? translator(areaHeadings, { src_lang: SRC_FLORES, tgt_lang: lang.flores })
              .then((r) => (Array.isArray(r) ? r : [r]).map((x) => x.translation_text))
              .catch(() => [])
          : Promise.resolve([]),
      ]);

      if (ticket !== run) return; // Language changed while this was running.

      const doc = fillHoles(skeleton, translated);
      if (!doc.trim()) throw new Error('the translation came back empty');

      writeCache(tripId, lang.code, { doc, headings });
      apply(lang, doc, headings);
    } catch (err) {
      if (ticket !== run) return;
      console.warn('translate:', err);
      current = 'original';
      save(LANG_KEY, 'original');
      triggerEl.classList.remove('is-working');
      paint('original');
      render(markdown, meta);
      say(`Couldn't translate — ${esc(err.message || String(err))}.`);
    }
  }

  function choose(code) {
    setMenu(false);
    if (code === current && !triggerEl.classList.contains('is-working')) return;
    if (code === 'original') { toOriginal(true); return; }
    save(LANG_KEY, code);
    translate(byCode(code));
  }

  function setMenu(open) {
    menuEl.hidden = !open;
    triggerEl.setAttribute('aria-expanded', String(open));
  }

  triggerEl.addEventListener('click', () => setMenu(menuEl.hidden));
  menuEl.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-lang]');
    if (opt) choose(opt.dataset.lang);
  });
  banner.addEventListener('click', (e) => {
    if (e.target.closest('[data-revert]')) toOriginal(true);
  });
  document.addEventListener('click', (e) => {
    if (!menuEl.hidden && !e.target.closest('.lang')) setMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menuEl.hidden) setMenu(false);
  });

  paint('original');
  const remembered = read(LANG_KEY);
  if (remembered && remembered !== 'original' && byCode(remembered)) translate(byCode(remembered));
}

// ---------- storage, all best-effort ----------

function read(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
}
function readCache(id, code) {
  try { return JSON.parse(localStorage.getItem(cacheKey(id, code))); } catch (e) { return null; }
}
function writeCache(id, code, value) {
  try {
    localStorage.setItem(cacheKey(id, code), JSON.stringify(value));
  } catch (e) {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('trip-tr:'))
        .forEach((k) => localStorage.removeItem(k));
      localStorage.setItem(cacheKey(id, code), JSON.stringify(value));
    } catch (e2) { /* the translation still shows; it just won't persist */ }
  }
}

document.addEventListener('trip:loaded', (e) => initTranslate(e.detail), { once: true });
