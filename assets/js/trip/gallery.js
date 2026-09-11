// The Gallery section: a trip's photos, served from a per-trip GitHub repo via jsDelivr and
// resized on the fly by the wsrv.nl image proxy (a 900px WebP is ~15 KB vs a 1.7 MB original).
import { esc } from '../shared/dom.js';

const PHOTO_CDN = 'https://cdn.jsdelivr.net/gh';
const PHOTO_REPO_OWNER = 'ZhangEnYao';
const PHOTO_REPO_BRANCH = 'main';
const PHOTO_PROXY = 'https://wsrv.nl/';
const THUMB = { w: 900, q: 75 };
const FULL = { w: 2000, q: 80 };

const isUrl = (s) => /^https?:\/\//.test(s);

// `photoRepo` is "owner/repo" or "owner/repo@branch"; the default repo is named after the trip id.
function photoUrl(file, content, tripId) {
  if (isUrl(file)) return file;
  const slug = content.photoRepo || `${PHOTO_REPO_OWNER}/${tripId}`;
  const [repo, branch = PHOTO_REPO_BRANCH] = slug.split('@');
  return `${PHOTO_CDN}/${repo}@${branch}/${encodeURIComponent(file)}`;
}

function sizedUrl(url, { w, q }) {
  return `${PHOTO_PROXY}?${new URLSearchParams({ url, w: String(w), q: String(q), output: 'webp' })}`;
}

// The next source to try after a failed load, or '' when out of options.
// jsDelivr throttles bursts with a 403 that the proxy then caches as a 404; the same URL with
// an extra parameter misses that cache. After that, fall back to the original file.
export function retryPhotoSrc(src) {
  if (!src.startsWith(PHOTO_PROXY)) return '';
  const params = new URL(src).searchParams;
  if (!params.has('retry')) return `${src}&retry=1`;
  return params.get('url') || '';
}

// Returns [html, photos] where `photos` is the lightbox list in page order.
export function galleryHtml(content, tripId) {
  const photos = (content.photos || [])
    .map((p) => {
      const file = typeof p === 'string' ? p : p.file;
      if (!file) return null;
      const alt = typeof p === 'string' ? file.replace(/\.[^.]+$/, '') : (p.alt || '');
      const raw = photoUrl(file, content, tripId);
      return isUrl(file)
        ? { thumb: raw, src: raw, alt }
        : { thumb: sizedUrl(raw, THUMB), src: sizedUrl(raw, FULL), alt };
    })
    .filter(Boolean);
  if (!photos.length) return ['', []];

  const cells = photos
    .map((p, i) => `
        <button class="photo is-loading" type="button" data-photo="${i}" aria-label="${esc(p.alt || 'Open photo')}">
          <img src="${esc(p.thumb)}" alt="${esc(p.alt)}" loading="lazy">
        </button>`)
    .join('');
  return [`<h2>Gallery</h2><div class="photo-grid">${cells}</div>`, photos];
}

// Clears each cell's skeleton once its image loads (recording the real aspect ratio) or
// every fallback source has failed.
export function wireGallery(root) {
  root.querySelectorAll('.photo').forEach((cell) => {
    const img = cell.querySelector('img');
    const done = () => {
      if (img.naturalWidth && img.naturalHeight) {
        cell.style.setProperty('--ar', (img.naturalWidth / img.naturalHeight).toFixed(4));
      }
      cell.classList.remove('is-loading');
    };
    if (img.complete) return done();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', () => {
      const next = retryPhotoSrc(img.src);
      if (next) img.src = next;
      else cell.classList.remove('is-loading');
    });
  });
}
