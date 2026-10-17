// Screenshot helper: renders the board at desktop and phone widths so the
// layout and the hand-drawn SVG pieces can be inspected.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Override with CHROME_PATH on macOS/Linux, or edit the default below.
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = pathToFileURL(path.join(root, 'dist', 'index.html')).href;
if (!fs.existsSync(CHROME)) {
  console.error('Chrome not found at ' + CHROME + '\nSet CHROME_PATH or edit the CHROME constant at the top of this file.');
  process.exit(1);
}

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chessshot-'));
const port = 9600 + Math.floor(Math.random() * 200);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars',
  '--mute-audio', '--remote-debugging-port=' + port, '--user-data-dir=' + userDir, target
], { stdio: ['ignore', 'ignore', 'ignore'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(120);
  }
  throw new Error('no devtools');
}
const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
  }
};
function send(method, params) {
  const id = seq++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function evalInPage(expression, awaitPromise = true) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
await send('Runtime.enable');
await send('Page.enable');
await sleep(800);

async function shot(name, width, height, mobile, setup) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: mobile ? 2 : 1, mobile: mobile
  });
  await sleep(300);
  if (setup) { await evalInPage(setup); await sleep(900); }
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(root, 'dist', name), Buffer.from(r.data, 'base64'));
  console.log('wrote', name, width + 'x' + height);
}

// Play a few moves so the screenshot shows highlights, a move list and an eval.
const setup = `(async () => {
  const area = document.getElementById('boardArea');
  const r = area.getBoundingClientRect();
  const s = r.width / 8;
  const pt = (row, col) => [r.left + col*s + s/2, r.top + row*s + s/2];
  const ev = (type, row, col, buttons) => {
    const p = pt(row, col);
    area.dispatchEvent(new PointerEvent(type, { clientX: p[0], clientY: p[1], pointerId: 1, isPrimary: true, bubbles: true, cancelable: true, button: 0, buttons }));
  };
  const click = (row, col) => { ev('pointerdown', row, col, 1); ev('pointerup', row, col, 0); };
  click(6,4); click(4,4);
  await new Promise(r => setTimeout(r, 2600));
  return true;
})()`;

await shot('shot-desktop.png', 1440, 980, false, setup);
await shot('shot-mobile.png', 390, 844, true, `(async () => {
  window.scrollTo(0, 0);
  return true;
})()`);
await shot('shot-mobile-board.png', 390, 844, true, `(async () => {
  window.scrollTo(0, 0);
  return true;
})()`);
ws.close();
chrome.kill();
process.exit(0);
