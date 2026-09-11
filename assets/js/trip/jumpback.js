// After an in-page link jumps far, offers a "Back" pill to return to the reading position.
// It dismisses itself on use, Escape, ×, scrolling back near the origin, or after a while.
const REVEAL_MIN = 240; // px a jump must move before the pill is worth showing
const NEAR_ORIGIN = 120;
const HEADER_OFFSET = 80; // matches `scroll-padding-top` in core.css
const LINGER_MS = 13000;

const BACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-2"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

export function initJumpback() {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let originY = null;
  let leftOrigin = false; // The smooth scroll starts inside NEAR_ORIGIN; ignore that pass.
  let box = null;
  let raf = 0;
  let showRaf = 0;
  let timer = 0;

  function ensureBox() {
    if (box) return box;
    box = document.createElement('div');
    box.className = 'jumpback';
    box.hidden = true;
    box.innerHTML = `
      <button type="button" class="jumpback-go" aria-label="Back to where you were">${BACK_ICON}<span>Back</span></button>
      <button type="button" class="jumpback-dismiss" aria-label="Dismiss">${CLOSE_ICON}</button>`;
    box.querySelector('.jumpback-go').addEventListener('click', () => {
      const y = originY;
      hide();
      if (y != null) window.scrollTo({ top: y, behavior: reduceMotion ? 'auto' : 'smooth' });
    });
    box.querySelector('.jumpback-dismiss').addEventListener('click', hide);
    document.body.appendChild(box);
    return box;
  }

  function show() {
    leftOrigin = false;
    ensureBox().hidden = false;
    cancelAnimationFrame(showRaf);
    showRaf = requestAnimationFrame(() => box.classList.add('is-on'));
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('keydown', onKey);
    clearTimeout(timer);
    timer = setTimeout(hide, LINGER_MS);
  }

  function hide() {
    originY = null;
    leftOrigin = false;
    clearTimeout(timer);
    cancelAnimationFrame(showRaf);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('keydown', onKey);
    if (!box || box.hidden) return;
    box.classList.remove('is-on');
    const b = box;
    setTimeout(() => { if (!b.classList.contains('is-on')) b.hidden = true; }, 240);
  }

  function onKey(e) {
    if (e.key === 'Escape') hide();
  }

  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (originY == null) return;
      const gap = Math.abs(window.scrollY - originY);
      if (!leftOrigin) {
        if (gap > NEAR_ORIGIN * 1.5) leftOrigin = true;
      } else if (gap < NEAR_ORIGIN) {
        hide();
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a) return;

    const url = new URL(a.href, location.href);
    if (url.pathname !== location.pathname || url.search !== location.search || !url.hash) return;
    const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
    if (!target) return;

    const from = Math.round(window.scrollY);
    const dest = Math.round(target.getBoundingClientRect().top + window.scrollY - HEADER_OFFSET);
    if (Math.abs(dest - from) < REVEAL_MIN) return hide();

    originY = from;
    show();
  });
}
