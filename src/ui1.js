/* ==========================================================================
   SECTION 3 - THE WORKER
   The engine is stringified (Function.prototype.toString) and turned into a Blob
   URL, which is how a single HTML file can still run a real Web Worker. The
   glue below is a normal function too, so the exact same code can be exercised
   in tests with a fake `self`.
   ========================================================================== */

const WORKER_LEVELS = {
  beginner:     { depth: 2,  timeMs: 300,  blunder: 0.35, book: false },
  easy:         { depth: 3,  timeMs: 450,  blunder: 0.18, book: false },
  intermediate: { depth: 5,  timeMs: 800,  blunder: 0.06, book: true  },
  advanced:     { depth: 9,  timeMs: 1400, blunder: 0.01, book: true  },
  max:          { depth: 50, timeMs: 2600, blunder: 0,    book: true  }
};

/* eslint-disable no-unused-vars */
function workerMain(self, coreFactory, baselineFactory) {
  'use strict';
  var Engine = coreFactory();
  var Baseline = baselineFactory(Engine);
  var levels = {
    beginner:     { depth: 2,  timeMs: 300,  blunder: 0.35, book: false },
    easy:         { depth: 3,  timeMs: 450,  blunder: 0.18, book: false },
    intermediate: { depth: 5,  timeMs: 800,  blunder: 0.06, book: true  },
    advanced:     { depth: 9,  timeMs: 1400, blunder: 0.01, book: true  },
    max:          { depth: 50, timeMs: 2600, blunder: 0,    book: true  }
  };
  var currentId = -1;
  var timer = null;

  function post(m) { self.postMessage(m); }

  function loadPosition(fen, history) {
    var r = (history && history.length)
      ? Engine.fromFenWithHistory(fen, history)
      : Engine.fromFen(fen);
    return r;
  }

  function emitBest(id, pos, res) {
    post({
      type: 'bestmove', id: id,
      uci: res.uci || '', score: res.score || 0, mate: res.mate,
      depth: res.depth || 0, seldepth: res.seldepth || 0,
      nodes: res.nodes || 0, nps: res.nps || 0, elapsed: res.elapsed || 0,
      pvSan: res.pvSan || [], book: !!res.book, blunder: !!res.blunder,
      flag: !!res.flag
    });
  }

  function handleSearch(msg) {
    var id = msg.id;
    currentId = id;
    var lvl = levels[msg.level] || levels.advanced;
    var loaded = loadPosition(msg.fen, msg.history);
    if (!loaded.ok) { post({ type: 'error', id: id, message: loaded.error }); return; }
    var pos = loaded.pos;
    var legal = Engine.legalMoves(pos);
    if (!legal.length) {
      post({ type: 'bestmove', id: id, uci: '', none: true, score: 0, mate: null,
             depth: 0, nodes: 0, nps: 0, pvSan: [], elapsed: 0 });
      return;
    }

    // Opening book: a few dozen mainlines, weighted random choice. Disabled for
    // the weakest levels so that a beginner opponent does not play 12 moves of
    // theory from a 2600-rated repertoire.
    if (!msg.analysis && lvl.book && msg.useBook !== false) {
      var bm = Engine.bookMove(pos);
      if (bm) {
        emitBest(id, pos, {
          uci: Engine.moveToUci(bm), score: 0, mate: null, depth: 0,
          nodes: 0, nps: 0, elapsed: 0, book: true,
          pvSan: [Engine.sanOf(pos, bm)]
        });
        return;
      }
    }

    // Controlled weakness: a fixed chance of playing a random legal move.
    // This is the honest way to make a weak opponent from a strong engine -
    // reducing depth alone makes it weak positionally but still tactically sharp.
    if (!msg.analysis && Math.random() < lvl.blunder) {
      var rnd = legal[(Math.random() * legal.length) | 0];
      emitBest(id, pos, {
        uci: Engine.moveToUci(rnd), score: 0, mate: null, depth: 0,
        nodes: 0, nps: 0, elapsed: 0, blunder: true,
        pvSan: [Engine.sanOf(pos, rnd)]
      });
      return;
    }

    var limits = { depth: lvl.depth, timeMs: lvl.timeMs, nodes: 0 };
    if (msg.limits) {
      if (msg.limits.depth) limits.depth = msg.limits.depth;
      if (msg.limits.timeMs) limits.timeMs = msg.limits.timeMs;
      if (msg.limits.nodes) limits.nodes = msg.limits.nodes;
    }
    Engine.searchStart(pos, limits);

    var last = null;
    var step = function () {
      if (currentId !== id) return;            // superseded: never post stale info
      var info = Engine.searchNext();
      if (!info) {
        var res = Engine.searchResult();
        emitBest(id, pos, {
          uci: res.bestUci, score: res.score, mate: res.mate, depth: res.depth,
          seldepth: res.seldepth, nodes: res.nodes, nps: res.nps,
          elapsed: res.timeMs, pvSan: res.pvSan, flag: last === null
        });
        return;
      }
      last = info;
      post({ type: 'info', id: id, info: info });
      // Yield to the event loop between iterations so a 'stop' message (and the
      // player closing the tab) can actually be processed mid-search.
      timer = setTimeout(step, 0);
    };
    timer = setTimeout(step, 0);
  }

  self.onmessage = function (e) {
    var msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'hello':
        post({ type: 'ready', ttSize: Engine.TT_SIZE });
        break;
      case 'stop':
        Engine.searchStop();
        break;
      case 'search':
        handleSearch(msg);
        break;
      case 'perft': {
        var r = Engine.fromFen(msg.fen);
        if (!r.ok) { post({ type: 'perft', id: msg.id, error: r.error }); return; }
        var t0 = Date.now();
        var n = Engine.perft(r.pos, msg.depth, 0);
        post({ type: 'perft', id: msg.id, nodes: n, ms: Date.now() - t0 });
        break;
      }
      case 'bench': {
        var rows = [];
        for (var i = 0; i < msg.cases.length; i++) {
          var c = msg.cases[i];
          var lr = Engine.fromFen(c.fen);
          if (!lr.ok) { rows.push({ name: c.name, error: lr.error }); continue; }
          Engine.searchStart(lr.pos, { depth: 60, timeMs: c.ms });
          var start = Date.now(), inf = null, lastInf = null;
          while ((inf = Engine.searchNext())) lastInf = inf;
          var rr = Engine.searchResult();
          var el = Date.now() - start;
          rows.push({
            name: c.name, budget: c.ms, depth: rr.depth, seldepth: rr.seldepth,
            nodes: rr.nodes, nps: el > 0 ? Math.round(rr.nodes / (el / 1000)) : 0,
            ms: el, score: rr.score, mate: rr.mate,
            pvSan: rr.pvSan.slice(0, 6).join(' ')
          });
          post({ type: 'benchProgress', id: msg.id, done: i + 1, total: msg.cases.length });
        }
        post({ type: 'bench', id: msg.id, rows: rows });
        break;
      }
      case 'match': {
        var result = Engine.runMatch(Baseline, {
          games: msg.games, timeMs: msg.timeMs, positions: msg.positions,
          maxPlies: msg.maxPlies,
          onGame: function (done, total, game) {
            post({ type: 'matchProgress', id: msg.id, done: done, total: total, game: game });
          }
        });
        post({ type: 'matchDone', id: msg.id, result: result });
        break;
      }
      default:
        break;
    }
  };
}
/* eslint-enable no-unused-vars */

/** Build the worker source: engine + baseline + glue, all from this file. */
function buildWorkerSource() {
  return '"use strict";\n' +
    'var __coreFactory = (' + EngineCore.toString() + ');\n' +
    'var __baselineFactory = (' + BaselineEngine.toString() + ');\n' +
    '(' + workerMain.toString() + ')(self, __coreFactory, __baselineFactory);\n';
}

/**
 * Thin promise wrapper around the worker. Every request carries a monotonic id;
 * responses for an unknown id are dropped, which is what makes "ignore results
 * from outdated searches" reliable rather than hopeful.
 */
function createEngineClient() {
  const client = {
    worker: null,
    seq: 1,
    pending: new Map(),
    url: null,
    onInfo: null,
    onProtocolError: null
  };

  function spawn() {
    if (client.worker) {
      try { client.worker.terminate(); } catch (e) { /* ignore */ }
      client.worker = null;
    }
    const src = buildWorkerSource();
    const blob = new Blob([src], { type: 'text/javascript' });
    if (client.url) URL.revokeObjectURL(client.url);
    client.url = URL.createObjectURL(blob);
    const w = new Worker(client.url);
    client.worker = w;
    w.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === 'ready') { client.ready = true; return; }
      const entry = client.pending.get(msg.id);
      if (!entry) return;                       // stale id: drop it
      if (msg.type === 'info') {
        if (entry.onInfo) entry.onInfo(msg.info);
        return;
      }
      if (msg.type === 'benchProgress' || msg.type === 'matchProgress') {
        if (typeof entry.onProgress === 'function') entry.onProgress(msg);
        return;
      }
      if (msg.type === 'error') {
        client.pending.delete(msg.id);
        entry.reject(new Error(msg.message || 'engine error'));
        return;
      }
      client.pending.delete(msg.id);
      entry.resolve(msg);
    };
    w.onerror = (ev) => {
      const err = new Error(ev.message || 'worker failed to start');
      for (const [, e] of client.pending) e.reject(err);
      client.pending.clear();
      if (client.onProtocolError) client.onProtocolError(err);
    };
    try { w.postMessage({ type: 'hello' }); } catch (e) { /* ignored */ }
  }

  // Callers may pass either a function or { onProgress } - accepting both
  // avoids silently losing the progress channel.
  function asProgress(p) {
    if (typeof p === 'function') return p;
    if (p && typeof p.onProgress === 'function') return p.onProgress;
    return null;
  }

  function send(msg, handlers) {
    if (!client.worker) spawn();
    const id = client.seq++;
    msg.id = id;
    return new Promise((resolve, reject) => {
      client.pending.set(id, {
        resolve, reject,
        onInfo: handlers && handlers.onInfo,
        onProgress: handlers && handlers.onProgress
      });
      try { client.worker.postMessage(msg); }
      catch (err) { client.pending.delete(id); reject(err); }
    });
  }

  return {
    spawn,
    /** Wipe the worker and its transposition table; cancels pending requests. */
    restart() {
      for (const [, e] of client.pending) e.reject(new Error('cancelled'));
      client.pending.clear();
      spawn();
    },
    search(opts, handlers) { return send(Object.assign({ type: 'search' }, opts), handlers); },
    stop() {
      if (client.worker) { try { client.worker.postMessage({ type: 'stop' }); } catch (e) { /* ignore */ } }
    },
    perft(fen, depth) { return send({ type: 'perft', fen, depth }); },
    bench(cases, onProgress) {
      return send({ type: 'bench', cases }, { onProgress: asProgress(onProgress) });
    },
    match(opts, onProgress) {
      return send(Object.assign({ type: 'match' }, opts), { onProgress: asProgress(onProgress) });
    },
    get busy() { return client.pending.size > 0; }
  };
}

/* ==========================================================================
   SECTION 4 - SOUND (Web Audio, no files)
   A pawn move and a capture should not sound the same: short, quiet feedback is
   a usability feature, not decoration. Everything is synthesised from
   oscillators so the file stays self-contained.
   ========================================================================== */
const Sound = (function () {
  let ctx = null;
  let muted = false;
  let unlocked = false;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    unlocked = true;
    return ctx;
  }

  function tone(freq, dur, type, gain, delay, slideTo) {
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + (delay || 0);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain || 0.06, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise(dur, gain) {
    const c = ensure();
    if (!c) return;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = c.createBufferSource();
    const g = c.createGain();
    g.gain.value = gain || 0.05;
    src.buffer = buf;
    src.connect(g).connect(c.destination);
    src.start();
  }

  return {
    unlock() { ensure(); },
    setMuted(v) { muted = !!v; if (!v) ensure(); },
    isMuted() { return muted; },
    play(kind) {
      if (muted) return;
      if (!ctx && !unlocked) { /* browsers require a gesture first */ }
      switch (kind) {
        case 'move': tone(320, 0.05, 'triangle', 0.05); break;
        case 'capture': noise(0.07, 0.06); tone(180, 0.08, 'square', 0.03); break;
        case 'castle': tone(280, 0.05, 'triangle', 0.05); tone(360, 0.06, 'triangle', 0.045, 0.07); break;
        case 'check': tone(660, 0.09, 'sine', 0.06); tone(880, 0.1, 'sine', 0.05, 0.1); break;
        case 'promote': tone(520, 0.07, 'sine', 0.05); tone(780, 0.09, 'sine', 0.05, 0.08); break;
        case 'illegal': tone(150, 0.1, 'sawtooth', 0.035); break;
        case 'end': tone(440, 0.14, 'sine', 0.06); tone(330, 0.16, 'sine', 0.055, 0.14); tone(220, 0.22, 'sine', 0.05, 0.3); break;
        default: break;
      }
    }
  };
})();

/* ==========================================================================
   SECTION 5 - STORAGE
   Every call is wrapped: file:// pages, private mode and disabled storage all
   throw in different ways, and a chess game must still work when they do.
   ========================================================================== */
const Store = {
  key: 'chesslab.v1',
  read() {
    try {
      const raw = window.localStorage.getItem(this.key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },
  write(obj) {
    try { window.localStorage.setItem(this.key, JSON.stringify(obj)); return true; }
    catch (e) { return false; }
  },
  clear() {
    try { window.localStorage.removeItem(this.key); } catch (e) { /* ignore */ }
  }
};

/* ==========================================================================
   SECTION 6 - PIECE ARTWORK
   Original shapes, drawn on a 45x45 grid with one shared plinth so the set
   stays visually consistent. Each piece is: body (.b) + carved detail (.d).
   Colours come from CSS variables, so the light/dark piece sets restyle with
   the theme and keep their contrast on every board palette.
   ========================================================================== */
const PLINTH = '<path class="b" d="M12.4 33.4h20.2l1.9 5.1H10.5z"/>' +
  '<rect class="b" x="9.4" y="38.5" width="26.2" height="3.1" rx="1.55"/>';

const PIECE_SHAPES = {
  p: '<circle class="b" cx="22.5" cy="16.2" r="5.15"/>' +
     '<path class="b" d="M17.8 21.7q4.7 2.9 9.4 0l2.7 11.7H15.1z"/>',
  r: '<path class="b" d="M13 12.2h4.6v3.5h3.1v-3.5h3.6v3.5h3.1v-3.5H32v7.2l-2.3 2.2v11.8H15.3V19.6L13 17.4z"/>' +
     '<rect class="d" x="19.3" y="21.8" width="2.5" height="7.2" rx=".9"/>' +
     '<rect class="d" x="23.2" y="21.8" width="2.5" height="7.2" rx=".9"/>',
  n: '<path class="b" d="M14.3 33.4c0-6.7 1.9-11 5.3-14.4l-4.6 1.2c-2.6.7-4.4-1-4.4-3.1 0-2 1.6-3.5 3.6-3.7.5-2.7 2.5-4.7 5.4-5.7.2-1.7 1.3-3 2.9-3 1.7 0 2.9 1.2 3 3 3.5 1.1 5.9 3.8 5.9 7.7 0 3.9-.8 7.6-.8 12v6z"/>' +
     '<circle class="d" cx="19.6" cy="16.6" r="1.05"/>' +
     '<path class="d" d="M26.2 12.6c1.6 1.1 2.7 2.6 3.2 4.4l-2.6-.6z"/>',
  b: '<circle class="b" cx="22.5" cy="8.7" r="2.55"/>' +
     '<path class="b" d="M22.5 11.6c5 3.4 7.5 7.9 6 12.6l-1.2 3.3H17.7l-1.2-3.3c-1.5-4.7 1-9.2 6-12.6z"/>' +
     '<path class="b" d="M16.3 28h12.4l1.6 3.6H14.7z"/>' +
     '<path class="d" d="M22.5 15.9l2.3 6h-4.6z"/>',
  q: '<path class="b" d="M12.4 22.4L10.9 11.2l6.1 5.1L22.5 8l5.5 8.3 6.1-5.1-1.5 11.2z"/>' +
     '<rect class="b" x="12.2" y="22.6" width="20.6" height="4.6" rx="1.7"/>' +
     '<path class="b" d="M14.5 27.4h16l1.8 6H12.7z"/>' +
     '<circle class="d" cx="10.9" cy="10.4" r="1.75"/>' +
     '<circle class="d" cx="22.5" cy="7.4" r="1.85"/>' +
     '<circle class="d" cx="34.1" cy="10.4" r="1.75"/>',
  k: '<path class="b" d="M21.4 3.2h2.2v2.6h2.6v2.2h-2.6v2.7h-2.2V8h-2.6V5.8h2.6z"/>' +
     '<path class="b" d="M12.6 21.8L11.2 12l6.1 4.6 5.2-5.5 5.2 5.5 6.1-4.6-1.4 9.8z"/>' +
     '<rect class="b" x="12.4" y="22.2" width="20.2" height="4.6" rx="1.7"/>' +
     '<path class="b" d="M14.6 27.2h15.8l1.9 6.2H12.7z"/>'
};

function pieceSvgMarkup(char) {
  const type = char.toLowerCase();
  const color = char === char.toUpperCase() ? 'pw' : 'pb';
  return '<svg viewBox="0 0 45 45" class="' + color + '" aria-hidden="true" focusable="false">' +
    '<g>' + PIECE_SHAPES[type] + PLINTH + '</g></svg>';
}

/* ==========================================================================
   SECTION 6B - PGN (pure functions, shared by the app and the test lab)
   PGN is a standard, and "e2e4" is not PGN. These two functions are the whole
   import/export path: parse checks that every token is legal SAN, and export
   regenerates SAN from the actual move list.
   ========================================================================== */
function pgnBuildText(headers, sans, result, startFen) {
  const order = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];
  let out = '';
  for (const k of order) {
    if (headers[k] !== undefined) out += '[' + k + ' "' + headers[k] + '"]\n';
  }
  if (startFen && startFen !== 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') {
    out += '[SetUp "1"]\n[FEN "' + startFen + '"]\n';
  }
  out += '\n';
  let line = '';
  const push = (tok) => {
    if ((line + tok).length > 79) { out += line.replace(/\s+$/, '') + '\n'; line = ''; }
    line += tok + ' ';
  };
  for (let i = 0; i < sans.length; i++) {
    if (i % 2 === 0) push((i / 2 + 1) + '.');
    push(sans[i]);
  }
  if (result) push(result);
  out += line.replace(/\s+$/, '') + '\n';
  return out;
}

function pgnParseText(Engine, text) {
  const headers = {};
  const headerRe = /\[(\w+)\s+"([^"]*)"\]/g;
  let m;
  while ((m = headerRe.exec(text))) headers[m[1]] = m[2];
  let body = text.replace(headerRe, ' ');
  body = body.replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ');
  let prev;
  do { prev = body; body = body.replace(/\([^()]*\)/g, ' '); } while (body !== prev);
  body = body.replace(/\$\d+/g, ' ');

  const startFen = headers.FEN || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const loaded = Engine.fromFen(startFen);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const pos = loaded.pos;
  const sans = [];
  let result = '*';
  const tokens = body.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    if (tok === '1-0' || tok === '0-1' || tok === '1/2-1/2' || tok === '*') { result = tok; continue; }
    if (/^\d+\.+$/.test(tok)) continue;
    const sanTok = tok.replace(/^\d+\.+/, '');
    if (!sanTok) continue;
    if (sanTok === '--') continue;
    const mv = Engine.parseSan(pos, sanTok);
    if (!mv) return { ok: false, error: 'Could not read the move "' + tok + '" in ' + Engine.toFen(pos) };
    sans.push(Engine.sanOf(pos, mv));
    Engine.makeMove(pos, mv);
  }
  return { ok: true, headers: headers, startFen: startFen, sans: sans, result: result, finalFen: Engine.toFen(pos) };
}
