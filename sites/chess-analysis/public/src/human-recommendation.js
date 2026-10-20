import { Chess, expectedPoints, scoreValue, uciMove } from './chess-core.js';
import { cloneChess, PIECE_NAMES } from './study.js';

const VALUES = { p:100, n:300, b:300, r:500, q:900, k:0 };
const CENTRAL = new Set(['d4','e4','d5','e5']);
const CENTRAL_DEVELOPMENT = new Set(['c3','d3','e3','f3','c4','d4','e4','f4','c5','d5','e5','f5','c6','d6','e6','f6']);
const other = color => color === 'w' ? 'b' : 'w';
const captureSquare = move => move.flags.includes('e') ? move.to[0]+move.from[1] : move.to;
const gain = move => (VALUES[move.captured] || 0)+(move.promotion ? VALUES[move.promotion]-VALUES.p : 0);
const bounded = value => Boolean(value && (value.lowerbound || value.upperbound || value.bound || value.scoreBound || value.partial || value.complete === false));
const validScore = score => Boolean(score && !bounded(score) && ['cp','mate'].includes(score.type) && Number.isFinite(score.value)
  && (score.type === 'cp' || ['w','b'].includes(score.winner) && (score.value === 0 || (score.value > 0) === (score.winner === 'w'))));
const sameScore = (a,b) => a?.type === b?.type && a?.value === b?.value && a?.winner === b?.winner;

function asPosition(position) {
  return typeof position === 'string' ? new Chess(position) : cloneChess(position);
}

// Each PV is checked from the actual history. A repeated/Fifty-move position
// must not become a fictitious continuation merely because its FEN is legal.
function legalLine(position, line, depth) {
  if (!line || bounded(line) || !validScore(line.score) || line.depth !== depth || !Array.isArray(line.pv)
    || !line.pv.length || line.pv.length > 512) return null;
  const chess = cloneChess(position), moves = [];
  try {
    for (const uci of line.pv) {
      if (typeof uci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci) || chess.isGameOver()) return null;
      const move = chess.move(uci);
      if (uciMove(move) !== uci) return null;
      moves.push(move);
    }
  } catch { return null; }
  return moves;
}

// This local exchange calculation is a guard, not another evaluation engine.
// Either player can stop trading on the square. If its small work bound is
// reached, the alternative is uncertain and therefore is not promoted.
function exchangeGain(chess, square, budget, depth = 0) {
  if (++budget.nodes > 160 || depth > 10) { budget.uncertain = true; return 0; }
  const victim = chess.get(square);
  if (!victim || victim.color === chess.turn() || victim.type === 'k') return 0;
  let best = 0;
  for (const capture of chess.moves({verbose:true})) {
    if (!capture.captured || captureSquare(capture) !== square) continue;
    chess.move(uciMove(capture));
    const net = gain(capture)-exchangeGain(chess,capture.to,budget,depth+1);
    chess.undo();
    best = Math.max(best,net);
    if (budget.uncertain) break;
  }
  return best;
}

function materialAtRisk(chess) {
  const budget = {nodes:0,uncertain:false};
  for (const capture of chess.moves({verbose:true})) {
    if (!capture.captured) continue;
    chess.move(uciMove(capture));
    const net = gain(capture)-exchangeGain(chess,capture.to,budget);
    chess.undo();
    if (net > 0 || budget.uncertain) return true;
  }
  return false;
}

function withTurn(chess, color) {
  const fields = chess.fen().split(' ');
  fields[1] = color;
  // En-passant rights apply to the actual next player only.
  fields[3] = '-';
  return new Chess(fields.join(' '));
}

function legalCaptureThreat(chess, square, enemy) {
  try { return withTurn(chess,enemy).moves({verbose:true}).some(move => move.captured && captureSquare(move) === square); }
  catch { return false; }
}

function naturalness(position, moves) {
  const move = moves[0], chess = cloneChess(position), reasons = [];
  let value = 0;
  chess.move(uciMove(move));
  const previous = position.history({verbose:true}).at(-1);
  if (previous?.captured && move.captured && captureSquare(move) === previous.to) {
    value += 5;
    reasons.push(`${move.to}에서 상대 ${PIECE_NAMES[move.captured]}${move.captured === 'n' ? '를' : '을'} 바로 되잡는 수입니다.`);
  }
  if (move.flags.includes('k') || move.flags.includes('q')) {
    value += 5;
    reasons.push(`캐슬링으로 킹을 ${move.to}에, 룩을 ${move.flags.includes('k') ? 'f' : 'd'}${move.from[1]}에 함께 옮깁니다.`);
  }
  const early = position.moveNumber() <= 12;
  if (early && ['n','b'].includes(move.piece) && move.from[1] === (move.color === 'w' ? '1' : '8') && move.to[1] !== move.from[1]) {
    value += 3;
    reasons.push(`시작 줄의 ${PIECE_NAMES[move.piece]}${move.piece === 'n' ? '를' : '을'} ${move.to}로 전개합니다.`);
  }
  if (legalCaptureThreat(position,move.from,other(move.color)) && !legalCaptureThreat(chess,move.to,other(move.color))) {
    value += 3;
    reasons.push(`상대가 잡을 수 있던 ${move.from}의 ${PIECE_NAMES[move.piece]}${move.piece === 'n' ? '를' : '을'} ${move.to}로 피합니다.`);
  }
  if (CENTRAL.has(move.to) || ['n','b'].includes(move.piece) && CENTRAL_DEVELOPMENT.has(move.to)) {
    value += 1;
    if (CENTRAL.has(move.to)) reasons.push(`${move.to} 중앙 칸에 ${PIECE_NAMES[move.piece]}${move.piece === 'n' ? '를' : '을'} 놓습니다.`);
  }
  if (!move.captured && !/[+#]$/.test(move.san)) value += 0.5;
  if (early && move.piece === 'q' && !move.captured && move.to[1] !== (move.color === 'w' ? '1' : '8')) value -= 4;
  if (!move.captured && move.san.endsWith('+')) value -= 1;
  // A long PV by itself is not difficult. Penalize only an actually observed
  // forcing sequence, and never describe its sampled replies as forced.
  const forcing = moves.slice(0,10).filter(step => step.captured || /[+#]$/.test(step.san)).length;
  value -= Math.max(0,forcing-2)*0.5;
  return {value,reasons,after:chess};
}

/**
 * Pick an understandable near-best move from a completed Stockfish snapshot.
 * Scores remain White-relative and the engine ranking/result are never changed.
 * This is an explicit local heuristic, not Torch Human or a learned player model.
 */
export function humanRecommendation(position, result) {
  let chess;
  try { chess = asPosition(position); } catch { return null; }
  if (chess.isGameOver() || !result || bounded(result) || result.multipvComplete !== true || !Number.isInteger(result.depth)
    || result.depth < 1 || !validScore(result.score) || !Array.isArray(result.lines) || !result.lines.length
    || result.fen && result.fen !== chess.fen()) return null;
  const engineLine = result.lines[0];
  if (engineLine?.multipv !== 1 || !sameScore(engineLine.score,result.score) || engineLine.pv?.[0] !== result.bestmove) return null;
  const engineMoves = legalLine(chess,engineLine,result.depth);
  if (!engineMoves) return null;
  const baseline = naturalness(chess,engineMoves);
  let selected = {line:engineLine,moves:engineMoves,traits:baseline,lossCp:0,pointsLoss:0};
  const roots = new Set([result.bestmove]);
  if (engineLine.score.type === 'cp') {
    for (let index=1;index<result.lines.length;index++) {
      const line = result.lines[index], root = line?.pv?.[0];
      if (!line || line.multipv !== index+1 || !root || roots.has(root)) continue;
      roots.add(root);
      if (line.score?.type !== 'cp') continue;
      const moves = legalLine(chess,line,result.depth);
      if (!moves) continue;
      const lossCp = scoreValue(engineLine.score,chess.turn())-scoreValue(line.score,chess.turn());
      const pointsLoss = expectedPoints(engineLine.score,chess.turn())-expectedPoints(line.score,chess.turn());
      if (lossCp < 0 || lossCp > 25 || pointsLoss < 0 || pointsLoss > 0.01+Number.EPSILON) continue;
      const traits = naturalness(chess,moves);
      if (!traits.reasons.length || traits.value < baseline.value+1.5 || traits.value <= selected.traits.value || materialAtRisk(traits.after)) continue;
      selected = {line,moves,traits,lossCp,pointsLoss};
    }
  }
  const isEngineBest = selected.line === engineLine;
  const facts = selected.traits.reasons;
  return {line:selected.line,engineLine,move:selected.moves[0],engineMove:engineMoves[0],isEngineBest,
    lossCp:selected.lossCp,pointsLoss:selected.pointsLoss,
    reason:facts[0] || '엔진이 가장 높게 평가한 수입니다.',facts,policy:'near-best-human-v1'};
}
