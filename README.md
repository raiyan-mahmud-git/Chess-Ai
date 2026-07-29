# ♟️ Chess AI

A feature-rich browser-based chess game built with **HTML, CSS, and Vanilla JavaScript**. It includes a complete chess rules engine, drag-and-drop gameplay, AI move suggestions using the Minimax algorithm with Alpha-Beta pruning, FEN/PGN support, and game state detection.

## Features

-  Complete chess rules implementation
-  AI move suggestions (Minimax + Alpha-Beta Pruning)
-  Legal move validation
-  Check, Checkmate, and Stalemate detection
-  Castling
-  En Passant
-  Pawn Promotion
-  Undo moves
-  Move history
-  FEN import/export
-  PGN export
-  Position evaluation score
-  Responsive UI
-  Drag & Drop support
-  AI move highlighting

---

## Technologies Used

- HTML5
- CSS3
- Vanilla JavaScript

No external libraries or frameworks are required.

---

## AI Engine

The built-in chess AI includes:

- Minimax Search
- Alpha-Beta Pruning
- Material Evaluation
- Piece-Square Tables
- Mobility Evaluation
- Move Ordering

Current search depth:
- **Depth 3**

---

## Chess Rules Supported

- Standard piece movement
- Legal move filtering
- King safety checking
- Check detection
- Checkmate detection
- Stalemate detection
- Threefold repetition
- Fifty-move rule
- Insufficient material draw
- Castling
- En Passant
- Pawn promotion

---

## Project Structure

```
index.html
```

Everything (HTML, CSS, JavaScript, and the chess engine) is contained in a single file.

---

## How to Run

1. Download the repository.
2. Open `index.html` in any modern web browser.

No installation or dependencies are required.

---

## Controls

- Click a piece to see legal moves.
- Drag and drop pieces to move.
- **Best Move** → Shows the AI's recommended move.
- **Undo** → Reverts the previous move.
- **New Game** → Starts a new game.
- **Load FEN** → Loads a custom chess position.
- **Export FEN** → Copies the current position.
- **Export PGN** → Exports the move history.

---

## Future Improvements

- Stronger AI (Depth 5–8)
- Opening book
- Transposition table (Zobrist hashing)
- Iterative deepening
- Multiplayer support
- Online play
- Time controls
- AI vs AI mode
- Game analysis
- Move animations
- Sound effects
- Opening explorer

---

## License

This project is open source and available under the MIT License.
