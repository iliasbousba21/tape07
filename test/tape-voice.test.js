import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'public/scratch-processor.js'), 'utf8');
const cut = src.indexOf('class ScratchProcessor');
const TapeVoice = new Function(`${src.slice(0, cut)}; return TapeVoice;`)();

function rms(b) {
  let s = 0;
  for (let i = 0; i < b.length; i++) s += b[i] * b[i];
  return Math.sqrt(s / b.length);
}

function voiceWith(fill, len = 48000) {
  const ch = new Float32Array(len);
  for (let i = 0; i < len; i++) ch[i] = fill(i, len);
  const v = new TapeVoice();
  v.setBuffer(ch, null, len, 48000);
  v.fade = 0;
  v.lp0 = 0;
  v.lp1 = 0;
  return v;
}

test('stopped wheel is silent, not a frozen sample', () => {
  const v = voiceWith(() => 0.8, 8000);
  v.pos = 1000;
  const out = new Float32Array(512);
  const outR = new Float32Array(512);
  v.render(out, outR, out.length, 0, true, 48000);
  assert.ok(rms(out) < 1e-3, `rms ${rms(out)}`);
  assert.equal(v.pos, 1000);
});

test('forward playback reads the buffer in order', () => {
  const v = voiceWith((i) => i * 0.0001, 8000);
  v.pos = 1000;
  const n = 100;
  const out = new Float32Array(n);
  v.render(out, new Float32Array(n), n, 1, false, 48000);
  assert.ok(Math.abs(out[0] - 0.1) < 1e-4, `first ${out[0]}`);
  assert.ok(Math.abs(out[99] - 0.1099) < 1e-4, `last ${out[99]}`);
  assert.ok(out[50] > out[0]);
});

test('reverse playback reads the buffer backwards', () => {
  const v = voiceWith((i) => i * 0.0001, 8000);
  v.pos = 1000;
  const n = 100;
  const out = new Float32Array(n);
  v.render(out, new Float32Array(n), n, -1, false, 48000);
  assert.ok(Math.abs(out[0] - 0.1) < 1e-4, `first ${out[0]}`);
  assert.ok(Math.abs(out[99] - 0.0901) < 1e-4, `last ${out[99]}`);
  assert.ok(out[50] < out[0]);
  assert.ok(v.pos < 1000);
});

test('a 48 kHz buffer played on a 24 kHz device stays in tune', () => {
  const v = voiceWith((i) => i * 0.0001, 8000);
  v.bufRate = 48000;
  v.pos = 100;
  const out = new Float32Array(10);
  v.render(out, new Float32Array(10), 10, 1, false, 24000);
  assert.ok(Math.abs(v.pos - 120) < 0.01, `pos ${v.pos}`);
  assert.ok(out.every((x) => Number.isFinite(x)));
});

test('varispeed 0.5 steps half a sample and stays finite', () => {
  const v = voiceWith((i) => Math.sin(i / 20), 4000);
  v.pos = 100;
  const out = new Float32Array(256);
  v.render(out, new Float32Array(256), 256, 0.5, false, 48000);
  assert.ok(out.every((x) => Number.isFinite(x)));
  assert.ok(rms(out) > 0.05);
  assert.ok(Math.abs(v.pos - (100 + 128)) < 1);
});

test('fast scratch adds a little friction on top of the tape', () => {
  const silent = voiceWith(() => 0, 8000);
  silent.pos = 4000;
  const a = new Float32Array(2048);
  silent.render(a, new Float32Array(2048), 2048, 6, false, 48000);
  const noisy = voiceWith(() => 0, 8000);
  noisy.pos = 4000;
  const b = new Float32Array(2048);
  noisy.render(b, new Float32Array(2048), 2048, 6, true, 48000);
  assert.ok(rms(a) < 1e-4, `clean ${rms(a)}`);
  assert.ok(rms(b) > 0.002, `friction ${rms(b)}`);
});

test('running into either end does not buzz the edge sample', () => {
  const v = voiceWith((i, n) => (i < 10 || i > n - 10 ? 1 : 0), 4000);
  v.pos = 0;
  const head = new Float32Array(128);
  v.render(head, new Float32Array(128), 128, -1, true, 48000);
  assert.ok(rms(head) < 0.05, `head buzz ${rms(head)}`);
  v.pos = v.len - 1;
  v.lp0 = 0;
  v.lp1 = 0;
  const tail = new Float32Array(128);
  v.render(tail, new Float32Array(128), 128, 1, true, 48000);
  assert.ok(rms(tail) < 0.05, `tail buzz ${rms(tail)}`);
  assert.ok(v.pos <= v.len - 1 && v.pos >= 0);
});

test('a wild rate stays finite and inside the buffer', () => {
  const v = voiceWith((i) => Math.sin(i * 0.01), 2000);
  v.playing = true;
  let pos = 100;
  for (let n = 0; n < 40; n++) {
    v.pos = pos;
    const rate = Math.sin(n) * 12;
    const out = new Float32Array(128);
    v.render(out, new Float32Array(128), 128, rate, n % 2 === 0, 48000);
    assert.ok(out.every((x) => Number.isFinite(x) && Math.abs(x) <= 1.21));
    assert.ok(v.pos >= 0 && v.pos <= v.len - 1);
    pos = v.pos;
  }
});
