// Min/max-style peak envelope shared by the decode worker and the main-thread fallback.
// Same shape the waveform already stores: 0..255, one value per bin.

export function computePeaks(channels, bins = 720) {
  if (!channels?.length || !channels[0]?.length) return new Array(bins).fill(0);
  const n = channels[0].length;
  const step = Math.max(1, Math.floor(n / bins));
  const out = new Array(bins);
  let max = 0;
  for (let b = 0; b < bins; b++) {
    const s = b * step;
    const end = Math.min(n, s + step);
    let peak = 0, sum = 0, c = 0;
    for (const ch of channels) {
      if (!ch) continue;
      for (let i = s; i < end; i += 2) {
        const v = ch[i] < 0 ? -ch[i] : ch[i];
        if (v > peak) peak = v;
        sum += v * v;
        c++;
      }
    }
    const rms = c ? Math.sqrt(sum / c) : 0;
    const blend = peak * 0.55 + rms * 1.1;
    out[b] = blend;
    if (blend > max) max = blend;
  }
  if (max > 0) {
    for (let b = 0; b < bins; b++) out[b] = Math.min(255, Math.round(Math.min(1, out[b] / max) * 255));
  } else {
    for (let b = 0; b < bins; b++) out[b] = 0;
  }
  return out;
}
