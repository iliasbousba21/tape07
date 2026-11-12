// REEL-7 tape reader. Classic script (no imports) so AudioWorklet.addModule can load it
// directly on Android WebView. Reads a decoded buffer at any rate, including reverse.
// Loaded from /scratch-processor.js — keep this file in public/ so the bundler does not wrap it.

class TapeVoice {
  constructor() {
    this.ch0 = null;
    this.ch1 = null;
    this.len = 0;
    this.bufRate = 44100;
    this.pos = 0;
    this.playing = false;
    this.ended = false;
    this.fade = 0;
    this.lp0 = 0;
    this.lp1 = 0;
    this.nz = 222222;
    this.hp = 0;
    this.prevN = 0;
    this.hasTarget = false;
    this.target = 0;
  }

  setBuffer(ch0, ch1, len, bufRate) {
    this.ch0 = ch0 && ch0.length ? ch0 : null;
    this.ch1 = ch1 && ch1.length ? ch1 : this.ch0;
    this.len = len | 0;
    this.bufRate = bufRate || 44100;
    this.pos = 0;
    this.ended = false;
    this.fade = 64;
    this.lp0 = 0;
    this.lp1 = 0;
    this.hasTarget = false;
    this.target = 0;
  }

  seek(seconds) {
    var p = (seconds || 0) * this.bufRate;
    if (p < 0) p = 0;
    if (this.len > 1 && p > this.len - 1) p = this.len - 1;
    this.pos = p || 0;
    this.target = this.pos;
    this.hasTarget = false;
    this.fade = 64;
    this.ended = false;
    this.lp0 = 0;
    this.lp1 = 0;
  }

  setTarget(seconds) {
    if (!this.len) return;
    var p = (seconds || 0) * this.bufRate;
    if (p < 0) p = 0;
    if (p > this.len - 1) p = this.len - 1;
    this.target = p;
    this.hasTarget = true;
  }

  // 4-point Hermite. Exact on linear ramps, so slow crawls stay smooth.
  static at(ch, pos, len) {
    if (!ch || len <= 0) return 0;
    if (pos < 0) pos = 0;
    if (pos > len - 1) pos = len - 1;
    var i = pos | 0;
    var t = pos - i;
    if (len < 4 || i < 1 || i > len - 3) {
      var a = ch[i] || 0;
      var b = ch[(i + 1 < len) ? i + 1 : i] || 0;
      return a + (b - a) * t;
    }
    var y0 = ch[i - 1];
    var y1 = ch[i];
    var y2 = ch[i + 1];
    var y3 = ch[i + 2];
    var c1 = 0.5 * (y2 - y0);
    var c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    var c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * t + c2) * t + c1) * t + y1;
  }

  render(out0, out1, frames, rate, scratching, sampleRate) {
    var ch0 = this.ch0;
    var ch1 = this.ch1 || ch0;
    var len = this.len;
    var sr = sampleRate || 44100;
    if (!ch0 || len < 2 || !out0 || !frames) {
      if (out0) out0.fill(0);
      if (out1 && out1 !== out0) out1.fill(0);
      return false;
    }
    if (!isFinite(rate)) rate = 0;
    var ar = rate < 0 ? -rate : rate;
    var ratio = this.bufRate / sr;
    var step = rate * ratio;
    var pos = this.pos;
    var lp0 = this.lp0;
    var lp1 = this.lp1;
    var nz = this.nz;
    var hp = this.hp;
    var prevN = this.prevN;
    var fade = this.fade;
    var pullStep = 0;
    // If the finger and the playhead drift, ease back. Only while scratching,
    // and only past ~40 ms, so normal playback is not tugged.
    if (scratching && this.hasTarget) {
      var err = this.target - pos;
      var lim = this.bufRate * 0.04;
      if (err > lim || err < -lim) {
        var pull = err * 0.35;
        var cap = this.bufRate * 0.012;
        if (pull > cap) pull = cap;
        if (pull < -cap) pull = -cap;
        pullStep = pull / frames;
      }
    }
    var friction = 0;
    if (scratching && ar > 0.45) {
      var ft = (ar - 0.45) / 6;
      if (ft > 1) ft = 1;
      friction = ft * ft * 0.05;
    }
    var stereo = out1 && out1 !== out0;

    for (var i = 0; i < frames; i++) {
      var atStart = pos <= 0 && rate <= 0;
      var atEnd = pos >= len - 1 && rate >= 0;
      var moving = ar >= 0.0008 && !atStart && !atEnd;
      var s0 = 0;
      var s1 = 0;
      if (moving) {
        s0 = TapeVoice.at(ch0, pos, len);
        s1 = TapeVoice.at(ch1, pos, len);
        if (ar > 1.05) {
          var c = 1.15 / ar;
          if (c < 0.03) c = 0.03;
          if (c > 0.9) c = 0.9;
          lp0 += (s0 - lp0) * c;
          lp1 += (s1 - lp1) * c;
          s0 = lp0;
          s1 = lp1;
        } else {
          lp0 = s0;
          lp1 = s1;
        }
      } else {
        lp0 *= 0.9;
        lp1 *= 0.9;
        s0 = lp0;
        s1 = lp1;
      }
      if (friction > 0) {
        nz = (Math.imul(nz, 1664525) + 1013904223) >>> 0;
        var white = nz / 4294967296 * 2 - 1;
        hp = (white - prevN) + 0.94 * hp;
        prevN = white;
        var fr = hp * friction;
        s0 += fr;
        s1 += fr;
      }
      if (fade > 0) {
        var g = 1 - fade / 64;
        s0 *= g;
        s1 *= g;
        fade--;
      }
      if (s0 > 1.2) s0 = 1.2;
      else if (s0 < -1.2) s0 = -1.2;
      if (s1 > 1.2) s1 = 1.2;
      else if (s1 < -1.2) s1 = -1.2;
      out0[i] = s0;
      if (stereo) out1[i] = s1;
      pos += step + pullStep;
      if (pos < 0) pos = 0;
      else if (pos > len - 1) pos = len - 1;
    }

    this.pos = pos;
    this.lp0 = lp0;
    this.lp1 = lp1;
    this.nz = nz;
    this.hp = hp;
    this.prevN = prevN;
    this.fade = fade;

    var hit = false;
    if (this.playing && !scratching && rate > 0 && pos >= len - 1) {
      if (!this.ended) {
        this.ended = true;
        hit = true;
      }
    } else if (pos < len - 8) {
      this.ended = false;
    }
    return hit;
  }
}

class ScratchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voice = new TapeVoice();
    this.acc = 0;
    var self = this;
    this.port.onmessage = function (e) { self.onMsg(e.data); };
  }

  onMsg(m) {
    if (!m) return;
    var v = this.voice;
    if (m.type === 'buffer') {
      v.setBuffer(m.ch0, m.ch1, m.len, m.bufRate);
    } else if (m.type === 'seek') {
      v.seek(m.seconds || 0);
    } else if (m.type === 'target') {
      v.setTarget(m.seconds || 0);
    } else if (m.type === 'playing') {
      v.playing = !!m.value;
      if (m.value) v.ended = false;
    } else if (m.type === 'scratching') {
      v.scratching = !!m.value;
      if (!m.value) v.hasTarget = false;
    } else if (m.type === 'ping') {
      this.port.postMessage({ type: 'ready', len: v.len });
    }
  }

  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 0, minValue: -32, maxValue: 32, automationRate: 'k-rate' },
      { name: 'scratch', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  process(inputs, outputs, params) {
    var out = outputs[0];
    if (!out || !out[0]) return true;
    var ch0 = out[0];
    var ch1 = out.length > 1 ? out[1] : ch0;
    var rate = params.rate && params.rate.length ? params.rate[0] : 0;
    var scratching = params.scratch && params.scratch.length ? params.scratch[0] >= 0.5 : false;
    var ended = this.voice.render(ch0, ch1, ch0.length, rate, scratching, sampleRate);
    this.acc += ch0.length;
    if (ended || this.acc >= 2048) {
      if (!ended) this.acc -= 2048;
      else this.acc = 0;
      var v = this.voice;
      this.port.postMessage({
        type: 'pos',
        seconds: v.bufRate ? v.pos / v.bufRate : 0,
        ended: !!ended,
        time: currentTime,
      });
    }
    return true;
  }
}

registerProcessor('reel7-scratch', ScratchProcessor);
