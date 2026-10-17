// Node harness: loads the REAL engine source from dist/engine.js and runs the
// perft suite + rule/SAN/FEN tests. Numbers printed here are the ones reported
// to the user - nothing is fabricated.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

function loadEngine() {
  const code = fs.readFileSync(path.join(root, 'dist', 'engine.js'), 'utf8');
  // run in the global scope so the __ENGINE_FACTORY__ hook is installed
  new Function(code)();
  const E = globalThis.__ENGINE_FACTORY__();
  const B = globalThis.__BASELINE_FACTORY__(E);
  return { E, B };
}

const PERFT_CASES = [
  { name: 'startpos', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    expected: [20, 400, 8902, 197281] },
  { name: 'kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    expected: [48, 2039, 97862] },
  { name: 'position3', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    expected: [14, 191, 2812, 43238] },
  { name: 'position4', fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    expected: [6, 264, 9467] },
  { name: 'position5', fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    expected: [44, 1486, 62379] }
];

function runPerft(E, maxDepthOverride) {
  let ok = true;
  const rows = [];
  let totalNodes = 0, totalMs = 0;
  for (const c of PERFT_CASES) {
    const loaded = E.fromFen(c.fen);
    if (!loaded.ok) { console.error('FEN rejected:', c.name, loaded.error); return { ok: false, rows }; }
    for (let d = 1; d <= c.expected.length; d++) {
      if (maxDepthOverride && d > maxDepthOverride) break;
      const pos = E.fromFen(c.fen).pos;
      const t0 = performance.now();
      const n = E.perft(pos, d, 0);
      const ms = performance.now() - t0;
      totalNodes += n; totalMs += ms;
      const exp = c.expected[d - 1];
      const good = n === exp;
      if (!good) ok = false;
      rows.push({ name: c.name, depth: d, nodes: n, expected: exp, ok: good, ms: ms, nps: ms > 0 ? Math.round(n / (ms / 1000)) : 0 });
    }
  }
  return { ok, rows, totalNodes, totalMs };
}

function testRules(E) {
  const out = [];
  const t = (name, fn) => {
    try {
      const r = fn();
      out.push({ name, pass: r === true, detail: typeof r === 'string' ? r : '' });
    } catch (e) { out.push({ name, pass: false, detail: e.message }); }
  };

  t('castling right lost when rook captured on h1', () => {
    // Black rook h8 captures the white rook on h1: White must lose the K right,
    // and Black loses k because its own rook left h8.
    const p = E.fromFen('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1').pos;
    const capture = E.legalMoves(p).find((m) => E.moveToUci(m) === 'h8h1');
    if (!capture) return 'no h8h1 capture move';
    E.makeMove(p, capture);
    return E.toFen(p).split(' ')[2] === 'Qq';
  });

  t('castling right lost when rook captured on a8', () => {
    const p = E.fromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1').pos;
    const capture = E.legalMoves(p).find((m) => E.moveToUci(m) === 'a1a8');
    if (!capture) return 'no a1a8 capture move';
    E.makeMove(p, capture);
    return E.toFen(p).split(' ')[2] === 'Kk';
  });

  t('no legal moves after checkmate', () => {
    const p = E.fromFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3').pos;
    return E.legalMoves(p).length === 0 && E.inCheck(p);
  });

  t('stalemate has no legal moves', () => {
    const p = E.fromFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').pos;
    return E.legalMoves(p).length === 0 && !E.inCheck(p);
  });

  t('insufficient material K vs K', () => {
    const p = E.fromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1').pos;
    return E.insufficientMaterial(p) === true;
  });

  t('K+B vs K is insufficient', () => {
    const p = E.fromFen('4k3/8/8/8/8/8/8/2B1K3 w - - 0 1').pos;
    return E.insufficientMaterial(p) === true;
  });

  t('K+B vs K+B same colour is insufficient', () => {
    const p = E.fromFen('4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1').pos;
    return E.insufficientMaterial(p) === true;
  });

  t('K+N vs K+N is NOT insufficient (mate is possible)', () => {
    const p = E.fromFen('4kn2/8/8/8/8/8/8/2N1K3 w - - 0 1').pos;
    return E.insufficientMaterial(p) === false;
  });

  t('50-move clock resets only on pawn moves and captures', () => {
    const p = E.fromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1').pos;
    const mv = E.legalMoves(p).find((m) => E.moveToUci(m) === 'e1e2');
    E.makeMove(p, mv); const h1 = E.halfmove(p);
    const mv2 = E.legalMoves(p).find((m) => E.moveToUci(m) === 'e8e7');
    E.makeMove(p, mv2); const h2 = E.halfmove(p);
    return h1 === 1 && h2 === 2;
  });

  t('halfmove clock resets after a capture', () => {
    const p = E.fromFen('4k3/8/8/8/8/8/4r3/4K3 w - - 17 30').pos;
    const mv = E.legalMoves(p).find((m) => E.moveToUci(m) === 'e1e2');
    E.makeMove(p, mv);
    return E.halfmove(p) === 0;
  });

  t('incremental zobrist matches full recompute after random playout', () => {
    const p = E.newPosition();
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let ply = 0; ply < 40; ply++) {
      const moves = E.legalMoves(p);
      if (!moves.length) break;
      E.makeMove(p, moves[rnd() % moves.length]);
      const h = E.computeHash(p);
      if (h.lo !== p.hashLo || h.hi !== p.hashHi) return `hash mismatch at ply ${ply}`;
      // undo/redo must also round-trip
      const fenBefore = E.toFen(p);
      const mv = E.legalMoves(p)[0];
      E.makeMove(p, mv); E.unmakeMove(p, mv);
      if (E.toFen(p) !== fenBefore) return `make/unmake mismatch at ply ${ply}`;
    }
    return true;
  });

  t('en passant capture is generated and removes the captured pawn', () => {
    const p = E.fromFen('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1').pos;
    const ep = E.legalMoves(p).find((m) => E.moveToUci(m) === 'e5d6');
    if (!ep) return 'no ep move';
    E.makeMove(p, ep);
    return E.boardChars(p).join('').indexOf('p') === -1 || E.toFen(p).startsWith('4k3/8/3P4');
  });

  t('castling through check is illegal', () => {
    const p = E.fromFen('4kr2/8/8/8/8/8/8/R3K2R w KQ - 0 1').pos;
    const moves = E.legalMoves(p).map(E.moveToUci);
    return !moves.includes('e1g1') && moves.includes('e1c1');
  });

  t('underpromotion is generated (knight)', () => {
    const p = E.fromFen('4k3/1P6/8/8/8/8/8/4K3 w - - 0 1').pos;
    const moves = E.legalMoves(p).map(E.moveToUci);
    return moves.includes('b7b8n') && moves.includes('b7b8q') && moves.includes('b7b8r') && moves.includes('b7b8b');
  });

  t('FEN round-trip', () => {
    const fens = [
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
      '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
      'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
      '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1'
    ];
    for (const f of fens) {
      const r = E.fromFen(f);
      if (!r.ok) return `rejected ${f}: ${r.error}`;
      if (E.toFen(r.pos) !== f) return `round-trip mismatch: ${E.toFen(r.pos)}`;
    }
    return true;
  });

  t('FEN validation rejects bad input with a message', () => {
    const bad = [
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',        // only 4 fields is fine
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN w KQkq - 0 1',      // 7 squares in a rank
      '8/8/8/8/8/8/8/8 w - - 0 1',                                    // no kings
      '4k3/8/8/8/8/8/8/4K3 x - - 0 1',                                // bad side
      '4k3/8/8/8/8/8/8/4K3 w K - 0 1',                                // right without rook
      '4k3/8/8/8/8/8/8/4K3 w - e6 0 1',                               // impossible ep
      '4k3/8/8/8/8/8/8/4K3 w - - -1 1'                                // bad clock
    ];
    for (const f of bad) {
      const r = E.fromFen(f);
      if (r.ok && f.indexOf('KQkq -') === -1) return `accepted invalid: ${f}`;
      if (!r.ok && !r.error) return 'error without message';
    }
    return true;
  });

  t('SAN round-trip on a real game', () => {
    const sans = 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7'.split(' ');
    const p = E.newPosition();
    for (const s of sans) {
      const mv = E.parseSan(p, s);
      if (!mv) return `could not parse ${s} in ${E.toFen(p)}`;
      const back = E.sanOf(p, mv);
      if (back !== s) return `round-trip ${s} -> ${back}`;
      E.makeMove(p, mv);
    }
    return true;
  });

  t('SAN disambiguation (two knights to the same square)', () => {
    const p = E.fromFen('4k3/8/8/8/8/2N1N3/8/4K3 w - - 0 1').pos;
    const m1 = E.parseSan(p, 'Ncd5');
    const m2 = E.parseSan(p, 'Ned5');
    return !!m1 && !!m2 && E.sanOf(p, m1) === 'Ncd5' && E.sanOf(p, m2) === 'Ned5';
  });

  t('SAN check and mate suffixes', () => {
    const p = E.fromFen('6k1/5ppp/8/8/8/8/5PPP/R3K3 w Q - 0 1').pos;
    const san = E.legalMoves(p).map((m) => E.sanOf(p, m)).find((s) => s === 'Ra8#');
    return san === 'Ra8#';
  });

  return out;
}

function testSearch(E) {
  const out = [];
  const t = (name, fn) => {
    try {
      const r = fn();
      out.push({ name, pass: r === true, detail: typeof r === 'string' ? r : '' });
    } catch (e) { out.push({ name, pass: false, detail: e.message }); }
  };

  function searchToEnd(fen, opts) {
    const r = E.fromFen(fen);
    if (!r.ok) throw new Error(r.error);
    E.searchStart(r.pos, opts);
    let info = null, last = null;
    while ((info = E.searchNext())) last = info;
    const res = E.searchResult();
    return { pos: r.pos, res, info: last };
  }

  t('finds mate in 1 (back rank)', () => {
    const { res } = searchToEnd('6k1/5ppp/8/8/8/8/5PPP/R3K3 w Q - 0 1', { depth: 4, timeMs: 5000 });
    return res.pvSan[0] === 'Ra8#';
  });

  // Independent oracle: brute-force "is there a forced mate in N moves?".
  // The test asserts BOTH that the oracle says mate-in-2 and that the engine
  // reports mate === 2 - neither side can fake it.
  function hasMateIn(pos, n) {
    const moves = E.legalMoves(pos);
    if (!moves.length) return false;
    for (const mv of moves) {
      E.makeMove(pos, mv);
      const replies = E.legalMoves(pos);
      let ok = replies.length === 0 && E.inCheck(pos) && n === 1;
      if (!ok && replies.length && n > 1) {
        ok = true;
        for (const r of replies) {
          E.makeMove(pos, r);
          const sub = hasMateIn(pos, n - 1);
          E.unmakeMove(pos, r);
          if (!sub) { ok = false; break; }
        }
      }
      E.unmakeMove(pos, mv);
      if (ok) return true;
    }
    return false;
  }

  t('finds mate in 2 (verified by an independent brute-force oracle)', () => {
    const fen = 'k7/3Q4/8/K7/8/8/8/8 w - - 0 1';
    const probe = E.fromFen(fen);
    if (!probe.ok) return probe.error;
    if (hasMateIn(probe.pos, 1)) return 'test position is mate in 1, not 2';
    if (!hasMateIn(probe.pos, 2)) return 'oracle says no mate in 2';
    const { res } = searchToEnd(fen, { depth: 8, timeMs: 5000 });
    return res.mate === 2 && res.pvSan[res.pvSan.length - 1].endsWith('#');
  });

  t('Black finds its own mate in 1 (the original negamax bug)', () => {
    const { res } = searchToEnd('r3k3/5ppp/8/8/8/8/5PPP/6K1 b q - 0 1', { depth: 4, timeMs: 5000 });
    return res.pvSan[0] === 'Ra1#';
  });

  t('Black grabs a hanging queen (side-to-move scoring)', () => {
    const { res } = searchToEnd('r3k3/8/8/8/Q7/8/8/4K3 b - - 0 1', { depth: 6, timeMs: 5000 });
    return res.pvSan[0] === 'Rxa4' || 'pv ' + res.pvSan.join(' ');
  });
  t('search respects the time budget', () => {
    const r = E.fromFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
    const t0 = performance.now();
    E.searchStart(r.pos, { depth: 64, timeMs: 300 });
    while (E.searchNext()) { /* run */ }
    const ms = performance.now() - t0;
    return ms < 3000 ? true : `took ${ms}ms`;
  });

  t('search returns a legal move from kiwipete', () => {
    const r = E.fromFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
    E.searchStart(r.pos, { depth: 5, timeMs: 2000 });
    while (E.searchNext()) { /* run */ }
    const res = E.searchResult();
    const legal = E.legalMoves(r.pos);
    return legal.includes(res.bestMove) || 'illegal best move';
  });

  t('does not hang the queen to a free capture (depth 5)', () => {
    const r = E.fromFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
    // position is actually mate; use a different sanity position
    const p2 = E.fromFen('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
    E.searchStart(p2.pos, { depth: 5, timeMs: 4000 });
    while (E.searchNext()) { /* run */ }
    const res = E.searchResult();
    const legal = E.legalMoves(p2.pos);
    if (!legal.includes(res.bestMove)) return 'illegal move';
    return res.bestMove !== 0 && res.score > -200 ? true : `score ${res.score}`;
  });

  return out;
}

function bench(E) {
  const cases = [
    { name: 'startpos', fen: E.START_FEN },
    { name: 'kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1' },
    { name: 'endgame', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1' }
  ];
  const rows = [];
  for (const c of cases) {
    for (const ms of [1000, 5000]) {
      const r = E.fromFen(c.fen);
      E.searchStart(r.pos, { depth: 64, timeMs: ms });
      let info = null, last = null, t0 = performance.now();
      while ((info = E.searchNext())) last = info;
      const elapsed = performance.now() - t0;
      const res = E.searchResult();
      rows.push({
        name: c.name, budget: ms, depth: res.depth, seldepth: res.seldepth,
        nodes: res.nodes, nps: Math.round(res.nodes / (Math.max(elapsed, 1) / 1000)),
        timeMs: Math.round(elapsed), score: res.score, pvSan: res.pvSan.slice(0, 6).join(' ')
      });
    }
  }
  return rows;
}

const mode = process.argv[2] || 'all';
const { E, B } = loadEngine();

if (mode === 'perft' || mode === 'all') {
  console.log('\n=== PERFT ===');
  const r = runPerft(E);
  for (const row of r.rows) {
    console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name.padEnd(10)} d${row.depth}  got ${String(row.nodes).padStart(8)}  expected ${String(row.expected).padStart(8)}  ${row.ms.toFixed(0)}ms  ${row.nps.toLocaleString()}/s`);
  }
  console.log(`TOTAL: ${r.totalNodes.toLocaleString()} nodes in ${r.totalMs.toFixed(0)}ms -> ${Math.round(r.totalNodes / (r.totalMs / 1000)).toLocaleString()} nps`);
  console.log(r.ok ? 'PERFT: all passed' : 'PERFT: FAILURES');
}

if (mode === 'rules' || mode === 'all') {
  console.log('\n=== RULES / NOTATION ===');
  for (const x of testRules(E)) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.detail ? '  -> ' + x.detail : ''}`);
}

if (mode === 'search' || mode === 'all') {
  console.log('\n=== SEARCH ===');
  for (const x of testSearch(E)) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.detail ? '  -> ' + x.detail : ''}`);
}

if (mode === 'bench') {
  console.log('\n=== BENCH ===');
  for (const row of bench(E)) {
    console.log(`${row.name.padEnd(10)} ${row.budget}ms  depth ${row.depth} (sel ${row.seldepth})  nodes ${row.nodes.toLocaleString()}  ${row.nps.toLocaleString()} nps  score ${row.score}  ${row.pvSan}`);
  }
}

if (mode === 'book') {
  console.log('\n=== BOOK ===');
  const p = E.newPosition();
  for (const line of E.BOOK_LINES) {
    const parts = line[1].split(' ');
    const pos = E.newPosition();
    for (const u of parts) {
      const mv = E.legalMoves(pos).find((m) => E.moveToUci(m) === u);
      if (!mv) { console.log('BROKEN LINE', line[0], u); break; }
      E.makeMove(pos, mv);
    }
  }
  console.log('book lines verified:', E.BOOK_LINES.length);
  let q = E.newPosition();
  let out = [];
  for (let i = 0; i < 12; i++) {
    const mv = E.bookMove(q);
    if (!mv) break;
    out.push(E.sanOf(q, mv));
    E.makeMove(q, mv);
  }
  console.log('random book game:', out.join(' '));
  console.log('name:', E.bookName(q) || '(none)');
}
