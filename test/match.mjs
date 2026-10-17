// Self-play strength check: new engine vs the original algorithm's baseline.
// 20 games, 5 opening positions, colours alternating, fixed time per move.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
new Function(fs.readFileSync(path.join(root, 'dist', 'engine.js'), 'utf8'))();
const E = globalThis.__ENGINE_FACTORY__();
const baseline = globalThis.__BASELINE_FACTORY__(E);

const timeMs = Number(process.argv[2] || 100);
const games = Number(process.argv[3] || 20);

// Five varied opening positions taken from the book lines (legal by construction).
const starts = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
  'rnbqkb1r/pp2pppp/3p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq - 0 5',
  'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 5',
  'rnbqkb1r/ppp1pppp/5n2/3p4/3P1B2/8/PPP1PPPP/RN1QKBNR w KQkq - 2 3'
];

const t0 = Date.now();
const res = E.runMatch(baseline, { games, timeMs, positions: starts, maxPlies: 160 });
const dt = Date.now() - t0;

console.log(`\n=== MATCH: new engine vs original-algorithm baseline ===`);
console.log(`games ${res.total}  time/move ${timeMs}ms  elapsed ${(dt / 1000).toFixed(1)}s`);
console.log(`W ${res.wins}  D ${res.draws}  L ${res.losses}   score ${res.score}/${res.total} = ${res.scorePct.toFixed(1)}%`);
console.log('\nper game:');
for (let i = 0; i < res.games.length; i++) {
  const g = res.games[i];
  if (g.error) { console.log(` #${i + 1} ERROR ${g.error}`); continue; }
  console.log(` #${String(i + 1).padStart(2)} new=${g.newIsWhite ? 'white' : 'black'}  ${g.outcome.padEnd(5)} after ${g.plies} plies  start ${g.startFen.split(' ')[0]}`);
}
console.log('\nfinal positions:');
for (let i = 0; i < res.games.length; i++) console.log(` #${i + 1} ${res.games[i].finalFen || ''}`);
