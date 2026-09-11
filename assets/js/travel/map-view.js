// Pan and zoom for a map: drag with inertia, pinch, ⌘/Ctrl + wheel and trackpad pinch,
// arrow and +/− keys, and "fly to" animations along van Wijk & Nuij's optimal zoom path.
// The view maps content units to screen pixels: screen = content × s + (x, y).

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const RHO = Math.SQRT2;
const cosh = (v) => (Math.exp(v) + Math.exp(-v)) / 2;
const sinh = (v) => (Math.exp(v) - Math.exp(-v)) / 2;
const tanh = (v) => sinh(v) / cosh(v);

// Interpolates [centerX, centerY, visibleWidth] so zooming out, panning and zooming back in
// read as one continuous flight (the same maths as d3.interpolateZoom).
function interpolateZoom([ux0, uy0, w0], [ux1, uy1, w1]) {
  const dx = ux1 - ux0;
  const dy = uy1 - uy0;
  const d2 = dx * dx + dy * dy;
  let S;
  let at;
  if (d2 < 1e-12) {
    S = Math.log(w1 / w0) / RHO;
    at = (t) => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(RHO * t * S)];
  } else {
    const d1 = Math.sqrt(d2);
    const b0 = (w1 * w1 - w0 * w0 + RHO ** 4 * d2) / (2 * w0 * RHO ** 2 * d1);
    const b1 = (w1 * w1 - w0 * w0 - RHO ** 4 * d2) / (2 * w1 * RHO ** 2 * d1);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
    const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    S = (r1 - r0) / RHO;
    at = (t) => {
      const s = t * S;
      const u = (w0 / (RHO ** 2 * d1)) * (cosh(r0) * tanh(RHO * s + r0) - sinh(r0));
      return [ux0 + u * dx, uy0 + u * dy, (w0 * cosh(r0)) / cosh(RHO * s + r0)];
    };
  }
  at.length_ = Math.abs(S);
  return at;
}

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

// iOS-style resistance past an edge: the further you pull, the less it follows.
const rubberBand = (overshoot, size) => (1 - 1 / ((overshoot * 0.55) / size + 1)) * size;

const DECELERATION_MS = 325;
const WHEEL_SMOOTHING_MS = 70;
const SETTLE_SMOOTHING_MS = 80;
const TAP_SLOP_PX = 6;

export class MapView {
  constructor(el, { width, height, maxZoom = 40, home, onChange, onTap, onHover, onGesture, onScrollHint }) {
    Object.assign(this, { el, width, height, maxZoom, home, onChange, onTap, onHover, onGesture, onScrollHint });
    this.w = 0;
    this.h = 0;
    this.view = { s: 1, x: 0, y: 0 };
    this.anim = null;
    this.raf = 0;

    this.resize();
    new ResizeObserver(() => this.resize()).observe(el);
    this.attachPointers();
    this.attachWheel();
    this.attachKeys();
  }

  get minScale() { return Math.min(this.w / this.width, this.h / this.height); }

  get maxScale() { return this.minScale * this.maxZoom; }

  clampScale(s) { return Math.min(this.maxScale, Math.max(this.minScale, s)); }

  // Keeps the content covering the viewport (or centred where it is smaller than it).
  clamp({ s, x, y }, rubber = false) {
    s = this.clampScale(s);
    const axis = (t, size, content) => {
      const span = content * s;
      if (span <= size) return (size - span) / 2;
      const lo = size - span;
      if (t > 0) return rubber ? rubberBand(t, size) : 0;
      if (t < lo) return rubber ? lo - rubberBand(lo - t, size) : lo;
      return t;
    };
    return { s, x: axis(x, this.w, this.width), y: axis(y, this.h, this.height) };
  }

  // The view that frames content bounds [[x0, y0], [x1, y1]] inside the viewport minus
  // `inset` pixels ({ top, right, bottom, left }), no closer than `maxZoom`.
  fitView([[x0, y0], [x1, y1]], { inset = {}, maxZoom = this.maxZoom } = {}) {
    const { top = 0, right = 0, bottom = 0, left = 0 } = inset;
    const aw = Math.max(1, this.w - left - right);
    const ah = Math.max(1, this.h - top - bottom);
    const fit = Math.min(aw / Math.max(x1 - x0, 1e-6), ah / Math.max(y1 - y0, 1e-6));
    const s = Math.max(this.minScale, Math.min(this.minScale * maxZoom, fit));
    return this.clamp({ s, x: left + aw / 2 - (s * (x0 + x1)) / 2, y: top + ah / 2 - (s * (y0 + y1)) / 2 });
  }

  homeView() { return this.home ? this.home(this) : this.clamp({ s: this.minScale, x: 0, y: 0 }); }

  isHome() {
    const a = this.view;
    const b = this.homeView();
    return Math.abs(a.s / b.s - 1) < 0.01 && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;
  }

  toScreen([cx, cy]) { return [cx * this.view.s + this.view.x, cy * this.view.s + this.view.y]; }

  toContent([px, py]) { return [(px - this.view.x) / this.view.s, (py - this.view.y) / this.view.s]; }

  resize() {
    const { width, height } = this.el.getBoundingClientRect();
    if (!width || !height || (width === this.w && height === this.h)) return;
    const first = !this.w;
    const zoom = first ? 1 : this.view.s / this.minScale;
    const center = first ? null : this.toContent([this.w / 2, this.h / 2]);
    this.w = width;
    this.h = height;
    if (first) return this.set(this.homeView());
    const s = this.minScale * zoom;
    this.set({ s, x: width / 2 - center[0] * s, y: height / 2 - center[1] * s });
  }

  // ---------- applying views ----------

  apply(view) {
    this.view = view;
    this.onChange?.(view, this);
  }

  set(view) {
    this.stop();
    this.apply(this.clamp(view));
  }

  run(anim) {
    this.anim = anim;
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    this.anim = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  tick = (now) => {
    const dt = Math.min(64, now - this.last);
    this.last = now;
    const anim = this.anim;
    if (!anim) { this.raf = 0; return; }
    if (anim.step(now, dt)) {
      if (this.anim === anim) this.anim = null;
      this.raf = 0;
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  flyTo(target) {
    const to = this.clamp(target);
    const zoomSpace = (v) => [(this.w / 2 - v.x) / v.s, (this.h / 2 - v.y) / v.s, this.w / v.s];
    const path = interpolateZoom(zoomSpace(this.view), zoomSpace(to));
    const duration = reduceMotion.matches ? 0 : Math.min(1300, Math.max(420, path.length_ * 650));
    if (!duration || !Number.isFinite(path.length_)) return this.set(to);

    const start = performance.now();
    this.run({
      step: (now) => {
        const t = Math.min(1, (now - start) / duration);
        if (t === 1) { this.apply(to); return true; }
        const [cx, cy, visible] = path(easeInOutCubic(t));
        const s = this.w / visible;
        this.apply({ s, x: this.w / 2 - cx * s, y: this.h / 2 - cy * s });
        return false;
      },
    });
  }

  zoomBy(factor, at = [this.w / 2, this.h / 2]) {
    const c = this.toContent(at);
    const s = this.clampScale(this.view.s * factor);
    this.flyTo({ s, x: at[0] - c[0] * s, y: at[1] - c[1] * s });
  }

  panBy(dx, dy) {
    this.flyTo({ ...this.view, x: this.view.x + dx, y: this.view.y + dy });
  }

  // Wheel and trackpad zoom: each event moves a target, and the view eases after it, so
  // coarse mouse-wheel steps still animate and a pinch stays anchored under the cursor.
  smoothZoom(factor, at) {
    const chase = this.anim?.kind === 'zoom' ? this.anim : { kind: 'zoom' };
    chase.target = this.clampScale((chase.target ?? this.view.s) * factor);
    chase.at = at;
    chase.anchor = this.toContent(at);
    if (reduceMotion.matches) {
      const s = chase.target;
      return this.set({ s, x: at[0] - chase.anchor[0] * s, y: at[1] - chase.anchor[1] * s });
    }
    chase.step = (now, dt) => {
      const k = 1 - Math.exp(-dt / WHEEL_SMOOTHING_MS);
      const current = Math.log(this.view.s);
      const done = Math.abs(Math.log(chase.target) - current) < 0.002;
      const s = done ? chase.target : Math.exp(current + (Math.log(chase.target) - current) * k);
      this.apply(this.clamp({ s, x: chase.at[0] - chase.anchor[0] * s, y: chase.at[1] - chase.anchor[1] * s }));
      return done;
    };
    if (this.anim !== chase) this.run(chase);
  }

  // Back inside the bounds after a rubber-banded drag or pinch.
  settle() {
    const to = this.clamp(this.view);
    const from = this.view;
    if (Math.abs(to.x - from.x) < 0.5 && Math.abs(to.y - from.y) < 0.5 && Math.abs(to.s - from.s) < 1e-6) return;
    if (reduceMotion.matches) return this.set(to);
    this.run({
      step: (now, dt) => {
        const k = 1 - Math.exp(-dt / SETTLE_SMOOTHING_MS);
        const v = this.view;
        const next = { s: v.s + (to.s - v.s) * k, x: v.x + (to.x - v.x) * k, y: v.y + (to.y - v.y) * k };
        const done = Math.abs(next.x - to.x) < 0.3 && Math.abs(next.y - to.y) < 0.3;
        this.apply(done ? to : next);
        return done;
      },
    });
  }

  // Momentum after a flick, decelerating like a scroll view and stopping at the edges.
  glide(vx, vy) {
    if (reduceMotion.matches || Math.hypot(vx, vy) < 0.2) return this.settle();
    this.run({
      step: (now, dt) => {
        const v = this.view;
        const free = { s: v.s, x: v.x + vx * dt, y: v.y + vy * dt };
        const next = this.clamp(free);
        if (next.x !== free.x) vx = 0;
        if (next.y !== free.y) vy = 0;
        const decay = Math.exp(-dt / DECELERATION_MS);
        vx *= decay;
        vy *= decay;
        this.apply(next);
        return Math.hypot(vx, vy) < 0.02;
      },
    });
  }

  // ---------- input ----------

  local(e) {
    const r = this.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  attachPointers() {
    const el = this.el;
    const pointers = new Map();
    let gesture = null;
    let tap = null;
    let samples = [];

    const begin = () => {
      const pts = [...pointers.values()];
      samples = [];
      if (pts.length === 1) {
        gesture = { type: 'pan', raw: { ...this.view } };
      } else {
        const [a, b] = pts;
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        gesture = { type: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, s0: this.view.s, anchor: this.toContent(mid) };
      }
    };

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (pointers.size >= 2) return;
      this.stop();
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, this.local(e));
      tap = pointers.size === 1 ? { target: e.target, at: this.local(e), moved: false } : null;
      if (pointers.size === 2) this.onGesture?.();
      begin();
    });

    el.addEventListener('pointermove', (e) => {
      const p = this.local(e);
      if (!pointers.has(e.pointerId)) {
        if (e.pointerType === 'mouse') this.onHover?.(p);
        return;
      }
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, p);

      if (tap && !tap.moved) {
        if (Math.hypot(p[0] - tap.at[0], p[1] - tap.at[1]) < TAP_SLOP_PX) return;
        tap.moved = true;
        el.classList.add('is-dragging');
        this.onGesture?.();
      }

      if (gesture.type === 'pan') {
        gesture.raw.x += p[0] - prev[0];
        gesture.raw.y += p[1] - prev[1];
        this.apply(this.clamp(gesture.raw, true));
        samples.push([e.timeStamp, this.view.x, this.view.y]);
        while (samples.length > 2 && e.timeStamp - samples[0][0] > 100) samples.shift();
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const s = this.clampScale((gesture.s0 * Math.hypot(a[0] - b[0], a[1] - b[1])) / gesture.d0);
        this.apply(this.clamp({ s, x: mid[0] - gesture.anchor[0] * s, y: mid[1] - gesture.anchor[1] * s }, true));
      }
    });

    const end = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pointers.size) return begin(); // A pinch lifted one finger: carry on panning.

      el.classList.remove('is-dragging');
      const wasTap = tap && !tap.moved && e.type === 'pointerup';
      const tapped = tap;
      tap = null;
      if (wasTap) return this.onTap?.(tapped.target, tapped.at);

      const clamped = this.clamp(this.view);
      const outOfBounds = Math.abs(clamped.x - this.view.x) > 0.5 || Math.abs(clamped.y - this.view.y) > 0.5;
      const first = samples[0];
      const last = samples.at(-1);
      if (gesture?.type !== 'pan' || outOfBounds || !first || first === last || e.timeStamp - last[0] > 60) {
        return this.settle();
      }
      const dt = Math.max(16, last[0] - first[0]);
      this.glide((last[1] - first[1]) / dt, (last[2] - first[2]) / dt);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.onHover?.(null); });

    // Safari reports trackpad pinches as gesture events rather than ctrl + wheel.
    let lastScale = 1;
    el.addEventListener('gesturestart', (e) => { e.preventDefault(); lastScale = 1; });
    el.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      if (pointers.size) return; // A touch pinch, already handled by pointer events.
      this.onGesture?.();
      this.smoothZoom(e.scale / lastScale, this.local(e));
      lastScale = e.scale;
    });
    el.addEventListener('gestureend', (e) => e.preventDefault());
  }

  attachWheel() {
    this.el.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return this.onScrollHint?.(); // Plain scrolling scrolls the page.
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002;
      // Trackpad pinches arrive as small ctrl + wheel deltas; mouse wheels as large steps.
      const exponent = Math.max(-0.5, Math.min(0.5, -e.deltaY * unit * (e.ctrlKey ? 10 : 1)));
      this.onGesture?.();
      this.smoothZoom(2 ** exponent, this.local(e));
    }, { passive: false });
  }

  attachKeys() {
    this.el.addEventListener('keydown', (e) => {
      if (e.target !== this.el || e.metaKey || e.ctrlKey || e.altKey) return;
      const step = Math.min(this.w, this.h) * 0.25;
      const actions = {
        ArrowLeft: () => this.panBy(step, 0),
        ArrowRight: () => this.panBy(-step, 0),
        ArrowUp: () => this.panBy(0, step),
        ArrowDown: () => this.panBy(0, -step),
        '+': () => this.zoomBy(2),
        '=': () => this.zoomBy(2),
        '-': () => this.zoomBy(0.5),
        _: () => this.zoomBy(0.5),
        0: () => this.flyTo(this.homeView()),
      };
      const action = actions[e.key];
      if (!action) return;
      e.preventDefault();
      this.onGesture?.();
      action();
    });
  }
}
