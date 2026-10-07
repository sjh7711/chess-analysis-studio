import { Chess, DEFAULT_POSITION, validateFen } from '../vendor/chess.js';
import { isBookMove } from './opening-book.js';

export { Chess, DEFAULT_POSITION };

export function validatePosition(fen) {
  if (fen.trim().split(/\s+/).length !== 6) throw new Error('FEN은 공백으로 구분된 6개 항목이 필요합니다.');
  const valid = validateFen(fen);
  if (!valid.ok) throw new Error(`올바르지 않은 FEN입니다. ${valid.error}`);
  const chess = new Chess(fen);
  const turn = chess.turn();
  const other = turn === 'w' ? 'b' : 'w';
  const king = chess.board().flat().find(p => p?.type === 'k' && p.color === other);
  if (chess.isAttacked(king.square, turn)) throw new Error('차례가 아닌 쪽의 왕이 체크 상태입니다. FEN을 확인해 주세요.');
  for (const color of ['w', 'b']) {
    const men = chess.board().flat().filter(p => p?.color === color);
    if (men.length > 16 || men.filter(p => p.type === 'p').length > 8) throw new Error('기물 또는 폰의 개수가 너무 많습니다.');
  }
  const rights = fen.split(/\s+/)[2];
  for (const [right, kingSquare, rookSquare, color] of [['K','e1','h1','w'],['Q','e1','a1','w'],['k','e8','h8','b'],['q','e8','a8','b']]) {
    if (rights.includes(right) && (chess.get(kingSquare)?.type !== 'k' || chess.get(kingSquare)?.color !== color || chess.get(rookSquare)?.type !== 'r' || chess.get(rookSquare)?.color !== color)) throw new Error('캐슬링 권리와 왕·룩의 위치가 일치하지 않습니다.');
  }
  return chess;
}

export function parseGame(input, kind = 'pgn') {
  const text = input.trim();
  if (!text) throw new Error('기보 또는 FEN을 입력해 주세요.');
  if (text.length > 250000) throw new Error('기보가 너무 큽니다. 한 대국만 불러와 주세요.');
  let chess;
  if (kind === 'fen') chess = validatePosition(text);
  else {
    chess = new Chess();
    try { chess.loadPgn(text); }
    catch (error) { throw new Error(`PGN을 읽지 못했습니다. 수와 표기를 확인해 주세요. (${error.message})`); }
    if (chess.getHeaders().Variant && !['standard', 'chess'].includes(chess.getHeaders().Variant.toLowerCase())) throw new Error('일반 체스 기보만 지원합니다.');
  }
  const moves = chess.history({ verbose: true });
  if (moves.length > 1000) throw new Error('최대 1,000개의 반수를 지원합니다.');
  const startFen = moves[0]?.before || chess.fen();
  validatePosition(startFen);
  return { input: text, kind, headers: chess.getHeaders(), startFen, moves, positions: [startFen, ...moves.map(m => m.after)] };
}

export function gameAt(game, index) {
  const chess = new Chess(game.startFen);
  for (const move of game.moves.slice(0, index)) chess.move({ from: move.from, to: move.to, promotion: move.promotion });
  return chess;
}

export function positionCommand(chess) {
  const history = chess.history({ verbose: true });
  const start = history[0]?.before || chess.fen();
  return `position fen ${start}${history.length ? ` moves ${history.map(uciMove).join(' ')}` : ''}`;
}

export function uciMove(move) { return `${move.from}${move.to}${move.promotion || ''}`; }

export function parseInfo(line, turn) {
  if (!line.startsWith('info ') || /\b(?:lowerbound|upperbound)\b/.test(line)) return null;
  const score = line.match(/\bscore (cp|mate) (-?\d+)/);
  const pv = line.match(/\bpv (.+)$/);
  const depth = line.match(/\bdepth (\d+)/);
  if (!score || !pv || !depth) return null;
  return {
    score: { type: score[1], value: Number(score[2]) * (turn === 'w' ? 1 : -1), ...(score[1] === 'mate' ? { winner: Number(score[2]) > 0 ? turn : turn === 'w' ? 'b' : 'w' } : {}) },
    depth: Number(depth[1]), multipv: Number(line.match(/\bmultipv (\d+)/)?.[1] || 1), pv: pv[1].trim().split(/\s+/),
    nodes: Number(line.match(/\bnodes (\d+)/)?.[1] || 0),
  };
}

export function terminalResult(chess) {
  let score, label;
  if (chess.isCheckmate()) { const winner = chess.turn() === 'w' ? 'b' : 'w'; score = { type: 'mate', value: 0, winner }; label = `${winner === 'w' ? '백' : '흑'} 체크메이트 승리`; }
  else if (chess.isStalemate()) { score = { type: 'cp', value: 0 }; label = '스테일메이트 · 무승부'; }
  else if (chess.isThreefoldRepetition()) { score = { type: 'cp', value: 0 }; label = '3회 동형 반복 · 무승부 청구 가능'; }
  else if (chess.isDrawByFiftyMoves()) { score = { type: 'cp', value: 0 }; label = '50수 규칙 · 무승부 청구 가능'; }
  else if (chess.isInsufficientMaterial()) { score = { type: 'cp', value: 0 }; label = '기물 부족 · 무승부'; }
  if (!score) return null;
  return { score, depth: 0, lines: [], bestmove: null, terminal: label };
}

// Engine results and PGN annotations stay white-relative; perspective only changes presentation.
export function scoreValue(score, perspective = 'w') {
  const sign = perspective === 'b' ? -1 : 1;
  if (score.type === 'cp') return score.value * sign;
  return sign * ((score.winner ? score.winner === 'w' : score.value > 0) ? 100000 - Math.abs(score.value) : -100000 + Math.abs(score.value));
}

export function formatScore(score, perspective = 'w') {
  if (!score) return '—';
  const value = scoreValue(score, perspective);
  if (score.type === 'mate') return `${value > 0 ? '+' : '−'}M${Math.abs(score.value)}`;
  return `${value > 0 ? '+' : ''}${(value / 100).toFixed(2)}`;
}

export function scoreSummary(result) {
  if (!result) return '국면을 분석하면 평가가 표시됩니다.';
  if (result.terminal) return result.terminal;
  const score = result.score;
  if (score.type === 'mate') return `${scoreValue(score) > 0 ? '백' : '흑'}이 최선의 수를 두면 ${Math.abs(score.value)}수 안에 체크메이트`;
  const value = Math.abs(score.value);
  if (value < 30) return '팽팽한 국면입니다';
  return `${score.value > 0 ? '백' : '흑'}이 ${value < 100 ? '조금 유리합니다' : value < 300 ? '유리합니다' : '크게 유리합니다'}`;
}

export function pvToSan(fen, pv, limit = 12) {
  const chess = new Chess(fen);
  const tokens = [];
  for (const uci of pv.slice(0, limit)) {
    try {
      const number = chess.moveNumber();
      const prefix = chess.turn() === 'w' ? `${number}. ` : tokens.length === 0 ? `${number}... ` : '';
      const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      tokens.push(`${prefix}${move.san}`);
    } catch { break; }
  }
  return tokens.join(' ');
}

export const MOVE_GRADES = Object.freeze({
  brilliant:{label:'탁월수',symbol:'!!'}, great:{label:'훌륭한 수',symbol:'!'},
  best:{label:'최선의 수',symbol:'★'}, excellent:{label:'우수한 수',symbol:'✓'},
  good:{label:'좋은 수',symbol:'·'}, book:{label:'이론',symbol:'▤'},
  inaccuracy:{label:'부정확',symbol:'?!'}, mistake:{label:'실수',symbol:'?'},
  miss:{label:'놓친 기회',symbol:'×'}, blunder:{label:'블런더',symbol:'??'},
});
export const GRADING_BASIS = '예상 승점 감소: 우수한 수 2%p 미만, 좋은 수 5%p 미만, 부정확 5~10%p, 실수 10~20%p, 블런더 20%p 이상. 새 강제 메이트 허용은 블런더, 강제 메이트 기회를 놓치면 놓친 기회로 분류합니다. 엔진 점수를 자체 모델로 환산한 참고 분류이며 Chess.com의 레이팅별 계산과는 다릅니다.';

// Transparent approximation, not a claim to reproduce Chess.com's undisclosed rating model.
export function expectedPoints(score, color = 'w') {
  const sign = color === 'w' ? 1 : -1;
  if (score.type === 'mate') return scoreValue(score)*sign > 0 ? 1 : 0;
  return 1 / (1 + Math.exp(-score.value*sign/250));
}

const gradeCache = new WeakMap();
const values = {p:1,n:3,b:3,r:5,q:9,k:0};
function material(chess, color) {
  return chess.board().flat().reduce((sum,p)=>sum+(p ? values[p.type]*(p.color===color ? 1 : -1) : 0),0);
}
function verifiedSacrifice(move, after) {
  if (!move.before || !move.after || !['n','b','r','q'].includes(move.piece) || move.promotion) return false;
  const pv = after.lines?.[0]?.pv;
  if (!pv || pv.length<4) return false;
  try {
    const original = new Chess(move.before), chess = new Chess(move.after);
    // An already hanging piece or an ordinary equal trade is not a brilliant sacrifice.
    if (original.isAttacked(move.from,move.color==='w'?'b':'w')) return false;
    let first;
    for (const uci of pv.slice(0,4)) {
      const reply=chess.move(uci);
      if (!first) {
        first=reply;
        if (reply.to!==move.to || reply.captured!==move.piece) return false;
      }
    }
    return material(original,move.color)-material(chess,move.color)>=2;
  } catch { return false; }
}

export function classifyMove(before, after, move, {previous} = {}) {
  if (!before || !after || !move) return null;
  const cached = gradeCache.get(move);
  if (cached?.before===before && cached.after===after && cached.previous===previous) return cached.grade;
  const sign = move.color === 'w' ? 1 : -1;
  let loss;
  if (before.score.type === 'mate' && after.score.type === 'mate' && Math.sign(scoreValue(before.score)) === Math.sign(scoreValue(after.score))) loss = 0;
  else loss = Math.max(0, (scoreValue(before.score) - scoreValue(after.score)) * sign);
  const best = before.bestmove === uciMove(move);
  if (best) loss=0;
  const beforePoints=expectedPoints(before.score,move.color), afterPoints=expectedPoints(after.score,move.color);
  const pointsLoss=best ? 0 : Math.max(0,beforePoints-afterPoints);
  let key=best || pointsLoss===0 ? 'best' : pointsLoss<0.02 ? 'excellent' : pointsLoss<0.05 ? 'good' : pointsLoss<0.10 ? 'inaccuracy' : pointsLoss<0.20 ? 'mistake' : 'blunder';
  let severity=pointsLoss>=0.20 ? 3 : pointsLoss>=0.10 ? 2 : pointsLoss>=0.05 ? 1 : 0;
  let reason='';
  const second=before.lines?.find(line=>line.multipv===2 && line.score);
  if (!best && after.score.type==='mate' && afterPoints===0 && !(before.score.type==='mate' && beforePoints===0)) {
    key='blunder'; severity=3; reason='상대에게 강제 체크메이트를 허용했습니다.';
  } else if (!best && before.score.type==='mate' && beforePoints===1 && !(after.score.type==='mate' && afterPoints===1)) {
    key='miss'; severity=2; reason='강제 체크메이트 기회를 놓쳤습니다.';
  } else if (pointsLoss<0.02 && afterPoints>=0.45 && beforePoints<0.90 && verifiedSacrifice(move,after)) {
    key='brilliant'; reason='예상 응수에서 기물을 희생하면서도 국면을 유지하는 수입니다.';
  } else if (best && second && afterPoints>=0.45 && beforePoints-expectedPoints(second.score,move.color)>=0.10) {
    key='great'; reason='다른 후보보다 예상 승점을 크게 지키는 결정적인 수입니다.';
  } else if (previous && beforePoints>=0.75 && afterPoints<=0.55 && beforePoints-expectedPoints(previous.score,move.color)>=0.10) {
    key='miss'; severity=Math.max(2,severity); reason='상대 실수로 생긴 승리 기회를 살리지 못했습니다.';
  } else if (pointsLoss<0.05 && isBookMove(move)) {
    key='book'; reason='등록된 오프닝 수순에 있는 이론 수입니다.';
  }
  const grade={key,...MOVE_GRADES[key],loss,pointsLoss,severity,reason};
  gradeCache.set(move,{before,after,previous,grade});
  return grade;
}

export function exportPgn(game, results) {
  const chess = new Chess(game.startFen);
  for (const [key, value] of Object.entries(game.headers)) if (!['FEN','SetUp','CurrentPosition'].includes(key)) chess.setHeader(key, value);
  const addComment = index => {
    const result = results.get(index);
    if (!result) return;
    const evaluation = result.score.type === 'mate' ? `#${scoreValue(result.score) > 0 ? '' : '-'}${Math.abs(result.score.value)}` : (result.score.value / 100).toFixed(2);
    chess.setComment(`[%eval ${evaluation}] Stockfish 19 Lite depth ${result.depth}`);
  };
  addComment(0);
  game.moves.forEach((move, i) => { chess.move(uciMove(move)); addComment(i + 1); });
  // Avoid chess.js 1.4.0's token-joining bug when line wrapping sparse comments.
  return chess.pgn({ maxWidth: 0 });
}
