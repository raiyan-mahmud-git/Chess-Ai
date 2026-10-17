import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Override with CHROME_PATH on macOS/Linux, or edit the default below.
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = pathToFileURL(path.join(root, "dist", "index.html")).href;
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "look-"));
const port = 9970 + Math.floor(Math.random()*20);
if (!fs.existsSync(CHROME)) {
  console.error("Chrome not found at " + CHROME + "\nSet CHROME_PATH or edit the CHROME constant at the top of this file.");
  process.exit(1);
}
const chrome = spawn(CHROME, ["--headless=new","--disable-gpu","--no-sandbox","--no-first-run","--hide-scrollbars","--remote-debugging-port="+port,"--user-data-dir="+userDir,target], {stdio:["ignore","ignore","ignore"]});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let ws;
for (let i=0;i<100;i++){ try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p=l.find(t=>t.type==="page"); if(p){ ws=new WebSocket(p.webSocketDebuggerUrl); break; } } catch(e){} await sleep(120); }
await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
let seq=1; const pend=new Map(); const errs=[];
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);} else if(m.method==="Runtime.exceptionThrown"){ errs.push(m.params.exceptionDetails.text); }};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=seq++;pend.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
await send("Runtime.enable"); await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride",{width:1280,height:900,deviceScaleFactor:1,mobile:false});
const ev = async (expr) => { const r = await send("Runtime.evaluate",{expression:expr,awaitPromise:false,returnByValue:true,userGesture:true}); if(r.exceptionDetails) return "EXC "+JSON.stringify(r.exceptionDetails).slice(0,300); return r.result.value; };
await sleep(1200);

const results = [];
const check = (n,p,d) => results.push([n, p, d]);

// dialog close
await ev("document.getElementById('helpBtn').click()");
await sleep(200);
const opened = await ev("document.getElementById('dlgHelp').open");
await ev("document.querySelector('#dlgHelp [data-close]').click()");
await sleep(200);
const closed = await ev("document.getElementById('dlgHelp').open");
check("help Close button closes the dialog", opened === true && closed === false, opened + " -> " + closed);
// backdrop close
await ev("document.getElementById('helpBtn').click()");
await sleep(150);
await ev("(() => { const d = document.getElementById('dlgHelp'); d.dispatchEvent(new MouseEvent('click', { bubbles: true })); return d.open; })()");
await sleep(200);
const backdrop = await ev("document.getElementById('dlgHelp').open");
check("backdrop click closes the dialog", backdrop === false, String(backdrop));
// Esc still works
await ev("document.getElementById('helpBtn').click()");
await sleep(150);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(250);
check("Escape closes the dialog", (await ev("document.getElementById('dlgHelp').open")) === false);

// piece styles
for (const set of ["classic","bold","neo","glass"]) {
  await ev(`(() => { const s = document.getElementById('pieceSel'); s.value = '${set}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(250);
  const state = await ev("[document.documentElement.dataset.pieces, document.querySelectorAll('.piece').length, document.querySelector('.piece svg .b').getAttribute('class')]");
  check("piece style " + set + " applies", state[0] === set && state[1] === 32, JSON.stringify(state));
  const shot = await send("Page.captureScreenshot", { format: "png", clip: await ev("(() => { const r = document.getElementById('boardArea').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}; })()") });
  fs.writeFileSync(path.join(root, "dist", "style-" + set + ".png"), Buffer.from(shot.data, "base64"));
}

// board palettes
for (const pal of ["purple","ice","brown"]) {
  await ev(`(() => { const s = document.getElementById('boardSel'); s.value = '${pal}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(200);
  const b = await ev("[document.documentElement.dataset.board, getComputedStyle(document.querySelector('.sq.dark')).backgroundColor]");
  check("board palette " + pal, b[0] === pal, JSON.stringify(b));
}

// coordinates toggle
await ev("(() => { const c = document.getElementById('coordsOn'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()");
await sleep(200);
const coordsOff = await ev("document.querySelectorAll('.coord').length");
await ev("(() => { const c = document.getElementById('coordsOn'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()");
await sleep(200);
const coordsOn = await ev("document.querySelectorAll('.coord').length");
check("coordinates toggle", coordsOff === 0 && coordsOn === 16, coordsOff + " -> " + coordsOn);

// theme select
await ev("(() => { const s = document.getElementById('themeSel'); s.value = 'light'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
await sleep(200);
check("theme select switches to light", (await ev("document.documentElement.dataset.theme")) === "light");
const shotLight = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(root, "dist", "shot-light.png"), Buffer.from(shotLight.data, "base64"));
await ev("(() => { const s = document.getElementById('themeSel'); s.value = 'dark'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");

// persistence of the piece style
await ev("(() => { const s = document.getElementById('pieceSel'); s.value = 'glass'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
await sleep(300);
await send("Page.reload", { ignoreCache: true });
await sleep(1800);
const afterReload = await ev("[document.documentElement.dataset.pieces, document.getElementById('pieceSel').value]");
check("piece style survives a reload", afterReload[0] === "glass" && afterReload[1] === "glass", JSON.stringify(afterReload));

// final screenshot (classic, green, dark)
await ev("(() => { const s = document.getElementById('pieceSel'); s.value='classic'; s.dispatchEvent(new Event('change',{bubbles:true})); const b=document.getElementById('boardSel'); b.value='green'; b.dispatchEvent(new Event('change',{bubbles:true})); })()");
await sleep(300);
const finalShot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(path.join(root, "dist", "shot-appearance.png"), Buffer.from(finalShot.data, "base64"));

for (const [n,p,d] of results) console.log((p ? "PASS  " : "FAIL  ") + n + (d ? "  -> " + d : ""));
console.log("errors:", errs.length ? errs : "none");
const failed = results.filter(r => !r[1]).length;
console.log(failed ? failed + " FAILED" : "ALL APPEARANCE CHECKS PASSED");
ws.close(); chrome.kill(); process.exit(failed ? 1 : 0);
