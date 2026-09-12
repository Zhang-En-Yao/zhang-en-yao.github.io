// The Gallery section: a trip's photos, served from a per-trip GitHub repo via jsDelivr and
// resized on the fly by the wsrv.nl image proxy (a 900px WebP is ~15 KB vs a 1.7 MB original).
import { esc } from '../shared/dom.js';

const PHOTO_CDN = 'https://cdn.jsdelivr.net/gh';
const PHOTO_REPO_BRANCH = 'main';
const PHOTO_PROXY = 'https://wsrv.nl/';
const THUMB = { w: 900, q: 75 };
const FULL = { w: 2000, q: 80 };
const HIRES = { w: 4000, q: 85 }; // Loaded only when zooming in.

const isUrl = (s) => /^https?:\/\//.test(s);

// Where a photo lives, or '' when nothing says.
//
// A migrated trip keeps its photos in its own assets repository under photos/, and the
// `assets` pin in travel/index.json already names that repository — nothing else has to.
// A trip that has not migrated names its photo repository with `photoRepo` ("owner/repo"
// or "owner/repo@branch"), the older arrangement of one repository per trip's photos.
// `photoRepo` disappears with the last unmigrated trip.
//
// There is deliberately no default. A guessed repository name renders as a broken image
// rather than an error, which is how the old fallback (an owner spelled without its
// hyphens) sat here never resolving for anyone. A trip with neither is a content error,
// and tools/check-assets.py is where it is caught.
function photoUrl(file, content, base) {
  if (isUrl(file)) return file;
  if (base) return `${base}/photos/${encodeURIComponent(file)}`;
  if (!content.photoRepo) return '';
  const [repo, branch = PHOTO_REPO_BRANCH] = content.photoRepo.split('@');
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

// Returns [html, photos] where `photos` is the lightbox list in page order. `caption` is set
// only for a photo given an explicit `alt`, not one named after its file.
export function galleryHtml(content, base) {
  const photos = (content.photos || [])
    .map((p) => {
      const file = typeof p === 'string' ? p : p.file;
      if (!file) return null;
      const alt = typeof p === 'string' ? file.replace(/\.[^.]+$/, '') : (p.alt || '');
      const caption = typeof p === 'string' ? '' : (p.alt || '');
      const raw = photoUrl(file, content, base);
      if (!raw) return null; // No source for this trip's photos; see photoUrl.
      return isUrl(file)
        ? { thumb: raw, src: raw, hires: raw, alt, caption }
        : { thumb: sizedUrl(raw, THUMB), src: sizedUrl(raw, FULL), hires: sizedUrl(raw, HIRES), alt, caption };
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
