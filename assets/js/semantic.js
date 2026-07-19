// Semantic search for the note list, run entirely in the browser.
//
// Exact search asks "which notes contain these characters?". This asks "which notes
// mean something like this?", so a query the papers never literally use — "how does
// the brain compute?" — still finds McCulloch & Pitts. The price is that every note
// has to be turned into a vector first, and comparing vectors is not free the way
// String.includes is.
//
// Transformers.js runs a small embedding model on WASM; the weights come from the
// Hugging Face CDN on first use and the browser's Cache API keeps them afterwards.
// Nothing is sent anywhere: the query never leaves the page.

// ~23 MB quantised, English-only. The notes and the papers are English, so this is
// the cheap fit; swapping in Xenova/paraphrase-multilingual-MiniLM-L12-v2 (~118 MB)
// is the one-line change that buys Chinese queries against the same English notes.
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

const CACHE_KEY = 'note-embeddings-v1';

// Cosine between unrelated MiniLM vectors sits near 0.0–0.15 and between genuinely
// related ones around 0.3 and up, so this trims the tail without hiding loose
// matches. It is the first number to turn if results feel too strict or too noisy —
// the cards show their score so it can be calibrated by eye.
const MIN_SCORE = 0.25;

// What the model reads for each note. The markdown body is deliberately left out:
// it is long enough to drown the title and summary in method detail.
const docText = (n) =>
  [n.title, n.authors, n.venue, (n.tags || []).join(', '), n.summary]
    .filter(Boolean)
    .join('\n');

// FNV-1a: cheap, stable across reloads, and enough to notice any edit to the index.
// Keyed with the model too, since vectors from two models are not comparable.
function fingerprint(texts) {
  const s = [MODEL, ...texts].join(' ');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// The model is loaded once, lazily — a visitor who never opens semantic mode never
// pays the download. `onProgress` reports the weight download, which is the slow part.
let extractorPromise = null;

function loadExtractor(onProgress) {
  if (extractorPromise) return extractorPromise;

  extractorPromise = (async () => {
    const { pipeline } = await import(TRANSFORMERS);
    return pipeline('feature-extraction', MODEL, {
      dtype: 'q8',
      progress_callback: (e) => {
        if (e.status === 'progress' && e.total) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      },
    });
  })();

  // A failed load must not poison every later search: drop the rejected promise so
  // the next query can retry. The caller still sees this rejection.
  extractorPromise.catch(() => {
    extractorPromise = null;
  });

  return extractorPromise;
}

async function embed(texts, onProgress) {
  const extract = await loadExtractor(onProgress);
  // Mean pooling over the token vectors is what this model was trained for, and
  // normalising makes the dot product below a cosine.
  const out = await extract(texts, { pooling: 'mean', normalize: true });
  return out.tolist();
}

function readCache(fp) {
  try {
    const hit = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return hit && hit.fingerprint === fp ? hit.vectors : null;
  } catch (e) {
    return null;
  }
}

function writeCache(fp, vectors) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fingerprint: fp, vectors }));
  } catch (e) {
    // Over quota, or private mode. The vectors are simply recomputed next visit.
  }
}

// Embedding the corpus is the one job that grows with the number of notes, so its
// result is cached across visits and reused across searches within one.
let vectorsPromise = null;

function noteVectors(notes, onProgress) {
  if (vectorsPromise) return vectorsPromise;

  const texts = notes.map(docText);
  const fp = fingerprint(texts);
  const cached = readCache(fp);

  vectorsPromise = cached
    ? Promise.resolve(cached)
    : embed(texts, onProgress).then((vectors) => {
        writeCache(fp, vectors);
        return vectors;
      });

  vectorsPromise.catch(() => {
    vectorsPromise = null;
  });

  return vectorsPromise;
}

// Both vectors are unit length, so the dot product is already the cosine.
function similarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// [{ note, score }], best first, anything below MIN_SCORE dropped. `onProgress(pct)`
// fires only while the weights are downloading. Rejects if the model cannot load —
// the caller decides what to show.
async function semanticSearch(query, notes, onProgress = () => {}) {
  if (!notes.length) return [];

  // Sequential on purpose: both calls share one model instance, and the corpus pass
  // is what triggers the download, so the query would only queue behind it anyway.
  const vectors = await noteVectors(notes, onProgress);
  const [queryVector] = await embed([query], onProgress);

  return notes
    .map((note, i) => ({ note, score: similarity(queryVector, vectors[i]) }))
    .filter((r) => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);
}
