// One-take recorder: mic -> MediaRecorder -> decode -> 16-bit WAV (seekable everywhere).
export class Recorder {
  constructor(engine) {
    this.engine = engine;
    this.active = false;
  }
  static supported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }
  async start() {
    const ctx = this.engine.ensure();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
    this.rec = new MediaRecorder(this.stream, mimeType ? { mimeType, audioBitsPerSecond: 192000 } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(500);
    this.t0 = performance.now();
    this.active = true;

    // input meter
    const src = ctx.createMediaStreamSource(this.stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(1024);
    this.srcNode = src;
    this.engine.recordingMeter = () => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      const v = Math.sqrt(s / buf.length) * 1.6;
      return [v, v];
    };
    try { this.wake = await navigator.wakeLock?.request('screen'); } catch {}
  }
  elapsed() {
    return this.active ? (performance.now() - this.t0) / 1000 : 0;
  }
  async stop() {
    if (!this.active) return null;
    const seconds = (performance.now() - this.t0) / 1000;
    this.active = false;
    const done = new Promise((r) => (this.rec.onstop = r));
    this.rec.stop();
    await done;
    this.stream.getTracks().forEach((t) => t.stop());
    this.srcNode?.disconnect();
    this.engine.recordingMeter = null;
    try { await this.wake?.release(); } catch {}
    const raw = new Blob(this.chunks, { type: this.rec.mimeType || 'audio/webm' });
    try {
      const ab = await raw.arrayBuffer();
      const audio = await this.engine.ctx.decodeAudioData(ab);
      return { blob: toWav(audio), duration: audio.duration, type: 'audio/wav' };
    } catch {
      return { blob: raw, duration: seconds, type: raw.type };
    }
  }
}

export function toWav(buffer) {
  const ch = Math.min(2, buffer.numberOfChannels);
  const sr = buffer.sampleRate;
  const n = buffer.length;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, sr, true); data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true);
  w(36, 'data'); data.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, i) => buffer.getChannelData(i));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([data], { type: 'audio/wav' });
}
