// Loads the scratch worklet in headless Chrome and checks forward, reverse, and held-still audio.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (path.endsWith('scratch-processor.js')) {
    res.setHeader('content-type', 'text/javascript');
    res.end(readFileSync(join(root, 'public/scratch-processor.js')));
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(readFileSync(join(root, 'scripts/scratch-harness.html')));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/scratch-harness.html`;

const chrome = spawn('google-chrome', [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--no-first-run',
  '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=9333',
  '--remote-allow-origins=*',
  '--user-data-dir=/tmp/reel7-chrome-scratch',
  url,
], { stdio: ['ignore', 'pipe', 'pipe'] });
chrome.stderr.on('data', (d) => process.stderr.write(d));

const deadline = Date.now() + 20000;
let page;
while (Date.now() < deadline) {
  try {
    const list = await fetch('http://127.0.0.1:9333/json/list').then((r) => r.json());
    page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 150));
}
if (!page) {
  chrome.kill();
  server.close();
  console.error('chrome did not expose a page');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
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

let result = null;
let text = '';
while (Date.now() < deadline) {
  const ev = await send('Runtime.evaluate', {
    expression: 'document.body ? JSON.stringify({ result: document.body.dataset.result || "", text: document.body.innerText || "" }) : ""',
    returnByValue: true,
  });
  if (!ev.result || ev.result.value == null || ev.result.value === '') {
    await new Promise((r) => setTimeout(r, 150));
    continue;
  }
  const info = JSON.parse(ev.result.value);
  text = info.text;
  if (info.result) { result = info.result; break; }
  await new Promise((r) => setTimeout(r, 150));
}
console.log(text);
ws.close();
chrome.kill();
server.close();
if (result !== 'pass') {
  console.error('scratch harness failed');
  process.exit(1);
}
