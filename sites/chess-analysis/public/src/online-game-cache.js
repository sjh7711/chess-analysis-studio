import { parseGame, uciMove } from './chess-core.js';

// Headers and engine comments can change when an online record is fetched
// again. Reuse analysis only for the exact starting position and full history;
// a matching final board alone loses repetition and fifty-move context.
// Search-policy validation remains with setGame's normal cache restoration.
export function matchingOnlineSnapshot(game, snapshot) {
  if (!snapshot || typeof snapshot.input !== 'string'
    || !['pgn', 'fen'].includes(snapshot.kind ?? 'pgn')) return null;
  try {
    const saved = parseGame(snapshot.input, snapshot.kind ?? 'pgn');
    if (game.startFen !== saved.startFen || game.moves.length !== saved.moves.length
      || !game.moves.every((move, index) => uciMove(move) === uciMove(saved.moves[index]))) return null;
    return snapshot;
  } catch {
    return null;
  }
}
