// ============================================================
// Eels & Escalators — board layout
// A 10x10 (1–100) snakes-and-ladders style board, themed as
// escalators (up) and eels (down), matching the uploaded board art.
//
// ⚠️ These squares were read off the board image and are the one part
// of this feature worth double-checking against your actual board —
// if any square is off by one, just fix the number here; nothing
// else in the app needs to change.
// ============================================================

export const BOARD_SIZE = 100;

// square you land ON (key) -> square you end up at (value), going UP
export const ESCALATORS = {
  3: 23,
  8: 13,
  39: 42,
  44: 56,
  64: 84,
  75: 95,
};

// square you land ON (key) -> square you end up at (value), going DOWN
export const EELS = {
  16: 5,
  48: 27,
  53: 33,
  73: 52,
  89: 68,
  93: 72,
  97: 76,
};

// Resolve where a player actually ends up after landing on `square`
// (applies at most one escalator/eel — the board is designed so a
// landing square is never itself the head/tail of another feature).
export function resolveLanding(square) {
  if (square >= BOARD_SIZE) return { square: BOARD_SIZE, type: null };
  if (ESCALATORS[square] != null) return { square: ESCALATORS[square], type: 'escalator' };
  if (EELS[square] != null) return { square: EELS[square], type: 'eel' };
  return { square, type: null };
}
