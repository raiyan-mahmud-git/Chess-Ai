# ♟️ Chess Lab

> **A high-performance chess engine, interactive analysis board, and verification test lab in a single, zero-dependency HTML file.**

[![Vanilla JS](https://img.shields.io/badge/Language-Vanilla%20JavaScript-yellow.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-brightgreen.svg)](#)
[![Web Worker](https://img.shields.io/badge/Architecture-Web%20Worker%20Thread-blue.svg)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

Chess Lab is a fully self-contained chess engine and analysis GUI running entirely inside your browser. It features a custom **0x88 board representation**, **negamax alpha-beta search with PVS & LMR** running inside an isolated Web Worker, **tapered midgame/endgame evaluation**, full **PGN/FEN support**, audio synthesis via the Web Audio API, and an interactive **Test Lab** for perft verification and engine benchmarking.

---

## 🌟 Key Features

### 🧠 The Engine
- **0x88 Board Architecture:** Single flat `Int8Array` (81 bytes) for instantaneous off-board bit testing (`sq & 0x88`) with zero per-node object allocation or GC overhead.
- **Search Capabilities:**
  - Negamax with Alpha-Beta pruning & Principal Variation Search (PVS).
  - Quiescence search with MVV-LVA move ordering & delta pruning.
  - Null-Move Pruning (with zugzwang safety guards) and Late Move Reductions (LMR).
  - Check extensions and aspiration windowing.
  - 524,288-entry Transposition Table (~10 MB typed arrays) with 64-bit split Zobrist hashing.
  - Killer move heuristics and history counters.
- **Tapered Evaluation:** PeSTO-style midgame/endgame interpolation based on game phase, evaluating pawn structure (islands, doubled, passed, backwards), mobility rays, bishop pairs, rooks on 7th/open files, and king safety zones.
- **Multi-Level Opponents:** From *Beginner* (controlled blunder rate & shallow depth) to *Max* (full iterative deepening with opening book).

### 🖥️ Board & User Experience
- **Responsive Layout:** Dynamic calculation scaling from mobile screens up to 3-column desktop viewports (`Board | Move List | Controls`).
- **Web Audio Sound Effects:** Pure oscillator synthesis without external audio files (distinct cues for move, capture, castle, check, promote, illegal move).
- **Interactive Annotations:** Right-click dragging to draw arrows and highlight squares.
- **Opening Book:** Built-in multi-line opening book with automatic opening identification.
- **Game Analysis:** Post-game graph showing centipawn evaluation swings, inaccuracies, mistakes, and blunders with calculated accuracy percentages.
- **Accessibility:** Keyboard navigation, skip links, screen-reader announcements, and high-contrast support.

### 🧪 Built-In Test Lab (`?test`)
- Real-time in-browser **Perft verification** across canonical test suites (*startpos*, *kiwipete*, positions 3, 4, 5).
- Rule legality tests: castling rights through attack rays, captured rooks, en-passant edge cases, and threefold repetition.
- Automated self-play match runner (benchmark against baseline depth-3 algorithms).

---

## 🚀 Quick Start

Because Chess Lab is built as a single file with zero external dependencies or build tools, running it is instantaneous:

1. Clone or download the repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/chess-lab.git
   cd chess-lab
   ```
2. Open `index.html` in any modern web browser:
   - On Windows: double-click `index.html` or run `start index.html`
   - On macOS: `open index.html`
   - On Linux: `xdg-open index.html`
3. To open the automated test suite, append `?test` to the URL:
   ```text
   file:///path/to/chess-lab/index.html?test
   ```

---

## 📐 Architecture Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                       Browser UI                            │
│  ┌──────────────────┐ ┌──────────────────┐ ┌─────────────┐  │
│  │   Chess Board    │ │ Move List & PGN  │ │   Clocks    │  │
│  │ (Pointer/Arrows) │ │  (SAN / Review)  │ │ (Eval Bar)  │  │
│  └────────▲─────────┘ └────────▲─────────┘ └──────▲──────┘  │
│           │                    │                  │         │
│  ┌────────┴────────────────────┴──────────────────┴──────┐  │
│  │                  Game Controller                      │  │
│  │   - State Management (History, Clocks, FEN Sync)      │  │
│  │   - Audio Synthesizer (Web Audio API)                 │  │
│  │   - LocalStorage & URL State Serialization            │  │
│  └───────────────────────────▲───────────────────────────┘  │
└──────────────────────────────┼──────────────────────────────┘
                               │ Structured Message Protocol
┌──────────────────────────────▼──────────────────────────────┐
│                  Dedicated Web Worker                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                     EngineCore                        │  │
│  │  - 0x88 Mailbox Board & Incremental Zobrist Keys      │  │
│  │  - Pseudo-legal Generator + Make/Unmake State Stack   │  │
│  │  - Tapered Evaluation (Midgame / Endgame PeSTO PST)   │  │
│  │  - Negamax / PVS / LMR / Quiescence Search            │  │
│  │  - 512K Transposition Table                           │  │
│  │  - Built-in Opening Book Map                          │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## ⌨️ Controls & Shortcuts

| Key | Action |
| :--- | :--- |
| **Click / Drag** | Move piece |
| **Right-Click Drag** | Draw tactical arrows |
| **Right-Click Square**| Toggle square highlight |
| **Arrow Keys** | Navigate through move history |
| **N** | Start new game |
| **U** | Undo move |
| **F** | Flip board orientation |
| **H** | Request engine hint |
| **Esc** | Clear selection / Dismiss modals |

---

## 📜 Standards & Compatibility

- **FEN Support:** Full import, export, and live URL hash synchronization (`#fen=...`).
- **PGN Support:** Standards-compliant PGN import and export with full SAN disambiguation, move checks, and metadata headers.
- **Engine Rules:** Compliant with FIDE rules: 50-move rule, threefold repetition, insufficient material detection, castling restrictions, and en-passant capture constraints.

---

## 📄 License

Distributed under the **MIT License**. Feel free to use, modify, and build upon this engine for study or projects.
