import { db, storageInfo } from './db.js';
import { readTags } from './id3.js';
import { Engine } from './audio.js';
import { Knob, Wheel, Fader, reducedMotion } from './controls.js';
import { Recorder } from './recorder.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const DEG_PER_SEC = 150; // 1 reel revolution = 2.4 s of tape at 1.00x
const MAX_CUES = 8;
const PEAK_BINS = 720;

const engine = new Engine();
// Transport facade. Playback time lives on the tape reader; this keeps the rest of
// the UI on the same shape it had when `el` was an <audio> element.
const el = {
  get currentTime() { return engine.currentTime; },
  set currentTime(v) { engine.seek(v); },
  get duration() { return engine.duration; },
  get paused() { return !engine.playing; },
  get playbackRate() { return engine.transportRate || 1; },
  set playbackRate(v) { engine.setTransportRate(v); },
  get readyState() { return engine.ready ? 1 : 0; },
  get error() { return engine.lastError; },
  play() { return engine.start(); },
  pause() { engine.halt(); },
  load() {},
  removeAttribute() { engine.unload(); },
  getAttribute(name) { return name === 'src' && engine.ready ? '1' : null; },
  addEventListener(type, fn) { engine.on(type, fn); },
};
const recorder = new Recorder(engine);

const S = {
  tracks: [],
  cur: -1,
  url: null,
  speed: 1,
  ramp: 1, // tape start/stop factor
  holding: false, // finger on the reel
  wasPlaying: false,
  pendingSeek: null,
  loadToken: 0,
  loopArm: null, // A set, waiting for B
  settings: loadSettings(),
};

/* ------------------------------------------------------------ settings */
function loadSettings() {
  try {
    return { volume: 0.8, tone: 0, drive: 0, echo: 0, space: 0, wow: 0, fx: true, speed: 1, ...JSON.parse(localStorage.getItem('reel7.settings') || '{}') };
  } catch {
    return { volume: 0.8, tone: 0, drive: 0, echo: 0, space: 0, wow: 0, fx: true, speed: 1 };
  }
}
let saveT;
function saveSettings() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const t = S.tracks[S.cur];
    const s = { ...S.settings, lastId: t?.id, lastPos: el.currentTime || 0 };
    try { localStorage.setItem('reel7.settings', JSON.stringify(s)); } catch {}
  }, 300);
}

/* ------------------------------------------------------------ display */
const dTime = $('dTime'), dTitle = $('dTitle'), dMode = $('dMode'), dIdx = $('dIdx'), dSpd = $('dSpd');
const dFx = $('dFx'), dLoop = $('dLoop'), dMsg = $('dMsg');
let msgT;
function flash(text, ms = 1400, kind = '') {
  dMsg.textContent = text;
  dMsg.className = 'd-msg show ' + kind;
  clearTimeout(msgT);
  msgT = setTimeout(() => (dMsg.className = 'd-msg'), ms);
}

const pad = (n, l = 2) => String(Math.floor(n)).padStart(l, '0');
function timecode(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = t / 3600, m = (t / 60) % 60, s = t % 60, cs = (t * 100) % 100;
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}
function short(t) {
  if (!isFinite(t)) return '--:--';
  return t >= 3600 ? `${Math.floor(t / 3600)}:${pad((t / 60) % 60)}:${pad(t % 60)}` : `${pad(t / 60)}:${pad(t % 60)}`;
}

function setTitle(t) {
  const txt = t ? (t.artist ? `${t.title} — ${t.artist}` : t.title) : S.tracks.length ? 'tape ready' : 'no tape — tap tape to load';
  if (dTitle.textContent === txt) return;
  dTitle.textContent = txt;
  dTitle.parentElement.classList.remove('marquee');
  requestAnimationFrame(() => {
    const over = dTitle.scrollWidth - dTitle.parentElement.clientWidth;
    if (over > 4) {
      dTitle.parentElement.classList.add('marquee');
      dTitle.style.setProperty('--over', `${-over - 12}px`);
      dTitle.style.setProperty('--dur', `${Math.max(6, over / 18)}s`);
    }
  });
}

function updateStatus() {
  const t = S.tracks[S.cur];
  const playing = !el.paused && !S.holding;
  const rec = recorder.active;
  dMode.textContent = rec ? '● rec' : S.holding ? 'hold' : playing ? '▶ play' : el.currentTime > 0 && t ? '‖ pause' : '■ stop';
  dMode.classList.toggle('rec', rec);
  dIdx.textContent = S.tracks.length ? `${pad(S.cur + 1)}/${pad(S.tracks.length)}` : '--/--';
  dSpd.textContent = `${S.speed.toFixed(2)}x`;
  dSpd.classList.toggle('on', S.speed !== 1);
  dFx.classList.toggle('on', S.settings.fx && fxActive());
  dFx.classList.toggle('dim', !S.settings.fx);
  const loop = t?.loop;
  dLoop.classList.toggle('on', !!(loop && loop.b != null));
  dLoop.classList.toggle('arm', S.loopArm != null);
  $('kLoop').classList.toggle('lit', !!(loop && loop.b != null) || S.loopArm != null);
  $('kLoop').classList.toggle('blink', S.loopArm != null);
  $('kFx').classList.toggle('lit', S.settings.fx);
  $('kFx').setAttribute('aria-pressed', String(S.settings.fx));
  $('kPlay').classList.toggle('lit', playing);
  $('kPlay').setAttribute('aria-label', playing ? 'pause' : 'play');
  $('kPlay').querySelector('.glyph').className = 'glyph ' + (playing ? 'g-pause' : 'g-play');
  $('kRec').classList.toggle('lit', rec);
  $('lampPlay').classList.toggle('on', playing);
  $('lampRec').classList.toggle('on', rec);
  document.body.classList.toggle('is-playing', playing);
  setTitle(rec ? { title: `recording take ${pad(nextTakeNo(), 3)}` } : t);
}
const fxActive = () => ['drive', 'echo', 'space', 'wow'].some((k) => S.settings[k] > 0.001) || S.settings.tone !== 0;

/* ------------------------------------------------------------ canvases */
const wave = $('wave'), meters = $('meters');
const wctx = wave.getContext('2d'), mctx = meters.getContext('2d');
let dpr = 1;
function sizeCanvases() {
  // Cap at 2. A 3× phone canvas is a lot of fill for a pixel-font waveform.
  dpr = Math.min(2, window.devicePixelRatio || 1);
  for (const c of [wave, meters]) {
    const r = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
  }
}
{ const ro = new ResizeObserver(sizeCanvases); ro.observe(wave); ro.observe(meters); }

const css = getComputedStyle(document.documentElement);
const C = {
  fg: css.getPropertyValue('--px-hi').trim() || '#efece4',
  dim: css.getPropertyValue('--px-lo').trim() || '#3a3a36',
  mid: css.getPropertyValue('--px-mid').trim() || '#8b8880',
  hot: css.getPropertyValue('--orange').trim() || '#ff5c00',
};

function drawWave(now) {
  const W = wave.width, H = wave.height;
  wctx.clearRect(0, 0, W, H);
  const t = S.tracks[S.cur];
  const dur = trackDuration();
  const pos = dur ? clamp(el.currentTime / dur, 0, 1) : 0;
  const px = Math.max(1, Math.round(dpr)); // one "pixel" of our display
  const bar = px * 2, gap = px;
  const n = Math.floor(W / (bar + gap));
  const mid = Math.round(H * 0.56);
  const headX = Math.round(pos * W);

  // loop region
  if (t?.loop && dur) {
    const a = (t.loop.a / dur) * W;
    const b = t.loop.b != null ? (t.loop.b / dur) * W : headX;
    wctx.fillStyle = t.loop.b != null ? 'rgba(255,92,0,.16)' : 'rgba(255,92,0,.08)';
    wctx.fillRect(Math.min(a, b), 0, Math.abs(b - a), H);
  }

  if (t?.peaks?.length) {
    const pk = t.peaks;
    for (let i = 0; i < n; i++) {
      const v = pk[Math.floor((i / n) * pk.length)] / 255;
      const h = Math.max(px, Math.round((v * (H * 0.82)) / px / 2) * px);
      const x = i * (bar + gap);
      wctx.fillStyle = x < headX ? C.fg : C.dim;
      wctx.fillRect(x, mid - h, bar, h);
      wctx.fillRect(x, mid + px, bar, Math.round(h * 0.45 / px) * px);
    }
  } else {
    // no waveform (yet): moving tape strip with sprocket holes
    const off = reducedMotion() ? 0 : ((el.currentTime * 40) % 12) * px;
    wctx.fillStyle = C.dim;
    wctx.fillRect(0, mid - px, W, px * 2);
    for (let x = -off; x < W; x += 12 * px) {
      wctx.fillStyle = x < headX ? C.mid : C.dim;
      wctx.fillRect(Math.round(x), mid - 6 * px, 4 * px, 3 * px);
      wctx.fillRect(Math.round(x), mid + 4 * px, 4 * px, 3 * px);
    }
    if (t && !t.peaks && !t.peaksFailed) {
      wctx.fillStyle = C.mid;
      wctx.font = `${8 * px}px "Geist Pixel", monospace`;
      wctx.fillText('reading tape…', 2 * px, 9 * px);
    }
  }

  // cues
  if (t?.cues && dur) {
    wctx.font = `${7 * px}px "Geist Pixel", monospace`;
    t.cues.forEach((c, i) => {
      const x = Math.round((c / dur) * W);
      wctx.fillStyle = C.fg;
      wctx.fillRect(x, 0, px, H);
      wctx.fillRect(x, 0, 6 * px, 8 * px);
      wctx.fillStyle = '#0d0e0c';
      wctx.fillText(String(i + 1), x + px, 7 * px);
    });
  }
  // playhead
  if (t) {
    wctx.fillStyle = C.hot;
    wctx.fillRect(headX - px, 0, px * 2, H);
  }
}

const lv = [0, 0], peak = [0, 0], peakT = [0, 0];
let lastMeterT = 0;
function drawMeters(now) {
  const dt = Math.min(100, now - (lastMeterT || now));
  lastMeterT = now;
  const raw = engine.readLevels();
  const W = meters.width, H = meters.height;
  mctx.clearRect(0, 0, W, H);
  const px = Math.max(1, Math.round(dpr));
  const segs = 30;
  const labelW = 7 * px;
  const segW = (W - labelW) / segs;
  const rowH = Math.floor((H - px * 3) / 2);
  mctx.font = `${7 * px}px "Geist Pixel", monospace`;
  for (let ch = 0; ch < 2; ch++) {
    // VU-like ballistics: ~60 ms attack, ~450 ms release, in dB space
    const db = 20 * Math.log10(Math.max(1e-5, raw[ch] * 1.414));
    const target = clamp((db + 48) / 51, 0, 1); // -48..+3 dBFS
    const k = target > lv[ch] ? 1 - Math.exp(-dt / 60) : 1 - Math.exp(-dt / 450);
    lv[ch] += (target - lv[ch]) * k;
    if (lv[ch] > peak[ch] || now - peakT[ch] > 1200) { peak[ch] = lv[ch]; peakT[ch] = now; }
    const y = ch * (rowH + px * 3);
    mctx.fillStyle = C.mid;
    mctx.fillText(ch ? 'r' : 'l', 0, y + rowH - px);
    const lit = lv[ch] * segs;
    for (let i = 0; i < segs; i++) {
      const x = Math.round(labelW + i * segW);
      const hot = i >= segs - 4;
      const on = i < lit;
      mctx.fillStyle = on ? (hot ? C.hot : C.fg) : C.dim;
      mctx.fillRect(x, y, Math.max(px, Math.round(segW - px)), rowH);
    }
    const pi = Math.min(segs - 1, Math.floor(peak[ch] * segs));
    if (peak[ch] > 0.02) {
      mctx.fillStyle = pi >= segs - 4 ? C.hot : C.fg;
      mctx.fillRect(Math.round(labelW + pi * segW), y, Math.max(px, Math.round(segW - px)), rowH);
    }
  }
}

/* ------------------------------------------------------------ playback */
function trackDuration() {
  const d = el.duration;
  if (isFinite(d) && d > 0) return d;
  return S.tracks[S.cur]?.duration || 0;
}

function applyRate() {
  const r = clamp(S.speed * S.ramp, 0.0625, 16);
  if (Math.abs(el.playbackRate - r) > 1e-3) el.playbackRate = r;
  el.defaultPlaybackRate = S.speed;
}

let rampRaf;
function rampTo(target, ms) {
  cancelAnimationFrame(rampRaf);
  return new Promise((resolve) => {
    const from = S.ramp, t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      S.ramp = from + (target - from) * (1 - Math.pow(1 - k, 2));
      applyRate();
      if (k < 1) rampRaf = requestAnimationFrame(step);
      else resolve();
    };
    rampRaf = requestAnimationFrame(step);
  });
}

let readFlash;
function scheduleReadFlash() {
  clearTimeout(readFlash);
  readFlash = setTimeout(() => flash('reading tape…', 60000), 160);
}
function cancelReadFlash() {
  clearTimeout(readFlash);
  if (dMsg.textContent === 'reading tape…') dMsg.className = 'd-msg';
}

async function loadTrack(i, { autoplay = false, at = 0 } = {}) {
  const t = S.tracks[i];
  if (!t) return false;
  const token = ++S.loadToken;
  S.cur = i;
  S.loopArm = null;
  if (S.holding) {
    S.holding = false;
    S.wasPlaying = false;
    wheel.cancel();
  }
  let blob;
  try {
    blob = await db.getBlob(t.id);
  } catch {}
  if (token !== S.loadToken) return false;
  if (!blob) {
    flash(`missing audio: ${t.title}`, 2600, 'err');
    t.error = 'missing';
    renderLibrary();
    updateStatus();
    return false;
  }
  updateStatus();
  renderLibrary();
  setMediaSession();
  saveSettings();
  if (!engine.hasDecoded(t.id) && !engine.tooBig(blob.size || t.size || 0, t.duration || 0)) scheduleReadFlash();
  let result;
  try {
    result = await engine.load(blob, { id: t.id, at: at > 0 ? at : 0, durationHint: t.duration || 0 });
  } catch {
    if (token !== S.loadToken) return false;
    cancelReadFlash();
    t.error = 'decode';
    flash('cannot play this file here', 2400, 'err');
    renderLibrary();
    updateStatus();
    return false;
  }
  if (token !== S.loadToken || !result || result.mode === 'cancelled') return false;
  cancelReadFlash();
  S.pendingSeek = null;
  if (result.duration && Math.abs((t.duration || 0) - result.duration) > 0.5) {
    t.duration = result.duration;
  }
  if (result.peaks && !t.peaks) t.peaks = result.peaks;
  if (result.mode === 'element') {
    const why = result.fallback === 'engine'
      ? 'scratch needs a newer webview — playing normally'
      : 'too large to scratch — playing normally';
    flash(why, 3200);
  } else {
    t.error = t.error === 'decode' || t.error === 'codec' ? null : t.error;
  }
  if (result.duration || result.peaks) db.putTrack(t).catch(() => {});
  engine.setLoop(t.loop?.b != null ? t.loop : null);
  applyRate();
  renderLibrary();
  updateStatus();
  setPositionState();
  if (!t.peaks && !t.peaksFailed) queuePeaks(t);
  prefetchNext(i + 1);
  if (autoplay) await play();
  return true;
}

function prefetchNext(i) {
  const t = S.tracks[i];
  if (!t) return;
  db.getBlob(t.id).then((blob) => {
    if (!blob || S.tracks[S.cur + 1]?.id !== t.id) return;
    engine.prefetch(blob, t.id, t.duration || 0);
  }).catch(() => {});
}

async function play() {
  if (recorder.active) return;
  if (S.holding) { S.wasPlaying = true; updateStatus(); return; }
  if (S.cur < 0) {
    if (!S.tracks.length) { openLibrary(); flash('load some audio first', 1800); return; }
    await loadTrack(0);
  }
  engine.ensure();
  const instant = reducedMotion();
  S.ramp = instant ? 1 : 0.35;
  applyRate();
  try {
    await el.play();
    if (!instant) rampTo(1, 260);
  } catch (e) {
    S.ramp = 1;
    applyRate();
    if (e.name === 'NotAllowedError') flash('tap play again to start audio', 2000);
    else if (e.name !== 'AbortError') flash('cannot play this file here', 2400, 'err');
  }
  updateStatus();
}

async function pause({ brake = true } = {}) {
  if (el.paused) return;
  if (brake && !reducedMotion()) {
    S.braking = true;
    await rampTo(0.08, 320); // tape stop
    S.braking = false;
  }
  el.pause();
  S.ramp = 1;
  applyRate();
  updateStatus();
  saveSettings();
}

function toggle() {
  if (recorder.active) return stopRec();
  el.paused ? play() : pause();
}

function stop() {
  if (recorder.active) return stopRec();
  if (S.holding) {
    S.holding = false;
    S.wasPlaying = false;
    wheel.cancel();
    engine.endScratch(engine.currentTime);
  }
  const wasPlaying = engine.playing;
  pause({ brake: wasPlaying }).then(() => {
    seek(0);
    updateStatus();
  });
}

function seek(t) {
  const d = trackDuration();
  if (!S.tracks[S.cur]) return;
  t = clamp(t, 0, d ? Math.max(0, d - 0.01) : t);
  if (el.readyState < 1) { S.pendingSeek = t; return; }
  try { el.currentTime = t; } catch {}
  setPositionState();
}

function next(auto = false) {
  if (S.cur < S.tracks.length - 1) loadTrack(S.cur + 1, { autoplay: auto || !el.paused });
  else if (auto) { el.pause(); seek(0); flash('end of tape', 1600); updateStatus(); }
  else flash('end of tape', 1200);
}
function prev() {
  if (el.currentTime > 3 || S.cur <= 0) return seek(0);
  loadTrack(S.cur - 1, { autoplay: !el.paused });
}

el.addEventListener('ended', () => next(true));
el.addEventListener('play', updateStatus);
el.addEventListener('pause', () => { if (!S.braking) updateStatus(); });
el.addEventListener('error', () => {
  const t = S.tracks[S.cur];
  if (!t) return;
  const code = el.error?.code;
  t.error = code === 4 ? 'codec' : 'decode';
  flash(code === 4 ? 'format not supported on this device' : 'decode error — skipping', 2800, 'err');
  renderLibrary();
  updateStatus();
});

function checkLoop() {
  const t = S.tracks[S.cur];
  if (!t?.loop || t.loop.b == null || S.holding) return;
  if (el.currentTime >= t.loop.b || el.currentTime < t.loop.a - 0.25) {
    try { el.currentTime = t.loop.a; } catch {}
  }
}

/* ------------------------------------------------------------ media session */
function setMediaSession() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const t = S.tracks[S.cur];
  try {
    ms.metadata = new MediaMetadata({
      title: t?.title || 'reel–7',
      artist: t?.artist || 'reel–7 field player',
      album: t?.album || `tape · ${pad(S.cur + 1)}/${pad(S.tracks.length)}`,
      artwork: [
        { src: new URL('icons/icon-192.png', location.href).href, sizes: '192x192', type: 'image/png' },
        { src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' },
      ],
    });
  } catch {}
}
function setPositionState() {
  const d = trackDuration();
  if (!navigator.mediaSession?.setPositionState || !d) return;
  try {
    navigator.mediaSession.setPositionState({ duration: d, playbackRate: clamp(el.playbackRate, 0.0625, 16), position: clamp(el.currentTime, 0, d) });
  } catch {}
}
if (navigator.mediaSession) {
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch {} };
  h('play', () => play());
  h('pause', () => pause({ brake: false }));
  h('stop', () => stop());
  h('previoustrack', () => prev());
  h('nexttrack', () => next());
  h('seekbackward', (e) => seek(el.currentTime - (e.seekOffset || 10)));
  h('seekforward', (e) => seek(el.currentTime + (e.seekOffset || 10)));
  h('seekto', (e) => seek(e.seekTime));
}
el.addEventListener('play', () => navigator.mediaSession && (navigator.mediaSession.playbackState = 'playing'));
el.addEventListener('pause', () => navigator.mediaSession && (navigator.mediaSession.playbackState = 'paused'));

/* ------------------------------------------------------------ reel / jog */
let scrubAcc = 0, lastScrubAt = 0, scratchRate = 0;
let scratchFallbackNoted = false;
const wheel = new Wheel($('wheel'), {
  onGrab() {
    engine.unlock();
    if (!S.tracks[S.cur] || !engine.ready) return;
    cancelAnimationFrame(rampRaf);
    S.wasPlaying = S.holding ? S.wasPlaying : engine.playing;
    S.holding = true;
    scrubAcc = engine.currentTime;
    scratchRate = 0;
    lastScrubAt = performance.now();
    scratchFallbackNoted = false;
    engine.beginScratch(scrubAcc);
    wheel.angle = scrubAcc * DEG_PER_SEC;
    if (engine.mode === 'element' && !scratchFallbackNoted) {
      scratchFallbackNoted = true;
      flash('this tape plays forward only', 1800);
    }
    updateStatus();
  },
  onScrub(deg) {
    if (!S.holding || !S.tracks[S.cur]) return;
    const d = trackDuration();
    const prev = scrubAcc;
    scrubAcc = clamp(scrubAcc + deg / DEG_PER_SEC, 0, d || Infinity);
    const now = performance.now();
    const dt = (now - lastScrubAt) / 1000;
    lastScrubAt = now;
    let instant = 0;
    if (dt > 0.0004 && dt < 0.08) instant = (scrubAcc - prev) / dt;
    else instant = wheel.vel * 1000 / DEG_PER_SEC;
    const follow = dt > 0.03 ? 0.85 : 0.55;
    scratchRate += (instant - scratchRate) * follow;
    if (Math.abs(scratchRate) < 0.025) scratchRate = 0;
    engine.noteScratch(scrubAcc, scratchRate);
  },
  onRelease() {},
  onSettle() {
    if (!S.holding) return;
    const resume = S.wasPlaying;
    engine.endScratch(scrubAcc, { keepAlive: resume });
    S.holding = false;
    scratchRate = 0;
    if (resume) play();
    else { updateStatus(); setPositionState(); }
  },
});
$('wheel').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') seek(el.currentTime - 2);
  else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') seek(el.currentTime + 2);
  else return;
  e.preventDefault();
  e.stopPropagation();
});

/* ------------------------------------------------------------ loop + cues */
function persistTrack(t) { db.putTrack(t).catch(() => flash('could not save', 1600, 'err')); }

function loopKey() {
  const t = S.tracks[S.cur];
  if (!t) return flash('no track', 1000);
  const now = el.currentTime;
  if (t.loop?.b != null) {
    t.loop = null; S.loopArm = null;
    flash('loop off');
  } else if (S.loopArm == null) {
    S.loopArm = now;
    t.loop = { a: now, b: null };
    flash(`a  ${timecode(now).slice(3)}`);
  } else {
    let a = S.loopArm, b = now;
    if (b < a) [a, b] = [b, a];
    if (b - a < 0.1) b = Math.min(trackDuration(), a + 1);
    t.loop = { a, b };
    S.loopArm = null;
    flash(`loop ${short(a)} → ${short(b)}`);
    seek(a);
  }
  persistTrack({ ...t, loop: t.loop?.b != null ? t.loop : null });
  engine.setLoop(t.loop?.b != null ? t.loop : null);
  updateStatus();
}

function addCue() {
  const t = S.tracks[S.cur];
  if (!t) return flash('no track', 1000);
  t.cues = t.cues || [];
  const now = el.currentTime;
  if (t.cues.some((c) => Math.abs(c - now) < 0.5)) return flash('cue already here');
  if (t.cues.length >= MAX_CUES) return flash(`max ${MAX_CUES} cues · hold cue to clear`, 1800);
  t.cues.push(now);
  t.cues.sort((a, b) => a - b);
  flash(`cue ${t.cues.indexOf(now) + 1}  ${timecode(now).slice(3)}`);
  persistTrack(t);
}
function clearCues() {
  const t = S.tracks[S.cur];
  if (!t?.cues?.length) return flash('no cues');
  t.cues = [];
  persistTrack(t);
  flash('cues cleared');
}
function jumpCue(dir) {
  const t = S.tracks[S.cur];
  if (!t) return;
  const now = el.currentTime;
  const pts = [0, ...(t.cues || [])];
  let target;
  if (dir > 0) target = pts.find((c) => c > now + 0.25);
  else target = [...pts].reverse().find((c) => c < now - 0.75) ?? 0;
  if (target == null) return flash('last cue');
  seek(target);
  const n = (t.cues || []).indexOf(target);
  flash(n >= 0 ? `cue ${n + 1}` : 'top of track');
}

/* ------------------------------------------------------------ fx knobs */
const fmtPct = (v) => `${Math.round(v * 100)}`.padStart(3, ' ');
function toneText(v) {
  if (v === 0) return 'flat';
  const d = 0.04, x = (Math.abs(v) - d) / (1 - d);
  if (x <= 0) return 'flat';
  const f = v < 0 ? 20000 * Math.pow(250 / 20000, x) : 20 * Math.pow(4000 / 20, x);
  return `${v < 0 ? 'lp' : 'hp'} ${f >= 1000 ? (f / 1000).toFixed(1) + 'k' : Math.round(f)}hz`;
}
const knobDefs = [
  ['knVol', 'volume', 'vol', { def: 0.8, format: (v) => `${fmtPct(v)}%` }],
  ['knTone', 'tone', 'tone', { min: -1, max: 1, bipolar: true, format: toneText }],
  ['knDrive', 'drive', 'drive', { format: (v) => `${fmtPct(v)}%` }],
  ['knEcho', 'echo', 'echo', { format: (v) => `${fmtPct(v)}%` }],
  ['knSpace', 'space', 'spring', { format: (v) => `${fmtPct(v)}%` }],
  ['knWow', 'wow', 'wow·flut', { format: (v) => `${fmtPct(v)}%` }],
];
const knobs = {};
for (const [id, key, label, opt] of knobDefs) {
  knobs[key] = new Knob($(id), {
    min: 0, max: 1, def: 0, ...opt, label: key, value: S.settings[key],
    onChange(v) {
      S.settings[key] = v;
      engine.set(key, v);
      flash(`${label}  ${opt.format(v)}${key !== 'volume' && !S.settings.fx ? ' · bypassed' : ''}`, 900);
      updateStatus();
      saveSettings();
    },
  });
  engine.params[key] = S.settings[key];
}
engine.params.fx = S.settings.fx;

function toggleFx() {
  S.settings.fx = !S.settings.fx;
  engine.set('fx', S.settings.fx);
  flash(S.settings.fx ? 'fx on' : 'fx bypass');
  updateStatus();
  saveSettings();
}

/* ------------------------------------------------------------ speed */
const fader = new Fader($('fader'), {
  value: S.settings.speed || 1,
  onChange(v) {
    S.speed = v;
    S.settings.speed = v;
    applyRate();
    flash(`speed ${v.toFixed(2)}x  ${v === 1 ? '· locked' : (v > 1 ? '+' : '') + (12 * Math.log2(v)).toFixed(1) + ' st'}`, 900);
    updateStatus();
    saveSettings();
  },
});
S.speed = fader.value;

/* ------------------------------------------------------------ import */
const EXT_TYPES = {
  mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg; codecs=opus', flac: 'audio/flac', webm: 'audio/webm',
  weba: 'audio/webm', '3gp': 'audio/3gpp', amr: 'audio/amr',
};
const extOf = (n) => (n.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

function probe(blob) {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    const done = (v) => { clearTimeout(to); a.removeAttribute('src'); a.load(); URL.revokeObjectURL(url); resolve(v); };
    const to = setTimeout(() => done(null), 15000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      if (isFinite(a.duration)) return done(a.duration);
      // some containers report Infinity until seeked to the end
      a.ondurationchange = () => isFinite(a.duration) && done(a.duration);
      try { a.currentTime = 1e7; } catch { done(0); }
    };
    a.onerror = () => done(null);
    a.src = url;
  });
}

async function importFiles(files) {
  files = [...files];
  if (!files.length) return;
  engine.ensure();
  let ok = 0, bad = [];
  let order = S.tracks.reduce((m, t) => Math.max(m, t.order), 0) + 1;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    flash(`loading ${i + 1}/${files.length}  ${f.name}`, 60000);
    const ext = extOf(f.name);
    const type = f.type && f.type !== 'application/octet-stream' ? f.type : EXT_TYPES[ext] || '';
    if (!type.startsWith('audio') && !type.startsWith('video') && !EXT_TYPES[ext]) { bad.push(f.name); continue; }
    const blob = f.type === type ? f : new Blob([f], { type });
    const duration = await probe(blob);
    if (duration == null) { bad.push(f.name); continue; }
    const tags = ext === 'mp3' ? await readTags(f) : {};
    const t = {
      id: uid(),
      title: (tags.title || f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ')).trim() || 'untitled',
      artist: tags.artist || '',
      album: tags.album || '',
      duration: duration || 0,
      size: f.size,
      type,
      ext,
      order: order++,
      added: Date.now(),
      cues: [],
      loop: null,
      peaks: null,
    };
    try {
      await db.addTrack(t, blob);
      S.tracks.push(t);
      ok++;
      queuePeaks(t);
    } catch (e) {
      bad.push(f.name);
      if (e?.name === 'QuotaExceededError') { flash('storage full', 3000, 'err'); break; }
    }
    renderLibrary();
  }
  if (bad.length) flash(`${ok} loaded · ${bad.length} skipped (format not supported)`, 3600, ok ? '' : 'err');
  else flash(`${ok} loaded onto tape`, 1600);
  if (S.cur < 0 && S.tracks.length) loadTrack(0);
  updateStatus();
  updateStorage();
}

/* waveform peaks, one at a time, decoded in the worker at 8 kHz */
const peakQueue = [];
let peakBusy = false;
function queuePeaks(t) {
  if (!t || peakQueue.includes(t.id) || t.peaks || t.peaksFailed) return;
  peakQueue.push(t.id);
  runPeaks();
}
async function runPeaks() {
  if (peakBusy) return;
  const id = peakQueue.shift();
  if (!id) return;
  peakBusy = true;
  const t = S.tracks.find((x) => x.id === id);
  try {
    if (!t || t.peaks) throw 0;
    if (t.size > 160 * 1024 * 1024) throw new Error('too big');
    const blob = await db.getBlob(id);
    const peaks = await engine.computePeaks(blob);
    if (!peaks) throw new Error('peaks');
    if (!t.peaks) {
      t.peaks = peaks;
      await db.putTrack(t);
    }
  } catch (e) {
    if (t && e !== 0) { t.peaksFailed = true; db.putTrack(t).catch(() => {}); }
  }
  peakBusy = false;
  if (peakQueue.length) setTimeout(runPeaks, 80);
}

/* ------------------------------------------------------------ library UI */
const list = $('tracklist');
function renderLibrary() {
  const n = S.tracks.length;
  $('libCount').textContent = `${pad(n)} track${n === 1 ? '' : 's'}`;
  $('libTotal').textContent = short(S.tracks.reduce((a, t) => a + (t.duration || 0), 0));
  $('libEmpty').hidden = n > 0;
  list.hidden = n === 0;
  $('kClear').disabled = n === 0;
  list.innerHTML = '';
  S.tracks.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'row' + (i === S.cur ? ' current' : '') + (t.error ? ' bad' : '');
    li.dataset.id = t.id;
    li.innerHTML = `
      <button class="row-main" aria-label="play ${esc(t.title)}">
        <span class="row-no mono">${pad(i + 1)}</span>
        <span class="row-txt"><b>${esc(t.title)}</b><small>${esc(t.artist || (t.ext || '').toUpperCase())}${t.cues?.length ? ` · ${t.cues.length} cue` : ''}${t.loop ? ' · a–b' : ''}${t.error ? ' · ' + (t.error === 'codec' ? 'unsupported' : t.error) : ''}</small></span>
        <span class="row-dur mono">${short(t.duration)}</span>
      </button>
      <button class="row-del" aria-label="erase ${esc(t.title)}"><b class="glyph g-close"></b></button>
      <span class="row-grip" aria-label="drag to reorder" role="button" tabindex="-1"><i></i></span>`;
    list.appendChild(li);
  });
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

list.addEventListener('click', async (e) => {
  const li = e.target.closest('.row');
  if (!li) return;
  const i = S.tracks.findIndex((t) => t.id === li.dataset.id);
  if (e.target.closest('.row-del')) {
    if (!li.classList.contains('confirm')) {
      li.classList.add('confirm');
      li.querySelector('.row-del').setAttribute('aria-label', 'tap again to erase');
      setTimeout(() => li.classList.remove('confirm'), 2500);
      return;
    }
    const t = S.tracks[i];
    await db.deleteTrack(t.id);
    S.tracks.splice(i, 1);
    if (i === S.cur) {
      el.pause(); el.removeAttribute('src'); el.load();
      S.cur = -1;
      if (S.tracks.length) await loadTrack(Math.min(i, S.tracks.length - 1));
    } else if (i < S.cur) S.cur--;
    renderLibrary(); updateStatus(); updateStorage();
    flash('erased');
    return;
  }
  if (e.target.closest('.row-main')) {
    if (i === S.cur) toggle();
    else await loadTrack(i, { autoplay: true });
    if (window.matchMedia('(max-width: 599px)').matches) closeSheets();
  }
});

// drag to reorder via grip
list.addEventListener('pointerdown', (e) => {
  const grip = e.target.closest('.row-grip');
  if (!grip) return;
  e.preventDefault();
  const li = grip.closest('.row');
  const rows = [...list.children];
  const from = rows.indexOf(li);
  const h = li.getBoundingClientRect().height;
  const y0 = e.clientY;
  let to = from;
  li.classList.add('dragging');
  grip.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const dy = ev.clientY - y0;
    li.style.transform = `translateY(${dy}px)`;
    to = clamp(from + Math.round(dy / h), 0, rows.length - 1);
    rows.forEach((r, k) => {
      if (r === li) return;
      let s = 0;
      if (from < to && k > from && k <= to) s = -h;
      if (from > to && k < from && k >= to) s = h;
      r.style.transform = s ? `translateY(${s}px)` : '';
    });
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    rows.forEach((r) => (r.style.transform = ''));
    li.classList.remove('dragging');
    if (to !== from) {
      const curId = S.tracks[S.cur]?.id;
      const [m] = S.tracks.splice(from, 1);
      S.tracks.splice(to, 0, m);
      S.tracks.forEach((t, k) => (t.order = k));
      S.cur = S.tracks.findIndex((t) => t.id === curId);
      db.putTracks(S.tracks);
      renderLibrary();
      updateStatus();
    }
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
});

let clearT;
$('kClear').addEventListener('click', async () => {
  const b = $('kClear');
  if (!b.classList.contains('confirm')) {
    b.classList.add('confirm');
    b.querySelector('.txt').textContent = 'sure?';
    clearT = setTimeout(() => { b.classList.remove('confirm'); b.querySelector('.txt').textContent = 'erase'; }, 3000);
    return;
  }
  clearTimeout(clearT);
  b.classList.remove('confirm');
  b.querySelector('.txt').textContent = 'erase';
  el.pause(); el.removeAttribute('src'); el.load();
  await db.clear();
  S.tracks = []; S.cur = -1;
  renderLibrary(); updateStatus(); updateStorage();
  flash('tape erased');
});

async function updateStorage() {
  const est = await storageInfo();
  const used = S.tracks.reduce((a, t) => a + (t.size || 0), 0);
  $('libStore').textContent = est?.quota
    ? `${(used / 1048576).toFixed(1)} mb on tape · ${Math.round(est.quota / 1073741824)} gb free-ish`
    : `${(used / 1048576).toFixed(1)} mb on tape`;
}

/* ------------------------------------------------------------ sheets */
const scrim = $('scrim');
function openSheet(id) {
  closeSheets(true);
  const s = $(id);
  s.classList.add('open');
  s.removeAttribute('inert');
  s.setAttribute('aria-hidden', 'false');
  scrim.hidden = false;
  requestAnimationFrame(() => scrim.classList.add('show'));
  if (id === 'library') $('kLib').classList.add('lit');
}
function closeSheets(quick) {
  for (const s of document.querySelectorAll('.sheet.open')) {
    s.classList.remove('open');
    s.setAttribute('inert', '');
    s.setAttribute('aria-hidden', 'true');
  }
  $('kLib').classList.remove('lit');
  scrim.classList.remove('show');
  if (!quick) setTimeout(() => !document.querySelector('.sheet.open') && (scrim.hidden = true), 250);
}
const openLibrary = () => openSheet('library');
scrim.addEventListener('click', () => closeSheets());

/* ------------------------------------------------------------ recorder */
let takeNo = 0;
function nextTakeNo() {
  return takeNo || S.tracks.filter((t) => /^take \d+/.test(t.title)).length + 1;
}
async function startRec() {
  if (!Recorder.supported()) return flash('recording not supported here', 2000, 'err');
  await engine.unlock();
  await pause({ brake: false });
  try {
    takeNo = nextTakeNo();
    await recorder.start();
    flash('recording · press memo to stop', 1600);
  } catch (e) {
    takeNo = 0;
    flash(e?.name === 'NotAllowedError' ? 'microphone blocked' : 'no microphone', 2400, 'err');
  }
  updateStatus();
}
async function stopRec() {
  flash('saving take…', 10000);
  const res = await recorder.stop();
  updateStatus();
  if (!res) return;
  const t = {
    id: uid(), title: `take ${pad(takeNo, 3)}`, artist: new Date().toLocaleString('nl-BE', { dateStyle: 'short', timeStyle: 'short' }),
    album: 'memo', duration: res.duration, size: res.blob.size, type: res.type, ext: res.type.includes('wav') ? 'wav' : 'webm',
    order: S.tracks.reduce((m, x) => Math.max(m, x.order), 0) + 1, added: Date.now(), cues: [], loop: null, peaks: null,
  };
  takeNo = 0;
  try {
    await db.addTrack(t, res.blob);
    S.tracks.push(t);
    renderLibrary();
    await loadTrack(S.tracks.length - 1);
    flash(`${t.title} saved · ${short(t.duration)}`, 2000);
  } catch {
    flash('could not save take', 2400, 'err');
  }
  updateStorage();
}

/* ------------------------------------------------------------ keys */
function press(id, fn, { hold } = {}) {
  const b = $(id);
  let timer, held = false;
  b.addEventListener('pointerdown', () => {
    engine.unlock(); // resume the context inside the gesture
    held = false;
    if (hold) timer = setTimeout(() => { held = true; hold(); navigator.vibrate?.(20); }, 600);
  });
  const cancel = () => clearTimeout(timer);
  b.addEventListener('pointerup', cancel);
  b.addEventListener('pointerleave', cancel);
  b.addEventListener('pointercancel', cancel);
  b.addEventListener('click', (e) => {
    if (held) { held = false; return; }
    fn(e);
  });
  b.addEventListener('contextmenu', (e) => e.preventDefault());
}
press('kPlay', toggle);
press('kStop', stop);
press('kPrev', prev);
press('kNext', () => next());
press('kRec', () => (recorder.active ? stopRec() : startRec()));
press('kLib', () => ($('library').classList.contains('open') ? closeSheets() : openLibrary()));
press('kLoop', loopKey);
press('kCue', addCue, { hold: clearCues });
press('kCuePrev', () => jumpCue(-1));
press('kCueNext', () => jumpCue(1));
press('kFx', toggleFx);
press('kSpeedReset', () => fader.set(1));
press('kLibClose', () => closeSheets());
press('kAboutClose', () => closeSheets());
press('btnInfo', () => openSheet('about'));
const pick = () => $('file').click();
press('kLoad', pick);
press('kLoad2', pick);
$('file').addEventListener('change', (e) => {
  importFiles(e.target.files);
  e.target.value = '';
});

// drag & drop (desktop / tablets)
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drop'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drop'); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('drop');
  if (e.dataTransfer?.files?.length) importFiles(e.dataTransfer.files);
});

// seek by tapping / dragging the waveform
{
  let drag = false;
  const at = (e) => {
    const r = wave.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * trackDuration());
  };
  wave.addEventListener('pointerdown', (e) => { if (!S.tracks[S.cur]) return; drag = true; wave.setPointerCapture(e.pointerId); at(e); });
  wave.addEventListener('pointermove', (e) => drag && at(e));
  wave.addEventListener('pointerup', () => (drag = false));
  wave.addEventListener('pointercancel', () => (drag = false));
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  if (e.target.closest?.('[role="slider"]') && e.key.startsWith('Arrow')) return;
  const k = e.key;
  if (k === ' ' && !e.target.closest?.('button')) { e.preventDefault(); toggle(); }
  else if (k === 'ArrowRight') { e.preventDefault(); e.shiftKey ? next() : seek(el.currentTime + 5); }
  else if (k === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? prev() : seek(el.currentTime - 5); }
  else if (k === '[') fader.set(fader.value - 0.05);
  else if (k === ']') fader.set(fader.value + 0.05);
  else if (k === '=') fader.set(1);
  else if (k === 'l') $('library').classList.contains('open') ? closeSheets() : openLibrary();
  else if (k === 'a') loopKey();
  else if (k === 'm') addCue();
  else if (k === 'Escape') closeSheets();
});

// block pinch-zoom / double-tap zoom gestures
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

/* ------------------------------------------------------------ frame loop */
let lastTC = '';
let smoothAngle = 0;
let lastPosState = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  if (S.holding && now - lastScrubAt > 48) {
    scratchRate = 0;
    engine.noteScratch(scrubAcc, 0);
  }
  const t = recorder.active ? recorder.elapsed() : S.holding ? scrubAcc : el.currentTime;
  const tc = timecode(t);
  if (tc !== lastTC) { dTime.textContent = tc; lastTC = tc; }
  if (!wheel.driving) {
    if (recorder.active) smoothAngle += 1.2; // slow spin while recording
    else if (!reducedMotion()) {
      const target = el.currentTime * DEG_PER_SEC;
      smoothAngle = Math.abs(target - smoothAngle) > 720 ? target : smoothAngle + (target - smoothAngle) * 0.35;
    }
    wheel.angle = smoothAngle;
    wheel.render();
  } else smoothAngle = wheel.angle;
  if (now - lastPosState > 500) { lastPosState = now; setPositionState(); }
  checkLoop();
  drawWave(now);
  drawMeters(now);
}

/* ------------------------------------------------------------ boot */
async function boot() {
  sizeCanvases();
  engine.prepare().catch(() => {});
  try {
    S.tracks = await db.allTracks();
  } catch {
    flash('storage unavailable — tracks will not persist', 4000, 'err');
  }
  renderLibrary();
  const last = S.tracks.findIndex((t) => t.id === S.settings.lastId);
  if (S.tracks.length) await loadTrack(last >= 0 ? last : 0, { at: last >= 0 ? S.settings.lastPos || 0 : 0 });
  updateStatus();
  updateStorage();
  for (const t of S.tracks) if (!t.peaks && !t.peaksFailed) queuePeaks(t);
  if (!S.tracks.length) flash('tap tape ▸ + load to add music', 4000);
  requestAnimationFrame(frame);
  document.fonts?.ready.then(sizeCanvases);
  setInterval(() => !el.paused && saveSettings(), 4000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveSettings();
    else if (engine.playing || engine.scratching) engine.unlock();
  });
}
boot();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
if (import.meta.env.DEV) window.__reel7 = { engine, S, knobs };
