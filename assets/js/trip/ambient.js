// Tints the page background with a heavily blurred copy of the most visible photo, reusing
// the already-loaded thumbnail. Two panes alternate so colours crossfade.
const TAKE_OVER = 0.15; // Visible share a photo needs to become the tint.

export function initAmbient(root) {
  const imgs = [...root.querySelectorAll('.photo img')];
  if (!imgs.length) return;

  const layer = document.createElement('div');
  layer.className = 'ambient';
  layer.setAttribute('aria-hidden', 'true');
  layer.innerHTML = '<img class="ambient-img" alt=""><img class="ambient-img" alt="">';
  document.body.appendChild(layer);

  const panes = [...layer.children];
  let front = 0;
  let current = '';

  function tint(src) {
    if (!src || src === current) return;
    current = src;
    const next = panes[1 - front];
    const cross = () => {
      if (current !== src) return; // A newer photo was picked while this one decoded.
      next.classList.add('is-on');
      panes[front].classList.remove('is-on');
      front = 1 - front;
    };
    next.src = src;
    if (next.complete && next.naturalWidth) cross();
    else next.addEventListener('load', cross, { once: true });
  }

  function clear() {
    if (!current) return;
    current = '';
    panes.forEach((pane) => pane.classList.remove('is-on'));
  }

  // Taking over needs TAKE_OVER, but any sliver of a photo keeps the current tint, so the
  // hand-off between stacked photos never flashes back to plain.
  const seen = new Map();
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => seen.set(e.target, e.isIntersecting ? e.intersectionRatio : 0));
    let best = null;
    let top = TAKE_OVER;
    let anyVisible = false;
    seen.forEach((ratio, img) => {
      if (ratio > 0) anyVisible = true;
      if (ratio > top) { top = ratio; best = img; }
    });
    if (best) tint(best.currentSrc || best.src);
    else if (!anyVisible) clear();
  }, { threshold: [0, 0.15, 0.35, 0.6, 0.85] });

  imgs.forEach((img) => io.observe(img));
}
