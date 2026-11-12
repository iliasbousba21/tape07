// Boots the built app, imports a tone, and checks that play moves the tape and lights the meters.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

function wavTone(path) {
  const sr = 44100;
  const n = sr; // 1s
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
  for (let i = 0; i < n; i++) {
    const v = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.6;
    data.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  writeFileSync(path, Buffer.from(data.buffer));
}

const tone = '/tmp/reel7-tone.wav';
wavTone(tone);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  const file = join(dist, path === '/' ? 'index.html' : path);
  if (!file.startsWith(dist)) { res.writeHead(403); res.end(); return; }
  try {
    const body = readFileSync(file);
    res.setHeader('content-type', types[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('missing ' + path);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;

const chrome = spawn('google-chrome', [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--no-first-run',
  '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=9334',
  '--remote-allow-origins=*',
  '--user-data-dir=/tmp/reel7-chrome-ui',
  url,
], { stdio: 'ignore' });

const deadline = Date.now() + 25000;
let page;
while (Date.now() < deadline) {
  try {
    const list = await fetch('http://127.0.0.1:9334/json/list').then((r) => r.json());
    page = list.find((t) => t.type === 'page' && t.url.startsWith(url) && t.webSocketDebuggerUrl);
    if (page) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 150));
}
if (!page) fail('chrome did not open the app');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
await send('Runtime.enable');
await send('DOM.enable');
const errors = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push(msg.params.args.map((a) => a.value || a.description || '').join(' '));
  }
});

async function evalJson(expression) {
  const ev = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (ev.exceptionDetails) throw new Error(ev.exceptionDetails.text + ' ' + (ev.exceptionDetails.exception?.description || ''));
  return ev.result.value;
}

async function waitFor(expression, label) {
  const until = Date.now() + 8000;
  let last = '';
  while (Date.now() < until) {
    last = await evalJson(expression);
    if (last && !String(last).startsWith('WAIT')) return last;
    await new Promise((r) => setTimeout(r, 120));
  }
  fail(label + ' — last: ' + last);
}

function fail(msg) {
  console.error(msg);
  console.error('console:', errors);
  try { ws.close(); } catch {}
  chrome.kill();
  server.close();
  process.exit(1);
}

const title = await waitFor(`document.getElementById('dTitle')?.textContent || 'WAIT'`, 'title');
if (!/no tape/i.test(title)) fail('expected empty tape, got ' + title);

const doc = await send('DOM.getDocument', { depth: -1 });
function find(node, id) {
  if (node.attributes) {
    for (let i = 0; i < node.attributes.length; i += 2) if (node.attributes[i] === 'id' && node.attributes[i + 1] === id) return node.nodeId;
  }
  for (const c of node.children || []) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return 0;
}
const input = find(doc.root, 'file');
if (!input) fail('file input missing');
await send('DOM.setFileInputFiles', { nodeId: input, files: [tone] });
await evalJson(`document.getElementById('file').dispatchEvent(new Event('change'))`);

const loaded = await waitFor(`(() => {
  const t = document.getElementById('dTitle').textContent;
  return /tone/i.test(t) ? t : 'WAIT ' + t + ' | ' + document.getElementById('dMsg').textContent;
})()`, 'import');
console.log('loaded', loaded);

await evalJson(`document.getElementById('kPlay').click()`);
const playing = await waitFor(`(() => {
  const mode = document.getElementById('dMode').textContent;
  const time = document.getElementById('dTime').textContent;
  return mode.includes('play') && time !== '00:00:00.00' ? mode + ' ' + time : 'WAIT ' + mode + ' ' + time + ' | ' + document.getElementById('dMsg').textContent;
})()`, 'playback');
console.log('playing', playing);

const light = await evalJson(`(() => {
  const c = document.getElementById('meters');
  const g = c.getContext('2d', { willReadFrequently: true });
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] > 160) n++;
  return n;
})()`);
console.log('meter pixels', light);
if (light < 20) fail('meters stayed dark — engine produced no audio');

await evalJson(`document.getElementById('kLib').click()`);
const lib = await waitFor(`document.getElementById('library').classList.contains('open') ? 'open' : 'WAIT'`, 'library');
console.log('library', lib);

if (errors.length) fail('page errors: ' + errors.join(' | '));
console.log('UI smoke passed');
ws.close();
chrome.kill();
server.close();
