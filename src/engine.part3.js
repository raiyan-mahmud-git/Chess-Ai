  /* ==========================================================================
     SECTION 1C - SEARCH
     Negamax + alpha-beta. "Negamax" means every node is evaluated from the point
     of view of the side to move, so there is only one code path: the score of a
     child is simply negated. That is what fixes the original bug where Black's
     best move was chosen by a white-perspective maximiser.

     The search is deliberately incremental: `newSearch()` returns a session and
     `next()` runs ONE iterative-deepening iteration. The worker calls next(),
     posts the info, yields to the event loop and calls it again. That is what
     keeps the Stop button and the live info panel responsive without
     SharedArrayBuffer (which file:// pages do not get).
     ========================================================================== */

  const TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;
  const ttLo = new Int32Array(TT_SIZE);
  const ttHi = new Int32Array(TT_SIZE);
  const ttData = new Int32Array(TT_SIZE);
  const ttScore = new Int16Array(TT_SIZE);

  const killers = new Int32Array(MAX_PLY * 2);
  const history = new Int32Array(128 * 64);
  const nodeBuf = new Int32Array((MAX_PLY + 2) * MAX_MOVES);
  const mvScores = new Int32Array((MAX_PLY + 2) * MAX_MOVES);
  const pvTable = new Int32Array(MAX_PLY * MAX_PLY);
  const pvLen = new Int32Array(MAX_PLY + 2);

  const MVV_VAL = [0, 100, 320, 330, 500, 900, 20000];

  // LMR table: reduction = 0.75 + ln(depth)*ln(moveNumber)/2.25
  const LMR = new Int16Array(65 * 65);
  (function buildLmr() {
    for (let d = 1; d < 65; d++) {
      for (let m = 1; m < 65; m++) {
        LMR[d * 65 + m] = Math.max(0, Math.floor(0.75 + (Math.log(d) * Math.log(m)) / 2.25));
      }
    }
  })();

  const now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  let nodes = 0, seldepth = 0, stopped = false, stopRequested = false;
  let startTime = 0, timeLimit = 1000, nodeLimit = 0, nextLimitCheck = 0;

  function checkLimits() {
    nextLimitCheck = nodes + 2048;
    if (nodeLimit && nodes >= nodeLimit) { stopped = true; return; }
    if (stopRequested) { stopped = true; return; }
    if (now() - startTime >= timeLimit) stopped = true;
  }

  const scoreToTT = (s, ply) => s >= MATE_BOUND ? s + ply : s <= -MATE_BOUND ? s - ply : s;
  const scoreFromTT = (s, ply) => s >= MATE_BOUND ? s - ply : s <= -MATE_BOUND ? s + ply : s;

  /** Can this TT move be applied safely to this position? A corrupted move would
      wreck the board, so every structural assumption is checked before use. */
  function ttMoveUsable(pos, mv) {
    if (!mv) return false;
    const from = mvFrom(mv), to = mvTo(mv), flag = mvFlag(mv), promo = mvPromo(mv);
    const pc = pos.board[from];
    if (!pc) return false;
    const black = (pc & BLACK) !== 0;
    if (black !== (pos.side === BLACK_SIDE)) return false;
    const target = pos.board[to];
    if (target && ((target & BLACK) !== 0) === (pos.side === BLACK_SIDE)) return false;
    if (flag === F_EP) return (pc & 7) === PAWN && pos.ep === to;
    if (flag === F_CASTLE_K) {
      return (pc & 7) === KING && to === (pos.side ? 118 : 6) &&
        ((pos.castling & (pos.side ? CASTLE_BK : CASTLE_WK)) !== 0);
    }
    if (flag === F_CASTLE_Q) {
      return (pc & 7) === KING && to === (pos.side ? 114 : 2) &&
        ((pos.castling & (pos.side ? CASTLE_BQ : CASTLE_WQ)) !== 0);
    }
    if (flag === F_DOUBLE) {
      const delta = to - from;
      return (pc & 7) === PAWN && (delta === 32 || delta === -32);
    }
    if (promo) return (pc & 7) === PAWN && (to >> 4) === (pos.side ? 0 : 7);
    return true;
  }

  function ttStore(pos, mv, score, depth, flag, ply) {
    const i = pos.hashLo & TT_MASK;
    const old = ttData[i];
    if (old !== 0) {
      const sameKey = ttHi[i] === pos.hashHi && ttLo[i] === pos.hashLo;
      const oldDepth = (old >>> 20) & 0x7f;
      // Depth-preferred replacement: never throw away a much deeper result.
      if (!sameKey && oldDepth > depth + 2) return;
    }
    ttLo[i] = pos.hashLo; ttHi[i] = pos.hashHi;
    ttData[i] = (mv & 0xfffff) | (Math.min(depth, 127) << 20) | (flag << 27);
    ttScore[i] = scoreToTT(score, ply);
  }

  function hasNonPawnMaterial(pos, side) {
    const b = pos.board;
    const base = side << 5;
    for (let i = base; i < base + pos.pLen[side]; i++) {
      const t = b[pos.pSq[i]] & 7;
      if (t === KNIGHT || t === BISHOP || t === ROOK || t === QUEEN) return true;
    }
    return false;
  }

  function moveOrderScore(pos, mv, ttMove, ply) {
    if (mv === ttMove) return 1 << 22;
    const to = mvTo(mv), from = mvFrom(mv);
    const flag = mvFlag(mv);
    if (flag === F_CAPTURE || flag === F_EP || flag === F_PROMO_CAP) {
      // MVV-LVA: capture the most valuable victim with the least valuable
      // attacker first. Cheap to compute and dramatically improves cutoffs.
      const victim = flag === F_EP ? PAWN : (pos.board[to] & 7);
      const attacker = pos.board[from] & 7;
      return (1 << 21) + MVV_VAL[victim] * 16 - attacker;
    }
    if (flag === F_PROMO) return (1 << 21) + MVV_VAL[mvPromo(mv)];
    if (mv === killers[ply * 2]) return (1 << 20) + 200;
    if (mv === killers[ply * 2 + 1]) return (1 << 20) + 100;
    return history[(from << 6) | to];
  }

  /* ------------------------------------------------------------ quiescence
     At the horizon, don't stop in the middle of an exchange: keep searching
     captures (and all moves while in check) until the position is quiet.
     This removes most of the "horizon effect" where an engine happily loses a
     piece because the recapture sits one ply beyond its depth limit.
     Delta pruning skips a capture that cannot possibly raise alpha.          */
  function quiesce(pos, alpha, beta, ply) {
    nodes++;
    if (nodes >= nextLimitCheck) checkLimits();
    if (stopped) return 0;
    if (ply > seldepth) seldepth = ply;
    if (pos.half >= 100) return 0;
    if (pos.hLen > 2 && isRepetition(pos)) return 0;
    if (ply >= MAX_PLY - 2) return evaluate(pos);

    const inChk = inCheck(pos, pos.side);
    let best;
    let stand = 0;
    if (inChk) best = -INF;
    else {
      stand = evaluate(pos);
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      best = stand;
    }

    const base = ply * MAX_MOVES;
    const n = genMoves(pos, nodeBuf, base, !inChk);
    for (let i = 0; i < n; i++) {
      const mv = nodeBuf[base + i];
      const to = mvTo(mv), from = mvFrom(mv);
      const flag = mvFlag(mv);
      const victim = flag === F_EP ? PAWN : (pos.board[to] & 7);
      mvScores[base + i] = MVV_VAL[victim] * 16 - (pos.board[from] & 7);
    }

    for (let i = 0; i < n; i++) {
      let bi = i;
      for (let j = i + 1; j < n; j++) if (mvScores[base + j] > mvScores[base + bi]) bi = j;
      if (bi !== i) {
        const tm = nodeBuf[base + i]; nodeBuf[base + i] = nodeBuf[base + bi]; nodeBuf[base + bi] = tm;
        const ts = mvScores[base + i]; mvScores[base + i] = mvScores[base + bi]; mvScores[base + bi] = ts;
      }
      const mv = nodeBuf[base + i];
      const flag = mvFlag(mv);
      const promo = mvPromo(mv);
      const victim = flag === F_EP ? PAWN : (pos.board[mvTo(mv)] & 7);
      if (!inChk && !promo && stand + MVV_VAL[victim] + 180 <= alpha) continue;

      makeMove(pos, mv);
      const us = pos.side ^ 1;
      const ks = us === WHITE_SIDE ? pos.kSq0 : pos.kSq1;
      if (ks < 0 || isAttacked(pos, ks, pos.side)) { unmakeMove(pos, mv); continue; }
      const score = -quiesce(pos, -beta, -alpha, ply + 1);
      unmakeMove(pos, mv);
      if (stopped) return 0;
      if (score > best) {
        best = score;
        if (score > alpha) {
          alpha = score;
          if (alpha >= beta) break;
        }
      }
    }
    if (inChk && best <= -INF + 1) return -MATE + ply;
    return best;
  }

  /* ------------------------------------------------------------- negamax
     The core loop. Ideas used, in plain language:
       * alpha/beta: the window (-INF, +INF) narrows as better moves are found;
         a score outside the window proves the branch cannot change the result,
         so it is cut off.
       * PVS: search the first move with a full window, every later move with a
         null window ("is it better than what I have?"), and re-search with the
         full window only if the answer is yes. Most moves are refuted cheaply.
       * null-move pruning: if passing the move still beats beta, the position is
         so good that a real move will be even better, so stop. Disabled in check
         and in pawn endgames (where passing is a disadvantage - "zugzwang").
       * LMR: late, quiet moves at high depth get searched shallower first; only
         re-searched deeper if they beat alpha.
       * check extension: a move that gives check gets its depth back, because
         forcing lines are cheap and critical to see.
       * TT: reuse the score and best move of a position seen before.
     Mate scores are ply-based: being mated now is -MATE + ply, so shorter mates
     always score higher and the engine prefers the fastest mate.             */
  function negamax(pos, depth, alpha, beta, ply, canNull) {
    nodes++;
    if (nodes >= nextLimitCheck) checkLimits();
    if (stopped) return 0;
    if (ply > seldepth) seldepth = ply;

    if (pos.half >= 100) return 0;
    if (pos.hLen > 2 && isRepetition(pos)) return 0;
    // Draw by insufficient material, checked only when the board is nearly bare
    // (the scan is short then, and it cannot matter with many pieces on).
    if (pos.pLen[0] + pos.pLen[1] <= 4 && insufficientMaterial(pos)) return 0;
    if (ply >= MAX_PLY - 2) return evaluate(pos);

    const inChk = inCheck(pos, pos.side);
    if (depth <= 0) return quiesce(pos, alpha, beta, ply);

    const pvNode = beta - alpha > 1;
    pvLen[ply] = 0;

    const idx = pos.hashLo & TT_MASK;
    let ttMove = 0;
    const data = ttData[idx];
    if (ttHi[idx] === pos.hashHi && ttLo[idx] === pos.hashLo && (data !== 0 || ttScore[idx] !== 0)) {
      const tm = data & 0xfffff;
      if (tm && ttMoveUsable(pos, tm)) ttMove = tm;
      if (!pvNode) {
        const d = (data >>> 20) & 0x7f;
        if (d >= depth) {
          const sc = scoreFromTT(ttScore[idx], ply);
          const flag = (data >>> 27) & 3;
          if (flag === TT_EXACT) return sc;
          if (flag === TT_LOWER && sc >= beta) return sc;
          if (flag === TT_UPPER && sc <= alpha) return sc;
        }
      }
    }

    const staticEval = inChk ? -INF : evaluate(pos);

    // Reverse futility: so far above beta that even a quiet move keeps us there.
    if (!pvNode && !inChk && depth <= 4 && Math.abs(beta) < MATE_BOUND &&
        staticEval - 85 * depth >= beta) return staticEval;

    // Null-move pruning.
    if (!pvNode && !inChk && canNull && depth >= 3 && staticEval >= beta &&
        Math.abs(beta) < MATE_BOUND && hasNonPawnMaterial(pos, pos.side)) {
      const R = 2 + (depth > 6 ? 1 : 0);
      makeNull(pos);
      const sc = -negamax(pos, depth - 1 - R, -beta, -beta + 1, ply + 1, false);
      unmakeNull(pos);
      if (stopped) return 0;
      if (sc >= beta) return sc >= MATE_BOUND ? beta : sc;
    }

    const base = ply * MAX_MOVES;
    const n = genMoves(pos, nodeBuf, base, false);
    for (let i = 0; i < n; i++) {
      mvScores[base + i] = moveOrderScore(pos, nodeBuf[base + i], ttMove, ply);
    }

    let best = -INF, bestMove = 0, legal = 0, flag = TT_UPPER;
    for (let i = 0; i < n; i++) {
      // selection sort: pull the best-scoring remaining move to position i
      let bi = i;
      for (let j = i + 1; j < n; j++) if (mvScores[base + j] > mvScores[base + bi]) bi = j;
      if (bi !== i) {
        const tm = nodeBuf[base + i]; nodeBuf[base + i] = nodeBuf[base + bi]; nodeBuf[base + bi] = tm;
        const ts = mvScores[base + i]; mvScores[base + i] = mvScores[base + bi]; mvScores[base + bi] = ts;
      }
      const mv = nodeBuf[base + i];
      const mFrom = mvFrom(mv), mTo = mvTo(mv), mFlag = mvFlag(mv), mPromo = mvPromo(mv);
      const isCap = mFlag === F_CAPTURE || mFlag === F_EP || mFlag === F_PROMO_CAP;

      makeMove(pos, mv);
      const us = pos.side ^ 1;
      const ks = us === WHITE_SIDE ? pos.kSq0 : pos.kSq1;
      if (ks < 0 || isAttacked(pos, ks, pos.side)) { unmakeMove(pos, mv); continue; }
      legal++;

      const givesCheck = inCheck(pos, pos.side);
      let newDepth = depth - 1;
      if (givesCheck && newDepth < MAX_PLY - 4) newDepth++;      // check extension

      let score;
      if (legal === 1) {
        score = -negamax(pos, newDepth, -beta, -alpha, ply + 1, true);
      } else {
        let r = 0;
        if (depth >= 3 && legal > 3 && !isCap && !mPromo && !givesCheck && !inChk) {
          r = LMR[depth * 65 + Math.min(legal, 64)];
        }
        score = -negamax(pos, newDepth - r, -alpha - 1, -alpha, ply + 1, true);
        if (!stopped && r > 0 && score > alpha) {
          score = -negamax(pos, newDepth, -alpha - 1, -alpha, ply + 1, true);
        }
        if (!stopped && score > alpha && score < beta) {
          score = -negamax(pos, newDepth, -beta, -alpha, ply + 1, true);
        }
      }
      unmakeMove(pos, mv);
      if (stopped) return 0;

      if (score > best) {
        best = score;
        bestMove = mv;
        if (score > alpha) {
          alpha = score;
          flag = TT_EXACT;
          if (ply < MAX_PLY - 2) {
            pvTable[ply * MAX_PLY] = mv;
            const childLen = pvLen[ply + 1];
            for (let k = 0; k < childLen; k++) pvTable[ply * MAX_PLY + 1 + k] = pvTable[(ply + 1) * MAX_PLY + k];
            pvLen[ply] = 1 + childLen;
          }
          if (alpha >= beta) {
            flag = TT_LOWER;
            if (!isCap && !mPromo) {
              if (killers[ply * 2] !== mv) { killers[ply * 2 + 1] = killers[ply * 2]; killers[ply * 2] = mv; }
              const hi = (mFrom << 6) | mTo;
              history[hi] += depth * depth;
              if (history[hi] > (1 << 20)) {
                for (let k = 0; k < history.length; k++) history[k] >>= 1;
              }
            }
            break;
          }
        }
      }
    }

    if (legal === 0) return inChk ? -MATE + ply : 0;
    ttStore(pos, bestMove, best, depth, flag, ply);
    return best;
  }

  /* ------------------------------------------------------------ root search
     Same idea as negamax, but the root needs to keep its move list stable so we
     can (a) report the best move and (b) try it first next iteration.        */
  function rootSearch(depth, alpha, beta) {
    const pos = S.pos;
    const moves = S.rootMoves;
    let bestScore = -INF, bestIdx = -1;
    const a0 = alpha;
    for (let i = 0; i < moves.length; i++) {
      const mv = moves[i];
      makeMove(pos, mv);
      const us = pos.side ^ 1;
      const ks = us === WHITE_SIDE ? pos.kSq0 : pos.kSq1;
      if (ks < 0 || isAttacked(pos, ks, pos.side)) { unmakeMove(pos, mv); continue; }
      let score;
      if (i === 0) {
        score = -negamax(pos, depth - 1, -beta, -alpha, 1, true);
      } else {
        score = -negamax(pos, depth - 1, -alpha - 1, -alpha, 1, true);
        if (!stopped && score > alpha) score = -negamax(pos, depth - 1, -beta, -alpha, 1, true);
      }
      unmakeMove(pos, mv);
      if (stopped) {
        if (bestIdx > 0) { const t = moves[0]; moves[0] = moves[bestIdx]; moves[bestIdx] = t; }
        return bestScore > -INF ? bestScore : a0;
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
        if (score > alpha) {
          alpha = score;
          if (alpha >= beta) break;
        }
      }
    }
    if (bestIdx > 0) {
      const t = moves[0]; moves[0] = moves[bestIdx]; moves[bestIdx] = t;
    }
    return bestScore;
  }

  /** Walk the transposition table to rebuild the principal variation. */
  function extractPv(pos, maxLen) {
    const out = [];
    // The root's own entry is stored explicitly after each iteration.
    for (let step = 0; step < maxLen; step++) {
      const i = pos.hashLo & TT_MASK;
      if (ttHi[i] !== pos.hashHi || ttLo[i] !== pos.hashLo) break;
      const mv = ttData[i] & 0xfffff;
      if (!mv || !ttMoveUsable(pos, mv)) break;
      makeMove(pos, mv);
      const us = pos.side ^ 1;
      const ks = us === WHITE_SIDE ? pos.kSq0 : pos.kSq1;
      if (ks < 0 || isAttacked(pos, ks, pos.side)) { unmakeMove(pos, mv); break; }
      out.push(mv);
    }
    for (let i = out.length - 1; i >= 0; i--) unmakeMove(pos, out[i]);
    return out;
  }

  function pvToSan(pos, pv) {
    const out = [];
    for (let i = 0; i < pv.length; i++) {
      out.push(sanOf(pos, pv[i]));
      makeMove(pos, pv[i]);
    }
    for (let i = pv.length - 1; i >= 0; i--) unmakeMove(pos, pv[i]);
    return out;
  }

  const S = {
    pos: null, rootMoves: null, nextDepth: 1, maxDepth: 1, depth: 0,
    bestMove: 0, bestScore: 0, pv: [], finished: true, nodes: 0, seldepth: 0,
    elapsed: 0, mate: null
  };

  function scoreToMate(score) {
    if (score >= MATE_BOUND) return Math.ceil((MATE - score) / 2);
    if (score <= -MATE_BOUND) return -Math.ceil((MATE + score) / 2);
    return null;
  }

  /**
   * Start a search. Returns nothing; call searchNext() until it returns null.
   * @param {object} pos position (mutated during the search, restored after)
   * @param {{depth?:number,timeMs?:number,nodes?:number}} [opts]
   */
  function searchStart(pos, opts) {
    opts = opts || {};
    S.pos = pos;
    S.rootMoves = legalMoves(pos);
    S.nextDepth = 1;
    S.maxDepth = Math.max(1, Math.min(opts.depth || MAX_PLY - 8, MAX_PLY - 8));
    S.depth = 0;
    S.bestMove = S.rootMoves.length ? S.rootMoves[0] : 0;
    S.bestScore = 0;
    S.pv = [];
    S.finished = !S.rootMoves.length;
    S.mate = null;
    nodes = 0; seldepth = 0; stopped = false; stopRequested = false;
    startTime = now();
    timeLimit = opts.timeMs || 1000;
    nodeLimit = opts.nodes || 0;
    nextLimitCheck = 0;
    killers.fill(0);
    // Decay history between searches instead of clearing it: ordering knowledge
    // from earlier moves in the same game is still useful.
    for (let i = 0; i < history.length; i++) history[i] >>= 1;
    for (let i = 0; i <= MAX_PLY; i++) pvLen[i] = 0;
  }

  function searchStop() { stopRequested = true; }

  /** Run one iterative-deepening iteration. Returns an info object, or null
      when the search is finished/stopped. */
  function searchNext() {
    if (S.finished || !S.pos) return null;
    const d = S.nextDepth;
    if (d > S.maxDepth) { S.finished = true; return null; }

    let score;
    // Aspiration windows: assume the new depth is close to the previous score
    // and search a narrow window. If that fails, re-search with a full window.
    if (d >= 5 && Math.abs(S.bestScore) < MATE_BOUND) {
      const alpha = Math.max(-INF, S.bestScore - 35);
      const beta = Math.min(INF, S.bestScore + 35);
      score = rootSearch(d, alpha, beta);
      if (!stopped && (score <= alpha || score >= beta)) score = rootSearch(d, -INF, INF);
    } else {
      score = rootSearch(d, -INF, INF);
    }
    if (stopped || stopRequested) { S.finished = true; return null; }

    S.depth = d;
    S.bestScore = score;
    S.bestMove = S.rootMoves.length ? S.rootMoves[0] : 0;
    ttStore(S.pos, S.bestMove, score, d, TT_EXACT, 0);
    S.pv = extractPv(S.pos, Math.min(24, d + 2));
    if (!S.pv.length && S.bestMove) S.pv = [S.bestMove];
    S.nextDepth = d + 1;
    S.nodes = nodes;
    S.seldepth = seldepth;
    S.elapsed = now() - startTime;
    S.mate = scoreToMate(score);

    const info = {
      depth: d, seldepth: seldepth, score: score, mate: S.mate,
      nodes: nodes, timeMs: S.elapsed,
      nps: S.elapsed > 0 ? Math.round((nodes * 1000) / S.elapsed) : 0,
      pv: S.pv.slice(), pvSan: pvToSan(S.pos, S.pv),
      bestMove: S.bestMove, bestUci: S.bestMove ? moveToUci(S.bestMove) : ''
    };
    if (S.nextDepth > S.maxDepth) S.finished = true;
    return info;
  }

  /** Final result of the last completed iteration. */
  function searchResult() {
    return {
      bestMove: S.bestMove, bestUci: S.bestMove ? moveToUci(S.bestMove) : '',
      score: S.bestScore, mate: S.mate, depth: S.depth, seldepth: S.seldepth,
      nodes: S.nodes, timeMs: S.elapsed,
      nps: S.elapsed > 0 ? Math.round((S.nodes * 1000) / S.elapsed) : 0,
      pv: S.pv.slice(), pvSan: pvToSan(S.pos, S.pv)
    };
  }

  /* ==========================================================================
     SECTION 1D - MATCH RUNNER (strength self-check)
     Plays the new engine against a baseline built from the original algorithm:
     fixed depth-3 alpha-beta with material + piece-square evaluation, no
     quiescence, no transposition table, no move ordering beyond captures.
     It deliberately shares the new (correct) move generator so the comparison
     measures search + evaluation quality, not bug-fixing.
     ========================================================================== */
  function runMatch(baseline, opts) {
    opts = opts || {};
    const games = opts.games || 20;
    const timeMs = opts.timeMs || 200;
    const maxPlies = opts.maxPlies || 160;
    const starts = opts.positions || [START_FEN];
    const results = [];
    let wins = 0, draws = 0, losses = 0;

    for (let g = 0; g < games; g++) {
      const startFen = starts[g % starts.length];
      const loaded = fromFen(startFen);
      if (!loaded.ok) { results.push({ error: loaded.error }); continue; }
      const pos = loaded.pos;
      const newIsWhite = (g & 1) === 0;
      const reps = new Map();
      let plies = 0, outcome = '';

      while (plies < maxPlies) {
        const legal = legalMoves(pos);
        if (!legal.length) {
          outcome = inCheck(pos, pos.side)
            ? ((pos.side === WHITE_SIDE) === newIsWhite ? 'loss' : 'win')
            : 'draw';
          break;
        }
        if (pos.half >= 100) { outcome = 'draw'; break; }
        if (insufficientMaterial(pos)) { outcome = 'draw'; break; }
        const key = toFen(pos).split(' ').slice(0, 4).join(' ');
        const seen = (reps.get(key) || 0) + 1;
        reps.set(key, seen);
        if (seen >= 3) { outcome = 'draw'; break; }

        const newSideToMove = (pos.side === WHITE_SIDE) === newIsWhite;
        let mv;
        if (newSideToMove) {
          searchStart(pos, { timeMs: timeMs, depth: 64 });
          let info = null;
          while ((info = searchNext())) { /* run to completion */ }
          mv = S.bestMove;
        } else {
          mv = baseline.chooseMove(pos);
        }
        if (!mv) { outcome = 'draw'; break; }
        makeMove(pos, mv);
        plies++;
      }
      if (!outcome) outcome = 'draw';          // adjudicated by the ply limit
      results.push({ startFen: startFen, newIsWhite: newIsWhite, plies: plies, outcome: outcome, finalFen: toFen(pos) });
      if (outcome === 'win') wins++;
      else if (outcome === 'loss') losses++;
      else draws++;
      if (opts.onGame) opts.onGame(results.length, games, results[results.length - 1]);
    }
    const score = wins + draws * 0.5;
    return {
      games: results, wins: wins, draws: draws, losses: losses,
      score: score, total: results.length,
      scorePct: results.length ? (100 * score) / results.length : 0
    };
  }
