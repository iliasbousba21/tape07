// Audio engine: one <audio> element (streams from a blob URL, keeps lock-screen /
// background playback working on Android) routed through a Web Audio FX chain.
//
// el -> source -> [dry bypass]--------------------------------------> master
//              -> wow(mod delay) -> hp -> lp -> drive -> fxOut -------> master
//                                                     -> echo send --> echo --> master (via fxOut bus)
//                                                     -> space send -> verb --> master
// master -> splitter -> analyser L/R ; master -> destination

export class Engine {
  constructor() {
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.crossOrigin = 'anonymous';
    this.el.setAttribute('playsinline', '');
    this.el.preservesPitch = false; // varispeed: speed changes pitch like tape
    this.el.mozPreservesPitch = false;
    this.el.webkitPreservesPitch = false;
    this.ctx = null;
    this.params = { volume: 0.8, tone: 0, drive: 0, echo: 0, space: 0, wow: 0, fx: true };
    this.levels = [0, 0];
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
      return this.ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const ctx = (this.ctx = new AC({ latencyHint: 'playback' }));
    const src = ctx.createMediaElementSource(this.el);
    this.src = src;

    this.master = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();

    // wow / flutter: modulated short delay = pitch wobble
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

    // tone: single DJ-style knob. left = low-pass, right = high-pass, centre = flat
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 10;
    this.hp.Q.value = 0.9;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 22000;
    this.lp.Q.value = 0.9;

    // drive: tape saturation
    this.preDrive = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '2x';
    this.postDrive = ctx.createGain();
    this.headBump = ctx.createBiquadFilter(); // tape head bump + soft top
    this.headBump.type = 'lowshelf';
    this.headBump.frequency.value = 90;
    this.headBump.gain.value = 0;

    // echo
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

    // space: spring-ish reverb (generated IR with metallic chirp)
    this.verbSend = ctx.createGain();
    this.verbSend.gain.value = 0;
    this.verb = ctx.createConvolver();
    this.verb.buffer = springIR(ctx);
    this.verbHp = ctx.createBiquadFilter();
    this.verbHp.type = 'highpass';
    this.verbHp.frequency.value = 180;
    this.verbSend.connect(this.verbHp).connect(this.verb).connect(this.wet);

    src.connect(this.dry).connect(this.master);
    src.connect(this.wowDelay).connect(this.hp).connect(this.lp).connect(this.preDrive)
      .connect(this.shaper).connect(this.postDrive).connect(this.headBump);
    this.headBump.connect(this.wet);
    this.headBump.connect(this.echoSend);
    this.headBump.connect(this.verbSend);
    this.wet.connect(this.master);

    // meters
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

    this.inputMeter = null; // set by recorder
    this.apply(true);
    return ctx;
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

    // tone
    const tone = p.tone; // -1..1
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

    // drive
    const d = p.drive;
    if (d !== this._lastDrive) {
      this.shaper.curve = d > 0.001 ? satCurve(d) : null;
      this._lastDrive = d;
    }
    ramp(this.preDrive.gain, 1 + d * 5);
    // keep perceived loudness roughly level: undo the small-signal gain of pre + curve
    const k = 1 + d * 6;
    const slope = d > 0.001 ? k / Math.tanh(k) : 1;
    ramp(this.postDrive.gain, (1 + d * 0.9) / ((1 + d * 5) * slope));
    ramp(this.headBump.gain, d * 4);

    // echo
    ramp(this.echoSend.gain, p.echo * 0.75);
    ramp(this.echoFb.gain, 0.25 + p.echo * 0.4);

    // space
    ramp(this.verbSend.gain, p.space * 1.1);

    // wow / flutter
    ramp(this.wowAmt.gain, p.wow * 0.0042);
    ramp(this.flutAmt.gain, p.wow * 0.00035);
  }

  // Smoothed level, VU-ish ballistics handled in the UI
  readLevels() {
    if (this.recordingMeter) return this.recordingMeter();
    if (!this.ctx) return [0, 0];
    this.anL.getFloatTimeDomainData(this.bufL);
    this.anR.getFloatTimeDomainData(this.bufR);
    return [rms(this.bufL), rms(this.bufR)];
  }
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
  const asym = amount * 0.12; // a hint of even harmonics, like tape
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
      // metallic chirp repeating every ~37 ms (the "boing" of a spring tank)
      const ph = (t % 0.037) / 0.037;
      const chirp = Math.sin(2 * Math.PI * (900 + 2600 * ph) * t + ch) * 0.35 * Math.exp(-ph * 4);
      const n = Math.random() * 2 - 1;
      lp += (n - lp) * 0.35;
      d[i] = (lp * 0.9 + chirp) * env;
    }
  }
  return buf;
}
