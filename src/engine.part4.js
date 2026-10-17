  /* ==========================================================================
     SECTION 1E - PUBLIC ENGINE API
     This object is the only surface the game controller and the worker touch.
     Keeping it small and explicit is what lets the UI stay ignorant of board
     representation, Zobrist keys and search internals.
     ========================================================================== */

  /** Board as 64 characters in display order (a8..h1), '' for empty. */
  function boardChars(pos) {
    const out = new Array(64);
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const c = pos.board[(7 - row) * 16 + col];
        out[row * 8 + col] = c ? codeToChar(c) : '';
      }
    }
    return out;
  }

  function clonePosition(pos) {
    const p = makePos();
    p.board.set(pos.board);
    p.pSq.set(pos.pSq);
    p.pIdx.set(pos.pIdx);
    p.pLen.set(pos.pLen);
    p.side = pos.side;
    p.castling = pos.castling;
    p.ep = pos.ep;
    p.half = pos.half;
    p.full = pos.full;
    p.kSq0 = pos.kSq0;
    p.kSq1 = pos.kSq1;
    p.hashLo = pos.hashLo;
    p.hashHi = pos.hashHi;
    p.hLen = Math.min(pos.hLen, MAX_HIST);
    p.hLo.set(pos.hLo.subarray(0, p.hLen));
    p.hHi.set(pos.hHi.subarray(0, p.hLen));
    p.sp = 0;
    return p;
  }

  /** Square index from display coordinates: row 0 is rank 8, col 0 is file a. */
  function sqFromRowCol(row, col) { return (7 - row) * 16 + col; }

  function legalTargetsFrom(pos, sq) {
    const out = [];
    const list = legalMoves(pos);
    for (let i = 0; i < list.length; i++) if (mvFrom(list[i]) === sq) out.push(mvTo(list[i]));
    return out;
  }

  return {
    // metadata
    START_FEN: START_FEN,
    MATE: MATE, MATE_BOUND: MATE_BOUND, MAX_PLY: MAX_PLY, TT_SIZE: TT_SIZE,
    // position lifecycle
    newPosition: function () { return fromFen(START_FEN).pos; },
    startPosition: startPosition,
    fromFen: fromFen,
    toFen: toFen,
    fenKey: fenKey,
    fromFenWithHistory: fromFenWithHistory,
    clonePosition: clonePosition,
    // rules
    legalMoves: legalMoves,
    hasLegalMove: hasLegalMove,
    makeMove: makeMove,
    unmakeMove: unmakeMove,
    inCheck: inCheck,
    isAttacked: isAttacked,
    perft: perft,
    computeHash: computeHash,
    isRepetition: isRepetition,
    insufficientMaterial: insufficientMaterial,
    // notation
    moveToUci: moveToUci,
    moveFrom: mvFrom,
    moveTo: mvTo,
    movePromotion: mvPromo,
    moveFlag: mvFlag,
    sanOf: sanOf,
    parseSan: parseSan,
    sqName: sqName,
    nameToSq: nameToSq,
    sqFromRowCol: sqFromRowCol,
    // accessors
    boardChars: boardChars,
    /** Piece character on a square ('' when empty), e.g. "N" or "q". */
    charAt: function (pos, sq) {
      const c = pos.board[sq];
      return c ? codeToChar(c) : '';
    },
    legalTargetsFrom: legalTargetsFrom,
    sideToMove: function (pos) { return pos.side ? 'b' : 'w'; },
    halfmove: function (pos) { return pos.half; },
    fullmove: function (pos) { return pos.full; },
    castlingRights: function (pos) { return pos.castling; },
    epSquare: function (pos) { return pos.ep; },
    kingSquare: function (pos, side) { return side === WHITE_SIDE ? pos.kSq0 : pos.kSq1; },
    isCapture: moveIsCapture,
    // evaluation
    evaluate: evaluate,
    evaluateForWhite: function (pos) { return pos.side === WHITE_SIDE ? evaluate(pos) : -evaluate(pos); },
    // search
    searchStart: searchStart,
    searchNext: searchNext,
    searchStop: searchStop,
    searchResult: searchResult,
    scoreToMate: scoreToMate,
    // book
    bookMove: bookMove,
    bookName: bookName,
    BOOK_LINES: BOOK_LINES,
    // self-play
    runMatch: runMatch
  };
}

/* ==========================================================================
   SECTION 2 - BASELINE ENGINE (only used by the ?test self-play match)
   A faithful re-implementation of the original depth-3 alpha-beta search with
   the original's material + piece-square evaluation. It shares this file's
   move generator so the match compares search/evaluation quality rather than
   accidental bugs. Kept as a function so the worker can be built from
   .toString() without duplicating source.
   ========================================================================== */
function BaselineEngine(E) {
  'use strict';

  const VAL = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 20000 };
  // The original file's tables, verbatim (index 0 = rank 8).
  const PST = {
    P: [
      [0, 0, 0, 0, 0, 0, 0, 0],
      [50, 50, 50, 50, 50, 50, 50, 50],
      [10, 10, 20, 30, 30, 20, 10, 10],
      [5, 5, 10, 25, 25, 10, 5, 5],
      [0, 0, 0, 20, 20, 0, 0, 0],
      [5, -5, -10, 0, 0, -10, -5, 5],
      [5, 10, 10, -20, -20, 10, 10, 5],
      [0, 0, 0, 0, 0, 0, 0, 0]],
    N: [
      [-50, -40, -30, -30, -30, -30, -40, -50],
      [-40, -20, 0, 0, 0, 0, -20, -40],
      [-30, 0, 10, 15, 15, 10, 0, -30],
      [-30, 5, 15, 20, 20, 15, 5, -30],
      [-30, 0, 15, 20, 20, 15, 0, -30],
      [-30, 5, 10, 15, 15, 10, 5, -30],
      [-40, -20, 0, 5, 5, 0, -20, -40],
      [-50, -40, -30, -30, -30, -30, -40, -50]],
    B: [
      [-20, -10, -10, -10, -10, -10, -10, -20],
      [-10, 0, 0, 0, 0, 0, 0, -10],
      [-10, 0, 5, 10, 10, 5, 0, -10],
      [-10, 5, 5, 10, 10, 5, 5, -10],
      [-10, 0, 10, 10, 10, 10, 0, -10],
      [-10, 10, 10, 10, 10, 10, 10, -10],
      [-10, 5, 0, 0, 0, 0, 5, -10],
      [-20, -10, -10, -10, -10, -10, -10, -20]],
    R: [
      [0, 0, 0, 0, 0, 0, 0, 0],
      [5, 10, 10, 10, 10, 10, 10, 5],
      [-5, 0, 0, 0, 0, 0, 0, -5],
      [-5, 0, 0, 0, 0, 0, 0, -5],
      [-5, 0, 0, 0, 0, 0, 0, -5],
      [-5, 0, 0, 0, 0, 0, 0, -5],
      [-5, 0, 0, 0, 0, 0, 0, -5],
      [0, 0, 0, 5, 5, 0, 0, 0]],
    Q: [
      [-20, -10, -10, -5, -5, -10, -10, -20],
      [-10, 0, 0, 0, 0, 0, 0, -10],
      [-10, 0, 5, 5, 5, 5, 0, -10],
      [-5, 0, 5, 5, 5, 5, 0, -5],
      [0, 0, 5, 5, 5, 5, 0, -5],
      [-10, 5, 5, 5, 5, 5, 0, -10],
      [-10, 0, 5, 0, 0, 0, 0, -10],
      [-20, -10, -10, -5, -5, -10, -10, -20]],
    K: [
      [-30, -40, -40, -50, -50, -40, -40, -30],
      [-30, -40, -40, -50, -50, -40, -40, -30],
      [-30, -40, -40, -50, -50, -40, -40, -30],
      [-30, -40, -40, -50, -50, -40, -40, -30],
      [-20, -30, -30, -40, -40, -30, -30, -20],
      [-10, -20, -20, -20, -20, -20, -20, -10],
      [20, 20, 0, 0, 0, 0, 20, 20],
      [20, 30, 10, 0, 0, 10, 30, 20]]
  };

  function staticEval(pos) {
    const chars = E.boardChars(pos);          // display order: row 0 = rank 8
    let score = 0;
    for (let i = 0; i < 64; i++) {
      const ch = chars[i];
      if (!ch) continue;
      const isBlack = ch === ch.toLowerCase();
      const type = ch.toUpperCase();
      const row = i >> 3, col = i & 7;
      const r = isBlack ? 7 - row : row;
      const sign = isBlack ? -1 : 1;
      score += sign * (VAL[type] + PST[type][r][col]);
    }
    return score;                              // white-positive
  }

  function evalSide(pos) {
    const w = staticEval(pos);
    return E.sideToMove(pos) === 'w' ? w : -w;
  }

  function negamax(pos, depth, alpha, beta, ply) {
    if (depth === 0) return evalSide(pos);
    const moves = E.legalMoves(pos);
    if (!moves.length) return E.inCheck(pos) ? -30000 + ply : 0;
    // The original only ordered captures first; keep that, plus stable order.
    moves.sort(function (a, b) { return (E.isCapture(b) ? 1 : 0) - (E.isCapture(a) ? 1 : 0); });
    let best = -Infinity;
    for (let i = 0; i < moves.length; i++) {
      E.makeMove(pos, moves[i]);
      const sc = -negamax(pos, depth - 1, -beta, -alpha, ply + 1);
      E.unmakeMove(pos, moves[i]);
      if (sc > best) {
        best = sc;
        if (sc > alpha) alpha = sc;
        if (alpha >= beta) break;
      }
    }
    return best;
  }

  return {
    /** Fixed depth-3 search, returns a move integer (0 if none). */
    chooseMove: function (pos) {
      const moves = E.legalMoves(pos);
      if (!moves.length) return 0;
      let bestScore = -Infinity;
      let best = [];
      let alpha = -Infinity;
      for (let i = 0; i < moves.length; i++) {
        E.makeMove(pos, moves[i]);
        const sc = -negamax(pos, 2, -Infinity, -alpha, 1);
        E.unmakeMove(pos, moves[i]);
        if (sc > bestScore + 0.5) { bestScore = sc; best = [moves[i]]; }
        else if (sc > bestScore - 0.5) best.push(moves[i]);
        if (sc > alpha) alpha = sc;
      }
      return best[(Math.random() * best.length) | 0] || moves[0];
    },
    evaluate: staticEval
  };
}
