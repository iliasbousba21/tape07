// Computes min/max peak pairs off the main thread.
self.onmessage = (e) => {
  const { id, channels, bins } = e.data;
  const n = channels[0].length;
  const step = Math.max(1, Math.floor(n / bins));
  const out = new Float32Array(bins);
  let max = 0;
  for (let b = 0; b < bins; b++) {
    const s = b * step, end = Math.min(n, s + step);
    let peak = 0, sum = 0, c = 0;
    for (const ch of channels) {
      for (let i = s; i < end; i += 2) {
        const v = ch[i] < 0 ? -ch[i] : ch[i];
        if (v > peak) peak = v;
        sum += v * v; c++;
      }
    }
    const rms = c ? Math.sqrt(sum / c) : 0;
    out[b] = peak * 0.55 + rms * 1.1; // blend: reads like a tape envelope, not a spiky DAW view
    if (out[b] > max) max = out[b];
  }
  if (max > 0) for (let b = 0; b < bins; b++) out[b] = Math.min(1, out[b] / max);
  self.postMessage({ id, peaks: Array.from(out, (v) => Math.round(v * 255)) });
};
