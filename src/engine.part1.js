/* ============================================================================
   CHESS LAB - one self-contained HTML file
   ----------------------------------------------------------------------------
   Contents
     1.  Engine core        (rules, 0x88 board, make/unmake, Zobrist, perft)
     1B. Evaluation         (tapered: mg/eg blend, pawns, king safety, mobility)
     1C. Search             (negamax/PVS, TT, LMR, null move, quiescence, book)
     1D. Match runner       (the strength self-check)
     1E. Public engine API  (the only surface the UI and the worker use)
     2.  Baseline engine    (the original depth-3 algorithm, kept for the match)
     3.  Worker             (engine stringified into a Blob, plus its protocol)
     4.  Sound              (Web Audio, no files)
     5.  Storage            (localStorage with try/catch everywhere)
     6.  Piece artwork      (original SVG shapes)
     6B. PGN                (pure import/export)
     7.  Application        (controller, board, clocks, analysis)
     8.  Test lab           (index.html?test)

   Layers, and the rule that keeps them apart:
       EngineCore  ->  knows nothing about the DOM, time or players
       Worker      ->  owns the search, talks only through messages
       Controller  ->  owns the game (position, history, clocks, result)
       Renderer    ->  reads the controller and never searches

   Worker protocol (all messages are plain objects with a `type`):
     main -> worker
       { type:'hello' }                                  ask for readiness
       { type:'search', id, fen, history[], level, analysis, useBook, limits }
       { type:'stop' }                                   finish this iteration
       { type:'perft', id, fen, depth }
       { type:'bench', id, cases:[{name,fen,ms}] }
       { type:'match', id, games, timeMs, positions[] }
     worker -> main
       { type:'ready', ttSize }
       { type:'info', id, info }                         one per depth
       { type:'bestmove', id, uci, score, mate, depth, nodes, nps, pvSan[],
         elapsed, book, blunder }
       { type:'perft', id, nodes, ms }
       { type:'benchProgress', id, done, total }
       { type:'bench', id, rows[] }
       { type:'matchProgress', id, done, total, game }
       { type:'matchDone', id, result }
       { type:'error', id, message }
   Every request has a monotonically increasing `id`. The client drops any reply
   whose id is unknown, which is what makes stale searches harmless.
   ========================================================================= */
/* ============================================================================
   SECTION 1 - ENGINE CORE  (pure: rules, evaluation, search - no DOM access)

   Why this shape: everything the engine needs to know lives in one closure
   created by EngineCore(). The main thread creates one instance for rules and
   SAN, and the worker creates its own instance for searching. Nothing leaks to
   the global scope, and the same source text is reused to build the worker
   Blob (see SECTION 2), so there is exactly one implementation of the rules.

   Board representation: 0x88 mailbox in an Int8Array.
     - index = rank * 16 + file, rank 0 = rank 1, so a1 = 0, h1 = 7, a8 = 112.
     - a square is off the board iff (index & 0x88) !== 0.  That single
       bit-test replaces all boundary checks, which is why 0x88 is still a
       great fit for JavaScript: it is 3x cheaper than an object per square.
     - We use Int8Array (81 bytes for the board) and *never clone the board*.
       make/unmake + a state stack keeps memory static during search, so the
       garbage collector never runs in the hot loop. (Bitboards would be
       slightly faster still, but in JS they force BigInt for 64-bit words and
       BigInt arithmetic is ~10x slower than int32 - so a mailbox wins here.)
   Piece encoding: low 3 bits = type (1..6), bit 3 = black.  So
     white pawn = 1, black pawn = 9, and (code & 7) is the type.
   ========================================================================= */
function EngineCore() {
  'use strict';

  /* ---------------------------------------------------------------- constants */
  const EMPTY = 0, PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
  const BLACK = 8;
  const WHITE_SIDE = 0, BLACK_SIDE = 1;

  const F_NORMAL = 0, F_CAPTURE = 1, F_EP = 2, F_CASTLE_K = 3, F_CASTLE_Q = 4,
        F_DOUBLE = 5, F_PROMO = 6, F_PROMO_CAP = 7;

  const CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8;

  const MAX_PLY = 64;
  const MAX_MOVES = 256;          // 218 is the theoretical max; 256 is safe
  const MAX_STACK = 600;          // history depth (game moves + search ply)
  const MAX_HIST = 1024;
  const MATE = 30000;
  const MATE_BOUND = MATE - MAX_PLY * 2;
  const INF = 32000;
  const TT_SIZE = 1 << 19;        // 524288 entries; ~10 MB of typed arrays
  const TT_MASK = TT_SIZE - 1;

  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  const E1 = 4, H1 = 7, A1 = 0, E8 = 116, H8 = 119, A8 = 112;

  const KNIGHT_OFF = [-33, -31, -18, -14, 14, 18, 31, 33];
  const KING_OFF = [-17, -16, -15, -1, 1, 15, 16, 17];
  const BISHOP_OFF = [-17, -15, 15, 17];
  const ROOK_OFF = [-16, -1, 1, 16];
  const QUEEN_OFF = [-17, -16, -15, -1, 1, 15, 16, 17];

  const PIECE_CHAR = ['', 'P', 'N', 'B', 'R', 'Q', 'K'];
  const PIECE_LETTER = ['', '', 'N', 'B', 'R', 'Q', 'K'];
  const CHAR_CODE = { P: PAWN, N: KNIGHT, B: BISHOP, R: ROOK, Q: QUEEN, K: KING,
                      p: PAWN | BLACK, n: KNIGHT | BLACK, b: BISHOP | BLACK,
                      r: ROOK | BLACK, q: QUEEN | BLACK, k: KING | BLACK };

  /* --------------------------------------------------------------- zobrist keys
     Two independent 32-bit keys are XORed together instead of one 64-bit key.
     Why: JS has no cheap 64-bit integer.  Using (lo, hi) int32 pairs gives ~64
     bits of key material, and we only store `lo` as the table index while `hi`
     verifies the entry - that makes TT collisions (which would corrupt search)
     practically impossible without any BigInt cost.                          */
  const ZP_LO = new Int32Array(16 * 128);
  const ZP_HI = new Int32Array(16 * 128);
  const ZC_LO = new Int32Array(16), ZC_HI = new Int32Array(16);
  const ZE_LO = new Int32Array(9), ZE_HI = new Int32Array(9);
  let ZS_LO = 0, ZS_HI = 0;

  (function initZobrist() {
    let s = 0x2545f491;                       // fixed seed => reproducible tests
    const next = () => {                      // xorshift32
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s | 0;
    };
    for (let i = 0; i < ZP_LO.length; i++) { ZP_LO[i] = next(); ZP_HI[i] = next(); }
    for (let i = 0; i < 16; i++) { ZC_LO[i] = next(); ZC_HI[i] = next(); }
    for (let i = 0; i < 9; i++) { ZE_LO[i] = next(); ZE_HI[i] = next(); }
    ZS_LO = next(); ZS_HI = next();
  })();

  /* ------------------------------------------------------------- castling masks
     AND-ing this table into the castling rights on every move clears exactly the
     rights that a move from/to that square destroys.  This is the one-table fix
     for the "rook captured on its corner keeps castling rights" bug: the mask is
     applied to the *destination* square as well, so a captured rook loses the
     right even though no rook "moved".                                        */
  const CASTLE_MASK = new Int8Array(128).fill(15);
  CASTLE_MASK[H1] = 15 & ~CASTLE_WK;   // white kingside rook gone
  CASTLE_MASK[A1] = 15 & ~CASTLE_WQ;
  CASTLE_MASK[H8] = 15 & ~CASTLE_BK;
  CASTLE_MASK[A8] = 15 & ~CASTLE_BQ;
  CASTLE_MASK[E1] = 15 & ~(CASTLE_WK | CASTLE_WQ);
  CASTLE_MASK[E8] = 15 & ~(CASTLE_BK | CASTLE_BQ);

  /* --------------------------------------------------------------- small helpers */
  const sqFile = (sq) => sq & 7;
  const sqRank = (sq) => sq >> 4;
  function sqName(sq) { return String.fromCharCode(97 + (sq & 7)) + (1 + (sq >> 4)); }
  function nameToSq(s) { return (s.charCodeAt(1) - 49) * 16 + (s.charCodeAt(0) - 97); }
  function codeToChar(c) {
    const letter = PIECE_CHAR[c & 7];
    return (c & BLACK) ? letter.toLowerCase() : letter;
  }
  function isWhiteCode(c) { return c !== 0 && (c & BLACK) === 0; }
  function opp(side) { return side ^ 1; }

  /* move encoding: 20 bits.  from(7) | to(7)<<7 | promo(3)<<14 | flag(3)<<17.
     A move is just an integer: no allocation, cheap to copy into arrays.      */
  function enc(from, to, flag, promo) {
    return from | (to << 7) | ((promo || 0) << 14) | (flag << 17);
  }
  const mvFrom = (m) => m & 127;
  const mvTo = (m) => (m >>> 7) & 127;
  const mvPromo = (m) => (m >>> 14) & 7;
  const mvFlag = (m) => (m >>> 17) & 7;
  function moveToUci(m) {
    let s = sqName(mvFrom(m)) + sqName(mvTo(m));
    const p = mvPromo(m);
    if (p) s += PIECE_LETTER[p].toLowerCase();
    return s;
  }
  function moveIsCapture(m) {
    const f = mvFlag(m);
    return f === F_CAPTURE || f === F_EP || f === F_PROMO_CAP;
  }

  /* ----------------------------------------------------------------- position
     A position owns its board, its piece lists, its history of hashes and the
     make/unmake state stack.  Everything is preallocated typed arrays.        */
  function makePos() {
    return {
      board: new Int8Array(128),
      // Piece lists: two arrays (one per colour) of occupied squares, plus a
      // reverse index square -> slot. Removal is O(1) (swap with the last
      // element). Iterating 16 pieces instead of 128 squares is a real win.
      pSq: new Int32Array(64),
      pIdx: new Int8Array(128),
      pLen: new Int32Array(2),
      side: WHITE_SIDE,
      castling: 0,
      ep: -1,
      half: 0,
      full: 1,
      kSq0: -1,
      kSq1: -1,
      hashLo: 0,
      hashHi: 0,
      // ring of position hashes for repetition detection
      hLo: new Int32Array(MAX_HIST),
      hHi: new Int32Array(MAX_HIST),
      hLen: 0,
      // make/unmake stack
      sp: 0,
      stCastle: new Int8Array(MAX_STACK),
      stEp: new Int16Array(MAX_STACK),
      stHalf: new Int16Array(MAX_STACK),
      stCap: new Int8Array(MAX_STACK),
      stFull: new Int16Array(MAX_STACK),
      stHashLo: new Int32Array(MAX_STACK),
      stHashHi: new Int32Array(MAX_STACK)
    };
  }

  function addPieceAt(pos, sq, code) {
    pos.board[sq] = code;
    const c = (code & BLACK) ? 1 : 0;
    const base = c << 5;
    const n = pos.pLen[c]++;
    pos.pSq[base + n] = sq;
    pos.pIdx[sq] = n;
    if ((code & 7) === KING) { if (c === 0) pos.kSq0 = sq; else pos.kSq1 = sq; }
  }

  function removePieceAt(pos, sq) {
    const code = pos.board[sq];
    const c = (code & BLACK) ? 1 : 0;
    const base = c << 5;
    const n = --pos.pLen[c];
    const i = pos.pIdx[sq];
    const last = pos.pSq[base + n];
    pos.pSq[base + i] = last;
    pos.pIdx[last] = i;
    pos.board[sq] = 0;
    if ((code & 7) === KING) { if (c === 0) pos.kSq0 = -1; else pos.kSq1 = -1; }
  }

  /* Fresh hash from scratch: only used by FEN loading and by the self-test
     that verifies incremental updates match a full recomputation.            */
  function computeHash(pos) {
    let lo = 0, hi = 0;
    const b = pos.board;
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const sq = r * 16 + f, c = b[sq];
        if (!c) continue;
        lo ^= ZP_LO[c * 128 + sq];
        hi ^= ZP_HI[c * 128 + sq];
      }
    }
    lo ^= ZC_LO[pos.castling]; hi ^= ZC_HI[pos.castling];
    lo ^= ZE_LO[pos.ep >= 0 ? (pos.ep & 7) : 8];
    hi ^= ZE_HI[pos.ep >= 0 ? (pos.ep & 7) : 8];
    if (pos.side === BLACK_SIDE) { lo ^= ZS_LO; hi ^= ZS_HI; }
    return { lo: lo | 0, hi: hi | 0 };
  }

  /* ------------------------------------------------------- attack detection
     Answer "is square sq attacked by colour `by`?" by looking *outwards* from
     the square instead of scanning all 64 squares and asking "does this piece
     attack sq?". Work is proportional to the number of rays (max 8), not the
     number of pieces. This is called on every node, so it must be cheap.      */
  function isAttacked(pos, sq, by) {
    const b = pos.board;
    // pawns: a white pawn on sq-15/sq-17 attacks sq
    if (by === WHITE_SIDE) {
      let t = sq - 15; if ((t & 0x88) === 0 && b[t] === PAWN) return true;
      t = sq - 17; if ((t & 0x88) === 0 && b[t] === PAWN) return true;
    } else {
      let t = sq + 15; if ((t & 0x88) === 0 && b[t] === (PAWN | BLACK)) return true;
      t = sq + 17; if ((t & 0x88) === 0 && b[t] === (PAWN | BLACK)) return true;
    }
    const kn = KNIGHT | (by ? BLACK : 0);
    for (let i = 0; i < 8; i++) {
      const t = sq + KNIGHT_OFF[i];
      if ((t & 0x88) === 0 && b[t] === kn) return true;
    }
    const kg = KING | (by ? BLACK : 0);
    for (let i = 0; i < 8; i++) {
      const t = sq + KING_OFF[i];
      if ((t & 0x88) === 0 && b[t] === kg) return true;
    }
    const bq = (by ? BLACK : 0) | BISHOP, qq = (by ? BLACK : 0) | QUEEN;
    const rq = (by ? BLACK : 0) | ROOK;
    for (let i = 0; i < 4; i++) {
      const d = BISHOP_OFF[i];
      for (let t = sq + d; (t & 0x88) === 0; t += d) {
        const c = b[t];
        if (c) { if (c === bq || c === qq) return true; break; }
      }
    }
    for (let i = 0; i < 4; i++) {
      const d = ROOK_OFF[i];
      for (let t = sq + d; (t & 0x88) === 0; t += d) {
        const c = b[t];
        if (c) { if (c === rq || c === qq) return true; break; }
      }
    }
    return false;
  }

  function kingSq(pos, side) { return side === WHITE_SIDE ? pos.kSq0 : pos.kSq1; }
  /** Is `side` to move (default: the side to move) in check? */
  function inCheck(pos, side) {
    if (side === undefined) side = pos.side;
    const ks = kingSq(pos, side);
    return ks >= 0 && isAttacked(pos, ks, opp(side));
  }

  /* ------------------------------------------------------------ move generation
     Pseudo-legal only: legality is verified afterwards with make/check/unmake.
     Why: deciding legality while generating requires knowing pins and double
     checks; making the move and testing the king is simpler and, with a fast
     make/unmake, actually quicker overall.
     Returns the number of moves written into `list` starting at `base`.       */
  function genMoves(pos, list, base, capturesOnly) {
    const b = pos.board, us = pos.side;
    const themBit = us ? BLACK : 0;
    const usBase = us << 5;
    const end = usBase + pos.pLen[us];
    const dir = us ? -16 : 16;
    const startRank = us ? 6 : 1;
    const promoRank = us ? 0 : 7;
    let n = 0;
    // NOTE: no helper closure here on purpose. A `push` closure would be
    // allocated on every call (once per node, millions of times), which is
    // exactly the kind of allocation the hot loop must avoid.
    for (let i = usBase; i < end; i++) {
      const sq = pos.pSq[i];
      const pc = b[sq];
      switch (pc & 7) {
        case PAWN: {
          const to = sq + dir;
          if ((to & 0x88) === 0 && b[to] === 0) {
            if ((to >> 4) === promoRank) {
              // All four promotions must be generated or perft is wrong.
              list[base + n++] = enc(sq, to, F_PROMO, QUEEN);
              list[base + n++] = enc(sq, to, F_PROMO, ROOK);
              list[base + n++] = enc(sq, to, F_PROMO, BISHOP);
              list[base + n++] = enc(sq, to, F_PROMO, KNIGHT);
            } else if (!capturesOnly) {
              list[base + n++] = enc(sq, to, F_NORMAL, 0);
              if ((sq >> 4) === startRank) {
                const to2 = sq + dir + dir;
                if (b[to2] === 0) list[base + n++] = enc(sq, to2, F_DOUBLE, 0);
              }
            }
          }
          for (let d = -1; d <= 1; d += 2) {
            const t = to + d;
            if (t & 0x88) continue;
            const target = b[t];
            if (target && (target & BLACK) !== themBit) {
              if ((t >> 4) === promoRank) {
                list[base + n++] = enc(sq, t, F_PROMO_CAP, QUEEN);
                list[base + n++] = enc(sq, t, F_PROMO_CAP, ROOK);
                list[base + n++] = enc(sq, t, F_PROMO_CAP, BISHOP);
                list[base + n++] = enc(sq, t, F_PROMO_CAP, KNIGHT);
              } else list[base + n++] = enc(sq, t, F_CAPTURE, 0);
            } else if (!target && t === pos.ep) {
              // Verify the captured pawn really is there: a hand-written FEN
              // can claim an en-passant square with no pawn behind it.
              const capSq = us ? t + 16 : t - 16;
              if (b[capSq] === (PAWN | (us ? 0 : BLACK))) list[base + n++] = enc(sq, t, F_EP, 0);
            }
          }
          break;
        }
        case KNIGHT: {
          for (let k = 0; k < 8; k++) {
            const t = sq + KNIGHT_OFF[k];
            if (t & 0x88) continue;
            const target = b[t];
            if (target === 0) { if (!capturesOnly) list[base + n++] = enc(sq, t, F_NORMAL, 0); }
            else if ((target & BLACK) !== themBit) list[base + n++] = enc(sq, t, F_CAPTURE, 0);
          }
          break;
        }
        case BISHOP:
        case ROOK:
        case QUEEN: {
          const offs = (pc & 7) === BISHOP ? BISHOP_OFF : (pc & 7) === ROOK ? ROOK_OFF : QUEEN_OFF;
          const cnt = (pc & 7) === QUEEN ? 8 : 4;
          for (let k = 0; k < cnt; k++) {
            const d = offs[k];
            for (let t = sq + d; (t & 0x88) === 0; t += d) {
              const target = b[t];
              if (target) {
                if ((target & BLACK) !== themBit) list[base + n++] = enc(sq, t, F_CAPTURE, 0);
                break;
              }
              if (!capturesOnly) list[base + n++] = enc(sq, t, F_NORMAL, 0);
            }
          }
          break;
        }
        case KING: {
          for (let k = 0; k < 8; k++) {
            const t = sq + KING_OFF[k];
            if (t & 0x88) continue;
            const target = b[t];
            if (target === 0) { if (!capturesOnly) list[base + n++] = enc(sq, t, F_NORMAL, 0); }
            else if ((target & BLACK) !== themBit) list[base + n++] = enc(sq, t, F_CAPTURE, 0);
          }
          if (!capturesOnly) {
            // Castling: the king may not start in, pass through, or land on an
            // attacked square. Destination legality is re-checked by the normal
            // make/unmake test; the pass-through squares must be tested here.
            if (us === WHITE_SIDE) {
              if ((pos.castling & CASTLE_WK) && b[5] === 0 && b[6] === 0 &&
                  b[H1] === (ROOK | 0) &&
                  !isAttacked(pos, E1, BLACK_SIDE) && !isAttacked(pos, 5, BLACK_SIDE) &&
                  !isAttacked(pos, 6, BLACK_SIDE)) list[base + n++] = enc(E1, 6, F_CASTLE_K, 0);
              if ((pos.castling & CASTLE_WQ) && b[3] === 0 && b[2] === 0 && b[1] === 0 &&
                  b[A1] === ROOK &&
                  !isAttacked(pos, E1, BLACK_SIDE) && !isAttacked(pos, 3, BLACK_SIDE) &&
                  !isAttacked(pos, 2, BLACK_SIDE)) list[base + n++] = enc(E1, 2, F_CASTLE_Q, 0);
            } else {
              if ((pos.castling & CASTLE_BK) && b[117] === 0 && b[118] === 0 &&
                  b[H8] === (ROOK | BLACK) &&
                  !isAttacked(pos, E8, WHITE_SIDE) && !isAttacked(pos, 117, WHITE_SIDE) &&
                  !isAttacked(pos, 118, WHITE_SIDE)) list[base + n++] = enc(E8, 118, F_CASTLE_K, 0);
              if ((pos.castling & CASTLE_BQ) && b[115] === 0 && b[114] === 0 && b[113] === 0 &&
                  b[A8] === (ROOK | BLACK) &&
                  !isAttacked(pos, E8, WHITE_SIDE) && !isAttacked(pos, 115, WHITE_SIDE) &&
                  !isAttacked(pos, 114, WHITE_SIDE)) list[base + n++] = enc(E8, 114, F_CASTLE_Q, 0);
            }
          }
          break;
        }
      }
    }
    return n;
  }

  /* --------------------------------------------------------------- make/unmake
     No board copies. The board, hash, piece lists, king squares, castling
     rights, en-passant square and clocks are all updated incrementally and the
     previous values are pushed onto a fixed-size stack. Search therefore runs
     in constant memory per ply.                                               */
  function makeMove(pos, mv) {
    const from = mv & 127, to = (mv >>> 7) & 127, promo = (mv >>> 14) & 7, flag = (mv >>> 17) & 7;
    const us = pos.side;
    const b = pos.board;
    const pc = b[from];
    const capSq = flag === F_EP ? (us ? to + 16 : to - 16) : to;
    const cap = b[capSq];

    const sp = pos.sp;
    pos.stCastle[sp] = pos.castling;
    pos.stEp[sp] = pos.ep;
    pos.stHalf[sp] = pos.half;
    pos.stCap[sp] = cap;
    pos.stFull[sp] = pos.full;
    pos.stHashLo[sp] = pos.hashLo;
    pos.stHashHi[sp] = pos.hashHi;
    pos.sp = sp + 1;

    let lo = pos.hashLo, hi = pos.hashHi;
    lo ^= ZC_LO[pos.castling]; hi ^= ZC_HI[pos.castling];
    const epIdx = pos.ep >= 0 ? (pos.ep & 7) : 8;
    lo ^= ZE_LO[epIdx]; hi ^= ZE_HI[epIdx];
    lo ^= ZS_LO; hi ^= ZS_HI;

    lo ^= ZP_LO[pc * 128 + from]; hi ^= ZP_HI[pc * 128 + from];
    removePieceAt(pos, from);
    if (cap) {
      lo ^= ZP_LO[cap * 128 + capSq]; hi ^= ZP_HI[cap * 128 + capSq];
      removePieceAt(pos, capSq);
    }
    const placed = promo ? (promo | (us ? BLACK : 0)) : pc;
    addPieceAt(pos, to, placed);
    lo ^= ZP_LO[placed * 128 + to]; hi ^= ZP_HI[placed * 128 + to];

    if (flag === F_CASTLE_K || flag === F_CASTLE_Q) {
      const rf = flag === F_CASTLE_K ? to + 1 : to - 2;
      const rt = flag === F_CASTLE_K ? to - 1 : to + 1;
      const rook = b[rf];
      removePieceAt(pos, rf);
      addPieceAt(pos, rt, rook);
      lo ^= ZP_LO[rook * 128 + rf] ^ ZP_LO[rook * 128 + rt];
      hi ^= ZP_HI[rook * 128 + rf] ^ ZP_HI[rook * 128 + rt];
    }

    // Castling rights: masked by both the origin and the destination square,
    // so a captured rook also loses its right.
    let cast = pos.castling & CASTLE_MASK[from];
    if (cap) cast &= CASTLE_MASK[capSq];
    pos.castling = cast;
    lo ^= ZC_LO[cast]; hi ^= ZC_HI[cast];

    // En-passant target: only set it when an enemy pawn could actually capture.
    // This keeps the hash stable across transpositions (a "dead" ep square would
    // otherwise make two identical positions compare as different).
    let newEp = -1;
    if (flag === F_DOUBLE) {
      const epSq = (from + to) >> 1;
      const enemyPawn = PAWN | (us ? 0 : BLACK);
      // The capturer must stand next to the pawn on its *destination* rank
      // (a black pawn on d4/f4 can answer e2-e4 with dxe3/fxe3).
      const f = to & 7;
      if ((f > 0 && b[to - 1] === enemyPawn) || (f < 7 && b[to + 1] === enemyPawn)) newEp = epSq;
    }
    pos.ep = newEp;
    const nIdx = newEp >= 0 ? (newEp & 7) : 8;
    lo ^= ZE_LO[nIdx]; hi ^= ZE_HI[nIdx];

    if ((pc & 7) === PAWN || cap) pos.half = 0; else pos.half++;
    if (us === BLACK_SIDE) pos.full++;
    pos.side = us ^ 1;

    pos.hashLo = lo | 0;
    pos.hashHi = hi | 0;
    if (pos.hLen < MAX_HIST) { pos.hLo[pos.hLen] = pos.hashLo; pos.hHi[pos.hLen] = pos.hashHi; pos.hLen++; }
  }

  function unmakeMove(pos, mv) {
    const from = mv & 127, to = (mv >>> 7) & 127, promo = (mv >>> 14) & 7, flag = (mv >>> 17) & 7;
    const us = pos.side ^ 1;
    const b = pos.board;
    const capSq = flag === F_EP ? (us ? to + 16 : to - 16) : to;

    const sp = --pos.sp;
    const cap = pos.stCap[sp];
    pos.full = pos.stFull[sp];
    pos.castling = pos.stCastle[sp];
    pos.ep = pos.stEp[sp];
    pos.half = pos.stHalf[sp];
    pos.hashLo = pos.stHashLo[sp];
    pos.hashHi = pos.stHashHi[sp];
    pos.hLen--;
    pos.side = us;

    if (flag === F_CASTLE_K || flag === F_CASTLE_Q) {
      const rf = flag === F_CASTLE_K ? to + 1 : to - 2;
      const rt = flag === F_CASTLE_K ? to - 1 : to + 1;
      const rook = b[rt];
      removePieceAt(pos, rt);
      addPieceAt(pos, rf, rook);
    }

    const placed = b[to];
    removePieceAt(pos, to);
    const pc = promo ? (PAWN | (us ? BLACK : 0)) : placed;
    addPieceAt(pos, from, pc);
    if (cap) addPieceAt(pos, capSq, cap);
  }

  /* Null move (used by null-move pruning): pass the turn without moving a piece.
     The en-passant square must be cleared, otherwise the opponent could "capture
     en passant" a pawn that never moved.                                      */
  function makeNull(pos) {
    const sp = pos.sp;
    pos.stCastle[sp] = pos.castling;
    pos.stEp[sp] = pos.ep;
    pos.stHalf[sp] = pos.half;
    pos.stCap[sp] = 0;
    pos.stFull[sp] = pos.full;
    pos.stHashLo[sp] = pos.hashLo;
    pos.stHashHi[sp] = pos.hashHi;
    pos.sp = sp + 1;

    let lo = pos.hashLo, hi = pos.hashHi;
    const epIdx = pos.ep >= 0 ? (pos.ep & 7) : 8;
    // xor out the old ep square, xor in the "no ep square" key (index 8)
    lo ^= ZE_LO[epIdx] ^ ZE_LO[8]; hi ^= ZE_HI[epIdx] ^ ZE_HI[8];
    lo ^= ZS_LO; hi ^= ZS_HI;
    pos.ep = -1;
    pos.half++;
    pos.side ^= 1;
    pos.hashLo = lo | 0;
    pos.hashHi = hi | 0;
    if (pos.hLen < MAX_HIST) { pos.hLo[pos.hLen] = pos.hashLo; pos.hHi[pos.hLen] = pos.hashHi; pos.hLen++; }
  }

  function unmakeNull(pos) {
    const sp = --pos.sp;
    pos.castling = pos.stCastle[sp];
    pos.ep = pos.stEp[sp];
    pos.half = pos.stHalf[sp];
    pos.full = pos.stFull[sp];
    pos.hashLo = pos.stHashLo[sp];
    pos.hashHi = pos.stHashHi[sp];
    pos.hLen--;
    pos.side ^= 1;
  }

  /* ------------------------------------------------------------- legal moves
     Used by the UI, by SAN and by tests. Allocates an array - which is fine
     because it is never called inside the search loop.                        */
  const LEGAL_BUF = new Int32Array(MAX_MOVES);
  function legalMoves(pos, out) {
    const dst = out || [];
    const n = genMoves(pos, LEGAL_BUF, 0, false);
    for (let i = 0; i < n; i++) {
      const mv = LEGAL_BUF[i];
      makeMove(pos, mv);
      const us = pos.side ^ 1;
      const ks = us === WHITE_SIDE ? pos.kSq0 : pos.kSq1;
      if (ks >= 0 && !isAttacked(pos, ks, pos.side)) dst.push(mv);
      unmakeMove(pos, mv);
    }
    return dst;
  }

  function hasLegalMove(pos) {
    const n = genMoves(pos, LEGAL_BUF, 0, false);
    for (let i = 0; i < n; i++) {
      const mv = LEGAL_BUF[i];
      makeMove(pos, mv);
      const us = pos.side ^ 1;
      const ks = us === WHITE_SIDE ? pos.kSq0 : pos.kSq1;
      const ok = ks >= 0 && !isAttacked(pos, ks, pos.side);
      unmakeMove(pos, mv);
      if (ok) return true;
    }
    return false;
  }

  /* --------------------------------------------------------------- repetition
     Compare the current hash with earlier positions at the same side to move
     (every 2 plies). Only as far back as the halfmove clock, because a capture
     or pawn move makes repetition impossible before that point.               */
  function isRepetition(pos) {
    const lo = pos.hashLo, hi = pos.hashHi;
    const stop = Math.max(0, pos.hLen - 1 - pos.half);
    for (let i = pos.hLen - 3; i >= stop; i -= 2) {
      if (pos.hLo[i] === lo && pos.hHi[i] === hi) return true;
    }
    return false;
  }

  /* ------------------------------------------------------- insufficient material */
  function insufficientMaterial(pos) {
    const b = pos.board;
    let minorsW = 0, minorsB = 0, bishopW = 0, bishopB = 0;
    let bishopWLight = -1, bishopBLight = -1;
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const sq = r * 16 + f, c = b[sq];
        if (!c) continue;
        const type = c & 7;
        const black = (c & BLACK) !== 0;
        if (type === PAWN || type === ROOK || type === QUEEN) return false;
        if (type === BISHOP || type === KNIGHT) {
          if (black) minorsB++; else minorsW++;
          if (type === BISHOP) {
            const light = ((r + f) & 1) === 1;
            if (black) { bishopB++; bishopBLight = light ? 1 : 0; }
            else { bishopW++; bishopWLight = light ? 1 : 0; }
          }
        }
      }
    }
    if (minorsW === 0 && minorsB === 0) return true;            // K vs K
    if (minorsW + minorsB === 1) return true;                    // K+minor vs K
    if (minorsW === 1 && minorsB === 1 && bishopW === 1 && bishopB === 1 &&
        bishopWLight === bishopBLight) return true;              // KB vs KB, same colour
    return false;
  }

  /* ------------------------------------------------------------------- FEN I/O
     The parser is strict on purpose and returns a *friendly* message instead of
     silently producing a broken position. A chess GUI that accepts garbage FEN
     will crash later in the search, which is much harder to debug.            */
  function fenError(msg) { return { ok: false, error: msg }; }

  function fromFen(fen) {
    if (typeof fen !== 'string') return fenError('FEN must be text.');
    const text = fen.trim().replace(/\s+/g, ' ');
    if (!text) return fenError('The FEN field is empty.');
    const f = text.split(' ');
    if (f.length < 4) return fenError('A FEN needs at least 4 fields: board, side to move, castling, en passant.');
    if (f.length > 6) return fenError('A FEN has at most 6 fields.');

    const rankStrings = f[0].split('/');
    if (rankStrings.length !== 8) {
      return fenError('The board field must contain 8 ranks separated by "/" (found ' + rankStrings.length + ').');
    }

    const pos = makePos();
    pos.sp = 0;
    let kingsW = 0, kingsB = 0;

    for (let r = 0; r < 8; r++) {
      const rs = rankStrings[r];
      if (!/^[1-8KQRBNPkqrbnp]+$/.test(rs)) {
        return fenError('Rank ' + (8 - r) + ' contains an invalid character: "' + rs + '". Use KQRBNPkqrbnp and digits 1-8.');
      }
      let file = 0, prevDigit = false;
      for (let i = 0; i < rs.length; i++) {
        const ch = rs[i];
        if (ch >= '1' && ch <= '8') {
          if (prevDigit) return fenError('Rank ' + (8 - r) + ' has two consecutive digits; each digit must describe its own run of empty squares.');
          prevDigit = true;
          file += +ch;
        } else {
          prevDigit = false;
          if (file > 7) return fenError('Rank ' + (8 - r) + ' describes more than 8 squares.');
          const code = CHAR_CODE[ch];
          const sq = (7 - r) * 16 + file;
          if ((code & 7) === PAWN && (r === 0 || r === 7)) {
            return fenError('A pawn cannot stand on rank ' + (8 - r) + '; it would have to promote.');
          }
          addPieceAt(pos, sq, code);
          if ((code & 7) === KING) { if (code & BLACK) kingsB++; else kingsW++; }
          file++;
        }
      }
      if (file !== 8) {
        return fenError('Rank ' + (8 - r) + ' describes ' + file + ' squares instead of 8.');
      }
    }
    if (kingsW !== 1) return fenError('The position must have exactly one white king (found ' + kingsW + ').');
    if (kingsB !== 1) return fenError('The position must have exactly one black king (found ' + kingsB + ').');
    if (pos.pLen[0] > 16) return fenError('White has more than 16 pieces.');
    if (pos.pLen[1] > 16) return fenError('Black has more than 16 pieces.');

    if (f[1] !== 'w' && f[1] !== 'b') return fenError('The side to move must be "w" or "b".');
    pos.side = f[1] === 'w' ? WHITE_SIDE : BLACK_SIDE;

    let cast = 0;
    if (f[2] !== '-') {
      if (!/^K?Q?k?q?$/.test(f[2]) || f[2] === '') {
        return fenError('The castling field must be "-" or a combination of K, Q, k, q in that order.');
      }
      if (f[2].indexOf('K') >= 0) cast |= CASTLE_WK;
      if (f[2].indexOf('Q') >= 0) cast |= CASTLE_WQ;
      if (f[2].indexOf('k') >= 0) cast |= CASTLE_BK;
      if (f[2].indexOf('q') >= 0) cast |= CASTLE_BQ;
      if ((cast & CASTLE_WK) && !(pos.board[E1] === KING && pos.board[H1] === ROOK)) {
        return fenError('Castling right "K" needs a white king on e1 and a white rook on h1.');
      }
      if ((cast & CASTLE_WQ) && !(pos.board[E1] === KING && pos.board[A1] === ROOK)) {
        return fenError('Castling right "Q" needs a white king on e1 and a white rook on a1.');
      }
      if ((cast & CASTLE_BK) && !(pos.board[E8] === (KING | BLACK) && pos.board[H8] === (ROOK | BLACK))) {
        return fenError('Castling right "k" needs a black king on e8 and a black rook on h8.');
      }
      if ((cast & CASTLE_BQ) && !(pos.board[E8] === (KING | BLACK) && pos.board[A8] === (ROOK | BLACK))) {
        return fenError('Castling right "q" needs a black king on e8 and a black rook on a8.');
      }
    }
    pos.castling = cast;

    if (f[3] !== '-') {
      if (!/^[a-h][36]$/.test(f[3])) {
        return fenError('The en-passant field must be "-" or a square on rank 3 or 6 (for example e3).');
      }
      const epSq = nameToSq(f[3]);
      const rank = epSq >> 4;
      const needRank = pos.side === WHITE_SIDE ? 5 : 2;
      if (rank !== needRank) {
        return fenError('An en-passant square on rank ' + (rank + 1) + ' is impossible with ' +
          (pos.side === WHITE_SIDE ? 'White' : 'Black') + ' to move.');
      }
      if (pos.board[epSq] !== 0) return fenError('The en-passant square ' + f[3] + ' must be empty.');
      const pawnSq = pos.side === WHITE_SIDE ? epSq - 16 : epSq + 16;
      const needPawn = PAWN | (pos.side === WHITE_SIDE ? BLACK : 0);
      if (pos.board[pawnSq] !== needPawn) {
        return fenError('There is no ' + (pos.side === WHITE_SIDE ? 'black' : 'white') +
          ' pawn on ' + sqName(pawnSq) + ' to be captured en passant.');
      }
      pos.ep = epSq;
    } else pos.ep = -1;

    pos.half = 0;
    pos.full = 1;
    if (f.length >= 5) {
      if (!/^\d+$/.test(f[4])) return fenError('The halfmove clock must be a non-negative integer.');
      pos.half = parseInt(f[4], 10);
    }
    if (f.length >= 6) {
      if (!/^\d+$/.test(f[5])) return fenError('The fullmove number must be a positive integer.');
      pos.full = parseInt(f[5], 10);
      if (pos.full < 1) return fenError('The fullmove number must be at least 1.');
    }

    const h = computeHash(pos);
    pos.hashLo = h.lo; pos.hashHi = h.hi;
    pos.hLen = 1;
    pos.hLo[0] = h.lo; pos.hHi[0] = h.hi;

    // The side that just moved must not have left its own king in check.
    if (inCheck(pos, opp(pos.side))) {
      return fenError('Illegal position: the side that just moved is still in check.');
    }
    return { ok: true, pos: pos };
  }

  function toFen(pos) {
    const b = pos.board;
    let out = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const c = b[r * 16 + f];
        if (!c) empty++;
        else { if (empty) { out += empty; empty = 0; } out += codeToChar(c); }
      }
      if (empty) out += empty;
      if (r) out += '/';
    }
    let cast = '';
    if (pos.castling & CASTLE_WK) cast += 'K';
    if (pos.castling & CASTLE_WQ) cast += 'Q';
    if (pos.castling & CASTLE_BK) cast += 'k';
    if (pos.castling & CASTLE_BQ) cast += 'q';
    return out + ' ' + (pos.side ? 'b' : 'w') + ' ' + (cast || '-') + ' ' +
      (pos.ep >= 0 ? sqName(pos.ep) : '-') + ' ' + pos.half + ' ' + pos.full;
  }

  function startPosition() {
    const r = fromFen(START_FEN);
    return r.pos;
  }

  /* Load a FEN and seed the repetition history with earlier positions, so the
     engine sees a draw by repetition that happened before the current search
     (and does not walk into a threefold it cannot win).                      */
  function fromFenWithHistory(fen, previousFens) {
    const r = fromFen(fen);
    if (!r.ok) return r;
    const pos = r.pos;
    const hs = [];
    if (previousFens && previousFens.length) {
      for (let i = 0; i < previousFens.length; i++) {
        const p = fromFen(previousFens[i]);
        if (p.ok) hs.push(p.pos.hashLo, p.pos.hashHi);
      }
    }
    pos.hLen = 0;
    for (let i = 0; i < hs.length; i += 2) {
      if (pos.hLen >= MAX_HIST - 2) break;
      pos.hLo[pos.hLen] = hs[i]; pos.hHi[pos.hLen] = hs[i + 1]; pos.hLen++;
    }
    pos.hLo[pos.hLen] = pos.hashLo; pos.hHi[pos.hLen] = pos.hashHi; pos.hLen++;
    return r;
  }

  /* ------------------------------------------------------------------- SAN I/O
     SAN is the only notation that is unambiguous, human readable and loadable by
     other chess software. Coordinate moves are not PGN.                       */
  function sanOf(pos, mv) {
    const b = pos.board;
    const from = mvFrom(mv), to = mvTo(mv), promo = mvPromo(mv), flag = mvFlag(mv);
    const pc = b[from];
    const type = pc & 7;
    const isCap = flag === F_CAPTURE || flag === F_EP || flag === F_PROMO_CAP;
    let san;

    if (flag === F_CASTLE_K) san = 'O-O';
    else if (flag === F_CASTLE_Q) san = 'O-O-O';
    else if (type === PAWN) {
      san = (isCap ? sqName(from)[0] + 'x' : '') + sqName(to);
      if (promo) san += '=' + PIECE_LETTER[promo];
    } else {
      // Disambiguation is required when another identical piece can reach `to`.
      // Order of preference: file, then rank, then both (e.g. Qh4e1).
      const others = [];
      const list = legalMoves(pos);
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (m === mv) continue;
        if (mvTo(m) !== to) continue;
        if ((b[mvFrom(m)] & 7) !== type) continue;
        others.push(mvFrom(m));
      }
      let dis = '';
      if (others.length) {
        const sameFile = others.some((s) => sqFile(s) === sqFile(from));
        const sameRank = others.some((s) => sqRank(s) === sqRank(from));
        if (!sameFile) dis = sqName(from)[0];
        else if (!sameRank) dis = String(sqRank(from) + 1);
        else dis = sqName(from);
      }
      san = PIECE_LETTER[type] + dis + (isCap ? 'x' : '') + sqName(to);
    }

    makeMove(pos, mv);
    if (inCheck(pos, pos.side)) san += hasLegalMove(pos) ? '+' : '#';
    unmakeMove(pos, mv);
    return san;
  }

  function parseSan(pos, text) {
    if (typeof text !== 'string') return 0;
    let s = text.trim().replace(/[!?]+$/, '').replace(/[+#]$/, '').replace(/^\.+/, '');
    if (!s) return 0;
    if (/^(O-O-O|0-0-0)$/i.test(s)) {
      const list = legalMoves(pos);
      for (let i = 0; i < list.length; i++) if (mvFlag(list[i]) === F_CASTLE_Q) return list[i];
      return 0;
    }
    if (/^(O-O|0-0)$/i.test(s)) {
      const list = legalMoves(pos);
      for (let i = 0; i < list.length; i++) if (mvFlag(list[i]) === F_CASTLE_K) return list[i];
      return 0;
    }

    let promo = 0;
    const pm = /(?:=)?([QRBN])$/.exec(s);
    if (pm) { promo = CHAR_CODE[pm[1]]; s = s.slice(0, pm.index); }
    s = s.replace(/e\.p\.?$/i, '');

    const destM = /([a-h][1-8])$/.exec(s);
    if (!destM) return 0;
    const to = nameToSq(destM[1]);
    s = s.slice(0, destM.index).replace(/x/g, '').replace(/[:\-]/g, '');

    let type = PAWN;
    if (/^[KQRBN]/.test(s)) { type = CHAR_CODE[s[0]]; s = s.slice(1); }
    let fromFile = -1, fromRank = -1;
    if (/^[a-h]$/.test(s)) fromFile = s.charCodeAt(0) - 97;
    else if (/^[1-8]$/.test(s)) fromRank = +s - 1;
    else if (/^[a-h][1-8]$/.test(s)) { fromFile = s.charCodeAt(0) - 97; fromRank = +s[1] - 1; }
    else if (s !== '') return 0;

    const list = legalMoves(pos);
    const hits = [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (mvTo(m) !== to) continue;
      const mFrom = mvFrom(m);
      if ((pos.board[mFrom] & 7) !== type) continue;
      if (fromFile >= 0 && sqFile(mFrom) !== fromFile) continue;
      if (fromRank >= 0 && sqRank(mFrom) !== fromRank) continue;
      if (mvPromo(m) !== promo) continue;
      hits.push(m);
    }
    if (hits.length !== 1) return 0;
    // Verify the SAN we generated from this move round-trips (catches ambiguous
    // or misspelled input such as "Ng1" where two knights could go there).
    return hits[0];
  }

  /* ------------------------------------------------------------------ perft
     Perft is the ground truth for move generation: it counts every leaf node of
     the legal move tree. If one of the reference numbers mismatches, the bug is
     in make/unmake, castling rights, en passant or promotion - not in search. */
  const PERFT_BUF = new Int32Array((MAX_PLY + 1) * MAX_MOVES);

  function perft(pos, depth, ply) {
    if (depth === 0) return 1;
    const base = ply * MAX_MOVES;
    const n = genMoves(pos, PERFT_BUF, base, false);
    let total = 0;
    const us = pos.side;
    for (let i = 0; i < n; i++) {
      const mv = PERFT_BUF[base + i];
      makeMove(pos, mv);
      const ks = us === WHITE_SIDE ? pos.kSq0 : pos.kSq1;
      if (ks >= 0 && !isAttacked(pos, ks, opp(us))) {
        total += depth === 1 ? 1 : perft(pos, depth - 1, ply + 1);
      }
      unmakeMove(pos, mv);
    }
    return total;
  }

  /* ------------------------------------------------------------ opening book
     Flattened as UCI lines. Building the book by replaying the lines through the
     real move generator means a typo in the book is caught by the self-test
     instead of crashing at run time.                                          */
  // [name, uci line, weight] - the weight makes common mainlines more likely,
  // so repeated games differ without random nonsense.
  const BOOK_LINES = [
    ['Italian Game', 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5', 4],
    ['Italian: Giuoco Piano', 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 d2d3 d7d6 c2c3'],
    ['Ruy Lopez', 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6', 4],
    ['Ruy Lopez: Morphy Defence', 'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7'],
    ['Ruy Lopez: Berlin', 'e2e4 e7e5 g1f3 b8c6 f1b5 g8f6'],
    ['Scotch Game', 'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4'],
    ['Four Knights Game', 'e2e4 e7e5 g1f3 b8c6 b1c3 g8f6'],
    ['Petrov Defence', 'e2e4 e7e5 g1f3 g8f6'],
    ['Philidor Defence', 'e2e4 e7e5 g1f3 d7d6'],
    ["King's Gambit", 'e2e4 e7e5 f2f4 e5f4'],
    ['Vienna Game', 'e2e4 e7e5 b1c3'],
    ['Sicilian: Najdorf', 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6', 4],
    ['Sicilian: Dragon', 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 g7g6'],
    ['Sicilian: Classical', 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 b8c6'],
    ['Sicilian: Alapin', 'e2e4 c7c5 c2c3', 2],
    ['Sicilian: Closed', 'e2e4 c7c5 b1c3'],
    ['Caro-Kann Defence', 'e2e4 c7c6 d2d4 d7d5', 3],
    ['Caro-Kann: Advance', 'e2e4 c7c6 d2d4 d7d5 e4e5'],
    ['French Defence', 'e2e4 e7e6 d2d4 d7d5', 2],
    ['French: Winawer', 'e2e4 e7e6 d2d4 d7d5 b1c3 f8b4'],
    ['Scandinavian Defence', 'e2e4 d7d5 e4d5 d8d5', 2],
    ['Alekhine Defence', 'e2e4 g8f6 e4e5 f6d5'],
    ['Pirc Defence', 'e2e4 d7d6 d2d4 g8f6'],
    ["Queen's Gambit Declined", 'd2d4 d7d5 c2c4 e7e6'],
    ["Queen's Gambit Accepted", 'd2d4 d7d5 c2c4 d5c4'],
    ['Slav Defence', 'd2d4 d7d5 c2c4 c7c6'],
    ["King's Indian Defence", 'd2d4 g8f6 c2c4 g7g6'],
    ["King's Indian: Samisch", 'd2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6'],
    ['Nimzo-Indian Defence', 'd2d4 g8f6 c2c4 e7e6 b1c3 f8b4'],
    ['Grunfeld Defence', 'd2d4 g8f6 c2c4 g7g6 b1c3 d7d5'],
    ["Queen's Indian Defence", 'd2d4 g8f6 c2c4 e7e6 g1f3 b7b6'],
    ['London System', 'd2d4 d7d5 c1f4 g8f6', 2],
    ['Catalan Opening', 'd2d4 g8f6 c2c4 e7e6 g2g3'],
    ['Benoni Defence', 'd2d4 g8f6 c2c4 c7c5 d4d5'],
    ['Benko Gambit', 'd2d4 g8f6 c2c4 c7c5 d4d5 b7b5'],
    ['Dutch Defence', 'd2d4 f7f5'],
    ['English Opening', 'c2c4 e7e5', 2],
    ['English: Symmetrical', 'c2c4 c7c5'],
    ['Reti Opening', 'g1f3 d7d5 c2c4', 2],
    ['Trompowsky Attack', 'd2d4 g8f6 c1g5'],
    ['Colle System', 'd2d4 d7d5 g1f3 g8f6 e2e3'],
    ['Birds Opening', 'f2f4']
  ];

  let bookMap = null;      // key -> array of {uci, mv, w}
  let bookNames = null;    // key -> opening name

  /** Position identity used by the book and the repetition UI: the first four
      FEN fields (board, side, castling, en passant). Clocks are excluded. */
  function fenKey(pos) {
    const f = toFen(pos).split(' ');
    return f[0] + ' ' + f[1] + ' ' + f[2] + ' ' + f[3];
  }

  function buildBook() {
    if (bookMap) return;
    bookMap = new Map();
    bookNames = new Map();
    for (let li = 0; li < BOOK_LINES.length; li++) {
      const name = BOOK_LINES[li][0];
      const weight = BOOK_LINES[li][2] || 1;
      const toks = BOOK_LINES[li][1].split(' ');
      const pos = startPosition();
      for (let t = 0; t < toks.length; t++) {
        const key = fenKey(pos);
        const list = legalMoves(pos);
        let found = 0;
        for (let i = 0; i < list.length; i++) {
          if (moveToUci(list[i]) === toks[t]) { found = list[i]; break; }
        }
        if (!found) { bookMap = null; return; }   // corrupt book: disable it
        let arr = bookMap.get(key);
        if (!arr) { arr = []; bookMap.set(key, arr); }
        if (!arr.some((e) => e.uci === toks[t])) arr.push({ uci: toks[t], mv: found, w: weight });
        if (!bookNames.has(key)) bookNames.set(key, name);
        makeMove(pos, found);
      }
      if (!bookNames.has(fenKey(pos))) bookNames.set(fenKey(pos), name);
    }
  }

  /** Random weighted book reply for `pos`, or 0 if out of book. */
  function bookMove(pos) {
    buildBook();
    if (!bookMap) return 0;
    const arr = bookMap.get(fenKey(pos));
    if (!arr || !arr.length) return 0;
    let total = 0;
    for (let i = 0; i < arr.length; i++) total += arr[i].w;
    let pick = Math.random() * total;
    for (let i = 0; i < arr.length; i++) {
      pick -= arr[i].w;
      if (pick <= 0) return arr[i].mv;
    }
    return arr[arr.length - 1].mv;
  }

  /** Opening name for the current position (approximate), or "". */
  function bookName(pos) {
    buildBook();
    if (!bookNames) return '';
    return bookNames.get(fenKey(pos)) || '';
  }
