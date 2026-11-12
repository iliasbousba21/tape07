// Physical-feeling controls: Knob, Wheel (jog/reel with inertia), Fader (varispeed).
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function haptic(ms = 6) {
  try { navigator.vibrate?.(ms); } catch {}
}

/* ---------------------------------------------------------------- knob */
export class Knob {
  // value: min..max, bipolar knobs show an arc from the centre
  constructor(el, { min = 0, max = 1, value = 0, def = 0, bipolar = false, label, onChange, format }) {
    Object.assign(this, { el, min, max, def, bipolar, onChange, format });
    el.classList.add('knob');
    el.setAttribute('role', 'slider');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', label);
    el.setAttribute('aria-valuemin', min);
    el.setAttribute('aria-valuemax', max);
    el.innerHTML = `
      <svg class="k-ring" viewBox="0 0 64 64" aria-hidden="true">
        ${ticks()}
        <path class="k-arc-bg" d="${arc(-135, 135)}"/>
        <path class="k-arc"/>
      </svg>
      <div class="k-body"><div class="k-cap"><i class="k-pointer"></i></div></div>`;
    this.arcEl = el.querySelector('.k-arc');
    this.cap = el.querySelector('.k-cap');
    this.set(value, false);
    this.bind();
  }
  norm(v = this.value) { return (v - this.min) / (this.max - this.min); }
  set(v, emit = true) {
    v = clamp(v, this.min, this.max);
    if (this.bipolar && Math.abs(v) < (this.max - this.min) * 0.025) v = 0; // centre detent
    this.value = v;
    const a = -135 + this.norm(v) * 270;
    this.cap.style.transform = `rotate(${a}deg)`;
    const from = this.bipolar ? 0 : -135;
    this.arcEl.setAttribute('d', Math.abs(a - from) < 0.5 ? '' : arc(Math.min(from, a), Math.max(from, a)));
    const active = this.bipolar ? v !== 0 : v > this.min + 1e-4;
    this.el.classList.toggle('is-active', active);
    this.el.setAttribute('aria-valuenow', v.toFixed(2));
    this.el.setAttribute('aria-valuetext', this.format ? this.format(v) : v.toFixed(2));
    if (emit) this.onChange?.(v);
  }
  bind() {
    const el = this.el;
    let start = null, lastTap = 0;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.focus({ preventScroll: true });
      const now = performance.now();
      if (now - lastTap < 300) { this.set(this.def); haptic(12); lastTap = 0; return; }
      lastTap = now;
      start = { x: e.clientX, y: e.clientY, v: this.value };
      el.classList.add('is-grab');
    });
    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      const d = (e.clientX - start.x) - (e.clientY - start.y);
      const fine = e.shiftKey ? 0.25 : 1;
      const before = this.value;
      this.set(start.v + (d / 180) * (this.max - this.min) * fine);
      if (this.bipolar && before !== 0 && this.value === 0) haptic(8);
    });
    const end = () => { start = null; el.classList.remove('is-grab'); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('keydown', (e) => {
      const step = (this.max - this.min) / (e.shiftKey ? 100 : 20);
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') this.set(this.value + step);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') this.set(this.value - step);
      else if (e.key === 'Home') this.set(this.min);
      else if (e.key === 'End') this.set(this.max);
      else if (e.key === 'Delete' || e.key === 'Backspace' || e.key === '0') this.set(this.def);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }
}

function polar(a, r = 27) {
  const rad = ((a - 90) * Math.PI) / 180;
  return [32 + r * Math.cos(rad), 32 + r * Math.sin(rad)];
}
function arc(a0, a1, r = 27) {
  const [x0, y0] = polar(a0, r), [x1, y1] = polar(a1, r);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function ticks() {
  let s = '';
  for (let i = 0; i <= 10; i++) {
    const a = -135 + i * 27;
    const [x0, y0] = polar(a, 30.5), [x1, y1] = polar(a, i % 5 === 0 ? 33.5 : 32.5);
    s += `<line class="k-tick" x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}"/>`;
  }
  return s;
}

/* ---------------------------------------------------------------- wheel */
// Jog / reel. Exposes `angle` (deg). While touched or coasting, `driving` is true and
// `onScrub(deltaDeg)` is called; otherwise the app sets `angle` from playback.
export class Wheel {
  constructor(el, { onGrab, onScrub, onRelease, onSettle }) {
    Object.assign(this, { el, onGrab, onScrub, onRelease, onSettle });
    this.rot = el.querySelector('.w-rot');
    this.angle = 0;
    this.vel = 0; // deg per ms
    this.driving = false;
    this.touching = false;
    this.bind();
    this.buildScale();
  }
  buildScale() {
    const svg = this.el.querySelector('.w-scale');
    if (!svg) return;
    let s = '';
    for (let i = 0; i < 72; i++) {
      const a = i * 5;
      const long = i % 6 === 0;
      const r0 = 47.2, r1 = long ? 49.6 : 48.6;
      const rad = ((a - 90) * Math.PI) / 180;
      s += `<line x1="${(50 + r0 * Math.cos(rad)).toFixed(2)}" y1="${(50 + r0 * Math.sin(rad)).toFixed(2)}" x2="${(50 + r1 * Math.cos(rad)).toFixed(2)}" y2="${(50 + r1 * Math.sin(rad)).toFixed(2)}" class="${long ? 'l' : ''}"/>`;
    }
    svg.innerHTML = s;
  }
  render() {
    this.rot.style.transform = `rotate(${this.angle.toFixed(2)}deg)`;
  }
  centre() {
    const r = this.el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, r: r.width / 2 };
  }
  bind() {
    const el = this.el;
    let last = null, samples = [];
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const { cx, cy } = this.centre();
      last = { a: Math.atan2(e.clientY - cy, e.clientX - cx), t: performance.now() };
      samples = [];
      this.touching = this.driving = true;
      this.vel = 0;
      cancelAnimationFrame(this.raf);
      el.classList.add('is-touch');
      haptic(5);
      this.onGrab?.();
    });
    el.addEventListener('pointermove', (e) => {
      if (!last) return;
      const { cx, cy } = this.centre();
      const a = Math.atan2(e.clientY - cy, e.clientX - cx);
      let d = a - last.a;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      const deg = (d * 180) / Math.PI;
      const t = performance.now();
      samples.push({ deg, dt: Math.max(1, t - last.t), t });
      samples = samples.filter((s) => t - s.t < 90);
      last = { a, t };
      this.angle += deg;
      this.render();
      this.onScrub?.(deg);
      // detent clicks every 15°
      const notch = Math.floor(this.angle / 15);
      if (notch !== this._notch) { this._notch = notch; haptic(3); }
    });
    const up = () => {
      if (!last) return;
      last = null;
      el.classList.remove('is-touch');
      this.touching = false;
      const t = performance.now();
      const recent = samples.filter((s) => t - s.t < 90);
      const sum = recent.reduce((a, s) => a + s.deg, 0);
      const dur = recent.reduce((a, s) => a + s.dt, 0);
      this.vel = dur ? sum / dur : 0;
      this.onRelease?.();
      if (Math.abs(this.vel) > 0.05) this.coast();
      else this.settle();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }
  coast() {
    let prev = performance.now();
    const step = (now) => {
      const dt = Math.min(48, now - prev);
      prev = now;
      const d = this.vel * dt;
      this.angle += d;
      this.render();
      this.onScrub?.(d);
      this.vel *= Math.pow(0.9965, dt); // inertia / friction
      if (Math.abs(this.vel) > 0.01 && !this.touching) this.raf = requestAnimationFrame(step);
      else this.settle();
    };
    this.raf = requestAnimationFrame(step);
  }
  settle() {
    if (this.touching) return;
    this.driving = false;
    this.onSettle?.();
  }
}

/* ---------------------------------------------------------------- fader */
// Vertical varispeed fader, 0.5x .. 2x on a log scale, centre = 1.00 with a detent.
export class Fader {
  constructor(el, { value = 1, onChange }) {
    Object.assign(this, { el, onChange });
    this.cap = el.querySelector('.f-cap');
    this.track = el.querySelector('.f-track');
    el.setAttribute('role', 'slider');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', 'varispeed');
    el.setAttribute('aria-valuemin', '0.5');
    el.setAttribute('aria-valuemax', '2');
    this.set(value, false);
    this.bind();
  }
  static toPos(v) { return 0.5 + Math.log2(v) / 2; } // 0..1, 0.5 = 1.00x
  static fromPos(p) { return Math.pow(2, (p - 0.5) * 2); }
  set(v, emit = true) {
    v = clamp(v, 0.5, 2);
    if (Math.abs(Math.log2(v)) < 0.018) v = 1;
    this.value = Math.round(v * 100) / 100;
    const p = Fader.toPos(this.value);
    this.el.style.setProperty('--pos', (1 - p).toFixed(4));
    this.el.classList.toggle('is-off-centre', this.value !== 1);
    this.el.setAttribute('aria-valuenow', this.value.toFixed(2));
    this.el.setAttribute('aria-valuetext', `${this.value.toFixed(2)} times`);
    if (emit) this.onChange?.(this.value);
  }
  bind() {
    const el = this.el;
    let drag = null, lastTap = 0;
    const posFromY = (y) => {
      const r = this.track.getBoundingClientRect();
      return 1 - clamp((y - r.top) / r.height, 0, 1);
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const now = performance.now();
      if (now - lastTap < 300) { this.set(1); haptic(12); lastTap = 0; return; }
      lastTap = now;
      const onCap = e.target.closest('.f-cap');
      drag = { y: e.clientY, p: Fader.toPos(this.value), rel: !!onCap };
      if (!onCap) this.set(Fader.fromPos(posFromY(e.clientY)));
      el.classList.add('is-grab');
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const before = this.value;
      if (drag.rel) {
        const h = this.track.getBoundingClientRect().height;
        this.set(Fader.fromPos(drag.p - (e.clientY - drag.y) / h));
      } else this.set(Fader.fromPos(posFromY(e.clientY)));
      if (before !== 1 && this.value === 1) haptic(10);
    });
    const end = () => { drag = null; el.classList.remove('is-grab'); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('keydown', (e) => {
      const p = Fader.toPos(this.value);
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') this.set(Fader.fromPos(p + 0.01));
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') this.set(Fader.fromPos(p - 0.01));
      else if (e.key === '0' || e.key === 'Home') this.set(1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }
}
