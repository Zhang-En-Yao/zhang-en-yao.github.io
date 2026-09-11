// Full-screen photo viewer: arrow keys or swipe to step, Space to play a slideshow.
import { retryPhotoSrc } from './gallery.js';

const SLIDE_MS = 13000; // Dwell per photo, counted from when it is actually shown.
const SWAP_MS = 300; // Minimum blur crossfade, so a cached photo doesn't cut in hard.
const SWIPE_MIN = 45;

const PLAY_ICONS = `
  <svg class="icon-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>
  <svg class="icon-pause" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/></svg>`;
const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

export function initLightbox(root, photos) {
  if (!photos.length) return;

  const box = document.createElement('div');
  box.className = 'lightbox';
  box.hidden = true;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', 'Photo');
  box.innerHTML = `
    <img class="lightbox-glow" alt="" aria-hidden="true">
    <button class="lightbox-btn lightbox-play" type="button" data-play aria-pressed="false" aria-label="Play slideshow">${PLAY_ICONS}</button>
    <button class="lightbox-btn lightbox-close" type="button" data-close aria-label="Close">${CLOSE_ICON}</button>
    <img class="lightbox-prev" alt="" aria-hidden="true">
    <figure class="lightbox-figure"><img class="lightbox-img" alt=""></figure>
    <div class="lightbox-spinner" aria-hidden="true"></div>`;
  document.body.appendChild(box);

  const imgEl = box.querySelector('.lightbox-img');
  const prevEl = box.querySelector('.lightbox-prev');
  const glowEl = box.querySelector('.lightbox-glow');
  const closeEl = box.querySelector('[data-close]');
  const playEl = box.querySelector('[data-play]');

  const many = photos.length > 1;
  playEl.hidden = !many;

  let at = 0;
  let opener = null;
  let playing = false;
  let slideTimer = 0;
  let holdTimer = 0;
  let shown = ''; // src currently on screen
  let arrived = false; // current photo loaded, or ran out of fallbacks
  let holding = false; // crossfade minimum still running
  let revealed = false;

  // Runs once both the load and the crossfade minimum are done, whichever finishes last.
  function reveal() {
    if (revealed || !arrived || holding) return;
    revealed = true;
    box.classList.remove('is-swapping', 'is-loading');
    if (shown) {
      glowEl.src = shown;
      box.classList.add('has-glow');
    }
    if (playing) queueNext();
  }

  function settle() {
    arrived = true;
    reveal();
  }

  function queueNext() {
    clearTimeout(slideTimer);
    slideTimer = setTimeout(() => show(at + 1), SLIDE_MS);
    if (many) new Image().src = photos[(at + 1) % photos.length].src; // Prefetch one ahead.
  }

  imgEl.addEventListener('load', () => {
    shown = imgEl.currentSrc || imgEl.src;
    settle();
  });
  imgEl.addEventListener('error', () => {
    const next = retryPhotoSrc(imgEl.src);
    if (next) imgEl.src = next;
    else settle();
  });

  // `carry`: blur the outgoing photo behind the incoming one (false on a fresh open).
  function show(i, carry = true) {
    at = (i + photos.length) % photos.length;
    clearTimeout(slideTimer);
    clearTimeout(holdTimer);

    const swap = carry && !!shown;
    if (swap) prevEl.src = shown;
    box.classList.toggle('has-prev', swap);
    box.classList.toggle('is-swapping', swap);
    box.classList.remove('is-loading', 'has-glow');
    shown = '';
    arrived = false;
    revealed = false;
    holding = swap;

    imgEl.alt = photos[at].alt;
    imgEl.src = photos[at].src;
    // Cached (or unchanged) sources may never fire `load`.
    if (imgEl.complete && imgEl.naturalWidth) {
      shown = imgEl.currentSrc || imgEl.src;
      arrived = true;
    }

    if (!swap) {
      if (!arrived) box.classList.add('is-loading');
      reveal();
      return;
    }
    holdTimer = setTimeout(() => {
      holding = false;
      if (!arrived) box.classList.add('is-loading');
      reveal();
    }, SWAP_MS);
  }

  function setPlaying(on) {
    playing = on && many;
    box.classList.toggle('is-playing', playing);
    playEl.setAttribute('aria-pressed', String(playing));
    playEl.setAttribute('aria-label', playing ? 'Pause slideshow' : 'Play slideshow');
    clearTimeout(slideTimer);
    if (playing && revealed) queueNext();
  }

  function open(i, from) {
    opener = from;
    show(i, false);
    box.hidden = false;
    document.body.classList.add('is-locked');
    closeEl.focus();
  }

  function close() {
    setPlaying(false);
    box.hidden = true;
    document.body.classList.remove('is-locked');
    opener?.focus();
    opener = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(slideTimer);
    else if (playing && !box.hidden && revealed) queueNext();
  });

  root.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-photo]');
    if (cell) open(Number(cell.dataset.photo), cell);
  });

  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-play]')) return setPlaying(!playing);
    if (e.target.closest('[data-close]') || !e.target.closest('.lightbox-figure')) close();
  });

  document.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'Escape') close();
    else if (!many) return;
    else if (e.key === ' ') {
      e.preventDefault(); // Otherwise Space also activates the focused Close button.
      setPlaying(!playing);
    } else if (e.key === 'ArrowLeft') show(at - 1);
    else if (e.key === 'ArrowRight') show(at + 1);
  });

  let startX = 0;
  let startY = 0;
  box.addEventListener('touchstart', (e) => {
    ({ clientX: startX, clientY: startY } = e.changedTouches[0]);
  }, { passive: true });
  box.addEventListener('touchend', (e) => {
    if (!many) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy)) return;
    show(at + (dx < 0 ? 1 : -1));
  }, { passive: true });
}
