// Audible engine: a decoded AudioBuffer read by an AudioWorklet (forwards or backwards,
// any rate) through the same FX chain as before. Jog scratching sets the read rate from
// the wheel, so the loaded track itself is what you hear — including reverse.
//
// A quiet looping <audio> element stays in the "playing" state during playback so Android
// keeps the audio session alive and Media Session / lock-screen controls still attach.
// Files that cannot be fully decoded fall back to that element (forward playback only).
//
// worklet -> input --+--> [dry bypass] -------------------------------> master
//                    +--> wow -> hp -> lp -> drive -> fxOut -----------> master
//                                                     -> echo -> master
//                                                     -> spring -> master
// master -> splitter -> analyser L/R ; master -> destination
//
// fallback <audio> -> fallbackGain -> input   (gain 0 unless the file was too large)

import { computePeaks } from './peaks.js';

const PEAK_BINS = 720;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

function buildId() {
  try { return __REEL7_BUILD__; } catch { return 'dev'; }
}

export class Engine {
  constructor() {
    // Fallback / legacy element. Buffer playback does not route music through it.
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.crossOrigin = 'anonymous';
    this.el.setAttribute('playsinline', '');
    this.el.preservesPitch = false;
    this.el.mozPreservesPitch = false;
    this.el.webkitPreservesPitch = false;

    this.ctx = null;
    this.params = { volume: 0.8, tone: 0, drive: 0, echo: 0, space: 0, wow: 0, fx: true };
    this.levels = [0, 0];

    this.playing = false;
    this.scratching = false;
    this.ready = false;
    this.mode = 'empty'; // 'buffer' | 'element' | 'empty'
    this.backend = null; // 'worklet' | 'script' | null
    this.scratchOK = false;
    this.duration = 0;
    this.position = 0;
    this.positionStamp = 0;
    this.playRate = 0;
    this.transportRate = 1;
    this.commandRate = 0;
    this.scratchPos = 0;
    this.loop = null;
    this.lastError = null;
    this.trackId = null;

    this.decoded = new Map();
    this.inflight = new Map();
    this._ev = {};
    this._wq = [];
    this._wBusy = null;
    this._w = null;
    this._req = 1;
    this._gen = 0;
    this._endedOnce = false;
    this._watch = null;
    this._fallbackScratchNoted = false;
  }

  on(type, fn) {
    (this._ev[type] || (this._ev[type] = [])).push(fn);
  }
  emit(type) {
    const list = this._ev[type];
    if (!list) return;
    for (const fn of list) {
      try { fn(); } catch {}
    }
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    // Interactive keeps the scratch path under a frame of latency. The hint is fixed
    // for the life of the context, so the whole player uses it.
    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
    this._buildGraph(ctx);
    ctx.onstatechange = () => {
      if (ctx.state === 'suspended' && (this.playing || this.scratching)) ctx.resume().catch(() => {});
    };
    if (!this._watch) this._watch = setInterval(() => this._tick(), 80);
    this.apply(true);
    return ctx;
  }

  unlock() {
    const ctx = this.ensure();
    if (ctx && ctx.state !== 'running') return ctx.resume().catch(() => {});
    return Promise.resolve();
  }

  // Context + reader. Safe to call more than once.
  prepare() {
    this.ensure();
    if (!this.ctx) return Promise.resolve(false);
    if (this._prepared) return this._prepared;
    this._prepared = this._setupReader().catch((err) => {
      this.scratchOK = false;
      this.backend = null;
      this.lastError = err;
      return false;
    });
    return this._prepared;
  }

  tooBig(bytes, duration) {
    if (bytes > MAX_FILE_BYTES) return true;
    const sr = this.ctx?.sampleRate || 48000;
    const est = (duration || 0) * sr * 2 * 4;
    return !!(duration && est > this._pcmBudget());
  }

  hasDecoded(id) {
    return this.decoded.has(id);
  }

  _pcmBudget() {
    const mem = navigator.deviceMemory;
    if (mem && mem <= 2) return 120 * 1024 * 1024;
    if (mem && mem <= 4) return 200 * 1024 * 1024;
    return 280 * 1024 * 1024;
  }

  async load(blob, { id, at = 0, durationHint = 0 } = {}) {
    const gen = ++this._gen;
    this.trackId = id || null;
    this.lastError = null;
    this._endedOnce = false;
    await this.prepare();
    if (gen !== this._gen) return { mode: 'cancelled' };
    // Drop a scratch in progress so the new tape doesn't inherit its rate.
    this.scratching = false;
    this._setScratch(0);
    this.halt();
    if (gen !== this._gen) return { mode: 'cancelled' };

    const oversized = this.tooBig(blob.size || 0, durationHint || 0) && !this.decoded.has(id);
    if (!this.scratchOK || oversized) {
      const peaksP = this.computePeaks(blob).catch(() => null);
      try {
        await this._loadElement(blob, at);
      } catch (err) {
        if (gen !== this._gen) return { mode: 'cancelled' };
        this.lastError = err;
        this.ready = false;
        this.emit('error');
        throw err;
      }
      if (gen !== this._gen) return { mode: 'cancelled' };
      const peaks = await peaksP;
      return { mode: 'element', duration: this.duration, peaks, fallback: oversized ? 'size' : 'engine' };
    }

    try {
      let data = this.decoded.get(id);
      if (data) this.decoded.delete(id);
      if (!data) data = await this._decode(blob, id, { store: false });
      if (gen !== this._gen) {
        if (data?.channels?.[0]?.buffer?.byteLength) this._remember(id, data);
        return { mode: 'cancelled' };
      }
      if (!data?.channels?.[0]?.length) throw new Error('empty decode');
      this._install(data, at);
      return { mode: 'buffer', duration: data.duration, peaks: data.peaks };
    } catch (err) {
      if (gen !== this._gen) return { mode: 'cancelled' };
      const msg = String(err && (err.message || err) || '');
      if (!/memory|allocat|oom|out of/i.test(msg)) {
        try {
          await this._loadElement(blob, at);
          if (gen !== this._gen) return { mode: 'cancelled' };
          return { mode: 'element', duration: this.duration, peaks: null, fallback: 'decode' };
        } catch (err2) {
          this.lastError = err2;
          this.ready = false;
          this.emit('error');
          throw err2;
        }
      }
      try {
        await this._loadElement(blob, at);
        if (gen !== this._gen) return { mode: 'cancelled' };
        return { mode: 'element', duration: this.duration, peaks: null, fallback: 'memory' };
      } catch (err2) {
        this.lastError = err2;
        this.ready = false;
        this.emit('error');
        throw err2;
      }
    }
  }

  prefetch(blob, id, durationHint) {
    if (!id || !this.scratchOK) return;
    if (this.decoded.has(id) || this.inflight.has(id)) return;
    if (this.tooBig(blob?.size || 0, durationHint || 0)) return;
    const est = (durationHint || 0) * (this.ctx?.sampleRate || 48000) * 2 * 4;
    if (durationHint && est > 140 * 1024 * 1024) return;
    this._decode(blob, id, { store: true }).catch(() => {});
  }

  computePeaks(blob) {
    return this._peaksOnly(blob);
  }

  async start() {
    await this.prepare();
    if (!this.ctx) throw Object.assign(new Error('no audio'), { name: 'NotSupportedError' });
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch {}
    }
    this._endedOnce = false;
    this.scratching = false;
    this._setScratch(0);
    this.playing = true;
    this._post({ type: 'playing', value: true });
    this._post({ type: 'scratching', value: false });
    const rate = this.transportRate || 1;
    try {
      if (this.mode === 'element') {
        this.position = this.el.currentTime || this.position || 0;
        if (this.fallbackGain) this.fallbackGain.gain.value = 1;
        this._setRate(0, true);
        this.keep && this.keep.pause();
        await this.el.play();
      } else {
        this.positionStamp = this.ctx.currentTime;
        this.playRate = rate;
        if (this.fallbackGain) this.fallbackGain.gain.value = 0;
        this._setRate(rate, true);
        await this._kickKeep(true);
      }
    } catch (err) {
      this.playing = false;
      this.playRate = 0;
      this._setRate(0, true);
      throw err;
    }
    if (this.ctx.state !== 'running') {
      this.playing = false;
      this.playRate = 0;
      this._setRate(0, true);
      const err = new Error('audio blocked');
      err.name = 'NotAllowedError';
      throw err;
    }
    this.emit('play');
    this._session('playing');
  }

  halt() {
    if (!this.playing && !this.scratching && this.commandRate === 0 && this.mode !== 'element') {
      this.playing = false;
      return;
    }
    if (this.mode === 'element') this.position = this.el.currentTime || this.position || 0;
    else if (this.playing) {
      this.position = this._readAhead();
      this.positionStamp = this.ctx ? this.ctx.currentTime : 0;
    }
    const was = this.playing;
    this.playing = false;
    this.playRate = 0;
    this._post({ type: 'playing', value: false });
    if (this.mode === 'element') {
      try { this.el.pause(); } catch {}
    }
    if (!this.scratching) {
      this._setRate(0, true);
      this._kickKeep(false);
      this._session('paused');
    }
    if (was) this.emit('pause');
  }

  unload() {
    this._gen++;
    this.halt();
    this.scratching = false;
    this.ready = false;
    this.duration = 0;
    this.position = 0;
    this.mode = 'empty';
    this.trackId = null;
    this.loop = null;
    try {
      this.el.pause();
      this.el.removeAttribute('src');
      this.el.load();
    } catch {}
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    if (this.backend === 'script' && this.voice) this.voice.setBuffer(null, null, 0, 44100);
    else this._post({ type: 'buffer', ch0: new Float32Array(0), ch1: null, len: 0, bufRate: 44100 });
    this._kickKeep(false);
  }

  seek(t) {
    if (!isFinite(t) || t < 0) t = 0;
    if (this.duration && t > this.duration - 0.01) t = Math.max(0, this.duration - 0.01);
    this._endedOnce = false;
    this.position = t;
    this.positionStamp = this.ctx ? this.ctx.currentTime : 0;
    if (this.scratching) this.scratchPos = t;
    if (this.mode === 'element' && this.ready) {
      try { this.el.currentTime = t; } catch {}
    }
    if (this.backend === 'script' && this.voice) this.voice.seek(t);
    else this._post({ type: 'seek', seconds: t });
  }

  setTransportRate(rate) {
    this.transportRate = rate;
    if (this.mode === 'element' && this.el) {
      const r = Math.min(16, Math.max(0.0625, Math.abs(rate) || 0.0625));
      try { if (Math.abs(this.el.playbackRate - r) > 1e-3) this.el.playbackRate = r; } catch {}
    }
    if (this.scratching || !this.playing || this.mode === 'element' || !this.ctx) return;
    this.position = this._readAhead();
    this.positionStamp = this.ctx.currentTime;
    this.playRate = rate;
    this._setRate(rate, false);
  }

  beginScratch(seconds) {
    this.ensure();
    const t = isFinite(seconds) ? seconds : this.currentTime;
    if (this.playing && this.mode !== 'element') {
      this.position = this._readAhead();
    }
    this.playing = false;
    this.playRate = 0;
    this.scratching = true;
    this.scratchPos = t;
    this.position = t;
    this.positionStamp = this.ctx ? this.ctx.currentTime : 0;
    this._setRate(0, true);
    this._setScratch(1);
    this._post({ type: 'playing', value: false });
    this._post({ type: 'scratching', value: true });
    this._post({ type: 'seek', seconds: t });
    if (this.backend === 'script' && this.voice) {
      this.voice.playing = false;
      this.voice.seek(t);
    }
    if (this.mode === 'element') {
      try { this.el.pause(); } catch {}
      this._fallbackScratchNoted = false;
    } else {
      this._kickKeep(true);
    }
    this._session('playing');
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  noteScratch(seconds, rate) {
    if (!isFinite(seconds)) return;
    if (this.duration && seconds > this.duration) seconds = this.duration;
    if (seconds < 0) seconds = 0;
    this.scratching = true;
    this.scratchPos = seconds;
    if (!isFinite(rate)) rate = 0;
    if (this.mode === 'element') {
      const now = performance.now();
      if (now - (this._lastElSeek || 0) > 70) {
        this._lastElSeek = now;
        try { this.el.currentTime = seconds; } catch {}
      }
      return;
    }
    this._setScratch(1);
    this._setRate(rate, false);
    if (this.backend === 'script' && this.voice) this.voice.setTarget(seconds);
    else this._post({ type: 'target', seconds });
  }

  endScratch(seconds, { keepAlive = false } = {}) {
    let t = isFinite(seconds) ? seconds : this.scratchPos;
    if (t < 0) t = 0;
    if (this.duration && t > this.duration - 0.01) t = Math.max(0, this.duration - 0.01);
    this.scratching = false;
    this.scratchPos = t;
    this.position = t;
    this.positionStamp = this.ctx ? this.ctx.currentTime : 0;
    this.playRate = 0;
    this._setScratch(0);
    this._setRate(0, true);
    this._post({ type: 'scratching', value: false });
    this._post({ type: 'seek', seconds: t });
    if (this.backend === 'script' && this.voice) this.voice.seek(t);
    if (this.mode === 'element') {
      try { this.el.currentTime = t; } catch {}
    }
    if (!keepAlive) {
      this._kickKeep(false);
      this._session('paused');
    }
  }

  setLoop(loop) {
    this.loop = loop && loop.b != null ? { a: loop.a || 0, b: loop.b } : null;
  }

  get currentTime() {
    if (this.scratching) return this.scratchPos || 0;
    if (this.mode === 'element' && this.ready) return this.el.currentTime || 0;
    if (this.playing) return this._readAhead();
    return this.position || 0;
  }

  set(name, v) {
    this.params[name] = v;
    this.apply();
  }

  apply(instant = false) {
    if (!this.ctx) return;
    const p = this.params;
    const t = this.ctx.currentTime;
    const tc = instant ? 0.001 : 0.04;
    const ramp = (param, v) => param.setTargetAtTime(v, t, tc);
    const on = p.fx;

    ramp(this.master.gain, Math.pow(p.volume, 2) * 1.1);
    ramp(this.dry.gain, on ? 0 : 1);
    ramp(this.wet.gain, on ? 1 : 0);

    const tone = p.tone;
    const dead = 0.04;
    if (tone < -dead) {
      const x = (-tone - dead) / (1 - dead);
      ramp(this.lp.frequency, 20000 * Math.pow(250 / 20000, x));
      ramp(this.lp.Q, 0.7 + x * 3.2);
    } else {
      ramp(this.lp.frequency, 22000);
      ramp(this.lp.Q, 0.7);
    }
    if (tone > dead) {
      const x = (tone - dead) / (1 - dead);
      ramp(this.hp.frequency, 20 * Math.pow(4000 / 20, x));
      ramp(this.hp.Q, 0.7 + x * 3.2);
    } else {
      ramp(this.hp.frequency, 10);
      ramp(this.hp.Q, 0.7);
    }

    const d = p.drive;
    if (d !== this._lastDrive) {
      this.shaper.curve = d > 0.001 ? satCurve(d) : null;
      this._lastDrive = d;
    }
    ramp(this.preDrive.gain, 1 + d * 5);
    const k = 1 + d * 6;
    const slope = d > 0.001 ? k / Math.tanh(k) : 1;
    ramp(this.postDrive.gain, (1 + d * 0.9) / ((1 + d * 5) * slope));
    ramp(this.headBump.gain, d * 4);

    ramp(this.echoSend.gain, p.echo * 0.75);
    ramp(this.echoFb.gain, 0.25 + p.echo * 0.4);
    ramp(this.verbSend.gain, p.space * 1.1);
    ramp(this.wowAmt.gain, p.wow * 0.0042);
    ramp(this.flutAmt.gain, p.wow * 0.00035);
  }

  readLevels() {
    if (this.recordingMeter) return this.recordingMeter();
    if (!this.ctx) return [0, 0];
    this.anL.getFloatTimeDomainData(this.bufL);
    this.anR.getFloatTimeDomainData(this.bufR);
    return [rms(this.bufL), rms(this.bufR)];
  }

  /* ---------------------------------------------------------------- graph */
  _buildGraph(ctx) {
    this.input = ctx.createGain();
    this.master = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();

    this.wowDelay = ctx.createDelay(0.05);
    this.wowDelay.delayTime.value = 0.012;
    this.wowLfo = ctx.createOscillator();
    this.wowLfo.frequency.value = 0.55;
    this.flutLfo = ctx.createOscillator();
    this.flutLfo.frequency.value = 6.3;
    this.wowAmt = ctx.createGain();
    this.flutAmt = ctx.createGain();
    this.wowAmt.gain.value = 0;
    this.flutAmt.gain.value = 0;
    this.wowLfo.connect(this.wowAmt).connect(this.wowDelay.delayTime);
    this.flutLfo.connect(this.flutAmt).connect(this.wowDelay.delayTime);
    this.wowLfo.start();
    this.flutLfo.start();

    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 10;
    this.hp.Q.value = 0.9;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 22000;
    this.lp.Q.value = 0.9;

    this.preDrive = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '2x';
    this.postDrive = ctx.createGain();
    this.headBump = ctx.createBiquadFilter();
    this.headBump.type = 'lowshelf';
    this.headBump.frequency.value = 90;
    this.headBump.gain.value = 0;

    this.echoSend = ctx.createGain();
    this.echoSend.gain.value = 0;
    this.echoDelay = ctx.createDelay(2);
    this.echoDelay.delayTime.value = 0.32;
    this.echoFb = ctx.createGain();
    this.echoFb.gain.value = 0.38;
    this.echoTone = ctx.createBiquadFilter();
    this.echoTone.type = 'bandpass';
    this.echoTone.frequency.value = 1600;
    this.echoTone.Q.value = 0.5;
    this.echoSend.connect(this.echoDelay).connect(this.echoTone).connect(this.echoFb).connect(this.echoDelay);
    this.echoTone.connect(this.wet);

    this.verbSend = ctx.createGain();
    this.verbSend.gain.value = 0;
    this.verb = ctx.createConvolver();
    this.verb.buffer = springIR(ctx);
    this.verbHp = ctx.createBiquadFilter();
    this.verbHp.type = 'highpass';
    this.verbHp.frequency.value = 180;
    this.verbSend.connect(this.verbHp).connect(this.verb).connect(this.wet);

    this.input.connect(this.dry).connect(this.master);
    this.input.connect(this.wowDelay).connect(this.hp).connect(this.lp).connect(this.preDrive)
      .connect(this.shaper).connect(this.postDrive).connect(this.headBump);
    this.headBump.connect(this.wet);
    this.headBump.connect(this.echoSend);
    this.headBump.connect(this.verbSend);
    this.wet.connect(this.master);

    this.fallbackGain = ctx.createGain();
    this.fallbackGain.gain.value = 0;
    this.mediaSrc = ctx.createMediaElementSource(this.el);
    this.mediaSrc.connect(this.fallbackGain).connect(this.input);

    this.split = ctx.createChannelSplitter(2);
    this.anL = ctx.createAnalyser();
    this.anR = ctx.createAnalyser();
    this.anL.fftSize = this.anR.fftSize = 1024;
    this.bufL = new Float32Array(1024);
    this.bufR = new Float32Array(1024);
    this.master.connect(this.split);
    this.split.connect(this.anL, 0);
    this.split.connect(this.anR, 1);
    this.master.connect(ctx.destination);

    this.el.addEventListener('ended', () => {
      if (this.mode === 'element' && this.playing) this._onEnded();
    });
  }

  async _setupReader() {
    const url = new URL('scratch-processor.js', document.baseURI);
    url.searchParams.set('v', String(buildId()));
    try {
      await this.ctx.audioWorklet.addModule(url.href);
      let node;
      try {
        node = new AudioWorkletNode(this.ctx, 'reel7-scratch', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
        });
      } catch {
        node = new AudioWorkletNode(this.ctx, 'reel7-scratch', { numberOfInputs: 0, numberOfOutputs: 1 });
      }
      this.node = node;
      this.rateParam = node.parameters.get('rate');
      this.scratchParam = node.parameters.get('scratch');
      node.port.onmessage = (e) => this._onWorklet(e.data);
      node.connect(this.input);
      this.backend = 'worklet';
      this.scratchOK = true;
      return true;
    } catch (err) {
      this.lastError = err;
      try { this.node?.disconnect(); } catch {}
      this.node = null;
      this.rateParam = null;
      this.scratchParam = null;
      return this._setupScript();
    }
  }

  async _setupScript() {
    let TapeVoice;
    try {
      const res = await fetch(new URL('scratch-processor.js', document.baseURI).href);
      const src = await res.text();
      const cut = src.indexOf('class ScratchProcessor');
      if (cut < 0) throw new Error('reader missing');
      TapeVoice = new Function(`${src.slice(0, cut)}; return TapeVoice;`)();
    } catch (err) {
      this.lastError = err;
      this.scratchOK = false;
      return false;
    }
    const size = 1024;
    let proc;
    try {
      proc = this.ctx.createScriptProcessor(size, 0, 2);
    } catch {
      try { proc = this.ctx.createScriptProcessor(size, 0, 1); } catch {
        this.scratchOK = false;
        return false;
      }
    }
    this.voice = new TapeVoice();
    this.proc = proc;
    proc.onaudioprocess = (e) => {
      const l = e.outputBuffer.getChannelData(0);
      const r = e.outputBuffer.numberOfChannels > 1 ? e.outputBuffer.getChannelData(1) : l;
      const ended = this.voice.render(l, r, l.length, this.commandRate, this.scratching, this.ctx.sampleRate);
      if (!this.scratching && this.voice.bufRate) {
        this.position = this.voice.pos / this.voice.bufRate;
        this.positionStamp = this.ctx.currentTime;
      }
      if (ended) this._onEnded();
    };
    proc.connect(this.input);
    this.backend = 'script';
    this.scratchOK = true;
    return true;
  }

  _onWorklet(m) {
    if (!m || m.type !== 'pos') return;
    if (!this.scratching && m.time != null && isFinite(m.seconds)) {
      this.position = m.seconds;
      this.positionStamp = m.time;
    }
    if (m.ended) this._onEnded();
  }

  _post(msg, transfers) {
    if (this.backend === 'script' && this.voice) {
      if (msg.type === 'buffer') this.voice.setBuffer(msg.ch0, msg.ch1, msg.len, msg.bufRate);
      else if (msg.type === 'seek') this.voice.seek(msg.seconds || 0);
      else if (msg.type === 'target') this.voice.setTarget(msg.seconds || 0);
      else if (msg.type === 'playing') this.voice.playing = !!msg.value;
      return;
    }
    if (!this.node) return;
    try { this.node.port.postMessage(msg, transfers || []); } catch {}
  }

  _setRate(rate, immediate) {
    let clamped = rate;
    if (!isFinite(clamped)) clamped = 0;
    if (clamped > 16) clamped = 16;
    if (clamped < -16) clamped = -16;
    this.commandRate = clamped;
    if (!this.rateParam || !this.ctx) return;
    const now = this.ctx.currentTime;
    try {
      if (immediate || !this.scratching) {
        this.rateParam.cancelScheduledValues(now);
        this.rateParam.setValueAtTime(clamped, now);
      } else {
        this.rateParam.setTargetAtTime(clamped, now, 0.005);
      }
    } catch {
      try { this.rateParam.setValueAtTime(clamped, now + 0.001); } catch {}
    }
  }

  _setScratch(on) {
    if (!this.scratchParam || !this.ctx) return;
    const now = this.ctx.currentTime;
    try {
      this.scratchParam.cancelScheduledValues(now);
      this.scratchParam.setValueAtTime(on ? 1 : 0, now);
    } catch {}
  }

  _readAhead() {
    if (!this.playing || !this.ctx) return this.position || 0;
    const dt = this.ctx.currentTime - (this.positionStamp || 0);
    let t = (this.position || 0) + dt * (this.playRate || 0);
    if (t < 0) t = 0;
    if (this.duration && t > this.duration) t = this.duration;
    return t;
  }

  _tick() {
    if (this.playing && !this.scratching && this.loop && this.loop.b != null) {
      const t = this.currentTime;
      if (t >= this.loop.b || t < this.loop.a - 0.25) this.seek(this.loop.a);
    }
    if (this.playing && !this.scratching && this.duration > 0.05 && this.currentTime >= this.duration - 0.03) {
      this._onEnded();
    }
  }

  _onEnded() {
    if (this._endedOnce || this.scratching) return;
    this._endedOnce = true;
    if (this.duration) this.position = this.duration;
    this.halt();
    this.emit('ended');
  }

  _session(state) {
    try { if (navigator.mediaSession) navigator.mediaSession.playbackState = state; } catch {}
  }

  async _kickKeep(on) {
    if (!this.keep) {
      this.keep = new Audio();
      this.keep.loop = true;
      this.keep.preload = 'auto';
      this.keep.setAttribute('playsinline', '');
      this.keep.src = keepaliveUrl();
      // Quiet, but not digital silence: some Android builds drop a zero stream
      // and then suspend the WebView audio thread.
      this.keep.volume = 1;
    }
    if (on) {
      try { await this.keep.play(); } catch {}
    } else {
      try { this.keep.pause(); } catch {}
    }
  }

  _install(data, at) {
    const ch0 = data.channels[0];
    const ch1 = data.channels[1] || null;
    this.mode = 'buffer';
    this.duration = data.duration || (data.length / data.sampleRate);
    this.ready = true;
    this.playing = false;
    this.playRate = 0;
    this.position = at || 0;
    this.positionStamp = this.ctx.currentTime;
    this.scratchPos = this.position;
    if (this.fallbackGain) this.fallbackGain.gain.value = 0;
    try { this.el.pause(); } catch {}
    this._setRate(0, true);
    this._setScratch(0);
    if (this.backend === 'script') {
      this.voice.setBuffer(ch0, ch1, data.length, data.sampleRate);
      this.voice.seek(at || 0);
      this.voice.playing = false;
    } else {
      const transfers = [];
      if (ch0?.buffer) transfers.push(ch0.buffer);
      if (ch1?.buffer && ch1.buffer !== ch0.buffer) transfers.push(ch1.buffer);
      this._post({
        type: 'buffer', ch0, ch1, len: data.length, bufRate: data.sampleRate,
      }, transfers);
      this._post({ type: 'seek', seconds: at || 0 });
      this._post({ type: 'playing', value: false });
    }
    data.channels = null;
    this.emit('loaded');
  }

  async _loadElement(blob, at) {
    this.mode = 'element';
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    this.fallbackGain && (this.fallbackGain.gain.value = 0);
    this._setRate(0, true);
    const ok = await new Promise((resolve) => {
      const done = (v) => {
        this.el.removeEventListener('loadedmetadata', onOk);
        this.el.removeEventListener('error', onBad);
        clearTimeout(timer);
        resolve(v);
      };
      const onOk = () => done(true);
      const onBad = () => done(false);
      const timer = setTimeout(() => done(false), 20000);
      this.el.addEventListener('loadedmetadata', onOk);
      this.el.addEventListener('error', onBad);
      this.el.src = this.url;
      this.el.load();
    });
    if (!ok) {
      const code = this.el.error?.code;
      const err = new Error(code === 4 ? 'codec' : 'decode');
      err.code = code;
      throw err;
    }
    this.duration = isFinite(this.el.duration) ? this.el.duration : 0;
    this.ready = true;
    this.position = at || 0;
    if (at > 0) {
      try { this.el.currentTime = at; } catch {}
    }
    this.emit('loaded');
  }

  _remember(id, data) {
    if (!id || !data?.channels?.[0]?.length) return;
    if (!data.channels[0].buffer || data.channels[0].buffer.byteLength === 0) return;
    this.decoded.delete(id);
    this.decoded.set(id, data);
    while (this.decoded.size > 1) {
      const oldest = this.decoded.keys().next().value;
      if (oldest === id) break;
      this.decoded.delete(oldest);
    }
  }

  _decode(blob, id, { store } = {}) {
    if (id && this.inflight.has(id)) return this.inflight.get(id);
    const p = this._runDecode(blob).then((data) => {
      if (store && id) this._remember(id, data);
      return data;
    });
    if (id) {
      this.inflight.set(id, p);
      p.then(() => {}, () => {}).finally(() => {
        if (this.inflight.get(id) === p) this.inflight.delete(id);
      });
    }
    return p;
  }

  async _runDecode(blob) {
    const sr = this.ctx?.sampleRate || 48000;
    try {
      const pcm = await blob.arrayBuffer();
      const data = await this._workerCall({ pcm, sampleRate: sr, bins: PEAK_BINS, peaksOnly: false });
      if (!data?.channels?.[0]?.length) throw new Error(data?.error || 'decode failed');
      return data;
    } catch (err) {
      const msg = String(err && (err.message || err) || '');
      if (/memory|allocat|oom|out of/i.test(msg)) throw err;
      const pcm = await blob.arrayBuffer();
      return this._decodeOnMain(pcm);
    }
  }

  async _peaksOnly(blob) {
    try {
      const pcm = await blob.arrayBuffer();
      const data = await this._workerCall({ pcm, sampleRate: 8000, bins: PEAK_BINS, peaksOnly: true });
      return data?.peaks || null;
    } catch {
      return null;
    }
  }

  _worker() {
    if (this._w) return this._w;
    this._w = new Worker(new URL('./decode.worker.js', import.meta.url), { type: 'module' });
    this._w.onmessage = (e) => {
      const job = this._wBusy;
      if (!job || !e.data || e.data.id !== job.id) return;
      clearTimeout(job.timer);
      this._wBusy = null;
      if (e.data.ok) job.resolve(e.data);
      else job.reject(new Error(e.data.error || 'decode failed'));
      this._pumpWorker();
    };
    this._w.onerror = () => {
      const job = this._wBusy;
      this._wBusy = null;
      if (job) {
        clearTimeout(job.timer);
        job.reject(new Error('worker failed'));
      }
      try { this._w.terminate(); } catch {}
      this._w = null;
      this._pumpWorker();
    };
    return this._w;
  }

  _workerCall(payload) {
    const id = this._req++;
    return new Promise((resolve, reject) => {
      this._wq.push({ id, payload, resolve, reject });
      this._pumpWorker();
    });
  }

  _pumpWorker() {
    if (this._wBusy || !this._wq.length) return;
    const job = this._wq.shift();
    let worker;
    try { worker = this._worker(); } catch (err) {
      job.reject(err);
      this._pumpWorker();
      return;
    }
    this._wBusy = job;
    job.timer = setTimeout(() => {
      if (this._wBusy !== job) return;
      this._wBusy = null;
      job.reject(new Error('decode timed out'));
      try { worker.terminate(); } catch {}
      this._w = null;
      this._pumpWorker();
    }, 45000);
    const transfers = [];
    if (payloadBuffer(job.payload)) transfers.push(job.payload.pcm);
    try { worker.postMessage({ ...job.payload, id: job.id }, transfers); }
    catch (err) {
      clearTimeout(job.timer);
      this._wBusy = null;
      job.reject(err);
      this._pumpWorker();
    }
  }

  async _decodeOnMain(arrayBuffer) {
    if (!this.ctx) throw new Error('no audio context');
    const audio = await this.ctx.decodeAudioData(arrayBuffer);
    const channels = [];
    for (let c = 0; c < Math.min(2, audio.numberOfChannels); c++) channels.push(audio.getChannelData(c).slice());
    return {
      channels,
      peaks: computePeaks(channels, PEAK_BINS),
      duration: audio.duration,
      sampleRate: audio.sampleRate,
      length: audio.length,
    };
  }
}

function payloadBuffer(payload) {
  return payload && payload.pcm && payload.pcm.byteLength;
}

function keepaliveUrl() {
  const sr = 8000;
  const n = sr;
  const data = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF');
  data.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, sr, true);
  data.setUint32(28, sr * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  w(36, 'data');
  data.setUint32(40, n * 2, true);
  // ~30 Hz at about -78 dBFS. Non-zero so Android does not treat the stream as idle.
  for (let i = 0; i < n; i++) {
    const v = Math.sin((2 * Math.PI * 30 * i) / sr) * 4;
    data.setInt16(44 + i * 2, v | 0, true);
  }
  return URL.createObjectURL(new Blob([data.buffer], { type: 'audio/wav' }));
}

function rms(b) {
  let s = 0;
  for (let i = 0; i < b.length; i++) s += b[i] * b[i];
  return Math.sqrt(s / b.length);
}

function satCurve(amount) {
  const n = 2048;
  const c = new Float32Array(n);
  const k = 1 + amount * 6;
  const asym = amount * 0.12;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = (Math.tanh(k * (x + asym)) - Math.tanh(k * asym)) / norm;
  }
  return c;
}

function springIR(ctx) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 2.4);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.pow(1 - i / len, 3.2) * Math.exp(-t * 1.6);
      const ph = (t % 0.037) / 0.037;
      const chirp = Math.sin(2 * Math.PI * (900 + 2600 * ph) * t + ch) * 0.35 * Math.exp(-ph * 4);
      const n = Math.random() * 2 - 1;
      lp += (n - lp) * 0.35;
      d[i] = (lp * 0.9 + chirp) * env;
    }
  }
  return buf;
}
