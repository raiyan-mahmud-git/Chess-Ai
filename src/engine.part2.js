  /* ==========================================================================
     SECTION 1B - EVALUATION
     A search is only as good as the number it is optimising. This eval is
     "tapered": every term is computed twice, once for the middlegame and once
     for the endgame, and then blended by the game phase. A queen is worth much
     more with 12 pieces on the board than in a bare endgame, and a king is a
     liability in the middlegame but a strong piece in the endgame - a single
     score cannot express both.
     All numbers are centipawns (100 = one pawn). Tweak the constants here.
     ========================================================================== */

  // Material. PeSTO-style midgame/endgame split (Friederich's values, rounded).
  const MG_VAL = [0, 82, 337, 365, 477, 1025, 0];
  const EG_VAL = [0, 94, 281, 297, 512, 936, 0];
  const PHASE_W = [0, 0, 1, 1, 2, 4, 0];        // phase units per piece
  const PHASE_TOTAL = 24;

  /* Piece-square tables. Index = rank * 8 + file with rank 0 = rank 1, i.e. the
     tables are written from White's point of view, starting at White's first
     rank. Black reads them mirrored vertically. Positive = good for that side.
     These are hand-built rather than copied: the point is that you can edit a
     square's value and immediately feel the difference in the engine's plans. */
  const PST_P_MG = [
       0,  0,  0,  0,  0,  0,  0,  0,
      -6, -4, -6, -8, -8, -6, -4, -6,
      -4, -2,  2,  4,  4,  2, -2, -4,
       0,  2,  6, 12, 12,  6,  2,  0,
       4,  8, 14, 20, 20, 14,  8,  4,
      10, 14, 22, 30, 30, 22, 14, 10,
      25, 32, 42, 50, 50, 42, 32, 25,
       0,  0,  0,  0,  0,  0,  0,  0];
  const PST_P_EG = [
       0,  0,  0,  0,  0,  0,  0,  0,
      -6, -4, -4, -6, -6, -4, -4, -6,
       0,  0,  2,  4,  4,  2,  0,  0,
       4,  6,  8, 12, 12,  8,  6,  4,
      10, 14, 20, 26, 26, 20, 14, 10,
      24, 32, 42, 50, 50, 42, 32, 24,
      55, 65, 80, 90, 90, 80, 65, 55,
       0,  0,  0,  0,  0,  0,  0,  0];
  const PST_N_MG = [
     -50, -40, -30, -30, -30, -30, -40, -50,
     -40, -20,   0,   2,   2,   0, -20, -40,
     -30,   2,  12,  16,  16,  12,   2, -30,
     -30,   6,  16,  22,  22,  16,   6, -30,
     -30,   6,  16,  22,  22,  16,   6, -30,
     -30,   2,  12,  16,  16,  12,   2, -30,
     -40, -20,   0,   2,   2,   0, -20, -40,
     -50, -40, -30, -30, -30, -30, -40, -50];
  const PST_N_EG = [
     -45, -35, -28, -28, -28, -28, -35, -45,
     -35, -18,   0,   2,   2,   0, -18, -35,
     -28,   2,  10,  14,  14,  10,   2, -28,
     -28,   5,  14,  18,  18,  14,   5, -28,
     -28,   5,  14,  18,  18,  14,   5, -28,
     -28,   2,  10,  14,  14,  10,   2, -28,
     -35, -18,   0,   2,   2,   0, -18, -35,
     -45, -35, -28, -28, -28, -28, -35, -45];
  const PST_B_MG = [
     -20, -10, -10, -10, -10, -10, -10, -20,
     -10,   0,   2,   0,   0,   2,   0, -10,
     -10,   4,   6,   8,   8,   6,   4, -10,
     -10,   2,   8,  10,  10,   8,   2, -10,
     -10,   2,   8,  10,  10,   8,   2, -10,
     -10,   4,   6,   8,   8,   6,   4, -10,
     -10,   2,   0,   2,   2,   0,   2, -10,
     -20, -10, -10, -10, -10, -10, -10, -20];
  const PST_B_EG = [
     -16,  -8,  -8,  -8,  -8,  -8,  -8, -16,
      -8,   0,   2,   2,   2,   2,   0,  -8,
      -8,   2,   6,   8,   8,   6,   2,  -8,
      -8,   2,   8,  12,  12,   8,   2,  -8,
      -8,   2,   8,  12,  12,   8,   2,  -8,
      -8,   2,   6,   8,   8,   6,   2,  -8,
      -8,   2,   2,   2,   2,   2,   2,  -8,
     -16,  -8,  -8,  -8,  -8,  -8,  -8, -16];
  const PST_R_MG = [
       0,   0,   0,   2,   2,   0,   0,   0,
       6,   8,   8,  10,  10,   8,   8,   6,
      -2,   0,   0,   2,   2,   0,   0,  -2,
      -2,   0,   0,   2,   2,   0,   0,  -2,
      -2,   0,   0,   2,   2,   0,   0,  -2,
      -2,   0,   0,   2,   2,   0,   0,  -2,
      -2,   0,   0,   0,   0,   0,   0,  -2,
       0,   0,   2,   6,   6,   2,   0,   0];
  const PST_R_EG = [
       2,   2,   2,   4,   4,   2,   2,   2,
       6,   8,   8,  10,  10,   8,   8,   6,
       0,   0,   0,   2,   2,   0,   0,   0,
       0,   0,   0,   2,   2,   0,   0,   0,
       0,   0,   0,   2,   2,   0,   0,   0,
       0,   0,   0,   2,   2,   0,   0,   0,
       2,   2,   2,   2,   2,   2,   2,   2,
       0,   0,   2,   4,   4,   2,   0,   0];
  const PST_Q_MG = [
     -16,  -8,  -8,  -4,  -4,  -8,  -8, -16,
      -8,   0,   2,   0,   0,   0,   0,  -8,
      -8,   2,   4,   4,   4,   4,   2,  -8,
      -4,   0,   4,   4,   4,   4,   0,  -4,
      -4,   0,   4,   4,   4,   4,   0,  -4,
      -8,   2,   4,   4,   4,   4,   2,  -8,
      -8,   0,   2,   2,   2,   2,   0,  -8,
     -16,  -8,  -8,  -4,  -4,  -8,  -8, -16];
  const PST_Q_EG = [
     -20, -12, -12,  -8,  -8, -12, -12, -20,
     -12,  -4,  -2,   0,   0,  -2,  -4, -12,
     -12,  -2,   4,   6,   6,   4,  -2, -12,
      -8,   0,   6,   8,   8,   6,   0,  -8,
      -8,   0,   6,   8,   8,   6,   0,  -8,
     -12,  -2,   4,   6,   6,   4,  -2, -12,
     -12,  -4,  -2,   0,   0,  -2,  -4, -12,
     -20, -12, -12,  -8,  -8, -12, -12, -20];
  const PST_K_MG = [
      20,  35,  15, -20, -20,  15,  35,  20,     // castled corners are good,
      20,  20,   0, -20, -20,   0,  20,  20,     // the centre is not
     -15, -25, -25, -35, -35, -25, -25, -15,
     -30, -45, -45, -55, -55, -45, -45, -30,
     -40, -55, -55, -65, -65, -55, -55, -40,
     -40, -55, -55, -65, -65, -55, -55, -40,
     -40, -55, -55, -65, -65, -55, -55, -40,
     -40, -55, -55, -65, -65, -55, -55, -40];
  const PST_K_EG = [
     -50, -30, -30, -30, -30, -30, -30, -50,
     -30, -30,   0,   0,   0,   0, -30, -30,
     -30, -10,  20,  30,  30,  20, -10, -30,
     -30, -10,  30,  40,  40,  30, -10, -30,
     -30, -10,  30,  40,  40,  30, -10, -30,
     -30, -10,  20,  30,  30,  20, -10, -30,
     -30, -40,  10,  10,  10,  10, -40, -30,
     -50, -40, -30, -30, -30, -30, -40, -50];

  const PST_MG = new Int16Array(7 * 64);
  const PST_EG = new Int16Array(7 * 64);
  (function buildPst() {
    const src = [null, PST_P_MG, PST_N_MG, PST_B_MG, PST_R_MG, PST_Q_MG, PST_K_MG];
    const srcEg = [null, PST_P_EG, PST_N_EG, PST_B_EG, PST_R_EG, PST_Q_EG, PST_K_EG];
    for (let t = 1; t <= 6; t++) {
      for (let i = 0; i < 64; i++) {
        PST_MG[t * 64 + i] = src[t][i];
        PST_EG[t * 64 + i] = srcEg[t][i];
      }
    }
  })();

  /* Tunable weights - every magic number of the evaluation, in one place. */
  const W = {
    tempoMG: 10,
    bishopPairMG: 30, bishopPairEG: 48,
    rookOpenMG: 20, rookOpenEG: 12,
    rookSemiMG: 10, rookSemiEG: 6,
    rook7thMG: 16, rook7thEG: 28,
    knightOutpost: 20,
    doubledMG: 9, doubledEG: 14,
    isolatedMG: 14, isolatedEG: 12,
    backwardMG: 8, backwardEG: 6,
    passedMG: [0, 4, 8, 16, 32, 60, 100, 140],
    passedEG: [0, 8, 16, 30, 55, 95, 150, 200],
    protectedPasserMG: 12, protectedPasserEG: 22,
    shieldMG: 12,                 // per missing shield pawn
    openFileNearKingMG: 22,
    semiOpenFileNearKingMG: 12,
    kingDangerMG: 3,              // multiplied by danger^2
    kingDangerCap: 240,
    mobN: [4, 3], mobB: [3, 3], mobR: [2, 4], mobQ: [1, 1],
    mateDriveEdge: 8, mateDriveKing: 4
  };

  // Scratch buffers: allocated once, reused by every evaluate() call. Eval is
  // single-threaded and not reentrant, so this is safe and allocation-free.
  const PAWN_FILES_W = new Uint8Array(8);
  const PAWN_FILES_B = new Uint8Array(8);

  function popcount8(v) {
    v = v - ((v >> 1) & 0x55);
    v = (v & 0x33) + ((v >> 2) & 0x33);
    return (v + (v >> 4)) & 0x0f;
  }

  /** Does a pawn mask contain a pawn on a rank strictly greater than r? */
  function maskAbove(mask, r) { return (mask & (~((1 << (r + 1)) - 1) & 0xff)) !== 0; }
  /** ... strictly less than r? */
  function maskBelow(mask, r) { return (mask & ((1 << r) - 1)) !== 0; }

  /** King-distance / edge bonus used to actually finish KQ-vs-K and KR-vs-K.
      Without it a winning side shuffles forever: material is already +9, so
      every move looks equally winning to a pure material evaluation.        */
  function mateDriveBonus(loserSq, winnerSq) {
    const lf = loserSq & 7, lr = loserSq >> 4;
    const wf = winnerSq & 7, wr = winnerSq >> 4;
    const edge = Math.abs(lf - 3.5) + Math.abs(lr - 3.5);      // 0 centre .. 7 corner
    const dist = Math.abs(lf - wf) + Math.abs(lr - wr);         // king proximity
    return W.mateDriveEdge * edge + W.mateDriveKing * (14 - dist);
  }

  /** Enemy pieces that attack the 3x3 box around `kingSq`, weighted by type.
      Cheap because we only walk rays from each attacker until a blocker. */
  function kingDanger(pos, kingSq, bySide) {
    const b = pos.board;
    const base = bySide << 5;
    const end = base + pos.pLen[bySide];
    const kf = kingSq & 7, kr = kingSq >> 4;
    let danger = 0;
    for (let i = base; i < end; i++) {
      const sq = pos.pSq[i];
      const pc = b[sq];
      const type = pc & 7;
      const f = sq & 7, r = sq >> 4;
      const df = f - kf, dr = r - kr;
      if (type === KNIGHT) {
        // If any of the knight's eight targets lands in the king's 3x3 box,
        // the knight is one of the attackers.
        for (let k = 0; k < 8; k++) {
          const t = sq + KNIGHT_OFF[k];
          if (t & 0x88) continue;
          if (Math.abs((t & 7) - kf) <= 1 && Math.abs((t >> 4) - kr) <= 1) { danger += 2; break; }
        }
      } else if (type === BISHOP || type === ROOK || type === QUEEN) {
        const dirs = type === ROOK ? ROOK_OFF : type === BISHOP ? BISHOP_OFF : QUEEN_OFF;
        const cnt = type === QUEEN ? 8 : 4;
        for (let k = 0; k < cnt; k++) {
          const d = dirs[k];
          let hit = false;
          for (let t = sq + d; (t & 0x88) === 0; t += d) {
            const tf = t & 7, tr = t >> 4;
            if (Math.abs(tf - kf) <= 1 && Math.abs(tr - kr) <= 1) {
              danger += type === QUEEN ? 4 : type === ROOK ? 3 : 2;
              hit = true;
              break;
            }
            if (b[t]) break;
          }
          if (hit) break;          // one attack per piece is enough
        }
      } else if (type === PAWN) {
        const dir = bySide === WHITE_SIDE ? 1 : -1;
        const af1 = f - 1, af2 = f + 1, ar = r + dir;
        if (ar >= 0 && ar < 8) {
          if ((af1 === kf || af2 === kf) && ar >= kr - 1 && ar <= kr + 1) danger += 1;
        }
      }
    }
    return danger;
  }

  /** Static evaluation, in centipawns, from the side-to-move's point of view. */
  function evaluate(pos) {
    const b = pos.board;
    const wFiles = PAWN_FILES_W, bFiles = PAWN_FILES_B;
    wFiles.fill(0); bFiles.fill(0);

    let mgW = 0, egW = 0, mgB = 0, egB = 0;
    let phase = 0;
    let wBishops = 0, bBishops = 0;
    let wPawns = 0, bPawns = 0;
    let wNonPawn = 0, bNonPawn = 0;

    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }          // skip the off-board half of the rank
      const pc = b[sq];
      if (!pc) continue;
      const type = pc & 7;
      const black = (pc & BLACK) !== 0;
      const r = sq >> 4, f = sq & 7;
      const idx = black ? (7 - r) * 8 + f : r * 8 + f;
      const mg = MG_VAL[type] + PST_MG[type * 64 + idx];
      const eg = EG_VAL[type] + PST_EG[type * 64 + idx];
      if (black) { mgB += mg; egB += eg; } else { mgW += mg; egW += eg; }
      phase += PHASE_W[type];

      switch (type) {
        case PAWN:
          if (black) { bFiles[f] |= 1 << r; bPawns++; } else { wFiles[f] |= 1 << r; wPawns++; }
          break;
        case BISHOP:
          if (black) bBishops++; else wBishops++;
          // Mobility: count squares along the diagonals until a blocker.
          // This is NOT legal move generation - no make/unmake, no king test.
          // Mobility is worth ~4cp per square, and doing it cheaply is why the
          // evaluation can run at the leaf of every search node.
          {
            let m = 0;
            for (let k = 0; k < 4; k++) {
              const d = BISHOP_OFF[k];
              for (let t = sq + d; (t & 0x88) === 0; t += d) {
                const c = b[t];
                if (!c) { m++; continue; }
                if (((c & BLACK) !== 0) !== black) m++;
                break;
              }
            }
            if (black) { mgB += m * W.mobB[0]; egB += m * W.mobB[1]; }
            else { mgW += m * W.mobB[0]; egW += m * W.mobB[1]; }
          }
          break;
        case KNIGHT: {
          let m = 0;
          for (let k = 0; k < 8; k++) {
            const t = sq + KNIGHT_OFF[k];
            if (t & 0x88) continue;
            const c = b[t];
            if (!c) m++;
            else if (((c & BLACK) !== 0) !== black) m++;
          }
          if (black) { mgB += m * W.mobN[0]; egB += m * W.mobN[1]; }
          else { mgW += m * W.mobN[0]; egW += m * W.mobN[1]; }
          break;
        }
        case ROOK: {
          let m = 0;
          for (let k = 0; k < 4; k++) {
            const d = ROOK_OFF[k];
            for (let t = sq + d; (t & 0x88) === 0; t += d) {
              const c = b[t];
              if (!c) { m++; continue; }
              if (((c & BLACK) !== 0) !== black) m++;
              break;
            }
          }
          if (black) { mgB += m * W.mobR[0]; egB += m * W.mobR[1]; }
          else { mgW += m * W.mobR[0]; egW += m * W.mobR[1]; }
          break;
        }
        case QUEEN: {
          let m = 0;
          for (let k = 0; k < 8; k++) {
            const d = QUEEN_OFF[k];
            for (let t = sq + d; (t & 0x88) === 0; t += d) {
              const c = b[t];
              if (!c) { m++; continue; }
              if (((c & BLACK) !== 0) !== black) m++;
              break;
            }
          }
          if (black) { mgB += m * W.mobQ[0]; egB += m * W.mobQ[1]; }
          else { mgW += m * W.mobQ[0]; egW += m * W.mobQ[1]; }
          break;
        }
      }
      if (type !== PAWN && type !== KING) {
        if (black) bNonPawn += MG_VAL[type]; else wNonPawn += MG_VAL[type];
      }
    }

    if (wBishops >= 2) { mgW += W.bishopPairMG; egW += W.bishopPairEG; }
    if (bBishops >= 2) { mgB += W.bishopPairMG; egB += W.bishopPairEG; }

    /* ---- pawn structure + rook/knight placement, per side ---- */
    for (let c = 0; c < 2; c++) {
      const ownFiles = c === 0 ? wFiles : bFiles;
      const oppFiles = c === 0 ? bFiles : wFiles;
      const base = c << 5;
      const end = base + pos.pLen[c];
      let mg = 0, eg = 0;
      for (let i = base; i < end; i++) {
        const sq = pos.pSq[i];
        const pc = b[sq];
        const type = pc & 7;
        const r = sq >> 4, f = sq & 7;
        const relRank = c === 0 ? r : 7 - r;          // 0 = own back rank

        if (type === PAWN) {
          // Doubled: there is another friendly pawn behind me on this file.
          const own = ownFiles[f];
          if (c === 0 ? maskBelow(own, r) : maskAbove(own, r)) { mg -= W.doubledMG; eg -= W.doubledEG; }
          // Isolated: no friendly pawn on either adjacent file.
          const left = f > 0 ? ownFiles[f - 1] : 0;
          const right = f < 7 ? ownFiles[f + 1] : 0;
          if (!left && !right) { mg -= W.isolatedMG; eg -= W.isolatedEG; }
          // Backward: cannot be supported by a neighbour and the stop square is
          // controlled by an enemy pawn.
          const supported = c === 0
            ? (maskBelow(left, r) || maskBelow(right, r))
            : (maskAbove(left, r) || maskAbove(right, r));
          if (!supported) {
            const stop = c === 0 ? sq + 16 : sq - 16;
            if (!(stop & 0x88)) {
              const af = stop & 7, ar = stop >> 4;
              let enemyAttacks = false;
              if (c === 0) {
                if (af > 0 && b[(ar - 1) * 16 + af - 1] === (PAWN | BLACK)) enemyAttacks = true;
                if (af < 7 && b[(ar - 1) * 16 + af + 1] === (PAWN | BLACK)) enemyAttacks = true;
              } else {
                if (af > 0 && b[(ar + 1) * 16 + af - 1] === PAWN) enemyAttacks = true;
                if (af < 7 && b[(ar + 1) * 16 + af + 1] === PAWN) enemyAttacks = true;
              }
              if (enemyAttacks) { mg -= W.backwardMG; eg -= W.backwardEG; }
            }
          }
          // Passed pawn: no enemy pawn on this or an adjacent file ahead of me.
          const lOpp = f > 0 ? oppFiles[f - 1] : 0;
          const rOpp = f < 7 ? oppFiles[f + 1] : 0;
          const passed = c === 0
            ? (!maskAbove(oppFiles[f], r) && !maskAbove(lOpp, r) && !maskAbove(rOpp, r))
            : (!maskBelow(oppFiles[f], r) && !maskBelow(lOpp, r) && !maskBelow(rOpp, r));
          if (passed) {
            mg += W.passedMG[relRank];
            eg += W.passedEG[relRank];
            // A protected passer is a genuine long-term asset.
            if (c === 0 ? (maskBelow(left, r) || maskBelow(right, r))
                        : (maskAbove(left, r) || maskAbove(right, r))) {
              mg += W.protectedPasserMG; eg += W.protectedPasserEG;
            }
          }
        } else if (type === ROOK) {
          const ownHere = ownFiles[f], oppHere = oppFiles[f];
          if (!ownHere) {
            if (!oppHere) { mg += W.rookOpenMG; eg += W.rookOpenEG; }
            else { mg += W.rookSemiMG; eg += W.rookSemiEG; }
          }
          if (relRank === 6) { mg += W.rook7thMG; eg += W.rook7thEG; }
        } else if (type === KNIGHT) {
          // Outpost: a knight on the 4th-6th rank, protected by a pawn, that no
          // enemy pawn can chase away. Such a knight is worth a bishop.
          if (relRank >= 2 && relRank <= 5) {
            const left = f > 0 ? ownFiles[f - 1] : 0;
            const right = f < 7 ? ownFiles[f + 1] : 0;
            const supported = c === 0
              ? (maskBelow(left, r) || maskBelow(right, r))
              : (maskAbove(left, r) || maskAbove(right, r));
            const lOpp = f > 0 ? oppFiles[f - 1] : 0;
            const rOpp = f < 7 ? oppFiles[f + 1] : 0;
            const chased = c === 0
              ? (maskAbove(oppFiles[f], r) || maskAbove(lOpp, r) || maskAbove(rOpp, r))
              : (maskBelow(oppFiles[f], r) || maskBelow(lOpp, r) || maskBelow(rOpp, r));
            if (supported && !chased) { mg += W.knightOutpost; eg += W.knightOutpost; }
          }
        }
      }
      if (c === 0) { mgW += mg; egW += eg; } else { mgB += mg; egB += eg; }
    }

    /* ---- king safety (middlegame only) ---- */
    if (phase > 8) {
      for (let c = 0; c < 2; c++) {
        const ks = c === 0 ? pos.kSq0 : pos.kSq1;
        if (ks < 0) continue;
        const r = ks >> 4, f = ks & 7;
        const ownFiles = c === 0 ? wFiles : bFiles;
        const oppFiles = c === 0 ? bFiles : wFiles;
        let penalty = 0;
        // pawn shield: three pawns in front of the king (when it is at home)
        const shieldRank = c === 0 ? r + 1 : r - 1;
        if (shieldRank >= 0 && shieldRank < 8) {
          for (let df = -1; df <= 1; df++) {
            const ff = f + df;
            if (ff < 0 || ff > 7) continue;
            if (!((ownFiles[ff] >> shieldRank) & 1)) penalty += W.shieldMG;
          }
        }
        // open files next to the king are how attacks actually arrive
        for (let df = -1; df <= 1; df++) {
          const ff = f + df;
          if (ff < 0 || ff > 7) continue;
          if (!ownFiles[ff]) penalty += oppFiles[ff] ? W.openFileNearKingMG : W.semiOpenFileNearKingMG;
        }
        const danger = kingDanger(pos, ks, c ^ 1);
        if (danger > 1) penalty += Math.min(W.kingDangerCap, danger * danger * W.kingDangerMG);
        if (c === 0) mgW -= penalty; else mgB -= penalty;
      }
    }

    /* ---- mating knowledge: drive a bare king to the edge ---- */
    if (bPawns === 0 && bNonPawn === 0 && wNonPawn >= MG_VAL[ROOK]) {
      egW += mateDriveBonus(pos.kSq1, pos.kSq0);
    }
    if (wPawns === 0 && wNonPawn === 0 && bNonPawn >= MG_VAL[ROOK]) {
      egB += mateDriveBonus(pos.kSq0, pos.kSq1);
    }

    /* ---- taper: blend middlegame and endgame by remaining material ---- */
    const ph = Math.min(PHASE_TOTAL, phase);
    let score = ((mgW - mgB) * ph + (egW - egB) * (PHASE_TOTAL - ph)) / PHASE_TOTAL;
    if (pos.side === WHITE_SIDE) score += W.tempoMG; else score -= W.tempoMG;
    score = pos.side === WHITE_SIDE ? score : -score;
    if (score > 20000) score = 20000;
    if (score < -20000) score = -20000;
    return score | 0;
  }
