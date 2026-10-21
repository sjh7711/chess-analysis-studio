import { Chess } from '../vendor/chess.js';

const uci = move => move.from + move.to + (move.promotion || '');
const positionKey = chess => chess.fen().split(' ').slice(0, 4).join(' ');
const cache = new WeakMap();
const historyCache = new WeakMap();
const historyFields = step => [step.before, step.after, step.from, step.to,
  step.promotion, step.piece, step.captured, step.color];
const prefixSignature = (moves, length) => JSON.stringify(moves.slice(0, length).map(historyFields));

// A move list is graded in order. Reuse its already replayed prefix, while
// checking the complete prefix signature before reuse (including in-place
// edits). The retained Chess position never includes the currently tested move.
function historyRoot(moves, index) {
  let state = historyCache.get(moves);
  if (!state || state.startFen !== moves[0].before || state.index > index
    || state.signature !== prefixSignature(moves, state.index)) {
    const chess = new Chess(moves[0].before);
    state = {chess, startFen: moves[0].before, index: 0,
      seen: new Set([positionKey(chess)]), repeated: false, signature: '[]'};
  }
  try {
    for (; state.index < index; state.index++) {
      const step = moves[state.index], chess = state.chess;
      if (chess.isGameOver() || chess.fen() !== step.before) throw Error('Invalid history prefix.');
      const replayed = chess.move(uci(step));
      if (replayed.after !== step.after || replayed.piece !== step.piece || replayed.color !== step.color
        || (replayed.captured || null) !== (step.captured || null)) throw Error('Altered history move.');
      if (replayed.captured || replayed.piece === 'p') { state.seen.clear(); state.repeated = false; }
      const key = positionKey(chess);
      if (state.seen.has(key)) state.repeated = true;
      state.seen.add(key);
    }
    state.signature = prefixSignature(moves, index);
    historyCache.set(moves, state);
    return state;
  } catch (error) { historyCache.delete(moves); throw error; }
}

function rookEnding(fen) {
  if (typeof fen !== 'string') return null;
  const men = fen.split(' ')[0].replace(/[1-8/]/g, '');
  if (men.length !== 3 || !men.includes('K') || !men.includes('k')) return null;
  const rook = men.replace(/[Kk]/g, '');
  return /^[Rr]$/.test(rook) ? { winner: rook === 'R' ? 'w' : 'b' } : null;
}

// Exhaustive KRK analysis bounds a win by sixteen winning-side moves:
// https://gilith.com/chess/krk/ . Reserve 34 reversible plies, and withhold
// this result when the actual history introduces a repetition or draw claim.
// This is outcome evidence; it does not assert a shortest mating distance.
export function elementaryEndgameEvidence(move, { moves, moveIndex } = {}) {
  if (!move) return null;
  const before = rookEnding(move.before), after = rookEnding(move.after);
  if (!before || !after || before.winner !== after.winner
    || Number(move.before.split(' ')[4]) > 66 || Number(move.after.split(' ')[4]) > 66
    || !Array.isArray(moves) || !Number.isInteger(moveIndex) || moveIndex < 0
    || moves.slice(0, moveIndex + 1).some(step => !step || typeof step !== 'object')
    || moves[moveIndex]?.before !== move.before || moves[moveIndex]?.after !== move.after
    || uci(moves[moveIndex]) !== uci(move)) return null;
  const signature = JSON.stringify({ move: [move.before, move.after, uci(move), move.color],
    history: moves.slice(0, moveIndex + 1).map(historyFields) });
  const cached = cache.get(move);
  if (cached?.signature === signature) return cached.result;
  const result = (() => {
    try {
      const {chess, seen, repeated} = historyRoot(moves, moveIndex);
      if (chess.fen() !== move.before || chess.turn() !== move.color || repeated) return null;
      const safe = position => {
        if (position.isGameOver()) return false;
        if (position.turn() === before.winner) return true;
        for (const reply of position.moves({ verbose: true })) {
          position.move(uci(reply));
          let draw;
          try { draw = position.isDraw() || reply.captured === 'r'; }
          finally { position.undo(); }
          if (draw) return false;
        }
        return true;
      };
      if (!safe(chess)) return null;
      const replayed = chess.move(uci(move));
      try {
        if (replayed.after !== move.after || replayed.piece !== move.piece || replayed.color !== move.color
          || (replayed.captured || null) !== (move.captured || null)
          || seen.has(positionKey(chess)) || !safe(chess)) return null;
      } finally { chess.undo(); }
      return Object.freeze({ version: 1, kind: 'preserved-king-rook-vs-king',
        winner: before.winner, drawClaimsChecked: true, maxHalfmove: 66 });
    } catch { return null; }
  })();
  cache.set(move, { signature, result });
  return result;
}
