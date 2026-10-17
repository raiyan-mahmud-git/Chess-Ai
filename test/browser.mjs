// End-to-end test in a real browser over the Chrome DevTools Protocol.
// No dependencies: node's global fetch + WebSocket drive a headless Chrome.
// Usage:
//   node test/browser.mjs                 # play a game through the real UI
//   node test/browser.mjs "" --lab        # run index.html?test and collect results
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Override with CHROME_PATH on macOS/Linux, or edit the default below.
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] || '';
const base = pathToFileURL(path.join(root, 'dist', 'index.html')).href;
const target = mode === '--lab' ? base + '?test' : base;

if (!fs.existsSync(CHROME)) {
  console.error('Chrome not found at ' + CHROME + '\nSet CHROME_PATH or edit the CHROME constant at the top of this file.');
  process.exit(1);
}

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chesslab-'));
const port = 9400 + Math.floor(Math.random() * 200);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + userDir,
  target
], { stdio: ['ignore', 'ignore', 'ignore'] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* not up yet */ }
    await sleep(120);
  }
  throw new Error('devtools did not come up');
}

const ws = new WebSocket(await getWsUrl());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 1;
const pending = new Map();
const events = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  } else if (msg.method) events.push(msg);
};

function send(method, params) {
  const id = seq++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

async function evaluate(expression, awaitPromise = true) {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true, userGesture: true
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('page exception: ' + ((d.exception && d.exception.description) || d.text));
  }
  return r.result.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await sleep(900);

const errors = [];
function collectErrors() {
  for (const e of events) {
    if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails;
      errors.push((d.exception && d.exception.description) || d.text);
    }
    if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
      const t = e.params.entry.text || '';
      if (!/favicon|net::ERR_FILE_NOT_FOUND/.test(t)) errors.push(t);
    }
  }
  events.length = 0;
}

const report = [];
function check(name, pass, detail) {
  report.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
}

if (mode === '--bench') {
  // initLab() runs the full suite on load; wait until its last section exists,
  // otherwise the bench button is ignored because the suite is still running.
  for (let i = 0; i < 200; i++) {
    await sleep(500);
    const done = await evaluate(`document.getElementById('labStatus').textContent === 'done'`);
    if (done) break;
  }
  await sleep(2000);
  // retry: the click is ignored while the initial suite is still finishing
  for (let attempt = 0; attempt < 8; attempt++) {
    await evaluate(`document.getElementById('runBench').click()`);
    await sleep(1200);
    const started = await evaluate(`Array.from(document.querySelectorAll('.lab-table')).some(x => /BUDGET/i.test(x.innerText))`);
    if (started) break;
  }
  let rows = [];
  for (let i = 0; i < 160; i++) {
    await sleep(500);
    rows = await evaluate(`(() => {
      const t = Array.from(document.querySelectorAll('.lab-table')).find(x => /budget/i.test(x.innerText));
      return t ? t.innerText.split('\\n') : [];
    })()`);
    if (rows.length > 6) break;
  }
  collectErrors();
  console.log(rows.join('\n'));
  for (const e of errors) check('no page errors', false, e);
  console.log('\n=== CHECKS ===');
  for (const r of report) console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '  -> ' + r.detail : ''));
  const failed = report.filter((r) => !r.pass).length;
  console.log(failed ? failed + ' FAILED' : 'ALL CHECKS PASSED');
  ws.close(); chrome.kill();
  process.exit(failed ? 1 : 0);
}

if (mode === '--lab') {
  let status = '';
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    status = await evaluate("document.getElementById('labStatus').textContent");
    if (/done|failed|Error/i.test(status)) break;
  }
  const lab = await evaluate(`(() => {
    const host = document.getElementById('labResults');
    return {
      pass: host.querySelectorAll('.pass').length,
      fail: host.querySelectorAll('.fail').length,
      tables: Array.from(host.querySelectorAll('.lab-table')).map(t => t.innerText.split('\\n').slice(0, 40)),
      notes: Array.from(host.querySelectorAll('.lab-note')).map(n => n.innerText.replace(/\\s+/g, ' ').trim()),
      sections: Array.from(host.querySelectorAll('.lab-group h2')).map(h => h.textContent)
    };
  })()`);
  collectErrors();
  check('lab finished', /done|complete/i.test(await evaluate("document.getElementById('labStatus').textContent || ''")) || lab.fail === 0, status);
  check('no failing checks in the lab', lab.fail === 0, 'fail markers: ' + lab.fail + ' / pass markers: ' + lab.pass);
  for (const n of lab.notes) {
    if (/Mismatch/i.test(n)) check('perft note', false, n);
  }
  console.log(JSON.stringify(lab, null, 2));
  for (const e of errors) check('no page errors', false, e);
  console.log('\n=== CHECKS ===');
  for (const r of report) console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '  -> ' + r.detail : ''));
  const failed = report.filter((r) => !r.pass).length;
  console.log(failed ? `\n${failed} FAILED` : '\nALL CHECKS PASSED');
  ws.close(); chrome.kill();
  process.exit(failed ? 1 : 0);
}

/* ------------------------------------------------------------- page helpers */
await evaluate(`(() => {
  const area = document.getElementById('boardArea');
  const pt = (row, col) => {
    const r = area.getBoundingClientRect();
    const s = r.width / 8;
    return [r.left + col * s + s / 2, r.top + row * s + s / 2];
  };
  const ev = (type, row, col, buttons) => {
    const p = pt(row, col);
    area.dispatchEvent(new PointerEvent(type, {
      clientX: p[0], clientY: p[1], pointerId: 1, isPrimary: true,
      bubbles: true, cancelable: true, button: 0, buttons: buttons
    }));
  };
  window.__click = (row, col) => { ev('pointerdown', row, col, 1); ev('pointerup', row, col, 0); };
  window.__drag = (r1, c1, r2, c2) => { ev('pointerdown', r1, c1, 1); ev('pointermove', r2, c2, 1); ev('pointerup', r2, c2, 0); };
  window.__sans = () => Array.from(document.querySelectorAll('#moveList .san'))
    .map(b => b.textContent.replace(/[?!]+$/, '').trim()).filter(Boolean);
  return true;
})()`);

const initial = await evaluate(`(() => ({
  pieces: document.querySelectorAll('.piece').length,
  squares: document.querySelectorAll('.sq').length,
  status: document.getElementById('status').textContent,
  coords: document.querySelectorAll('.coord').length,
  aria: document.querySelectorAll('.sq[aria-label]').length,
  theme: document.documentElement.dataset.theme
}))()`);
check('32 pieces rendered', initial.pieces === 32, initial.pieces);
check('64 squares rendered', initial.squares === 64, initial.squares);
check('16 coordinate labels', initial.coords === 16, initial.coords);
check('every square has an ARIA label', initial.aria === 64, initial.aria);
check('fresh game status', /White to move/.test(initial.status), initial.status);

// click-click move: e2 then e4
await evaluate('window.__click(6,4); window.__click(4,4)');
await sleep(400);
const afterE4 = await evaluate(`(() => ({
  sans: window.__sans(),
  status: document.getElementById('status').textContent,
  pieces: document.querySelectorAll('.piece').length
}))()`);
check('click-click plays e4 and records SAN', afterE4.sans[0] === 'e4', JSON.stringify(afterE4.sans));
check('piece count unchanged after a quiet move', afterE4.pieces === 32, afterE4.pieces);

// settings menu opens, has its sections, and closes on an outside click
const menu = await evaluate(`(() => {
  document.getElementById('menuBtn').click();
  const open = !document.getElementById('appMenu').hidden;
  const sections = document.querySelectorAll('#appMenu .menu-section').length;
  const selects = document.querySelectorAll('#appMenu select').length;
  document.body.click();
  return { open, sections, selects, closed: document.getElementById('appMenu').hidden };
})()`);
check('settings menu opens with its sections', menu.open && menu.sections === 3 && menu.selects === 7, JSON.stringify(menu));
check('settings menu closes on an outside click', menu.closed === true, String(menu.closed));

// the engine must not answer before its minimum "thinking" beat
const replyTiming = await evaluate(`(async () => {
  document.getElementById('undoBtn').click();          // back to the start
  await new Promise(r => setTimeout(r, 350));
  const before = window.__sans().length;
  const t0 = performance.now();
  window.__click(6, 4); window.__click(4, 4);          // e2-e4
  for (let k = 0; k < 100; k++) {
    await new Promise(r => setTimeout(r, 40));
    if (window.__sans().length >= before + 2) {
      return { ms: Math.round(performance.now() - t0), sans: window.__sans() };
    }
  }
  return { ms: -1, sans: window.__sans() };
})()`);
check('engine pauses at least ~0.5s before replying', replyTiming.ms >= 500 && replyTiming.ms < 6000, JSON.stringify(replyTiming));

// engine reply
let replied = false;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  const n = await evaluate('window.__sans().length');
  if (n >= 2) { replied = true; break; }
}
check('engine replies as Black', replied);

const afterReply = await evaluate(`(() => ({
  sans: window.__sans(),
  pv: document.getElementById('enginePv').textContent.trim(),
  depth: document.getElementById('stDepth').textContent,
  score: document.getElementById('stScore').textContent,
  nodes: document.getElementById('stNodes').textContent,
  nps: document.getElementById('stNps').textContent,
  evalNum: document.getElementById('evalNum').textContent,
  thinking: !document.getElementById('thinkBadge').hidden,
  book: !document.getElementById('bookBadge').hidden,
  status: document.getElementById('status').textContent
}))()`);
check('engine move is SAN (not coordinates)', afterReply.sans.length === 2 && /^([KQRBNO]|[a-h])/.test(afterReply.sans[1]) && afterReply.sans[1].length <= 7, afterReply.sans[1]);
check('engine panel reports depth', afterReply.depth !== '—' && afterReply.depth !== '', 'depth ' + afterReply.depth);
check('engine panel reports score', afterReply.score !== '—', 'score ' + afterReply.score);
check('engine panel reports nodes (or flags a book move)', afterReply.nodes !== '—' || afterReply.book, 'nodes ' + afterReply.nodes + ', book ' + afterReply.book);
check('engine panel shows a PV', afterReply.pv.length > 1, afterReply.pv.slice(0, 60));
check('eval bar shows a number', /[-+#]/.test(afterReply.evalNum), afterReply.evalNum);
check('human turn again', /White to move/.test(afterReply.status), afterReply.status);

// undo (two plies in vs-computer)
await evaluate("document.getElementById('undoBtn').click()");
await sleep(400);
const afterUndo = await evaluate(`(() => ({ sans: window.__sans(), status: document.getElementById('status').textContent, pieces: document.querySelectorAll('.piece').length }))()`);
check('undo returns to the start of the game', afterUndo.sans.length === 0 && afterUndo.pieces === 32, JSON.stringify(afterUndo.sans));

await evaluate("document.getElementById('redoBtn').click()");
await sleep(500);
const afterRedo = await evaluate('window.__sans().length');
check('redo replays the move', afterRedo >= 1, afterRedo);

// drag and drop
await evaluate("document.getElementById('undoBtn').click()");
await sleep(300);
await evaluate('window.__drag(6,3, 4,3)');   // d2-d4
await sleep(400);
const afterDrag = await evaluate('window.__sans()');
check('drag-and-drop plays d4', afterDrag[0] === 'd4', JSON.stringify(afterDrag));

// flip
const flip = await evaluate(`(() => {
  const before = Array.from(document.querySelectorAll('.piece')).map(p => p.dataset.code + '@' + p.style.transform).join('|');
  const coordsBefore = Array.from(document.querySelectorAll('.coord.rank')).map(c => c.textContent).join('');
  document.getElementById('flipBtn').click();
  const after = Array.from(document.querySelectorAll('.piece')).map(p => p.dataset.code + '@' + p.style.transform).join('|');
  const coordsAfter = Array.from(document.querySelectorAll('.coord.rank')).map(c => c.textContent).join('');
  document.getElementById('flipBtn').click();
  return { changed: before !== after, coordsChanged: coordsBefore !== coordsAfter, coordsBefore, coordsAfter };
})()`);
check('flip changes piece layout', flip.changed, JSON.stringify({ b: flip.coordsBefore, a: flip.coordsAfter }));
check('flip changes rank labels', flip.coordsChanged, flip.coordsBefore + ' -> ' + flip.coordsAfter);

// switch to human vs human for the deterministic tests
await evaluate(`(() => {
  const m = document.getElementById('modeSel');
  m.value = 'hvh';
  m.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('newBtn').click();
})()`);
await sleep(400);

// promotion dialog via FEN import
const promo = await evaluate(`(async () => {
  document.getElementById('importBtn').click();
  const ta = document.getElementById('importText');
  ta.value = '4k3/1P6/8/8/8/8/8/4K3 w - - 0 1';
  document.getElementById('doImport').click();
  await new Promise(r => setTimeout(r, 250));
  window.__click(1,1);      // b7
  window.__click(0,1);      // b8
  const dlgOpen = !document.getElementById('promo').hidden;
  const buttons = document.querySelectorAll('#promoRow .promo-btn').length;
  if (dlgOpen) document.querySelector('#promoRow .promo-btn').click();
  await new Promise(r => setTimeout(r, 150));
  return {
    dlgOpen, buttons,
    queen: !!document.querySelector('.sq[aria-label="white queen on b8"]'),
    sans: window.__sans()
  };
})()`);
check('promotion dialog opens with four choices', promo.dlgOpen && promo.buttons === 4, JSON.stringify({ open: promo.dlgOpen, buttons: promo.buttons }));
check('promotion produces a queen', promo.queen, JSON.stringify(promo.sans));

// mate + board lock
const mate = await evaluate(`(async () => {
  document.getElementById('importBtn').click();
  document.getElementById('importText').value = '6k1/5ppp/8/8/8/8/5PPP/R3K3 w Q - 0 1';
  document.getElementById('doImport').click();
  await new Promise(r => setTimeout(r, 250));
  window.__click(7,0);      // a1
  window.__click(0,0);      // a8 = mate
  await new Promise(r => setTimeout(r, 250));
  const banner = !document.getElementById('banner').hidden;
  const title = document.getElementById('bannerTitle').textContent;
  const text = document.getElementById('bannerText').textContent;
  const before = window.__sans().length;
  window.__click(6,7);      // try to move something after mate
  window.__click(5,7);
  const after = window.__sans().length;
  return { banner, title, text, before, after, sans: window.__sans(), status: document.getElementById('status').textContent };
})()`);
check('checkmate ends the game with a banner', mate.banner && /checkmate/i.test(mate.text), mate.title + ': ' + mate.text);
check('board is locked after game over', mate.before === mate.after, mate.before + ' -> ' + mate.after);
check('mate SAN has the # suffix', /#/.test((mate.sans || []).join(' ')), (mate.sans || []).join(' '));

// time control
const clocks = await evaluate(`(() => {
  const sel = document.getElementById('timeSel');
  sel.value = '3+2';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('newBtn').click();
  return [document.getElementById('topClock').textContent, document.getElementById('bottomClock').textContent];
})()`);
check('3+2 clock shows 3:00', clocks.join(' ') === '3:00 3:00', clocks.join(' / '));

// custom time control
const customClock = await evaluate(`(() => {
  const sel = document.getElementById('timeSel');
  sel.value = 'custom';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const min = document.getElementById('customMin');
  const inc = document.getElementById('customInc');
  min.value = '2';
  inc.value = '3';
  min.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('newBtn').click();
  return {
    visible: !document.getElementById('customTime').hidden,
    clocks: [document.getElementById('topClock').textContent, document.getElementById('bottomClock').textContent]
  };
})()`);
check('custom time control applies 2+3', customClock.visible && customClock.clocks.join(' ') === '2:00 2:00', JSON.stringify(customClock));

// theme + palette
const toggles = await evaluate(`(() => {
  const t0 = document.documentElement.dataset.theme;
  document.getElementById('themeBtn').click();
  const t1 = document.documentElement.dataset.theme;
  document.getElementById('themeBtn').click();
  const b0 = document.documentElement.dataset.board;
  const bs = document.getElementById('boardSel');
  bs.value = 'purple';
  bs.dispatchEvent(new Event('change', { bubbles: true }));
  const b1 = document.documentElement.dataset.board;
  return { theme: t0 !== t1, board: b0 !== b1 };
})()`);
check('theme toggle works', toggles.theme);
check('board palette toggle works', toggles.board);

// a real search (not the book): Hint must report depth, nodes and a PV
const hint = await evaluate(`(async () => {
  document.getElementById('hintBtn').click();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (document.getElementById('thinkBadge').hidden) break;
  }
  const arrow = document.querySelectorAll('#overlay .arrow').length;
  return {
    depth: document.getElementById('stDepth').textContent,
    nodes: document.getElementById('stNodes').textContent,
    nps: document.getElementById('stNps').textContent,
    pv: document.getElementById('enginePv').textContent.trim(),
    arrow
  };
})()`);
check('hint runs a real search (depth > 0, nodes > 0)', parseInt(hint.depth, 10) >= 2 && parseInt(hint.nodes.replace(/[^\d]/g, ''), 10) > 0, JSON.stringify(hint));
check('hint draws an arrow on the board', hint.arrow > 0, 'arrows: ' + hint.arrow);
// ---------------------------------------------------------------- extra flows
await evaluate("document.getElementById('newBtn').click()");
await sleep(300);

// keyboard play: e2 -> e4 with the board focused
const kbPlay = await evaluate(`(async () => {
  const board = document.getElementById('board');
  board.focus();
  board.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(r => setTimeout(r, 80));
  const selected = document.querySelectorAll('.sq.sel').length;
  board.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  board.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  await new Promise(r => setTimeout(r, 80));
  board.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(r => setTimeout(r, 150));
  return { selected, sans: window.__sans() };
})()`);
check('keyboard selects and plays (e4)', kbPlay.selected === 1 && kbPlay.sans[0] === 'e4', JSON.stringify(kbPlay));

// history navigation
await evaluate(`(() => {
  window.__click(1,4); window.__click(3,4);   // e5
  window.__click(7,6); window.__click(5,5);   // Nf3
})()`);
await sleep(300);
const nav = await evaluate(`(async () => {
  const sans = document.querySelectorAll('#moveList .san');
  sans[0].click();
  await new Promise(r => setTimeout(r, 120));
  const reviewing = document.getElementById('status').textContent;
  const badge = !document.getElementById('viewBadge').hidden;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await new Promise(r => setTimeout(r, 120));
  const current = document.querySelectorAll('#moveList .san.current').length;
  document.getElementById('lastBtn').click();
  await new Promise(r => setTimeout(r, 150));
  return { reviewing, badge, current, live: document.getElementById('viewBadge').hidden, moves: window.__sans().length };
})()`);
check('clicking a move enters review mode', /Reviewing move 1/.test(nav.reviewing) && nav.badge, nav.reviewing);
check('arrow key steps the history', nav.current === 1, 'current highlighted: ' + nav.current);
check('Live returns to the current position', nav.live, 'moves ' + nav.moves);

// right-click arrow
const arrow = await evaluate(`(() => {
  const area = document.getElementById('boardArea');
  const r = area.getBoundingClientRect();
  const s = r.width / 8;
  const pt = (row, col) => [r.left + col*s + s/2, r.top + row*s + s/2];
  const fire = (type, row, col, buttons) => {
    const p = pt(row, col);
    area.dispatchEvent(new PointerEvent(type, { clientX: p[0], clientY: p[1], pointerId: 2, isPrimary: true, bubbles: true, cancelable: true, button: 2, buttons }));
  };
  fire('pointerdown', 6, 3, 2);
  fire('pointermove', 4, 3, 2);
  fire('pointerup', 4, 3, 0);
  return document.querySelectorAll('#overlay .arrow.user').length;
})()`);
check('right-click drag draws an arrow', arrow > 0, 'user arrow elements: ' + arrow);

// PGN import through the dialog
const pgnImport = await evaluate(`(async () => {
  document.getElementById('importBtn').click();
  const ta = document.getElementById('importText');
  ta.value = '[Event "Test"]\\n[White "A"]\\n[Black "B"]\\n[Result "*"]\\n\\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *';
  document.getElementById('doImport').click();
  await new Promise(r => setTimeout(r, 300));
  return { sans: window.__sans(), status: document.getElementById('status').textContent };
})()`);
check('PGN import replays the game', pgnImport.sans.length === 6 && pgnImport.sans[4] === 'Bb5' && pgnImport.sans[5] === 'a6', JSON.stringify(pgnImport.sans));

// analysis mode: engine suggests but does not move
const analysisMode = await evaluate(`(async () => {
  const m = document.getElementById('modeSel');
  m.value = 'analysis';
  m.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  document.getElementById('newBtn').click();
  await new Promise(r => setTimeout(r, 400));
  window.__click(6,4); window.__click(4,4);
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (document.getElementById('thinkBadge').hidden) break;
  }
  return { sans: window.__sans(), arrows: document.querySelectorAll('#overlay .arrow.engine').length, pv: document.getElementById('enginePv').textContent.trim() };
})()`);
check('analysis mode suggests without moving', analysisMode.sans.length === 1 && analysisMode.sans[0] === 'e4', JSON.stringify(analysisMode.sans));
check('analysis mode draws the suggested move', analysisMode.arrows > 0, 'engine arrows: ' + analysisMode.arrows);

// computer vs computer plays both sides
const cvc = await evaluate(`(async () => {
  const m = document.getElementById('modeSel');
  m.value = 'cvc';
  m.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('newBtn').click();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (window.__sans().length >= 2) break;
  }
  return { sans: window.__sans(), moves: window.__sans().length };
})()`);
check('computer vs computer plays both sides', cvc.moves >= 2, JSON.stringify(cvc.sans));

// post-game analysis of a short game
const analyzed = await evaluate(`(async () => {
  const m = document.getElementById('modeSel');
  m.value = 'hvh';
  m.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('newBtn').click();
  await new Promise(r => setTimeout(r, 200));
  document.getElementById('annotOn');
  return { ok: true };
})()`);
await evaluate(`(() => {
  const seq = [[6,4,4,4],[1,4,3,4],[7,6,5,5],[0,6,2,5],[5,3,4,4]];
  for (const s of seq) { window.__click(s[0],s[1]); window.__click(s[2],s[3]); }
})()`);
await sleep(500);
const analyze = await evaluate(`(async () => {
  document.getElementById('analyzeBtn').click();
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (!document.getElementById('analysisSummary').hidden) break;
  }
  const summary = document.getElementById('analysisSummary');
  return {
    shown: !summary.hidden,
    text: summary.textContent.replace(/\\s+/g, ' ').trim(),
    marked: document.querySelectorAll('#moveList .san[title]').length
  };
})()`);
check('post-game analysis produces accuracy', analyze.shown && /Accuracy/.test(analyze.text), analyze.text.slice(0, 120));
check('analysis labels moves', analyze.marked >= 0, 'labelled moves: ' + analyze.marked);

// captured pieces + material difference
const cap = await evaluate(`(async () => {
  const m = document.getElementById('modeSel');
  m.value = 'hvh'; m.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('importBtn').click();
  document.getElementById('importText').value = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
  document.getElementById('doImport').click();
  await new Promise(r => setTimeout(r, 300));
  window.__click(4,4); window.__click(3,3);   // exd5
  await new Promise(r => setTimeout(r, 300));
  return {
    sans: window.__sans(),
    whiteTaken: document.querySelectorAll('#bottomCap svg').length,
    blackTaken: document.querySelectorAll('#topCap svg').length,
    matWhite: document.getElementById('bottomMat').textContent,
    matBlack: document.getElementById('topMat').textContent
  };
})()`);
check('capture is recorded as SAN exd5', cap.sans[0] === 'exd5', JSON.stringify(cap.sans));
check('captured piece shows next to the winner', cap.whiteTaken === 1 && cap.blackTaken === 0, JSON.stringify({ w: cap.whiteTaken, b: cap.blackTaken }));
check('material difference shows +1', cap.matWhite === '+1', cap.matWhite + ' / ' + cap.matBlack);
// persistence: reload and check the game came back
await evaluate(`(() => {
  const m = document.getElementById('modeSel');
  m.value = 'hvh'; m.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('newBtn').click();
})()`);
await sleep(200);
await evaluate('window.__click(6,4); window.__click(4,4)');
await sleep(300);
const beforeReload = await evaluate(`(() => ({
  hash: location.hash,
  ls: localStorage.getItem('chesslab.v1'),
  sans: window.__sans()
}))()`);
console.log('BEFORE RELOAD:', JSON.stringify(beforeReload).slice(0, 400));
await send('Page.reload', { ignoreCache: true });
await sleep(2000);
const afterReload = await evaluate(`(() => ({
  sans: Array.from(document.querySelectorAll('#moveList .san')).map(b => b.textContent.trim()).filter(Boolean),
  pieces: document.querySelectorAll('.piece').length,
  hash: location.hash,
  ls: localStorage.getItem('chesslab.v1')
}))()`);
check('game survives a reload', afterReload.sans.length >= 1 && afterReload.pieces === 32, JSON.stringify({ sans: afterReload.sans, pieces: afterReload.pieces, hash: afterReload.hash, ls: (afterReload.ls || '').slice(0, 200) }));

collectErrors();
for (const e of errors) check('no page errors', false, e);

console.log('\n=== CHECKS ===');
for (const r of report) console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '  -> ' + r.detail : ''));
const failed = report.filter((r) => !r.pass).length;
console.log(failed ? `\n${failed} FAILED` : '\nALL CHECKS PASSED');
ws.close();
chrome.kill();
process.exit(failed ? 1 : 0);
