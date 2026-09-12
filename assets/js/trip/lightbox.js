// The photo viewer for a trip's Gallery: a filmstrip, a Ken Burns slideshow, zoom for detail,
// swipe between photos (or down to close), full screen, keyboard shortcuts, and #photo-N
// links that open straight to a photo.
import { esc } from '../shared/dom.js';
import { retryPhotoSrc } from './gallery.js';
import { MapView } from '../travel/map-view.js';

const SLIDE_MS = 13000; // Dwell per photo while playing, counted from when it has loaded.
const FADE_MS = 900; // Slideshow crossfade.
const SLIDE_ANIM_MS = 380; // Manual paging.
const IDLE_MS = 2600; // Mouse stillness before the controls fade.
const SPINNER_DELAY_MS = 450;
const CONTENT_WIDTH = 1000; // Zoom content units; the height follows each photo's ratio.
const MAX_ZOOM = 6;
const GAP = 32; // px between neighbouring photos while paging
const RADIUS = 10; // px corner radius of a fitted photo
const HASH = /^#photo-(\d+)$/;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const touchFirst = window.matchMedia('(hover: none)');
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;

const icon = (body, attrs = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${attrs}>${body}</svg>`;
const ICONS = {
  play: '<svg class="icon-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.2v13.6a1 1 0 0 0 1.5.86l11-6.8a1 1 0 0 0 0-1.72l-11-6.8A1 1 0 0 0 8 5.2Z"/></svg>',
  pause: '<svg class="icon-pause" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1.2"/><rect x="14" y="4.5" width="4" height="15" rx="1.2"/></svg>',
  link: icon('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  enter: icon('<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>', 'class="icon-enter"'),
  exit: icon('<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/>', 'class="icon-exit"'),
  keyboard: icon('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M9 15.5h6"/>'),
  close: icon('<path d="M18 6 6 18M6 6l12 12"/>'),
};

const SHORTCUTS = [
  [['←', '→'], 'Previous or next photo'],
  [['Space'], 'Play or pause the slideshow'],
  [['+', '−'], 'Zoom in or out'],
  [['0'], 'Fit the photo to the screen'],
  [['Double-click'], 'Zoom to a detail'],
  [['F'], 'Full screen'],
  [['?'], 'Show or hide these shortcuts'],
  [['Esc'], 'Close'],
];

export function initLightbox(root, photos, { title = '' } = {}) {
  if (!photos.length) return;
  const count = photos.length;
  const wrap = (i) => ((i % count) + count) % count;

  const lb = document.createElement('div');
  lb.className = 'lb';
  lb.hidden = true;
  lb.tabIndex = -1;
  lb.setAttribute('role', 'dialog');
  lb.setAttribute('aria-modal', 'true');
  lb.setAttribute('aria-label', 'Photo viewer');
  lb.style.setProperty('--slide-ms', `${SLIDE_MS}ms`);
  lb.innerHTML = `
    <img class="lb-glow" alt="" aria-hidden="true">
    <div class="lb-stage">
      <div class="lb-track">
        <img class="lb-side" data-side="-1" alt="" aria-hidden="true">
        <div class="lb-outgoing" aria-hidden="true"><img alt=""></div>
        <div class="lb-zoom">
          <div class="lb-kb">
            <img class="lb-layer lb-thumb" alt="">
            <img class="lb-layer lb-full" alt="" aria-hidden="true">
            <img class="lb-layer lb-hires" alt="" aria-hidden="true">
          </div>
        </div>
        <img class="lb-side" data-side="1" alt="" aria-hidden="true">
      </div>
    </div>
    <div class="lb-spinner" aria-hidden="true"></div>
    <header class="lb-bar lb-top">
      <div class="lb-heading">
        <p class="lb-title">${esc(title)}</p>
        <p class="lb-counter" aria-live="polite"></p>
      </div>
      <div class="lb-actions">
        <button class="lb-btn" type="button" data-action="play" aria-pressed="false" aria-label="Play slideshow">${ICONS.play}${ICONS.pause}</button>
        <button class="lb-btn" type="button" data-action="link" aria-label="Copy a link to this photo">${ICONS.link}</button>
        <button class="lb-btn" type="button" data-action="fullscreen" aria-label="Full screen"${document.fullscreenEnabled || document.webkitFullscreenEnabled ? '' : ' hidden'}>${ICONS.enter}${ICONS.exit}</button>
        <button class="lb-btn lb-help-btn" type="button" data-action="help" aria-label="Keyboard shortcuts" aria-expanded="false">${ICONS.keyboard}</button>
        <button class="lb-btn" type="button" data-action="close" aria-label="Close">${ICONS.close}</button>
      </div>
    </header>
    <footer class="lb-bar lb-bottom">
      <div class="lb-progress" aria-hidden="true"><span></span></div>
      <div class="lb-strip" role="group" aria-label="All photos">
        ${photos.map((p, i) => `
          <button class="lb-thumbnail" type="button" data-index="${i}" aria-label="Photo ${i + 1} of ${count}">
            <img src="${esc(p.thumb)}" alt="" loading="lazy" decoding="async">
          </button>`).join('')}
      </div>
    </footer>
    <div class="lb-help" role="dialog" aria-label="Keyboard shortcuts" hidden>
      <p class="lb-help-title">Keyboard shortcuts</p>
      <dl>
        ${SHORTCUTS.map(([keys, what]) => `<dt>${keys.map((k) => `<kbd>${k}</kbd>`).join(' ')}</dt><dd>${what}</dd>`).join('')}
      </dl>
    </div>
    <p class="lb-toast" role="status"></p>`;
  document.body.appendChild(lb);

  const $ = (selector) => lb.querySelector(selector);
  const stage = $('.lb-stage');
  const track = $('.lb-track');
  const zoomEl = $('.lb-zoom');
  const kbEl = $('.lb-kb');
  const thumbImg = $('.lb-thumb');
  const fullImg = $('.lb-full');
  const hiresImg = $('.lb-hires');
  const outgoing = $('.lb-outgoing');
  const sides = [...lb.querySelectorAll('.lb-side')];
  const glow = $('.lb-glow');
  const counter = $('.lb-counter');
  const strip = $('.lb-strip');
  const thumbnails = [...strip.children];
  const progress = $('.lb-progress span');
  const help = $('.lb-help');
  const toast = $('.lb-toast');
  const buttons = Object.fromEntries([...lb.querySelectorAll('[data-action]')].map((b) => [b.dataset.action, b]));

  // Aspect ratios. The viewer's own images are authoritative once they load; until then ask
  // the gallery cell, whose thumbnail has normally loaded by the time a visitor clicks it.
  // Read lazily on purpose: at init the gallery markup is one tick old and nothing has loaded,
  // so snapshotting here would freeze every photo at the 1.5 fallback.
  const cells = [...root.querySelectorAll('.photo')];
  const ratios = photos.map(() => 0);
  const cellRatio = (i) => {
    const img = cells[i]?.querySelector('img');
    return img && img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 0;
  };
  const ratioOf = (i) => ratios[i] || cellRatio(i) || 1.5;
  // Until a photo's shape is known, its frame is held blank rather than guessed and resized.
  const known = (i) => ratios[i] > 0 || cellRatio(i) > 0;

  let at = 0;
  let isOpen = false;
  let opener = null;
  let pushedHistory = false;
  let playing = false;
  let arrived = false;
  let hiresRequested = false;
  let slideTimer = 0;
  let spinnerTimer = 0;
  let idleTimer = 0;
  let toastTimer = 0;
  let paging = null; // { timer, commit } while a slide animation runs
  let swipeAxis = null;
  let wheelTravel = 0;
  let wheelCooldown = 0;
  let overBars = false;

  const view = new MapView(stage, {
    width: CONTENT_WIDTH,
    height: CONTENT_WIDTH / 1.5,
    maxZoom: MAX_ZOOM,
    keys: false,
    wheelPan: true,
    onChange: applyView,
    onTap: tap,
    onDoubleTap: doubleTap,
    onSwipe: swipe,
    onScrollHint: wheelAtFit,
  });

  // ---------- geometry ----------

  function barPadding() {
    const narrow = window.matchMedia('(max-width: 640px)').matches;
    return narrow ? { top: 56, bottom: 84, left: 0, right: 0 } : { top: 68, bottom: 104, left: 32, right: 32 };
  }

  // Where a photo of ratio `ar` sits when fitted, in stage pixels.
  function fitRect(ar) {
    const { top, right, bottom, left } = view.padding;
    const aw = view.w - left - right;
    const ah = view.h - top - bottom;
    const w = Math.min(aw, ah * ar);
    const h = w / ar;
    return { x: left + (aw - w) / 2, y: top + (ah - h) / 2, w, h };
  }

  function placeRect(el, r) {
    Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  }

  function applyView({ s, x, y }) {
    zoomEl.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${s})`;
    zoomEl.style.setProperty('--r', `${(view.padding.left ? RADIUS : 0) / s}px`); // Square when edge to edge.
    const zoomed = !view.atMinScale;
    lb.classList.toggle('is-zoomed', zoomed);
    if (zoomed && playing) setPlaying(false);
    if (!hiresRequested && s > view.minScale * 1.6) loadHires();
  }

  function layoutSides() {
    sides.forEach((el) => {
      const offset = Number(el.dataset.side);
      const i = wrap(at + offset);
      const r = fitRect(ratioOf(i));
      placeRect(el, { ...r, x: r.x + offset * (view.w + GAP) });
      if (el.dataset.index !== String(i)) {
        el.dataset.index = String(i);
        el.src = photos[i].thumb;
      }
      el.hidden = count < 2 || !known(i);
    });
  }

  // ---------- loading ----------

  function watch(img, onDone) {
    img.onload = () => onDone(true);
    img.onerror = () => {
      const next = retryPhotoSrc(img.src);
      if (next) img.src = next;
      else onDone(false);
    };
  }

  function noteRatio(i, width, height) {
    if (!width || !height) return;
    const ar = width / height;
    if (Math.abs(ar / ratioOf(i) - 1) < 0.01 && known(i)) return;
    ratios[i] = ar;
    if (i === at) setContentFor(i);
    layoutSides();
  }

  const updateRatio = (i, img) => noteRatio(i, img.naturalWidth, img.naturalHeight);

  function setContentFor(i) {
    const height = CONTENT_WIDTH / ratioOf(i);
    zoomEl.style.width = `${CONTENT_WIDTH}px`;
    zoomEl.style.height = `${height}px`;
    view.setContent(CONTENT_WIDTH, height);
    lb.classList.toggle('is-measuring', !known(i));
  }

  function loadHires() {
    hiresRequested = true;
    const i = at;
    watch(hiresImg, (ok) => { if (ok && i === at) hiresImg.classList.add('is-loaded'); });
    hiresImg.src = photos[i].hires || photos[i].src;
  }

  function reveal() {
    if (arrived) return;
    arrived = true;
    clearTimeout(spinnerTimer);
    lb.classList.remove('is-loading');
    if (playing) startDwell();
  }

  // Loading a neighbour early also settles its shape, so paging to it never resizes the frame.
  function preloadNeighbours() {
    [1, -1].forEach((d) => {
      const i = wrap(at + d);
      const img = new Image();
      img.onload = () => noteRatio(i, img.naturalWidth, img.naturalHeight);
      img.src = photos[i].src;
      if (known(i)) return;
      const thumb = new Image(); // The smaller file answers the shape question sooner.
      thumb.onload = () => noteRatio(i, thumb.naturalWidth, thumb.naturalHeight);
      thumb.src = photos[i].thumb;
    });
  }

  // Every filmstrip thumbnail reports its shape as it loads.
  strip.addEventListener('load', (e) => {
    const i = Number(e.target.closest('.lb-thumbnail')?.dataset.index);
    if (Number.isInteger(i)) noteRatio(i, e.target.naturalWidth, e.target.naturalHeight);
  }, true);

  // ---------- showing a photo ----------

  function commit(i) {
    at = wrap(i);
    const photo = photos[at];
    finishPaging(false);
    track.style.transition = 'none';
    track.style.transform = '';
    kbEl.style.animation = '';
    progress.classList.remove('is-running');
    clearTimeout(slideTimer);

    arrived = false;
    hiresRequested = false;
    fullImg.classList.remove('is-loaded');
    hiresImg.classList.remove('is-loaded');
    hiresImg.removeAttribute('src');
    setContentFor(at);

    thumbImg.alt = photo.alt;
    watch(thumbImg, (ok) => { if (ok) updateRatio(at, thumbImg); });
    thumbImg.src = photo.thumb;
    if (thumbImg.complete) updateRatio(at, thumbImg);
    watch(fullImg, (ok) => {
      if (ok) {
        fullImg.classList.add('is-loaded');
        updateRatio(at, fullImg);
      }
      reveal();
    });
    fullImg.src = photo.src;
    if (fullImg.complete && fullImg.naturalWidth) {
      fullImg.classList.add('is-loaded');
      reveal();
    } else {
      clearTimeout(spinnerTimer);
      spinnerTimer = setTimeout(() => { if (!arrived) lb.classList.add('is-loading'); }, SPINNER_DELAY_MS);
    }

    glow.src = photo.thumb;
    counter.textContent = [`${at + 1} of ${count}`, photo.caption].filter(Boolean).join(' · ');
    thumbnails.forEach((t, j) => t.toggleAttribute('aria-current', j === at));
    centreThumbnail();
    layoutSides();
    preloadNeighbours();
    if (isOpen) history.replaceState(history.state, '', photoUrl());
  }

  function centreThumbnail() {
    const t = thumbnails[at];
    const left = t.offsetLeft + t.offsetWidth / 2 - strip.clientWidth / 2;
    strip.scrollTo({ left, behavior: reduceMotion.matches || !isOpen ? 'auto' : 'smooth' });
  }

  // Slide the track one photo over, then swap the content in place.
  function page(direction, fromOffset = 0) {
    if (count < 2) return;
    if (reduceMotion.matches) return commit(at + direction);
    finishPaging(true);
    const target = -direction * (view.w + GAP);
    const remaining = Math.abs(target - fromOffset) / (view.w + GAP);
    const duration = Math.max(180, SLIDE_ANIM_MS * remaining);
    track.style.transition = 'none';
    track.style.transform = `translate3d(${fromOffset}px, 0, 0)`;
    void track.offsetWidth;
    track.style.transition = `transform ${duration}ms cubic-bezier(0.22, 1, 0.36, 1)`;
    track.style.transform = `translate3d(${target}px, 0, 0)`;
    const next = at + direction;
    paging = { commit: () => commit(next), timer: setTimeout(() => { paging = null; commit(next); }, duration) };
  }

  function finishPaging(runCommit) {
    if (!paging) return;
    clearTimeout(paging.timer);
    const { commit: pending } = paging;
    paging = null;
    if (runCommit) pending();
  }

  // Crossfade to another photo, carrying the outgoing photo's Ken Burns frame with it.
  function fadeTo(i) {
    if (reduceMotion.matches) return commit(i);
    const r = fitRect(ratioOf(at));
    placeRect(outgoing, r);
    const img = outgoing.firstElementChild;
    img.src = (hiresImg.classList.contains('is-loaded') && hiresImg.currentSrc)
      || (fullImg.classList.contains('is-loaded') && fullImg.currentSrc) || thumbImg.currentSrc || thumbImg.src;
    img.style.transform = getComputedStyle(kbEl).transform;
    outgoing.getAnimations().forEach((a) => a.cancel());
    commit(i);
    outgoing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'ease-in-out', fill: 'forwards' });
    zoomEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease-in-out' });
  }

  function go(i, how) {
    const target = wrap(i);
    if (target === at && how !== 'force') return;
    if (how === 'slide') {
      const forward = wrap(at + 1) === target;
      const backward = wrap(at - 1) === target;
      if (forward || backward) return page(forward ? 1 : -1);
    }
    fadeTo(target);
  }

  // ---------- slideshow ----------

  function setPlaying(on) {
    playing = on && count > 1;
    lb.classList.toggle('is-playing', playing);
    buttons.play.setAttribute('aria-pressed', String(playing));
    buttons.play.setAttribute('aria-label', playing ? 'Pause slideshow' : 'Play slideshow');
    clearTimeout(slideTimer);
    if (playing) {
      if (!view.atMinScale) view.set(view.homeView());
      if (arrived) startDwell();
      scheduleIdle(true);
    } else {
      kbEl.style.animationPlayState = 'paused';
      progress.classList.remove('is-running');
    }
  }

  function startDwell() {
    clearTimeout(slideTimer);
    progress.classList.remove('is-running');
    void progress.offsetWidth;
    progress.classList.add('is-running');
    if (!reduceMotion.matches) {
      kbEl.style.animation = `lb-ken-burns-${at % 4} ${SLIDE_MS + FADE_MS}ms linear forwards`;
    }
    slideTimer = setTimeout(() => {
      if (playing) new Image().src = photos[wrap(at + 2)].src;
      fadeTo(at + 1);
    }, SLIDE_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (!isOpen || !playing) return;
    if (document.hidden) {
      clearTimeout(slideTimer);
      progress.classList.remove('is-running');
    } else if (arrived) {
      startDwell();
    }
  });

  // ---------- gestures ----------

  function tap(target, _at, pointerType) {
    if (pointerType === 'mouse') {
      if (!target.closest('.lb-zoom')) close();
      return;
    }
    lb.classList.toggle('is-idle');
  }

  function doubleTap(point) {
    if (view.atMinScale) view.zoomBy(2.5, point);
    else view.flyTo(view.homeView());
  }

  function swipe(phase, { dx, dy, vx, vy }) {
    if (phase === 'move') {
      if (!swipeAxis) swipeAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      finishPaging(true);
      track.style.transition = 'none';
      if (swipeAxis === 'x') {
        track.style.transform = `translate3d(${count > 1 ? dx : dx * 0.25}px, 0, 0)`;
      } else {
        const k = Math.min(1, Math.abs(dy) / 420);
        track.style.transformOrigin = '50% 50%';
        track.style.transform = `translate3d(${dx * 0.4}px, ${dy}px, 0) scale(${1 - k * 0.2})`;
        lb.style.setProperty('--dismiss', k.toFixed(3));
      }
      return;
    }

    const axis = swipeAxis;
    swipeAxis = null;
    if (phase === 'end' && axis === 'x' && count > 1
      && (Math.abs(dx) > view.w * 0.18 || (Math.abs(vx) > 0.35 && Math.sign(vx) === Math.sign(dx)))) {
      return page(dx < 0 ? 1 : -1, dx);
    }
    if (phase === 'end' && axis === 'y' && (Math.abs(dy) > 120 || Math.abs(vy) > 0.6)) {
      return close({ dismissY: dy });
    }
    springBack();
  }

  function springBack() {
    track.style.transition = `transform ${reduceMotion.matches ? 0 : 320}ms cubic-bezier(0.22, 1, 0.36, 1)`;
    track.style.transform = '';
    lb.style.setProperty('--dismiss', '0');
  }

  // Two-finger horizontal scrolling on a trackpad pages through photos.
  function wheelAtFit(e) {
    if (!e || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    if (e.timeStamp < wheelCooldown) return;
    wheelTravel += e.deltaX;
    if (Math.abs(wheelTravel) < 80) return;
    go(at + Math.sign(wheelTravel), 'slide');
    wheelTravel = 0;
    wheelCooldown = e.timeStamp + 500;
  }

  // ---------- chrome ----------

  function scheduleIdle(force = false) {
    lb.classList.remove('is-idle');
    clearTimeout(idleTimer);
    if (touchFirst.matches && !force) return;
    idleTimer = setTimeout(() => {
      if (!overBars && help.hidden) lb.classList.add('is-idle');
    }, IDLE_MS);
  }

  lb.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') scheduleIdle(); });
  lb.querySelectorAll('.lb-bar').forEach((bar) => {
    bar.addEventListener('pointerenter', () => { overBars = true; });
    bar.addEventListener('pointerleave', () => { overBars = false; });
  });

  function toggleHelp(show = help.hidden) {
    help.hidden = !show;
    buttons.help.setAttribute('aria-expanded', String(show));
    if (show) lb.classList.remove('is-idle');
    else scheduleIdle();
  }

  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-on'), 1800);
  }

  const photoUrl = () => `${location.pathname}${location.search}#photo-${at + 1}`;

  async function shareLink() {
    const url = new URL(photoUrl(), location.href).href;
    if (touchFirst.matches && navigator.share) {
      try {
        await navigator.share({ title: document.title, url });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied');
    } catch (err) {
      showToast('Could not copy the link');
    }
  }

  async function toggleFullscreen() {
    try {
      if (fullscreenElement()) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else await (lb.requestFullscreen || lb.webkitRequestFullscreen).call(lb);
    } catch (err) { /* Refused, e.g. without a user gesture. */ }
  }

  const onFullscreenChange = () => {
    const on = fullscreenElement() === lb;
    lb.classList.toggle('is-fullscreen', on);
    buttons.fullscreen.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // ---------- opening and closing ----------

  // The photo grows out of its gallery cell (and shrinks back into it on close).
  function flipFrom(rect, reverse = false) {
    if (!rect || !rect.width || reduceMotion.matches) return null;
    const r = fitRect(ratioOf(at));
    if (!r.w || !r.h) return null; // The viewer has not been laid out yet.
    const k = rect.width / r.w;
    const from = `translate3d(${rect.left - r.x * k}px, ${rect.top - r.y * k}px, 0) scale(${k})`;
    track.style.transformOrigin = '0 0';
    const frames = [{ transform: from, opacity: reverse ? 0 : 1 }, { transform: 'none', opacity: 1 }];
    return track.animate(reverse ? frames.reverse() : frames, { duration: 360, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
  }

  function visibleCellRect(i) {
    const rect = cells[i]?.getBoundingClientRect();
    return rect && rect.bottom > 0 && rect.top < window.innerHeight ? rect : null;
  }

  function open(i, from = null, { fromHistory = false } = {}) {
    // Measured first: showing the viewer and locking the body must not move the cell we
    // are growing out of.
    const fromRect = from?.getBoundingClientRect();
    opener = from;
    isOpen = true;
    lb.hidden = false;
    lb.classList.remove('is-closing');
    lb.style.setProperty('--dismiss', '0');
    document.body.classList.add('is-locked');
    view.padding = barPadding();
    view.resize();
    commit(i);
    view.set(view.homeView());
    if (!fromHistory) {
      if (HASH.test(location.hash)) history.replaceState(history.state, '', photoUrl());
      else {
        history.pushState({ lightbox: true }, '', photoUrl());
        pushedHistory = true;
      }
    }
    lb.classList.add('is-opening');
    const anim = flipFrom(fromRect);
    const done = () => lb.classList.remove('is-opening');
    if (anim) anim.finished.then(done, done);
    else done();
    scheduleIdle();
    lb.focus({ preventScroll: true });
  }

  // Closes the viewer. Called directly, or from popstate once the history entry is gone.
  function close({ dismissY = 0, fromHistory = false } = {}) {
    if (!isOpen) return;
    if (!fromHistory && pushedHistory && history.state?.lightbox) {
      closeOptions = { dismissY };
      history.back(); // popstate finishes the close.
      return;
    }
    if (!fromHistory) history.replaceState(history.state, '', `${location.pathname}${location.search}`);
    pushedHistory = false;
    hide(dismissY);
  }
  let closeOptions = null;

  function hide(dismissY = 0) {
    isOpen = false;
    setPlaying(false);
    toggleHelp(false);
    finishPaging(false);
    clearTimeout(spinnerTimer);
    clearTimeout(idleTimer);
    if (fullscreenElement() === lb) toggleFullscreen();

    const cellRect = visibleCellRect(at);
    lb.classList.add('is-closing');
    let anim = null;
    if (!reduceMotion.matches) {
      if (dismissY) {
        track.style.transition = 'transform 260ms ease-in';
        track.style.transform = `translate3d(0, ${Math.sign(dismissY) * view.h * 0.6}px, 0) scale(0.7)`;
      } else if (cellRect && view.atMinScale) {
        anim = flipFrom(cellRect, true);
      }
    }
    const finish = () => {
      lb.hidden = true;
      lb.classList.remove('is-closing', 'is-idle');
      track.style.transition = 'none';
      track.style.transform = '';
      document.body.classList.remove('is-locked');
      opener?.focus({ preventScroll: true });
      opener = null;
    };
    if (anim) anim.finished.then(finish, finish);
    else setTimeout(finish, reduceMotion.matches ? 0 : 260);
  }

  window.addEventListener('popstate', () => {
    const match = HASH.exec(location.hash);
    const index = match ? Number(match[1]) - 1 : -1;
    if (isOpen && index < 0) {
      pushedHistory = false;
      const options = closeOptions || {};
      closeOptions = null;
      hide(options.dismissY || 0);
    } else if (index >= 0 && index < count) {
      if (isOpen) go(index, 'fade');
      else open(index, cells[index] || null, { fromHistory: true });
    }
  });

  // ---------- wiring ----------

  root.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-photo]');
    if (cell) open(Number(cell.dataset.photo), cell);
  });

  lb.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'play') setPlaying(!playing);
    else if (action === 'link') shareLink();
    else if (action === 'fullscreen') toggleFullscreen();
    else if (action === 'help') toggleHelp();
    else if (action === 'close') close();

    const thumb = e.target.closest('.lb-thumbnail');
    if (thumb) go(Number(thumb.dataset.index), 'slide');
    if (!help.hidden && !e.target.closest('.lb-help, [data-action="help"]')) toggleHelp(false);
  });

  document.addEventListener('keydown', (e) => {
    if (!isOpen || e.metaKey || e.ctrlKey || e.altKey) return;
    const zoomAt = [view.w / 2, view.h / 2];
    const actions = {
      Escape: () => {
        if (!help.hidden) toggleHelp(false);
        else if (!view.atMinScale) view.flyTo(view.homeView());
        else close();
      },
      ArrowLeft: () => go(at - 1, 'slide'),
      ArrowRight: () => go(at + 1, 'slide'),
      Home: () => go(0, 'fade'),
      End: () => go(count - 1, 'fade'),
      ' ': () => setPlaying(!playing),
      f: toggleFullscreen,
      F: toggleFullscreen,
      '?': () => toggleHelp(),
      '+': () => view.zoomBy(1.6, zoomAt),
      '=': () => view.zoomBy(1.6, zoomAt),
      '-': () => view.zoomBy(1 / 1.6, zoomAt),
      _: () => view.zoomBy(1 / 1.6, zoomAt),
      0: () => view.flyTo(view.homeView()),
      Tab: () => trapFocus(e),
    };
    const action = actions[e.key];
    if (!action) return;
    if (e.key !== 'Tab') e.preventDefault();
    // Space and Enter on a focused button should press it, not toggle the slideshow.
    if (e.key === ' ' && e.target.closest?.('button')) {
      e.preventDefault();
      e.target.click();
      return;
    }
    action();
  });

  function trapFocus(e) {
    const focusable = [...lb.querySelectorAll('button:not([hidden])')].filter((b) => b.offsetParent);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (e.shiftKey && (document.activeElement === first || document.activeElement === lb)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  new ResizeObserver(() => {
    if (!isOpen) return;
    const zoomed = !view.atMinScale;
    view.padding = barPadding();
    if (!zoomed) view.set(view.homeView());
    layoutSides();
    centreThumbnail();
  }).observe(stage);

  // Opened from a shared link.
  const match = HASH.exec(location.hash);
  if (match) {
    const index = Number(match[1]) - 1;
    if (index >= 0 && index < count) {
      cells[index]?.scrollIntoView({ block: 'center' });
      open(index, cells[index] || null, { fromHistory: true });
    }
  }
}
