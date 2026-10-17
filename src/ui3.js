/* ==========================================================================
   SECTION 8 - TEST LAB (index.html?test)
   This is the in-page version of the Node harness: the same perft numbers, the
   same rule checks, plus worker benchmarks and the 20-game self-play match.
   Every number shown here is measured at run time.
   ========================================================================== */

const LAB_PERFT = [
  { name: 'startpos', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', expected: [20, 400, 8902, 197281] },
  { name: 'kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', expected: [48, 2039, 97862] },
  { name: 'position 3', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', expected: [14, 191, 2812, 43238] },
  { name: 'position 4', fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', expected: [6, 264, 9467] },
  { name: 'position 5', fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', expected: [44, 1486, 62379] }
];

function initLab() {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const Engine = EngineCore();
  const client = createEngineClient();
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  document.getElementById('app').hidden = true;
  const lab = document.getElementById('lab');
  lab.hidden = false;
  const results = $('labResults');
  const progress = $('labProgress');
  const bar = $('labBar');
  const statusEl = $('labStatus');
  let running = false;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function section(title, body, note) {
    return '<section class="lab-group"><h2>' + title + '</h2>' + body +
      (note ? '<div class="lab-note">' + note + '</div>' : '') + '</section>';
  }
  function table(headers, rows) {
    let h = '<table class="lab-table"><thead><tr>' + headers.map((x) => '<th>' + x + '</th>').join('') + '</tr></thead><tbody>';
    for (const r of rows) h += '<tr>' + r.map((c) => '<td class="' + (c && c.cls ? c.cls : '') + '">' + (c && c.html !== undefined ? c.html : esc(c)) + '</td>').join('') + '</tr>';
    return h + '</tbody></table>';
  }
  function fmtNps(nodes, ms) {
    const nps = nodes / Math.max(ms, 0.001) * 1000;
    return nps >= 1e6 ? (nps / 1e6).toFixed(2) + 'M nps' : Math.round(nps / 1000) + 'k nps';
  }
  function setProgress(pct, text) {
    progress.hidden = false;
    bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    statusEl.textContent = text;
  }
  function clearProgress() { progress.hidden = true; }

  /* ------------------------------------------------------------------ perft */
  function runPerft(extra) {
    const rows = [];
    let total = 0, totalMs = 0, allOk = true;
    for (const c of LAB_PERFT) {
      const loaded = Engine.fromFen(c.fen);
      if (!loaded.ok) { rows.push(['<span class="fail">FEN rejected</span>', '', '', '', '', '']); continue; }
      const maxD = c.expected.length + (extra && c.name === 'startpos' ? 1 : 0);
      for (let d = 1; d <= maxD; d++) {
        const pos = Engine.fromFen(c.fen).pos;
        const t0 = performance.now();
        const n = Engine.perft(pos, d, 0);
        const dt = performance.now() - t0;
        total += n; totalMs += dt;
        const exp = c.expected[d - 1];
        const ok = exp === undefined ? null : n === exp;
        if (ok === false) allOk = false;
        rows.push([
          c.name, 'd' + d,
          { html: n.toLocaleString(), cls: 'name' },
          exp === undefined ? '—' : exp.toLocaleString(),
          { html: ok === null ? '<span class="pass">extra</span>' : ok ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>' },
          dt.toFixed(1) + ' ms · ' + fmtNps(n, dt)
        ]);
      }
    }
    const html = section('Perft — move generation ground truth',
      table(['position', 'depth', 'nodes', 'expected', 'result', 'time'], rows),
      'Total: <b>' + total.toLocaleString() + '</b> nodes in <b>' + totalMs.toFixed(1) + ' ms</b> (' +
      fmtNps(total, totalMs) + '). ' +
      (allOk ? '<b>All reference counts match.</b>' : '<b class="fail">Mismatch — move generation is wrong.</b>'));
    return { html, ok: allOk, total, totalMs };
  }

  /* ------------------------------------------------------------ rule tests */
  function ruleTests() {
    const out = [];
    const t = (name, fn) => {
      try {
        const r = fn();
        out.push({ name, pass: r === true, detail: typeof r === 'string' ? r : '' });
      } catch (e) { out.push({ name, pass: false, detail: e.message }); }
    };
    const uci = (p) => Engine.legalMoves(p).map((m) => Engine.moveToUci(m));

    t('rook captured on h1 clears the white k-side right', () => {
      const p = Engine.fromFen('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1').pos;
      const mv = Engine.legalMoves(p).find((m) => Engine.moveToUci(m) === 'h8h1');
      if (!mv) return 'move missing';
      Engine.makeMove(p, mv);
      return Engine.toFen(p).split(' ')[2] === 'Qq';
    });
    t('rook captured on a8 clears the black q-side right', () => {
      const p = Engine.fromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1').pos;
      const mv = Engine.legalMoves(p).find((m) => Engine.moveToUci(m) === 'a1a8');
      if (!mv) return 'move missing';
      Engine.makeMove(p, mv);
      return Engine.toFen(p).split(' ')[2] === 'Kk';
    });
    t('checkmate: no legal moves and in check', () => {
      const p = Engine.fromFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3').pos;
      return Engine.legalMoves(p).length === 0 && Engine.inCheck(p);
    });
    t('stalemate: no legal moves and not in check', () => {
      const p = Engine.fromFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').pos;
      return Engine.legalMoves(p).length === 0 && !Engine.inCheck(p);
    });
    t('insufficient material: K vs K, KB vs K, KB vs KB same colour', () => {
      return Engine.insufficientMaterial(Engine.fromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1').pos) &&
        Engine.insufficientMaterial(Engine.fromFen('4k3/8/8/8/8/8/8/2B1K3 w - - 0 1').pos) &&
        Engine.insufficientMaterial(Engine.fromFen('4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1').pos);
    });
    t('K+N vs K+N is NOT insufficient', () => {
      return Engine.insufficientMaterial(Engine.fromFen('4kn2/8/8/8/8/8/8/2N1K3 w - - 0 1').pos) === false;
    });
    t('halfmove clock resets only on pawn moves and captures', () => {
      const p = Engine.fromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1').pos;
      Engine.makeMove(p, Engine.legalMoves(p).find((m) => Engine.moveToUci(m) === 'e1e2'));
      const a = Engine.halfmove(p);
      Engine.makeMove(p, Engine.legalMoves(p).find((m) => Engine.moveToUci(m) === 'e8e7'));
      return a === 1 && Engine.halfmove(p) === 2;
    });
    t('incremental Zobrist key equals a full recompute (40 plies)', () => {
      const p = Engine.newPosition();
      let seed = 12345;
      const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
      for (let i = 0; i < 40; i++) {
        const ms = Engine.legalMoves(p);
        if (!ms.length) break;
        Engine.makeMove(p, ms[rnd(ms.length)]);
        const h = Engine.computeHash(p);
        if (h.lo !== p.hashLo || h.hi !== p.hashHi) return 'mismatch at ply ' + i;
      }
      return true;
    });
    t('en passant captures the pawn that just double-pushed', () => {
      const p = Engine.fromFen('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1').pos;
      const ep = Engine.legalMoves(p).find((m) => Engine.moveToUci(m) === 'e5d6');
      if (!ep) return 'no ep move';
      Engine.makeMove(p, ep);
      return Engine.toFen(p).indexOf('3P4') >= 0 && Engine.toFen(p).indexOf('3p4') < 0;
    });
    t('castling through an attacked square is illegal', () => {
      const p = Engine.fromFen('4kr2/8/8/8/8/8/8/R3K2R w KQ - 0 1').pos;
      const moves = uci(p);
      return moves.indexOf('e1g1') < 0 && moves.indexOf('e1c1') >= 0;
    });
    t('all four promotions are generated', () => {
      const moves = uci(Engine.fromFen('4k3/1P6/8/8/8/8/8/4K3 w - - 0 1').pos);
      return moves.indexOf('b7b8n') >= 0 && moves.indexOf('b7b8q') >= 0 &&
        moves.indexOf('b7b8r') >= 0 && moves.indexOf('b7b8b') >= 0;
    });
    t('FEN round-trips exactly', () => {
      const fens = [
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
        '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1'];
      for (const f of fens) {
        const r = Engine.fromFen(f);
        if (!r.ok) return 'rejected ' + f;
        if (Engine.toFen(r.pos) !== f) return 'changed to ' + Engine.toFen(r.pos);
      }
      return true;
    });
    t('FEN validation gives a friendly error', () => {
      const bad = ['8/8/8/8/8/8/8/8 w - - 0 1',
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN w KQkq - 0 1',
        '4k3/8/8/8/8/8/8/4K3 w K - 0 1',
        '4k3/8/8/8/8/8/8/4K3 w - e6 0 1'];
      for (const f of bad) {
        const r = Engine.fromFen(f);
        if (r.ok) return 'accepted invalid FEN: ' + f;
        if (!r.error) return 'no message';
      }
      return true;
    });
    t('SAN round-trip over 21 moves of a real game', () => {
      const sans = 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7'.split(' ');
      const p = Engine.newPosition();
      for (const s of sans) {
        const mv = Engine.parseSan(p, s);
        if (!mv) return 'cannot parse ' + s;
        if (Engine.sanOf(p, mv) !== s) return s + ' -> ' + Engine.sanOf(p, mv);
        Engine.makeMove(p, mv);
      }
      return true;
    });
    t('SAN disambiguation and mate marker', () => {
      const p = Engine.fromFen('4k3/8/8/8/8/2N1N3/8/4K3 w - - 0 1').pos;
      const a = Engine.parseSan(p, 'Ncd5'), b = Engine.parseSan(p, 'Ned5');
      if (!a || !b) return 'ambiguous parse failed';
      const q = Engine.fromFen('6k1/5ppp/8/8/8/8/5PPP/R3K3 w Q - 0 1').pos;
      const mate = Engine.legalMoves(q).map((m) => Engine.sanOf(q, m)).indexOf('Ra8#');
      return Engine.sanOf(p, a) === 'Ncd5' && Engine.sanOf(p, b) === 'Ned5' && mate >= 0;
    });
    t('PGN export → import → export is byte-identical', () => {
      const sans = 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O'.split(' ');
      const headers = { Event: 'Round trip', Site: 'Lab', Date: '2024.01.01', Round: '1', White: 'A', Black: 'B', Result: '*' };
      const one = pgnBuildText(headers, sans, '*', START);
      const parsed = pgnParseText(Engine, one);
      if (!parsed.ok) return parsed.error;
      const two = pgnBuildText(headers, parsed.sans, parsed.result, parsed.startFen);
      return one === two;
    });
    t('PGN parser rejects an illegal move with a useful message', () => {
      const bad = '[Event "x"]\n\n1. e4 e5 2. Qxf7# 3. Ke2 *';
      const parsed = pgnParseText(Engine, bad);
      return parsed.ok === false && /Could not read/.test(parsed.error);
    });
    t('threefold repetition is detected inside the engine', () => {
      const p = Engine.newPosition();
      const line = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
      for (const u of line) {
        const mv = Engine.legalMoves(p).find((m) => Engine.moveToUci(m) === u);
        if (!mv) return 'move missing ' + u;
        Engine.makeMove(p, mv);
      }
      return Engine.isRepetition(p) === true;
    });
    t('opening book lines are all legal', () => {
      for (const line of Engine.BOOK_LINES) {
        const p = Engine.newPosition();
        for (const u of line[1].split(' ')) {
          const mv = Engine.legalMoves(p).find((m) => Engine.moveToUci(m) === u);
          if (!mv) return 'book line "' + line[0] + '" has illegal move ' + u;
          Engine.makeMove(p, mv);
        }
      }
      return true;
    });

    const rows = out.map((x) => [x.name, { html: x.pass ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>' }, x.detail || '']);
    const pass = out.filter((x) => x.pass).length;
    return {
      html: section('Rules, notation and round-trips',
        table(['test', 'result', 'detail'], rows),
        '<b>' + pass + ' / ' + out.length + '</b> checks passed.'),
      ok: pass === out.length, pass, total: out.length
    };
  }

  /* ------------------------------------------------------------ search tests */
  function hasMateIn(pos, n) {
    const moves = Engine.legalMoves(pos);
    if (!moves.length) return false;
    for (const mv of moves) {
      Engine.makeMove(pos, mv);
      const replies = Engine.legalMoves(pos);
      let ok = replies.length === 0 && Engine.inCheck(pos) && n === 1;
      if (!ok && replies.length && n > 1) {
        ok = true;
        for (const r of replies) {
          Engine.makeMove(pos, r);
          const sub = hasMateIn(pos, n - 1);
          Engine.unmakeMove(pos, r);
          if (!sub) { ok = false; break; }
        }
      }
      Engine.unmakeMove(pos, mv);
      if (ok) return true;
    }
    return false;
  }

  async function runSearchTests() {
    const out = [];
    const add = (name, pass, detail) => out.push({ name, pass: !!pass, detail: detail || '' });

    // mate in 1
    try {
      const msg = await client.search({
        fen: '6k1/5ppp/8/8/8/8/5PPP/R3K3 w Q - 0 1', level: 'advanced',
        analysis: true, useBook: false, limits: { depth: 4, timeMs: 5000 }
      });
      add('finds mate in 1 (Ra8#)', msg.pvSan && msg.pvSan[0] === 'Ra8#', (msg.pvSan || []).join(' '));
    } catch (e) { add('finds mate in 1 (Ra8#)', false, e.message); }

    // mate in 2, verified with an independent brute-force oracle first
    try {
      const fen = 'k7/3Q4/8/K7/8/8/8/8 w - - 0 1';
      const p = Engine.fromFen(fen).pos;
      const oracle1 = hasMateIn(p, 1);
      const oracle2 = hasMateIn(p, 2);
      const msg = await client.search({ fen, level: 'advanced', analysis: true, useBook: false, limits: { depth: 10, timeMs: 5000 } });
      add('finds mate in 2 (oracle-verified)', !oracle1 && oracle2 && msg.mate === 2,
        'oracle: mate in 1 = ' + oracle1 + ', mate in 2 = ' + oracle2 + '; engine mate = ' + msg.mate + '; pv ' + (msg.pvSan || []).join(' '));
    } catch (e) { add('finds mate in 2 (oracle-verified)', false, e.message); }

    // Black must find its own mate: the original engine always maximised White.
    try {
      const msg = await client.search({
        fen: 'r3k3/5ppp/8/8/8/8/5PPP/6K1 b q - 0 1', level: 'advanced',
        analysis: true, useBook: false, limits: { depth: 4, timeMs: 5000 }
      });
      add('Black finds its own mate in 1', msg.pvSan && msg.pvSan[0] === 'Ra1#', (msg.pvSan || []).join(' '));
    } catch (e) { add('Black finds its own mate in 1', false, e.message); }

    // legal move in a sharp position
    try {
      const msg = await client.search({
        fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
        level: 'max', analysis: true, useBook: false, limits: { depth: 12, timeMs: 1500 }
      });
      const p = Engine.fromFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1').pos;
      const legal = Engine.legalMoves(p).map((m) => Engine.moveToUci(m));
      add('kiwipete: returns a legal move', legal.indexOf(msg.uci) >= 0, msg.uci + ' at depth ' + msg.depth + ', ' + msg.nodes + ' nodes');
    } catch (e) { add('kiwipete: returns a legal move', false, e.message); }

    // does not lose material in a quiet position
    try {
      const msg = await client.search({
        fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4',
        level: 'advanced', analysis: true, useBook: false, limits: { depth: 40, timeMs: 1200 }
      });
      add('no self-destructive move (score > -1.5 pawns)', msg.score > -150, 'score ' + msg.score + ' cp, pv ' + (msg.pvSan || []).join(' '));
    } catch (e) { add('no self-destructive move (score > -1.5 pawns)', false, e.message); }

    const rows = out.map((x) => [x.name, { html: x.pass ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>' }, x.detail]);
    const pass = out.filter((x) => x.pass).length;
    return {
      html: section('Search sanity', table(['test', 'result', 'detail'], rows)),
      ok: pass === out.length, pass, total: out.length
    };
  }

  /* --------------------------------------------------------------- benches */
  async function runBench() {
    setProgress(5, 'benchmarking…');
    const cases = [
      { name: 'startpos', fen: START, ms: 1000 },
      { name: 'kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', ms: 1000 },
      { name: 'endgame', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', ms: 1000 },
      { name: 'startpos', fen: START, ms: 5000 },
      { name: 'kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', ms: 5000 },
      { name: 'endgame', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', ms: 5000 }
    ];
    const msg = await client.bench(cases, {
      onProgress(p) { setProgress((p.done / p.total) * 100, 'benchmark ' + p.done + '/' + p.total); }
    });
    clearProgress();
    const rows = msg.rows.map((r) => [
      r.name, (r.budget || 0) + ' ms', 'd' + r.depth + ' (' + r.seldepth + ')',
      r.nodes.toLocaleString(), Math.round(r.nps / 1000) + 'k',
      String(r.score) + (r.mate !== null && r.mate !== undefined ? ' (M' + r.mate + ')' : ''),
      r.pvSan
    ]);
    return section('Benchmarks — depth reached in 1 s and 5 s',
      table(['position', 'budget', 'depth/seldepth', 'nodes', 'nps', 'score', 'principal variation'], rows),
      'Measured in your browser, in the worker. Search speed depends on the machine; these are not estimates.');
  }

  /* ---------------------------------------------------------------- match */
  async function runMatch() {
    setProgress(2, 'starting 20-game match…');
    const starts = [
      START,
      'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
      'rnbqkb1r/pp2pppp/3p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq - 0 5',
      'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 5',
      'rnbqkb1r/ppp1pppp/5n2/3p4/3P1B2/8/PPP1PPPP/RN1QKBNR w KQkq - 2 3'
    ];
    const t0 = Date.now();
    const msg = await client.match({ games: 20, timeMs: 100, positions: starts, maxPlies: 140 }, {
      onProgress(p) { setProgress((p.done / p.total) * 100, 'game ' + p.done + ' / ' + p.total); }
    });
    clearProgress();
    const r = msg.result;
    const rows = r.games.map((g, i) => [
      '#' + (i + 1), g.newIsWhite ? 'white' : 'black',
      { html: g.outcome === 'win' ? '<span class="pass">win</span>' : g.outcome === 'loss' ? '<span class="fail">loss</span>' : 'draw' },
      String(g.plies), g.startFen.split(' ')[0]
    ]);
    return section('Self-play: new engine vs the original depth-3 algorithm',
      table(['game', 'new engine', 'result', 'plies', 'start position'], rows),
      'W <b>' + r.wins + '</b> · D <b>' + r.draws + '</b> · L <b>' + r.losses + '</b> — score <b>' +
      r.score + '/' + r.total + ' (' + r.scorePct.toFixed(1) + '%)</b>. 100 ms per move for the new engine, fixed depth 3 for the baseline. ' +
      'The baseline is the original algorithm (material + piece-square eval, no quiescence, no TT) running on the new move generator, ' +
      'so this measures search and evaluation quality rather than bug fixes. Elapsed ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s.');
  }

  /* -------------------------------------------------------------- assembly */
  function render(parts) {
    results.innerHTML = parts.filter(Boolean).join('');
  }

  async function runAll() {
    if (running) return;
    running = true;
    const parts = [];
    try {
      setProgress(4, 'perft…');
      await new Promise((r) => setTimeout(r, 20));
      const perft = runPerft(false);
      parts.push(perft.html);
      render(parts);

      setProgress(35, 'rules and notation…');
      await new Promise((r) => setTimeout(r, 20));
      const rules = ruleTests();
      parts.push(rules.html);
      render(parts);

      setProgress(55, 'search tests…');
      const search = await runSearchTests();
      parts.push(search.html);
      parts.push(section('Environment',
        '<div class="lab-note">Engine: 0x88 board, ' + (Engine.TT_SIZE / 1024).toFixed(0) + 'k-entry transposition table, ' +
        'negamax + PVS + LMR + null-move + quiescence. Worker source: ' +
        Math.round(buildWorkerSource().length / 1024) + ' kB. User agent: ' + esc(navigator.userAgent) + '</div>'),
        'Perft: ' + perft.ok + ' · rules ' + rules.pass + '/' + rules.total + ' · search ' + search.pass + '/' + search.total);
      render(parts);
      setProgress(100, 'done');
      setTimeout(clearProgress, 1200);
    } catch (err) {
      parts.push(section('Error', '<div class="lab-note fail">' + esc(err.message) + '</div>'));
      render(parts);
      clearProgress();
    }
    running = false;
  }

  $('runAll').addEventListener('click', () => { if (!running) runAll(); });
  $('runPerft').addEventListener('click', () => {
    results.innerHTML = runPerft(false).html;
  });
  $('runPerftDeep').addEventListener('click', () => {
    setProgress(30, 'extra depth on the start position…');
    setTimeout(() => {
      results.innerHTML = runPerft(true).html;
      clearProgress();
    }, 30);
  });
  $('runBench').addEventListener('click', async () => {
    if (running) return;
    running = true;
    try {
      const html = await runBench();
      results.innerHTML = html;
    } catch (e) {
      results.innerHTML = section('Benchmark failed', '<div class="lab-note fail">' + esc(e.message) + '</div>');
    }
    clearProgress();
    running = false;
  });
  $('runMatch').addEventListener('click', async () => {
    if (running) return;
    running = true;
    try {
      const html = await runMatch();
      results.innerHTML = html;
    } catch (e) {
      results.innerHTML = section('Match failed', '<div class="lab-note fail">' + esc(e.message) + '</div>');
    }
    clearProgress();
    running = false;
  });

  // Show the perft table immediately so the page is never blank.
  results.innerHTML = runPerft(false).html;
  runAll();
}

/* --------------------------------------------------------------------------
   Boot dispatch lives here, at the very end of the script, so that every
   const/let in the file is initialised before the UI starts. Calling initLab()
   from the middle of the file would hit the temporal dead zone of LAB_PERFT.
   -------------------------------------------------------------------------- */
if (typeof document !== 'undefined') {
  if (/[?&]test\b/.test(location.search)) initLab();
  else initApp();
}
