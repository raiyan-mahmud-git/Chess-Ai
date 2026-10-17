/* ==========================================================================
   SECTION 7 - APPLICATION
   Layers: GameController owns the truth (position, history, clocks, result);
   the renderer only reads it. Nothing in the DOM layer calls engine search
   functions - searches go through the worker client.
   ========================================================================== */

const LEVEL_LABELS = {
  beginner: 'Beginner',
  easy: 'Easy',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
  max: 'Max'
};

// A book move or a blunder returns in a few milliseconds. These minimums keep
// the opponent's reply from appearing before the player's own move animation
// has finished, so the game has a readable rhythm.
const THINK_MIN_MS = { beginner: 900, easy: 850, intermediate: 800, advanced: 700, max: 700 };

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function initApp() {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const Engine = EngineCore();
  const client = createEngineClient();

  /* ---------------------------------------------------------------- settings */
  const settings = {
    theme: 'dark',
    board: 'green',
    pieces: 'classic',
    coords: true,
    sound: true,
    autoFlip: false,
    showLegal: true,
    animate: true,
    mode: 'hvc',
    human: 'w',
    level: 'advanced',
    time: '10+0'
  };

  /* ------------------------------------------------------------------- state */
  const S = {
    pos: null,
    startFen: START_FEN,
    moves: [],
    redo: [],
    view: -1,
    viewPos: null,
    flip: false,
    selected: -1,
    targets: [],
    focus: { row: 6, col: 4 },
    hint: null,
    arrows: [],
    marks: [],
    drag: null,
    result: null,
    scoreWhite: 0,
    mateWhite: null,
    evalPoints: [],
    clocks: { on: false, w: 0, b: 0, inc: 0, base: 0, running: false, last: 0 },
    thinking: false,
    gen: 0,
    thinkTimer: null,
    pendingPromo: null,
    lastMove: null,
    skipAnim: false,
    analysis: null,
    analyzing: false,
    started: false
  };

  const dom = {};
  const ids = ['board', 'pieces', 'overlay', 'boardArea', 'status', 'live', 'toastHost',
    'promo', 'promoRow', 'banner', 'bannerTitle', 'bannerText', 'bannerAgain', 'bannerClose',
    'evalFill', 'evalNum', 'evalBar', 'graph', 'moveList', 'openingName', 'viewBadge',
    'topName', 'topCap', 'topMat', 'topClock', 'topAvatar', 'bottomName', 'bottomCap',
    'bottomMat', 'bottomClock', 'bottomAvatar', 'playerTop', 'playerBottom',
    'stDepth', 'stScore', 'stNodes', 'stNps', 'enginePv', 'thinkBadge', 'bookBadge',
    'analysisSummary', 'modeSel', 'levelSel', 'sideSel', 'sideField', 'timeSel',
    'autoFlip', 'showLegal', 'animOn', 'newBtn', 'undoBtn', 'redoBtn', 'flipBtn',
    'hintBtn', 'stopBtn', 'resignBtn', 'drawBtn', 'analyzeBtn', 'bestMoveBtn',
    'evalNowBtn', 'copyFenBtn', 'copyPgnBtn', 'importBtn', 'shareBtn', 'themeBtn',
    'soundBtn', 'helpBtn', 'dlgImport', 'importText', 'importError', 'menuBtn', 'appMenu', 'menuClose',
    'doImport', 'dlgHelp', 'firstBtn', 'prevBtn', 'nextBtn', 'lastBtn', 'testLink', 'customTime', 'customMin', 'customInc', 'pieceSel', 'boardSel', 'themeSel', 'coordsOn', 'boardShell', 'boardCol', 'playerTop', 'playerBottom', 'underboard'];
  ids.forEach((id) => { dom[id] = $(id); });

  const pieceEls = new Map();      // display index (0..63) -> element
  let squareEls = [];
  let toastTimer = null;

  /* ------------------------------------------------------------------ helpers */
  function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = 'toast' + (kind === 'err' ? ' err' : '');
    t.textContent = msg;
    dom.toastHost.appendChild(t);
    setTimeout(() => t.remove(), 3600);
    while (dom.toastHost.children.length > 3) dom.toastHost.firstChild.remove();
  }

  function announce(msg) {
    dom.live.textContent = '';
    setTimeout(() => { dom.live.textContent = msg; }, 20);
  }

  function flipped() { return S.flip; }

  /** Engine square for a display row/col (row 0 = top edge). */
  function sqAt(row, col) {
    const r = flipped() ? 7 - row : row;
    const c = flipped() ? 7 - col : col;
    return (7 - r) * 16 + c;
  }
  function rowColOf(sq) {
    const r = 7 - (sq >> 4), c = sq & 7;
    return flipped() ? [7 - r, 7 - c] : [r, c];
  }
  function displayIndex(sq) {
    const rc = rowColOf(sq);
    return rc[0] * 8 + rc[1];
  }

  /* Size the board from the space that is actually free instead of a hard
     coded "100dvh minus N", which is what kept the board small on big screens.
     JavaScript measures the shell (whose size is fixed by the flex/grid layout,
     not by the board) and writes --board-size. */
  let fitQueued = false;
  function fitBoard() {
    fitQueued = false;
    if (!dom.boardShell) return;
    if (!window.matchMedia('(min-width: 1000px)').matches) {
      document.documentElement.style.removeProperty('--board-size');
      return;
    }
    const col = dom.boardCol.getBoundingClientRect();
    if (col.width < 60 || col.height < 60) return;
    const gap = parseFloat(getComputedStyle(dom.boardCol).rowGap) || 6;
    const fixed = dom.playerTop.getBoundingClientRect().height +
      dom.playerBottom.getBoundingClientRect().height +
      dom.underboard.getBoundingClientRect().height + gap * 3;
    // The visible viewport is the hard ceiling: a stale column measurement
    // must never be allowed to push the bottom row off screen.
    const availH = Math.min(col.height, window.innerHeight) - fixed - 2;
    // >=1560px the layout is three columns (board | moves | controls), so the
    // board column is sized by its own content and cannot be measured for the
    // available width - derive it from the window instead.
    const availW = document.documentElement.classList.contains('three-col')
      ? window.innerWidth - COL_RAIL - COL_CONTROLS - COL_CHROME
      : col.width - 38;
    const size = Math.max(240, Math.floor(Math.min(availH, availW)));
    document.documentElement.style.setProperty('--board-size', size + 'px');
  }
  /* The app must be exactly as tall as the visible viewport, and the three
     column layout must only switch on when it does not cost board size. */
  const COL_RAIL = 258, COL_CONTROLS = 392, COL_CHROME = 38 + 20 + 24;
  const ROW_CHROME = 130;   // topbar + both player rows + status line + padding
  function setAppHeight() {
    document.documentElement.style.setProperty('--app-h', window.innerHeight + 'px');
    const freeWidth = window.innerWidth - COL_RAIL - COL_CONTROLS - COL_CHROME;
    const freeHeight = window.innerHeight - ROW_CHROME;
    // A little tolerance: losing <=40px of board to fill 300px of empty margin
    // on each side is a good trade.
    document.documentElement.classList.toggle('three-col', freeWidth >= freeHeight - 40);
  }

  function queueFit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(fitBoard);
  }

  function currentPos() {
    if (S.view === -1) return S.pos;
    if (!S.viewPos) {
      const rec = S.moves[S.view - 1];
      S.viewPos = rec ? Engine.fromFen(rec.fenAfter).pos : S.pos;
    }
    return S.viewPos;
  }

  function sideOfChar(ch) { return ch === ch.toUpperCase() ? 'w' : 'b'; }
  function other(s) { return s === 'w' ? 'b' : 'w'; }

  function historyFens() {
    const out = [S.startFen];
    for (let i = 0; i < S.moves.length - 1; i++) out.push(S.moves[i].fenAfter);
    return out;
  }

  /* -------------------------------------------------------------------- clock */
  function clockFromSpec(spec) {
    if (spec === 'none') return { on: false, w: 0, b: 0, inc: 0, base: 0, running: false, last: 0 };
    if (spec === 'custom') {
      const m = Math.max(1, Math.min(180, parseInt(dom.customMin.value, 10) || 10));
      const i = Math.max(0, Math.min(120, parseInt(dom.customInc.value, 10) || 0));
      const base = m * 60000;
      return { on: true, w: base, b: base, inc: i * 1000, base: base, running: false, last: 0 };
    }
    const parts = spec.split('+');
    const base = parseInt(parts[0], 10) * 60000;
    const inc = parseInt(parts[1] || '0', 10) * 1000;
    return { on: true, w: base, b: base, inc: inc, base: base, running: false, last: 0 };
  }

  function fmtClock(ms) {
    if (!isFinite(ms)) return '—';
    ms = Math.max(0, ms);
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (ms < 20000) return m + ':' + String(s).padStart(2, '0') + '.' + Math.floor((ms % 1000) / 100);
    return m + ':' + String(s).padStart(2, '0');
  }

  function tickClocks() {
    if (!S.clocks.on || !S.clocks.running || S.result || S.view !== -1) return;
    const now = Date.now();
    const dt = now - S.clocks.last;
    S.clocks.last = now;
    const turn = Engine.sideToMove(S.pos);
    S.clocks[turn] = Math.max(0, S.clocks[turn] - dt);
    if (S.clocks[turn] <= 0) {
      endGame('Time forfeit', (turn === 'w' ? 'Black' : 'White') + ' wins on time', 'timeout');
      return;
    }
    renderClocks();
  }

  /* ------------------------------------------------------------ board rendering */
  function buildBoard() {
    dom.board.innerHTML = '';
    squareEls = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const d = document.createElement('div');
        d.className = 'sq ' + (((r + c) & 1) ? 'dark' : 'light');
        d.dataset.row = String(r);
        d.dataset.col = String(c);
        d.setAttribute('role', 'gridcell');
        dom.board.appendChild(d);
        squareEls.push(d);
      }
    }
  }

  function setPieceTransform(el, row, col) {
    el.style.transform = 'translate3d(' + (col * 100) + '%, ' + (row * 100) + '%, 0)';
  }

  function renderPieces(animate) {
    const pos = currentPos();
    const chars = Engine.boardChars(pos);
    const want = new Array(64).fill('');

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const sq = sqAt(r, c);
        const ch = Engine.charAt(pos, sq);
        want[r * 8 + c] = ch || '';
      }
    }

    for (const [i, el] of Array.from(pieceEls)) {
      if (!want[i] || el.dataset.code !== want[i]) { el.remove(); pieceEls.delete(i); }
    }
    for (let i = 0; i < 64; i++) {
      if (!want[i] || pieceEls.has(i)) continue;
      const el = document.createElement('div');
      el.className = 'piece ' + (want[i] === want[i].toUpperCase() ? 'pw' : 'pb');
      el.dataset.code = want[i];
      el.dataset.sq = String(i);
      el.innerHTML = pieceSvgMarkup(want[i]);
      pieceEls.set(i, el);
      dom.pieces.appendChild(el);
      setPieceTransform(el, i >> 3, i & 7);
    }

    if (animate && S.lastMove && !S.skipAnim && settings.animate && S.view === -1) {
      const toIdx = displayIndex(S.lastMove.to);
      const fromIdx = displayIndex(S.lastMove.from);
      const el = pieceEls.get(toIdx);
      if (el) {
        const fr = fromIdx >> 3, fc = fromIdx & 7;
        el.classList.add('no-anim');
        setPieceTransform(el, fr, fc);
        void el.offsetWidth;
        el.classList.remove('no-anim');
        setPieceTransform(el, toIdx >> 3, toIdx & 7);
      }
    }
    S.skipAnim = false;
  }

  function renderCoords() {
    // Cheap: only 16 small labels, re-created when the board flips.
    for (const sq of squareEls) {
      const old = sq.querySelectorAll('.coord');
      for (const o of old) o.remove();
    }
    if (!settings.coords) return;
    for (let i = 0; i < 8; i++) {
      const rankSq = squareEls[i * 8];
      const rankLabel = document.createElement('span');
      rankLabel.className = 'coord rank';
      rankLabel.textContent = String(flipped() ? i + 1 : 8 - i);
      rankSq.appendChild(rankLabel);

      const fileSq = squareEls[56 + i];
      const fileLabel = document.createElement('span');
      fileLabel.className = 'coord file';
      fileLabel.textContent = String.fromCharCode(97 + (flipped() ? 7 - i : i));
      fileSq.appendChild(fileLabel);
    }
  }

  function renderHighlights() {
    const pos = currentPos();
    const turn = Engine.sideToMove(pos);
    const inCheck = Engine.inCheck(pos);
    const kingSq = Engine.kingSquare(pos, turn === 'w' ? 0 : 1);
    const last = S.lastMove;

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const sq = sqAt(r, c);
        const cell = squareEls[r * 8 + c];
        cell.classList.toggle('last', !!last && S.view === -1 && (sq === last.from || sq === last.to));
        cell.classList.toggle('sel', S.selected === sq);
        cell.classList.toggle('check', inCheck && sq === kingSq);
        cell.classList.toggle('focus', S.focus.row === r && S.focus.col === c);
        const oldDot = cell.querySelector('.dot');
        const oldRing = cell.querySelector('.ring');
        const isTarget = S.targets.indexOf(sq) >= 0;
        const hasPiece = Engine.charAt(pos, sq) !== '';
        if (isTarget && settings.showLegal && !hasPiece) {
          if (!oldDot) { const d = document.createElement('div'); d.className = 'dot'; cell.appendChild(d); }
          if (oldRing) oldRing.remove();
        } else if (isTarget && settings.showLegal && hasPiece) {
          if (!oldRing) { const d = document.createElement('div'); d.className = 'ring'; cell.appendChild(d); }
          if (oldDot) oldDot.remove();
        } else {
          if (oldDot) oldDot.remove();
          if (oldRing) oldRing.remove();
        }
        const label = Engine.charAt(pos, sq);
        cell.setAttribute('aria-label', label
          ? (label === label.toUpperCase() ? 'white ' : 'black ') + pieceName(label) + ' on ' + Engine.sqName(sq)
          : Engine.sqName(sq));
      }
    }
    renderOverlay();
  }

  function pieceName(ch) {
    const map = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
    return map[ch.toLowerCase()] || 'piece';
  }

  function sqCenter(sq) {
    const rc = rowColOf(sq);
    return [rc[1] + 0.5, rc[0] + 0.5];
  }

  function renderOverlay() {
    let svg = '';
    const drawArrow = (from, to, cls) => {
      const a = sqCenter(from), b = sqCenter(to);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 0.1) return;
      const ux = dx / len, uy = dy / len;
      const sx = a[0] + ux * 0.22, sy = a[1] + uy * 0.22;
      const ex = b[0] - ux * 0.34, ey = b[1] - uy * 0.34;
      const px = -uy, py = ux;
      const hx = ex - ux * 0.16, hy = ey - uy * 0.16;
      svg += '<line class="arrow ' + cls + '" x1="' + sx + '" y1="' + sy + '" x2="' + hx + '" y2="' + hy + '"/>';
      svg += '<polygon class="arrow ' + cls + '" style="fill:var(--' + (cls === 'engine' ? 'accent' : 'accent-2') + ')" points="' +
        ex + ',' + ey + ' ' + (hx + px * 0.14) + ',' + (hy + py * 0.14) + ' ' + (hx - px * 0.14) + ',' + (hy - py * 0.14) + '"/>';
    };
    if (S.hint) drawArrow(S.hint.from, S.hint.to, 'engine');
    for (const a of S.arrows) drawArrow(a[0], a[1], 'user');
    for (const m of S.marks) {
      const rc = rowColOf(m);
      svg += '<rect class="mark" x="' + rc[1] + '" y="' + rc[0] + '" width="1" height="1" rx="0.12"/>';
    }
    dom.overlay.innerHTML = svg;
  }

  /* ------------------------------------------------------------ panel rendering */
  function fmtScore(cp, mate) {
    if (mate !== null && mate !== undefined) return (mate > 0 ? '#' : '-#') + Math.abs(mate);
    const v = cp / 100;
    return (v > 0 ? '+' : '') + v.toFixed(2);
  }

  function evalPercent(cp, mate) {
    if (mate !== null && mate !== undefined) return mate > 0 ? 100 : 0;
    const p = 100 / (1 + Math.exp(-cp / 280));
    return Math.max(2, Math.min(98, p));
  }

  function renderEval() {
    const pct = evalPercent(S.scoreWhite, S.mateWhite);
    dom.evalFill.style.height = pct.toFixed(1) + '%';
    dom.evalBar.setAttribute('data-lead', S.scoreWhite < 0 ? 'b' : 'w');
    dom.evalNum.textContent = fmtScore(S.scoreWhite, S.mateWhite);
    dom.evalNum.classList.toggle('neg', S.scoreWhite < 0);
    dom.evalBar.setAttribute('aria-label', 'Evaluation ' + fmtScore(S.scoreWhite, S.mateWhite) + ' for white');
    renderGraph();
  }

  function renderGraph() {
    const pts = S.evalPoints;
    const grid = '<line x1="0" y1="8.5" x2="100" y2="8.5" stroke="var(--line)" stroke-width="0.5" opacity="0.55"/>' +
      '<line x1="0" y1="25.5" x2="100" y2="25.5" stroke="var(--line)" stroke-width="0.5" opacity="0.55"/>';
    const zero = grid + '<line x1="0" y1="17" x2="100" y2="17" stroke="var(--line)" stroke-width="0.6" stroke-dasharray="2 2"/>';
    // Even with no evaluations yet the box should read as a chart, not a hole.
    if (pts.length < 2) { dom.graph.innerHTML = zero; return; }
    const n = Math.max(pts.length - 1, 1);
    let d = '';
    for (let i = 0; i < pts.length; i++) {
      const x = (i / n) * 100;
      const pct = evalPercent(pts[i].cp, pts[i].mate) / 100;
      const y = 34 - pct * 34;
      d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
    }
    // A tall chart (three-column layout) reads better as a clean line; the
    // half-filled band only makes sense in the short strip version.
    const tall = dom.graph.getBoundingClientRect().height > 120;
    const area = tall ? '' : '<path d="' + d + 'L100 34 L0 34 Z" fill="var(--accent)" opacity="0.16"/>';
    dom.graph.innerHTML =
      area +
      '<path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="1.2" vector-effect="non-scaling-stroke"/>' +
      zero;
  }

  function renderClocks() {
    const turn = S.result ? null : Engine.sideToMove(S.pos);
    const bottom = flipped() ? 'b' : 'w';
    const top = other(bottom);
    const pairs = [[top, dom.topClock, dom.playerTop], [bottom, dom.bottomClock, dom.playerBottom]];
    for (const [side, clockEl, rowEl] of pairs) {
      if (!S.clocks.on) { clockEl.textContent = '∞'; clockEl.classList.remove('active', 'low'); continue; }
      clockEl.textContent = fmtClock(S.clocks[side]);
      clockEl.classList.toggle('active', S.clocks.running && turn === side && !S.result);
      clockEl.classList.toggle('low', S.clocks[side] < 30000);
      rowEl.classList.toggle('active', turn === side && !S.result && S.view === -1);
    }
  }

  function capturedInfo() {
    const lost = { w: [], b: [] };
    for (const m of S.moves) {
      if (!m.capturedChar) continue;
      const owner = sideOfChar(m.capturedChar);
      lost[owner].push(m.capturedChar);
    }
    // material balance from the live board
    const pos = S.view === -1 ? S.pos : currentPos();
    const chars = Engine.boardChars(pos);
    let bal = 0;
    for (const ch of chars) {
      if (!ch) continue;
      const v = PIECE_VALUE[ch.toLowerCase()] || 0;
      bal += ch === ch.toUpperCase() ? v : -v;
    }
    return { lost, bal };
  }

  function renderPlayers() {
    const bottomSide = flipped() ? 'b' : 'w';
    const topSide = other(bottomSide);
    const { lost, bal } = capturedInfo();
    // The pieces a player captured are the opponent's lost pieces.
    const topCaptured = lost[other(topSide)];
    const bottomCaptured = lost[other(bottomSide)];

    dom.topAvatar.textContent = topSide === 'w' ? 'W' : 'B';
    dom.bottomAvatar.textContent = bottomSide === 'w' ? 'W' : 'B';
    dom.topAvatar.className = 'player-avatar ' + topSide;
    dom.bottomAvatar.className = 'player-avatar ' + bottomSide;

    dom.topName.textContent = playerName(topSide);
    dom.bottomName.textContent = playerName(bottomSide);

    dom.topCap.innerHTML = topCaptured.map((c) => pieceSvgMarkup(c)).join('');
    dom.bottomCap.innerHTML = bottomCaptured.map((c) => pieceSvgMarkup(c)).join('');

    const balTxt = '+' + Math.abs(bal);
    dom.topMat.textContent = ((topSide === 'w' && bal > 0) || (topSide === 'b' && bal < 0)) ? balTxt : '';
    dom.bottomMat.textContent = ((bottomSide === 'w' && bal > 0) || (bottomSide === 'b' && bal < 0)) ? balTxt : '';
  }

  function playerName(side) {
    if (settings.mode === 'hvc') return side === settings.human ? 'You' : 'Engine · ' + LEVEL_LABELS[settings.level];
    if (settings.mode === 'cvc') return 'Engine · ' + LEVEL_LABELS[settings.level];
    return side === 'w' ? 'White' : 'Black';
  }

  function renderMoves() {
    const host = dom.moveList;
    host.innerHTML = '';
    if (!S.moves.length) {
      const p = document.createElement('div');
      p.className = 'empty-state';
      p.textContent = 'No moves yet. Drag a piece, or click one and then its destination.';
      host.appendChild(p);
      dom.openingName.textContent = openingName();
      return;
    }
    for (let i = 0; i < S.moves.length; i += 2) {
      const num = document.createElement('div');
      num.className = 'num';
      num.textContent = (i / 2 + 1) + '.';
      host.appendChild(num);
      for (let k = i; k < Math.min(i + 2, S.moves.length); k++) {
        const b = document.createElement('button');
        b.className = 'san';
        const label = S.moves[k].san;
        const mark = S.analysis && S.analysis.labels[k];
        b.textContent = label + (mark ? ' ' + mark.glyph : '');
        if (mark) {
          b.title = mark.text;
          b.style.color = mark.color;
        }
        if (S.view === k + 1) b.classList.add('current');
        b.dataset.index = String(k);
        b.addEventListener('click', () => setView(k + 1));
        host.appendChild(b);
      }
      if (i + 1 >= S.moves.length) {
        const pad = document.createElement('div');
        pad.className = 'san empty';
        host.appendChild(pad);
      }
    }
    dom.openingName.textContent = openingName();
    const cur = host.querySelector('.san.current');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function openingName() {
    if (!S.moves.length) return 'Start';
    try {
      let idx = S.view === -1 ? S.moves.length - 1 : S.view - 1;
      if (idx < 0) return 'Start';
      const p = Engine.fromFen(S.moves[idx].fenAfter);
      if (!p.ok) return '—';
      return Engine.bookName(p.pos) || '—';
    } catch (e) { return '—'; }
  }

  function renderStatus() {
    const pos = currentPos();
    const turn = Engine.sideToMove(pos);
    const inChk = Engine.inCheck(pos);
    let text;
    if (S.result) {
      text = S.result.text + ' — ' + S.result.title;
    } else if (S.view !== -1) {
      text = 'Reviewing move ' + S.view + ' of ' + S.moves.length + ' — press → or ⏭ to resume';
    } else if (S.analyzing) {
      text = 'Analyzing the game…';
    } else if (S.thinking) {
      text = 'Engine is thinking…';
    } else {
      text = (turn === 'w' ? 'White' : 'Black') + ' to move' + (inChk ? ' — check!' : '');
    }
    dom.status.textContent = text;
    dom.status.classList.toggle('warn', !!(S.result || (inChk && !S.result)));
    dom.viewBadge.hidden = S.view === -1;
    dom.stopBtn.hidden = !S.thinking;
    dom.undoBtn.disabled = !S.moves.length;
    dom.redoBtn.disabled = !S.redo.length;
    dom.hintBtn.disabled = !!S.result;
    dom.bestMoveBtn.disabled = !!S.result || S.thinking;
    dom.resignBtn.disabled = !!S.result;
    dom.drawBtn.disabled = !!S.result;
    dom.analyzeBtn.disabled = !S.moves.length || S.analyzing;
  }

  function renderBoard() {
    renderCoords();
    renderPieces(true);
    renderHighlights();
    renderPlayers();
    dom.banner.hidden = !S.result;
  }

  function renderAll() {
    renderBoard();
    renderMoves();
    renderClocks();
    renderEval();
    renderStatus();
    renderEnginePanel();
  }

  function renderEnginePanel() {
    dom.thinkBadge.hidden = !S.thinking;
  }

  /* ------------------------------------------------------------------ game flow */
  function applySettings(skipSave) {
    settings.mode = dom.modeSel.value;
    settings.level = dom.levelSel.value;
    settings.human = dom.sideSel.value;
    settings.time = dom.timeSel.value;
    settings.autoFlip = dom.autoFlip.checked;
    settings.showLegal = dom.showLegal.checked;
    settings.animate = dom.animOn.checked;
    settings.pieces = dom.pieceSel.value;
    settings.board = dom.boardSel.value;
    settings.theme = dom.themeSel.value;
    settings.coords = dom.coordsOn.checked;
    dom.sideField.style.display = settings.mode === 'hvc' ? '' : 'none';
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.dataset.board = settings.board;
    document.documentElement.dataset.pieces = settings.pieces;
    dom.pieceSel.value = settings.pieces;
    dom.boardSel.value = settings.board;
    dom.themeSel.value = settings.theme;
    dom.coordsOn.checked = settings.coords;
    dom.soundBtn.setAttribute('aria-pressed', String(!settings.sound));
    dom.autoFlip.checked = settings.autoFlip;
    dom.showLegal.checked = settings.showLegal;
    dom.animOn.checked = settings.animate;
    if (!skipSave) persist();
  }

  function newGame(fen, opts) {
    const target = fen || START_FEN;
    const r = Engine.fromFen(target);
    if (!r.ok) { toast(r.error, 'err'); return; }
    abortSearch();
    S.startFen = target;
    S.startKey = Engine.fenKey(r.pos);
    S.pos = r.pos;
    S.moves = [];
    S.redo = [];
    S.view = -1;
    S.viewPos = null;
    S.selected = -1;
    S.targets = [];
    S.hint = null;
    S.arrows = [];
    S.marks = [];
    S.result = null;
    S.lastMove = null;
    S.evalPoints = [];
    S.analysis = null;
    S.analyzing = false;
    S.started = false;
    S.clocks = clockFromSpec(settings.time);
    S.clocks.running = false;
    S.clocks.last = Date.now();
    S.scoreWhite = Engine.evaluateForWhite(S.pos);
    S.mateWhite = null;
    S.flip = settings.mode === 'hvc' ? settings.human === 'b' : false;
    dom.banner.hidden = true;
    dom.analysisSummary.hidden = true;
    dom.analysisSummary.textContent = '';
    dom.enginePv.textContent = 'Waiting for the engine…';
    dom.stDepth.textContent = '—';
    dom.stScore.textContent = '—';
    dom.stNodes.textContent = '—';
    dom.stNps.textContent = '—';
    client.restart();               // clean worker + fresh TT on every new game
    renderAll();
    persist();
    maybeStartEngine();
  }

  function commitMove(mv) {
    const pos = S.pos;
    const mover = Engine.sideToMove(pos);
    const from = Engine.moveFrom(mv), to = Engine.moveTo(mv);
    const flag = Engine.moveFlag(mv);
    const capturedChar = flag === 2 ? (mover === 'w' ? 'p' : 'P')
      : (Engine.charAt(pos, to) || '');
    const san = Engine.sanOf(pos, mv);
    const uci = Engine.moveToUci(mv);
    const isCap = !!capturedChar;

    if (S.clocks.on && S.started) S.clocks[mover] += S.clocks.inc;

    Engine.makeMove(pos, mv);
    S.moves.push({
      san: san, uci: uci, mv: mv, fenAfter: Engine.toFen(pos),
      key: Engine.fenKey(pos),
      capturedChar: isCap ? capturedChar : '', clock: [S.clocks.w, S.clocks.b]
    });
    S.redo.length = 0;
    S.lastMove = { from: from, to: to };
    S.selected = -1;
    S.targets = [];
    S.hint = null;
    if (settings.autoFlip) S.flip = Engine.sideToMove(S.pos) === 'b';
    if (S.clocks.on) { S.started = true; S.clocks.running = true; S.clocks.last = Date.now(); }

    const check = Engine.inCheck(S.pos);
    let snd = 'move';
    if (flag === 3 || flag === 4) snd = 'castle';
    else if (Engine.isCapture(mv)) snd = 'capture';
    else if (Engine.movePromotion(mv)) snd = 'promote';
    Sound.play(snd);
    if (check && !S.result) setTimeout(() => Sound.play('check'), 60);
    S.evalPoints.push({ cp: S.scoreWhite, mate: S.mateWhite, ply: S.moves.length });

    const ended = detectEnd();
    renderAll();
    if (!ended) {
      dom.live.textContent = san + (check ? ', check' : '') + '. ' +
        (Engine.sideToMove(S.pos) === 'w' ? 'White' : 'Black') + ' to move.';
    }
    persist();
    if (!ended) maybeStartEngine();
  }

  function repetitionCount() {
    const key = Engine.fenKey(S.pos);
    let n = 0;
    if (S.startKey === key) n++;
    for (const m of S.moves) {
      if (m.key === key) n++;
    }
    return n;
  }

  function detectEnd() {
    if (S.result) return true;
    const pos = S.pos;
    const legal = Engine.legalMoves(pos);
    if (!legal.length) {
      const turn = Engine.sideToMove(pos);
      if (Engine.inCheck(pos)) {
        endGame('Checkmate', (turn === 'w' ? 'Black' : 'White') + ' wins by checkmate', 'checkmate');
      } else {
        endGame('Stalemate', 'Draw — no legal moves but no check', 'stalemate');
      }
      return true;
    }
    if (Engine.halfmove(pos) >= 100) {
      endGame('Draw', 'Fifty moves without a capture or pawn move', 'fifty-move rule');
      return true;
    }
    if (Engine.insufficientMaterial(pos)) {
      endGame('Draw', 'Insufficient material to mate', 'insufficient material');
      return true;
    }
    if (repetitionCount() >= 3) {
      endGame('Draw', 'Threefold repetition', 'threefold repetition');
      return true;
    }
    return false;
  }

  function endGame(title, text, reason) {
    S.result = { title: title, text: text, reason: reason };
    S.clocks.running = false;
    S.thinking = false;
    dom.bannerTitle.textContent = title;
    dom.bannerText.textContent = text;
    dom.banner.hidden = false;
    announce(title + '. ' + text);
    Sound.play('end');
    abortSearch();
    persist();
  }

  function resultString() {
    if (!S.result) return '*';
    const t = S.result.title;
    if (t === 'Checkmate') return S.moves.length % 2 === 1 ? '1-0' : '0-1';
    if (t === 'Time forfeit' || t === 'Resignation') {
      // winner was encoded in the text
      return /Black/.test(S.result.text) ? '0-1' : '1-0';
    }
    return '1/2-1/2';
  }

  /* ----------------------------------------------------------------- engine I/O */
  function abortSearch() {
    if (S.thinkTimer) { clearTimeout(S.thinkTimer); S.thinkTimer = null; }
    S.gen++;
    if (S.thinking) client.stop();
    S.thinking = false;
    dom.thinkBadge.hidden = true;
    dom.stopBtn.hidden = true;
  }

  function engineLimits() {
    // Max gets a bigger budget; the level presets cover the rest.
    if (settings.level === 'max') return { depth: 50, timeMs: 3000 };
    return {};
  }

  function requestEngine(opts) {
    opts = opts || {};
    const started = performance.now();
    const fen = Engine.toFen(S.pos);
    const gen = ++S.gen;
    S.thinking = true;
    dom.thinkBadge.hidden = false;
    dom.stopBtn.hidden = false;
    dom.bestMoveBtn.disabled = true;
    const level = settings.level;
    const body = {
      fen: fen,
      history: historyFens(),
      level: level,
      analysis: !!opts.analysis,
      useBook: opts.useBook !== false,
      limits: opts.limits || engineLimits()
    };
    client.search(body, {
      onInfo(info) {
        if (gen !== S.gen) return;
        const side = Engine.sideToMove(S.pos);
        const sign = side === 'w' ? 1 : -1;
        S.scoreWhite = Math.round(info.score * sign);
        S.mateWhite = info.mate === null ? null : info.mate * sign;
        dom.stDepth.textContent = String(info.depth) + '/' + info.seldepth;
        dom.stScore.textContent = fmtScore(S.scoreWhite, S.mateWhite);
        dom.stScore.className = S.scoreWhite >= 0 ? 'pos' : 'neg';
        dom.stNodes.textContent = fmtNum(info.nodes);
        dom.stNps.textContent = fmtNum(info.nps);
        dom.enginePv.innerHTML = '<b>' + info.depth + '.</b> ' + info.pvSan.slice(0, 10).join(' ');
        renderEval();
      }
    }).then((msg) => {
      if (gen !== S.gen) return;
      const finishThinking = () => {
        S.thinking = false;
        dom.thinkBadge.hidden = true;
        dom.stopBtn.hidden = true;
        dom.bestMoveBtn.disabled = false;
      };
      const side = Engine.sideToMove(S.pos);
      const sign = side === 'w' ? 1 : -1;
      if (typeof msg.score === 'number' && !msg.book) {
        S.scoreWhite = Math.round(msg.score * sign);
        S.mateWhite = msg.mate === null || msg.mate === undefined ? null : msg.mate * sign;
      }
      const isBook = !!msg.book;
      dom.stDepth.textContent = isBook ? 'book' : String(msg.depth || 0);
      dom.stScore.textContent = isBook ? '=' : fmtScore(S.scoreWhite, S.mateWhite);
      dom.stScore.className = S.scoreWhite >= 0 ? 'pos' : 'neg';
      dom.stNodes.textContent = isBook ? '—' : fmtNum(msg.nodes || 0);
      dom.stNps.textContent = isBook ? '—' : fmtNum(msg.nps || 0);
      dom.enginePv.innerHTML = isBook
        ? '<b>book</b> ' + (msg.pvSan || []).join(' ')
        : ((msg.pvSan && msg.pvSan.length)
          ? '<b>' + (msg.depth || 0) + '.</b> ' + msg.pvSan.slice(0, 10).join(' ')
          : '—');
      dom.bookBadge.hidden = !isBook;
      renderEval();
      if (S.view !== -1 || S.result) { finishThinking(); renderStatus(); return; }
      if (msg.none || !msg.uci) { finishThinking(); detectEnd(); renderStatus(); return; }
      if (opts.analysis) {
        // suggestion only
        const legal = Engine.legalMoves(S.pos);
        const mv = legal.find((m) => Engine.moveToUci(m) === msg.uci);
        if (mv) {
          S.hint = { from: Engine.moveFrom(mv), to: Engine.moveTo(mv) };
          renderHighlights();
        }
        renderStatus();
        finishThinking();
        return;
      }
      const applyBest = () => {
        finishThinking();
        const legal = Engine.legalMoves(S.pos);
        const mv = legal.find((m) => Engine.moveToUci(m) === msg.uci);
        if (!mv) { detectEnd(); renderAll(); return; }
        commitMove(mv);
      };
      const minThink = THINK_MIN_MS[settings.level] || 600;
      const wait = Math.max(0, minThink - (performance.now() - started));
      if (wait > 0) {
        S.thinkTimer = setTimeout(() => {
          S.thinkTimer = null;
          if (gen === S.gen) applyBest();
        }, wait);
      } else {
        applyBest();
      }
    }).catch((err) => {
      if (gen !== S.gen) return;
      S.thinking = false;
      dom.thinkBadge.hidden = true;
      dom.stopBtn.hidden = true;
      dom.bestMoveBtn.disabled = false;
      if (String(err.message) !== 'cancelled') toast('Engine error: ' + err.message, 'err');
    });
  }

  function fmtNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  function engineToMove() {
    if (S.result || S.view !== -1) return false;
    if (settings.mode === 'hvc') return Engine.sideToMove(S.pos) !== settings.human;
    if (settings.mode === 'cvc') return true;
    return false;
  }

  function maybeStartEngine() {
    if (S.result || S.view !== -1) return;
    if (settings.mode === 'analysis') { requestEngine({ analysis: true, useBook: false }); return; }
    if (!engineToMove() || S.thinking) return;
    requestEngine({});
  }

  /* ------------------------------------------------------------------ input */
  function canHumanMove() {
    if (S.result || S.view !== -1 || S.analyzing) return false;
    if (settings.mode === 'cvc') return false;
    if (settings.mode === 'hvc') return Engine.sideToMove(S.pos) === settings.human;
    return true;
  }

  function selectSquare(sq) {
    const pos = currentPos();
    S.selected = sq;
    const legal = Engine.legalMoves(pos);
    S.targets = legal.filter((m) => Engine.moveFrom(m) === sq).map((m) => Engine.moveTo(m));
    renderHighlights();
  }

  function clearSelection() {
    S.selected = -1;
    S.targets = [];
    renderHighlights();
  }

  function tryMove(from, to) {
    if (!canHumanMove()) return false;
    const legal = Engine.legalMoves(S.pos);
    const matches = legal.filter((m) => Engine.moveFrom(m) === from && Engine.moveTo(m) === to);
    if (!matches.length) return false;
    if (matches.length > 1) { showPromotion(matches); return true; }
    commitMove(matches[0]);
    return true;
  }

  function showPromotion(matches) {
    S.pendingPromo = matches;
    renderPieces(false);             // put the dragged piece back in place
    dom.promoRow.innerHTML = '';
    const color = Engine.sideToMove(S.pos) === 'w' ? 'Q' : 'q';
    const order = ['q', 'r', 'b', 'n'];
    for (const t of order) {
      const ch = color === 'Q' ? t.toUpperCase() : t;
      const mv = matches.find((m) => Engine.movePromotion(m) === { q: 5, r: 4, b: 3, n: 2 }[t]);
      if (!mv) continue;
      const b = document.createElement('button');
      b.className = 'promo-btn';
      b.setAttribute('aria-label', 'Promote to ' + pieceName(t));
      b.innerHTML = pieceSvgMarkup(ch);
      b.addEventListener('click', () => {
        dom.promo.hidden = true;
        S.pendingPromo = null;
        commitMove(mv);
      });
      dom.promoRow.appendChild(b);
    }
    dom.promo.hidden = false;
    const first = dom.promoRow.querySelector('button');
    if (first) first.focus();
  }

  function squareFromClient(clientX, clientY) {
    const rect = dom.boardArea.getBoundingClientRect();
    const size = rect.width / 8;
    let col = Math.floor((clientX - rect.left) / size);
    let row = Math.floor((clientY - rect.top) / size);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return { row: row, col: col };
  }

  let dragState = null;

  function onPointerDown(e) {
    if (S.view !== -1) { setView(-1); return; }
    if (S.pendingPromo) return;
    const hit = squareFromClient(e.clientX, e.clientY);
    if (!hit) return;
    const sq = sqAt(hit.row, hit.col);
    const pos = currentPos();
    const ch = Engine.charAt(pos, sq);

    // right button: arrows / square marks
    if (e.button === 2 || (e.pointerType === 'touch' && e.altKey)) {
      dragState = { mode: 'arrow', from: sq, to: sq, moved: false, pointerId: e.pointerId };
      try { dom.boardArea.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    // clear annotations on a normal click
    if (S.arrows.length || S.marks.length) { S.arrows = []; S.marks = []; renderOverlay(); }

    if (S.selected >= 0 && S.targets.indexOf(sq) >= 0) {
      const from = S.selected;
      clearSelection();
      tryMove(from, sq);
      e.preventDefault();
      return;
    }
    if (S.selected === sq) { clearSelection(); return; }
    if (ch && sideOfChar(ch) === Engine.sideToMove(pos) && canHumanMove()) {
      selectSquare(sq);
      Sound.unlock();
      if (settings.animate) {
        const idx = displayIndex(sq);
        const el = pieceEls.get(idx);
        if (el) {
          dragState = {
            mode: 'drag', from: sq, el: el, pointerId: e.pointerId,
            startX: e.clientX, startY: e.clientY, active: false
          };
          try { dom.boardArea.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
        }
      }
      e.preventDefault();
      return;
    }
    clearSelection();
  }

  function onPointerMove(e) {
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    if (dragState.mode === 'arrow') {
      const hit = squareFromClient(e.clientX, e.clientY);
      if (!hit) return;
      dragState.to = sqAt(hit.row, hit.col);
      dragState.moved = dragState.to !== dragState.from;
      S.arrows = dragState.moved ? [[dragState.from, dragState.to]] : [];
      S.marks = dragState.moved ? [] : [dragState.from];
      renderOverlay();
      return;
    }
    if (dragState.mode === 'drag') {
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      if (!dragState.active && Math.hypot(dx, dy) < 5) return;
      if (!dragState.active) {
        dragState.active = true;
        dragState.el.classList.add('dragging');
      }
      const rect = dom.boardArea.getBoundingClientRect();
      const size = rect.width / 8;
      const x = e.clientX - rect.left - size / 2;
      const y = e.clientY - rect.top - size / 2;
      dragState.el.style.transform = 'translate3d(' + x + 'px, ' + y + 'px, 0)';
      const hit = squareFromClient(e.clientX, e.clientY);
      if (hit) {
        const sq = sqAt(hit.row, hit.col);
        if (S.targets.indexOf(sq) >= 0 && !dragState.hover) {
          dragState.hover = sq;
        }
      }
      e.preventDefault();
    }
  }

  function onPointerUp(e) {
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    const st = dragState;
    dragState = null;
    try { dom.boardArea.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }

    if (st.mode === 'arrow') {
      if (st.moved) S.arrows = [[st.from, st.to]];
      else { S.marks = [st.from]; S.arrows = []; }
      renderOverlay();
      return;
    }
    if (st.mode === 'drag') {
      st.el.classList.remove('dragging');
      const hit = squareFromClient(e.clientX, e.clientY);
      // Accept a release on a legal target even when no pointermove was seen
      // (fast flicks on touch screens, and synthetic events in tests).
      if (hit) {
        const to = sqAt(hit.row, hit.col);
        if (to !== st.from && S.targets.indexOf(to) >= 0) {
          S.skipAnim = true;
          if (!tryMove(st.from, to)) { renderPieces(false); }
          return;
        }
      }
      // snap back
      const rc = rowColOf(st.from);
      setPieceTransform(st.el, rc[0], rc[1]);
      if (st.active) soundless();
    }
  }

  function soundless() { /* dropping on an illegal square is silent */ }

  function onKeyDown(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'Escape') {
      if (S.pendingPromo) { dom.promo.hidden = true; S.pendingPromo = null; }
      clearSelection();
      if (S.arrows.length || S.marks.length) { S.arrows = []; S.marks = []; renderOverlay(); }
      return;
    }
    // With the board focused the arrows move a keyboard cursor; everywhere else
    // they step through the game history. Same keys, two obvious contexts.
    if (document.activeElement === dom.board) {
      if (e.key === 'ArrowUp') { S.focus.row = (S.focus.row + 7) % 8; e.preventDefault(); renderHighlights(); return; }
      if (e.key === 'ArrowDown') { S.focus.row = (S.focus.row + 1) % 8; e.preventDefault(); renderHighlights(); return; }
      if (e.key === 'ArrowLeft') { S.focus.col = (S.focus.col + 7) % 8; e.preventDefault(); renderHighlights(); return; }
      if (e.key === 'ArrowRight') { S.focus.col = (S.focus.col + 1) % 8; e.preventDefault(); renderHighlights(); return; }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const sq = sqAt(S.focus.row, S.focus.col);
        if (S.selected >= 0 && S.targets.indexOf(sq) >= 0) {
          const from = S.selected;
          clearSelection();
          tryMove(from, sq);
        } else if (S.selected === sq) clearSelection();
        else if (canHumanMove()) selectSquare(sq);
        return;
      }
    }
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepView(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepView(1); }
  }

  function stepView(delta) {
    const target = Math.max(-1, Math.min(S.moves.length, (S.view === -1 ? S.moves.length : S.view) + delta));
    setView(target);
  }

  function setView(index) {
    if (index >= S.moves.length) index = -1;
    S.view = index;
    S.viewPos = null;
    clearSelection();
    S.hint = null;
    const live = index === -1;
    if (live) maybeStartEngine();
    else abortSearch();
    renderAll();
  }

  /* -------------------------------------------------------------- undo / redo */
  function undoMove() {
    if (!S.moves.length) return;
    abortSearch();
    S.result = null;
    dom.banner.hidden = true;
    let n = 1;
    if (settings.mode === 'hvc') n = 2;
    let undone = 0;
    while (S.moves.length && undone < n) {
      const rec = S.moves.pop();
      Engine.unmakeMove(S.pos, rec.mv);
      S.redo.push(rec);
      undone++;
      if (settings.mode !== 'hvc' && undone >= n) break;
    }
    if (settings.mode === 'hvc' && Engine.sideToMove(S.pos) !== settings.human && S.moves.length) {
      const rec = S.moves.pop();
      Engine.unmakeMove(S.pos, rec.mv);
      S.redo.push(rec);
    }
    const last = S.moves[S.moves.length - 1];
    S.lastMove = last ? { from: Engine.moveFrom(last.mv), to: Engine.moveTo(last.mv) } : null;
    S.view = -1;
    S.viewPos = null;
    S.hint = null;
    S.evalPoints = S.evalPoints.slice(0, S.moves.length + 1);
    S.scoreWhite = Engine.evaluateForWhite(S.pos);
    S.mateWhite = null;
    if (S.clocks.on) {
      const prev = S.moves[S.moves.length - 1];
      if (prev) {
        S.clocks.w = prev.clock[0];
        S.clocks.b = prev.clock[1];
        S.clocks.running = true;
        S.clocks.last = Date.now();
      } else {
        S.clocks = clockFromSpec(settings.time);
        S.clocks.running = false;
        S.started = false;
      }
    }
    renderAll();
    persist();
  }

  function redoMove() {
    if (!S.redo.length) return;
    abortSearch();
    const rec = S.redo.pop();
    Engine.makeMove(S.pos, rec.mv);
    S.moves.push(rec);
    S.view = -1;
    S.viewPos = null;
    S.lastMove = { from: Engine.moveFrom(rec.mv), to: Engine.moveTo(rec.mv) };
    S.evalPoints.push({ cp: S.scoreWhite, mate: S.mateWhite, ply: S.moves.length });
    const ended = detectEnd();
    renderAll();
    persist();
    if (!ended) maybeStartEngine();
  }

  /* ---------------------------------------------------------------- serialise */
  function persist() {
    const data = {
      v: 1,
      startFen: S.startFen,
      moves: S.moves.map((m) => m.uci),
      settings: Object.assign({}, settings, { customMin: dom.customMin.value, customInc: dom.customInc.value }),
      clocks: { w: S.clocks.w, b: S.clocks.b, base: S.clocks.base, inc: S.clocks.inc, on: S.clocks.on },
      result: S.result ? { title: S.result.title, text: S.result.text, reason: S.result.reason } : null
    };
    Store.write(data);
    try {
      const fen = Engine.toFen(S.pos);
      history.replaceState(null, '', '#fen=' + encodeURIComponent(fen));
    } catch (e) { /* file:// may refuse; ignore */ }
  }

  function restore() {
    let hashFen = null;
    try {
      const h = decodeURIComponent(location.hash.replace(/^#fen=/, ''));
      if (location.hash.indexOf('#fen=') === 0 && h) hashFen = h;
    } catch (e) { /* ignore */ }

    const stored = Store.read();
    if (stored && stored.settings) Object.assign(settings, stored.settings);

    // 1. Restore the saved game first, with its full move list, so a reload
    //    keeps the history rather than only the position.
    let restoredGame = false;
    if (stored && stored.startFen) {
      const r = Engine.fromFen(stored.startFen);
      if (r.ok) {
        S.pos = r.pos;
        S.startFen = stored.startFen;
        S.startKey = Engine.fenKey(r.pos);
        S.clocks = clockFromSpec(settings.time);
        if (stored.clocks && stored.clocks.on && S.clocks.on) {
          S.clocks.w = stored.clocks.w;
          S.clocks.b = stored.clocks.b;
        }
        S.scoreWhite = Engine.evaluateForWhite(S.pos);
        let ok = true;
        for (const uci of (stored.moves || [])) {
          const mv = Engine.legalMoves(S.pos).find((m) => Engine.moveToUci(m) === uci);
          if (!mv) { ok = false; break; }
          const san = Engine.sanOf(S.pos, mv);
          const to = Engine.moveTo(mv);
          const capturedChar = Engine.moveFlag(mv) === 2
            ? (Engine.sideToMove(S.pos) === 'w' ? 'p' : 'P')
            : (Engine.charAt(S.pos, to) || '');
          const mover = Engine.sideToMove(S.pos);
          Engine.makeMove(S.pos, mv);
          S.moves.push({
            san: san, uci: uci, mv: mv, fenAfter: Engine.toFen(S.pos),
            key: Engine.fenKey(S.pos),
            capturedChar: capturedChar, clock: [S.clocks.w, S.clocks.b], mover: mover
          });
        }
        if (!ok) { S.moves = []; S.pos = Engine.fromFen(S.startFen).pos; }
        const last = S.moves[S.moves.length - 1];
        S.lastMove = last ? { from: Engine.moveFrom(last.mv), to: Engine.moveTo(last.mv) } : null;
        S.started = S.moves.length > 0;
        restoredGame = true;
      }
    }

    // 2. A hash that points at a different position means somebody shared a
    //    link: that position wins and starts a fresh game.
    if (hashFen) {
      const r = Engine.fromFen(hashFen);
      if (r.ok) {
        const sameAsSaved = restoredGame && Engine.toFen(S.pos) === hashFen;
        if (!sameAsSaved) {
          S.startFen = hashFen;
          S.startKey = Engine.fenKey(r.pos);
          S.pos = r.pos;
          S.moves = [];
          S.redo = [];
          S.evalPoints = [];
          S.result = null;
          S.lastMove = null;
          S.clocks = clockFromSpec(settings.time);
          S.started = false;
          S.scoreWhite = Engine.evaluateForWhite(S.pos);
        }
        return;
      }
    }

    if (!restoredGame) {
      S.clocks = clockFromSpec(settings.time);
      S.scoreWhite = Engine.evaluateForWhite(S.pos);
    }
  }

  /* -------------------------------------------------------------------- PGN */
  function pgnDate() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate());
  }

  function pgnText(headers, sans, result) {
    return pgnBuildText(headers, sans, result, S.startFen);
  }

  function exportPgn() {
    const headers = {
      Event: 'Chess Lab game',
      Site: 'Local',
      Date: pgnDate(),
      Round: '-',
      White: playerName('w'),
      Black: playerName('b'),
      Result: resultString()
    };
    return pgnText(headers, S.moves.map((m) => m.san), headers.Result);
  }

  function parsePgn(text) {
    return pgnParseText(Engine, text);
  }

  function loadPgn(text) {
    const parsed = parsePgn(text);
    if (!parsed.ok) { toast(parsed.error, 'err'); return false; }
    const r = Engine.fromFen(parsed.startFen);
    if (!r.ok) { toast(r.error, 'err'); return false; }
    abortSearch();
    S.startFen = parsed.startFen;
    S.startKey = Engine.fenKey(r.pos);
    S.pos = r.pos;
    S.moves = [];
    S.redo = [];
    S.result = null;
    S.evalPoints = [];
    S.analysis = null;
    S.hint = null;
    S.lastMove = null;
    S.clocks = clockFromSpec(settings.time);
    S.started = false;
    for (const san of parsed.sans) {
      const mv = Engine.parseSan(S.pos, san);
      if (!mv) break;
      const to = Engine.moveTo(mv);
      const capturedChar = Engine.moveFlag(mv) === 2
        ? (Engine.sideToMove(S.pos) === 'w' ? 'p' : 'P')
        : (Engine.charAt(S.pos, to) || '');
      Engine.makeMove(S.pos, mv);
      S.moves.push({
        san: san, uci: Engine.moveToUci(mv), mv: mv, fenAfter: Engine.toFen(S.pos),
        key: Engine.fenKey(S.pos),
        capturedChar: capturedChar, clock: [S.clocks.w, S.clocks.b]
      });
    }
    const last = S.moves[S.moves.length - 1];
    S.lastMove = last ? { from: Engine.moveFrom(last.mv), to: Engine.moveTo(last.mv) } : null;
    S.view = -1;
    S.viewPos = null;
    dom.banner.hidden = true;
    S.scoreWhite = Engine.evaluateForWhite(S.pos);
    S.mateWhite = null;
    renderAll();
    detectEnd();
    renderAll();
    persist();
    toast('Loaded ' + S.moves.length + ' moves');
    maybeStartEngine();
    return true;
  }

  /* -------------------------------------------------------------- game analysis */
  function mateToCp(score, mate) {
    if (mate === null || mate === undefined) return score;
    return mate > 0 ? 10000 - Math.abs(mate) * 50 : -10000 + Math.abs(mate) * 50;
  }

  function classify(cpLoss) {
    if (cpLoss <= 10) return { key: 'best', glyph: '', text: 'Best', color: '' };
    if (cpLoss <= 45) return { key: 'good', glyph: '', text: 'Good', color: '' };
    if (cpLoss <= 100) return { key: 'inaccuracy', glyph: '?!', text: 'Inaccuracy', color: 'var(--accent-2)' };
    if (cpLoss <= 220) return { key: 'mistake', glyph: '?', text: 'Mistake', color: 'var(--danger)' };
    return { key: 'blunder', glyph: '??', text: 'Blunder', color: 'var(--danger)' };
  }

  function winPercent(cp) {
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
  }

  function accuracyFrom(pctBefore, pctAfter) {
    const diff = Math.abs(pctBefore - pctAfter);
    const raw = 103.1668 * Math.exp(-0.04354 * diff) - 3.1669;
    return Math.max(0, Math.min(100, raw));
  }

  async function analyzeGame() {
    if (!S.moves.length || S.analyzing) return;
    S.analyzing = true;
    abortSearch();
    renderStatus();
    const positions = [S.startFen].concat(S.moves.map((m) => m.fenAfter));
    const evals = [];
    try {
      for (let i = 0; i < positions.length; i++) {
        const r = Engine.fromFen(positions[i]);
        if (!r.ok) throw new Error(r.error);
        const side = Engine.sideToMove(r.pos);
        const msg = await client.search({
          fen: positions[i],
          history: positions.slice(0, i),
          level: 'advanced',
          analysis: true,
          useBook: false,
          limits: { depth: 50, timeMs: 220 }
        });
        const cp = mateToCp(msg.score || 0, msg.mate) * (side === 'w' ? 1 : -1);
        evals.push(cp);
        dom.status.textContent = 'Analyzing… ' + (i + 1) + ' / ' + positions.length;
        dom.status.classList.remove('warn');
      }
    } catch (err) {
      S.analyzing = false;
      toast('Analysis failed: ' + err.message, 'err');
      renderStatus();
      return;
    }

    const labels = [];
    let accW = 0, accB = 0, nW = 0, nB = 0;
    for (let i = 0; i < S.moves.length; i++) {
      const side = Engine.sideToMove(Engine.fromFen(positions[i]).pos);
      const sign = side === 'w' ? 1 : -1;
      const before = evals[i] * sign;
      const after = evals[i + 1] * sign;
      const loss = Math.max(0, before - after);
      const label = classify(loss);
      label.cpLoss = Math.round(loss);
      labels.push(label);
      const p1 = winPercent(evals[i] * sign);
      const p2 = winPercent(evals[i + 1] * sign);
      const acc = accuracyFrom(p1, p2);
      if (side === 'w') { accW += acc; nW++; } else { accB += acc; nB++; }
    }
    S.analysis = {
      evals: evals,
      labels: labels,
      accuracy: { w: nW ? accW / nW : 100, b: nB ? accB / nB : 100 }
    };
    S.analyzing = false;
    renderAll();
    const summary = dom.analysisSummary;
    summary.hidden = false;
    const inacc = labels.filter((l) => l.key === 'inaccuracy').length;
    const mist = labels.filter((l) => l.key === 'mistake').length;
    const blun = labels.filter((l) => l.key === 'blunder').length;
    summary.innerHTML = 'Accuracy: <b>White ' + S.analysis.accuracy.w.toFixed(1) + '%</b> · ' +
      '<b>Black ' + S.analysis.accuracy.b.toFixed(1) + '%</b><br>' +
      inacc + ' inaccuracies, ' + mist + ' mistakes, ' + blun + ' blunders.';
    dom.status.textContent = 'Analysis complete';
    toast('Analysis complete — ' + blun + ' blunders found');
  }

  /* ------------------------------------------------------------------ dialogs */
  function openImport() {
    dom.importText.value = '';
    dom.importError.hidden = true;
    if (!dom.dlgImport.open) dom.dlgImport.showModal();
    setTimeout(() => dom.importText.focus(), 30);
  }

  function doImport() {
    const text = dom.importText.value.trim();
    if (!text) { dom.importError.hidden = false; dom.importError.textContent = 'Paste a FEN or a PGN first.'; return; }
    // Heuristic: PGN has headers or move numbers; FEN has 4+ space separated fields
    const looksPgn = /\[Event|\[FEN|\[Result|\d+\.\s*[a-hKQRBNO]/.test(text);
    if (looksPgn) {
      if (!loadPgn(text)) {
        dom.importError.hidden = false;
        dom.importError.textContent = 'That PGN could not be read. Check the move numbers and SAN.';
        return;
      }
    } else {
      const r = Engine.fromFen(text);
      if (!r.ok) {
        dom.importError.hidden = false;
        dom.importError.textContent = r.error;
        return;
      }
      newGame(text);
    }
    dom.dlgImport.close();
  }

  /* ------------------------------------------------------------------ copy utils */
  async function copyText(text, label) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast(label + ' copied');
    } catch (e) {
      toast('Could not copy: ' + e.message, 'err');
    }
  }

  /* ------------------------------------------------------------------ wiring */
  function wire() {
    buildBoard();

    dom.boardArea.addEventListener('pointerdown', onPointerDown);
    dom.boardArea.addEventListener('pointermove', onPointerMove);
    dom.boardArea.addEventListener('pointerup', onPointerUp);
    dom.boardArea.addEventListener('pointercancel', onPointerUp);
    dom.boardArea.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.boardArea.addEventListener('dragstart', (e) => e.preventDefault());
    document.addEventListener('keydown', onKeyDown);

    dom.modeSel.addEventListener('change', () => {
      applySettings();
      S.flip = settings.mode === 'hvc' ? settings.human === 'b' : false;
      renderAll();
      maybeStartEngine();
    });
    dom.levelSel.addEventListener('change', () => { applySettings(); restartIfEngineTurn(); });
    dom.sideSel.addEventListener('change', () => {
      applySettings();
      S.flip = settings.human === 'b';
      renderAll();
      restartIfEngineTurn();
    });
    dom.timeSel.addEventListener('change', () => {
      const hadMoves = S.moves.length > 0;
      dom.customTime.hidden = dom.timeSel.value !== 'custom';
      applySettings();
      if (!hadMoves) {
        S.clocks = clockFromSpec(settings.time);
        S.clocks.running = false;
        renderClocks();
      } else {
        toast('Time control applies to the next game');
      }
    });
    const onCustomChange = () => {
      if (dom.timeSel.value !== 'custom') return;
      applySettings();
      if (!S.moves.length) { S.clocks = clockFromSpec('custom'); S.clocks.running = false; renderClocks(); }
    };
    dom.customMin.addEventListener('change', onCustomChange);
    dom.customInc.addEventListener('change', onCustomChange);

    dom.autoFlip.addEventListener('change', () => { applySettings(); if (settings.autoFlip) S.flip = Engine.sideToMove(S.pos) === 'b'; renderAll(); });
    dom.showLegal.addEventListener('change', () => { applySettings(); renderHighlights(); });
    dom.animOn.addEventListener('change', () => applySettings());

    dom.newBtn.addEventListener('click', () => newGame(START_FEN));
    dom.bannerAgain.addEventListener('click', () => newGame(START_FEN));
    dom.bannerClose.addEventListener('click', () => { dom.banner.hidden = true; });
    dom.undoBtn.addEventListener('click', undoMove);
    dom.redoBtn.addEventListener('click', redoMove);
    dom.flipBtn.addEventListener('click', () => {
      S.flip = !S.flip;
      rebuildPieces();
      renderAll();
    });
    dom.hintBtn.addEventListener('click', () => {
      if (S.result) return;
      if (S.thinking) { toast('Already searching'); return; }
      requestEngine({ analysis: true, useBook: false, limits: { depth: 50, timeMs: 700 } });
    });
    dom.bestMoveBtn.addEventListener('click', () => {
      if (S.result || S.thinking) return;
      requestEngine({ analysis: false, useBook: false });
    });
    dom.evalNowBtn.addEventListener('click', () => {
      if (S.thinking) return;
      requestEngine({ analysis: true, useBook: false, limits: { depth: 50, timeMs: 900 } });
    });
    dom.stopBtn.addEventListener('click', () => {
      client.stop();
      toast('Stopping at the end of this iteration');
    });
    dom.resignBtn.addEventListener('click', () => {
      if (S.result) return;
      const loser = settings.mode === 'hvc' ? settings.human : Engine.sideToMove(S.pos);
      abortSearch();
      endGame('Resignation', (loser === 'w' ? 'Black' : 'White') + ' wins by resignation', 'resignation');
      renderAll();
    });
    dom.drawBtn.addEventListener('click', async () => {
      if (S.result) return;
      if (settings.mode !== 'hvc') {
        endGame('Draw', 'Draw by agreement', 'agreement');
        renderAll();
        return;
      }
      const fen = Engine.toFen(S.pos);
      try {
        const msg = await client.search({
          fen: fen, history: historyFens(), level: settings.level,
          analysis: true, useBook: false, limits: { depth: 50, timeMs: 400 }
        });
        const side = Engine.sideToMove(Engine.fromFen(fen).pos);
        const cp = (msg.score || 0) * (side === 'w' ? 1 : -1);
        if (cp <= -40) {
          endGame('Draw', 'Draw by agreement', 'agreement');
          toast('The engine accepts the draw');
        } else {
          toast('The engine declines the draw offer');
        }
        renderAll();
      } catch (e) { toast('Draw offer failed: ' + e.message, 'err'); }
    });
    dom.analyzeBtn.addEventListener('click', analyzeGame);

    dom.copyFenBtn.addEventListener('click', () => copyText(Engine.toFen(S.pos), 'FEN'));
    dom.copyPgnBtn.addEventListener('click', () => copyText(exportPgn(), 'PGN'));
    dom.importBtn.addEventListener('click', openImport);
    dom.doImport.addEventListener('click', (e) => { e.preventDefault(); doImport(); });
    dom.shareBtn.addEventListener('click', () => {
      const url = location.origin === 'null'
        ? location.href.replace(/#.*$/, '') + '#fen=' + encodeURIComponent(Engine.toFen(S.pos))
        : location.origin + location.pathname + '#fen=' + encodeURIComponent(Engine.toFen(S.pos));
      copyText(url, 'Link');
    });

    dom.themeBtn.addEventListener('click', () => {
      settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
      dom.themeSel.value = settings.theme;
      applySettings();
    });
    dom.soundBtn.addEventListener('click', () => {
      settings.sound = !settings.sound;
      Sound.setMuted(!settings.sound);
      if (settings.sound) { Sound.unlock(); Sound.play('move'); }
      applySettings();
    });

    dom.firstBtn.addEventListener('click', () => setView(0));
    dom.prevBtn.addEventListener('click', () => stepView(-1));
    dom.nextBtn.addEventListener('click', () => stepView(1));
    dom.lastBtn.addEventListener('click', () => setView(-1));

    dom.pieceSel.addEventListener('change', () => { applySettings(); renderPieces(false); });
    dom.boardSel.addEventListener('change', () => applySettings());
    dom.themeSel.addEventListener('change', () => applySettings());
    dom.coordsOn.addEventListener('change', () => { applySettings(); renderCoords(); });

    // Dialogs: explicit close buttons plus backdrop clicks. Relying only on
    // <form method="dialog"> is fragile, so the buttons close the dialog
    // themselves and Esc/backdrop keep working.
    document.querySelectorAll('dialog [data-close]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const dlg = btn.closest('dialog');
        if (dlg) dlg.close('button');
      });
    });
    for (const dlg of [dom.dlgHelp, dom.dlgImport]) {
      dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('backdrop'); });
    }
    dom.helpBtn.addEventListener('click', () => { if (!dom.dlgHelp.open) dom.dlgHelp.showModal(); });

    // Settings menu: a plain dropdown. It closes on the button, the x, Escape
    // and any click outside, so it never traps the pointer.
    function setMenu(open) {
      const show = open === undefined ? dom.appMenu.hidden : open;
      dom.appMenu.hidden = !show;
      dom.menuBtn.setAttribute('aria-expanded', String(show));
    }
    dom.menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setMenu();
    });
    if (dom.menuClose) dom.menuClose.addEventListener('click', () => setMenu(false));
    document.addEventListener('click', (e) => {
      if (dom.appMenu.hidden) return;
      if (dom.appMenu.contains(e.target) || dom.menuBtn.contains(e.target)) return;
      setMenu(false);
    });
    dom.appMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
    dom.dlgImport.addEventListener('close', () => { dom.importError.hidden = true; });

    setInterval(tickClocks, 100);
    window.addEventListener('resize', queueFit);
    window.addEventListener('resize', setAppHeight);
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => queueFit());
      ro.observe(dom.boardCol);
      const layoutEl = document.querySelector('.layout');
      if (layoutEl) ro.observe(layoutEl);
    }
    window.addEventListener('load', () => { setAppHeight(); queueFit(); });
    setTimeout(() => { setAppHeight(); queueFit(); }, 120);
    setTimeout(queueFit, 450);
    window.addEventListener('orientationchange', queueFit);

    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return; // handled above
      if (e.key === 'f') { S.flip = !S.flip; rebuildPieces(); renderAll(); }
      if (e.key === 'n') newGame(START_FEN);
      if (e.key === 'u') undoMove();
      if (e.key === 'h') dom.hintBtn.click();
    });
  }

  function rebuildPieces() {
    for (const [, el] of pieceEls) el.remove();
    pieceEls.clear();
    renderCoords();
    renderPieces(false);
    renderHighlights();
  }

  function restartIfEngineTurn() {
    if (S.thinking) abortSearch();
    maybeStartEngine();
  }

  /* ------------------------------------------------------------------- boot */
  function boot() {
    // 1. settings first, so the very first paint uses the saved theme
    const stored = Store.read();
    if (stored && stored.settings) Object.assign(settings, stored.settings);
    S.pos = Engine.fromFen(START_FEN).pos;
    wire();
    if (dom.modeSel) dom.modeSel.value = settings.mode;
    if (dom.levelSel) dom.levelSel.value = settings.level;
    if (dom.sideSel) dom.sideSel.value = settings.human;
    if (dom.timeSel) dom.timeSel.value = settings.time;
    if (settings.time === 'custom') {
      dom.customMin.value = settings.customMin || 10;
      dom.customInc.value = settings.customInc || 0;
    }
    dom.customTime.hidden = settings.time !== 'custom';
    dom.autoFlip.checked = settings.autoFlip;
    dom.showLegal.checked = settings.showLegal;
    dom.animOn.checked = settings.animate;
    dom.pieceSel.value = settings.pieces || 'classic';
    dom.boardSel.value = settings.board || 'green';
    dom.themeSel.value = settings.theme || 'dark';
    dom.coordsOn.checked = settings.coords !== false;
    Sound.setMuted(!settings.sound);
    // Do not save from here: restore() has not read localStorage yet, and an
    // early save would overwrite the saved game with an empty one.
    applySettings(true);
    if (dom.enginePv && !dom.enginePv.textContent.trim()) dom.enginePv.textContent = 'Play a move to start the engine.';

    // 2. then the game itself (URL hash wins over localStorage)
    restore();

    S.flip = settings.mode === 'hvc' ? settings.human === 'b' : false;
    S.scoreWhite = Engine.evaluateForWhite(S.pos);
    if (S.clocks.on && S.moves.length) { S.clocks.running = true; S.clocks.last = Date.now(); }
    setAppHeight();
    renderAll();
    queueFit();
    if (S.moves.length) {
      const last = S.moves[S.moves.length - 1];
      S.lastMove = { from: Engine.moveFrom(last.mv), to: Engine.moveTo(last.mv) };
      renderBoard();
      detectEnd();
      renderAll();
    }
    maybeStartEngine();
    persist();
    // test lab link keeps the mode
    if (dom.testLink) dom.testLink.href = '?test';
  }

  boot();
}
