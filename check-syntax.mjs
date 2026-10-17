import fs from "node:fs";
const html = fs.readFileSync("dist/index.html","utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log("NO SCRIPT"); process.exit(1); }
try { new Function(m[1]); console.log("SCRIPT SYNTAX OK", m[1].length, "bytes"); }
catch (e) { console.log("SYNTAX ERROR:", e.message); process.exit(1); }
