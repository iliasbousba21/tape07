// Decodes a track off the main thread and returns PCM plus a waveform envelope.
// The main thread transfers the file bytes in and the channel data back out.

import { computePeaks } from './peaks.js';

function own(arr) {
  if (!arr) return null;
  if (arr.byteOffset === 0 && arr.buffer.byteLength === arr.length * 4) return arr;
  return arr.slice();
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (typeof OfflineAudioContext === 'undefined') throw new Error('no offline context');
    const sr = msg.peaksOnly ? 8000 : (msg.sampleRate || 48000);
    const ctx = new OfflineAudioContext(2, 1, sr);
    const audio = await ctx.decodeAudioData(msg.pcm);
    const bins = msg.bins || 720;
    const ch0 = own(audio.getChannelData(0));
    const ch1 = audio.numberOfChannels > 1 ? own(audio.getChannelData(1)) : null;
    const channels = ch1 ? [ch0, ch1] : [ch0];
    const peaks = computePeaks(channels, bins);
    if (msg.peaksOnly) {
      self.postMessage({
        id: msg.id,
        ok: true,
        peaks,
        duration: audio.duration,
        sampleRate: audio.sampleRate,
        length: audio.length,
      });
      return;
    }
    const transfers = [ch0.buffer];
    if (ch1 && ch1.buffer !== ch0.buffer) transfers.push(ch1.buffer);
    self.postMessage({
      id: msg.id,
      ok: true,
      channels,
      peaks,
      duration: audio.duration,
      sampleRate: audio.sampleRate,
      length: audio.length,
    }, transfers);
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String(err && (err.message || err) || 'decode failed') });
  }
};
