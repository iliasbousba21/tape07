// Computes min/max peak pairs off the main thread.
import { computePeaks } from './peaks.js';

self.onmessage = (e) => {
  const { id, channels, bins } = e.data;
  self.postMessage({ id, peaks: computePeaks(channels, bins || 720) });
};
