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
export const GRADING_BASIS = 'Chess.com 공개 예상 승점 감소 구간: 우수한 수 0~2%p, 좋은 수 2~5%p, 부정확 5~10%p, 실수 10~20%p, 블런더 20%p 이상. 최선의 수는 엔진 1순위 또는 같은 완료 깊이에서 동일한 평가를 받은 후보입니다. 이 앱은 경계값부터 다음 등급을 적용하며, 예상 승점 환산·특수 분류·승점이 포화된 국면의 전술 손실 보정은 자체 추정입니다. 승점 감소가 작아도 최선보다 추가 주요 기물 손실이 검증되면 실수로 분류합니다. Chess.com의 레이팅별 환산식과 CAPS2 정확도 계산식은 공개되지 않아 동일한 결과를 보장하지 않습니다.';

// Transparent approximation, not a claim to reproduce Chess.com's undisclosed rating model.
export function expectedPoints(score, color = 'w') {
  const sign = color === 'w' ? 1 : -1;
  if (score.type === 'mate') return scoreValue(score)*sign > 0 ? 1 : 0;
  return 1 / (1 + Math.exp(-score.value*sign/250));
}

const gradeCache = new WeakMap();
const sameScore=(a,b)=>a?.type===b?.type && a?.value===b?.value && a?.winner===b?.winner;
export function hasMoveReview(before, after, move) {
  const review=after?.moveReview;
  return !!(before && move && review?.version===1 && review.fen===move.before && review.uci===uciMove(move)
    && review.configKey===before.configKey && review.beforeDepth===before.depth && review.beforeBestmove===before.bestmove
    && sameScore(review.beforeScore,before.score) && ['cp','mate'].includes(review.score?.type) && Number.isFinite(review.score.value)
    && review.pv?.[0]===review.uci);
}

// A root-restricted search includes the played move. Convert its PV and mate
// distance to the resulting position before building explanations/replays.
export function assessedMoveResult(before, after, move) {
  if (!hasMoveReview(before,after,move)) return after;
  const review=after.moveReview;
  let score=review.score;
  if (score.type==='mate' && score.winner===move.color) score={...score,value:Math.sign(scoreValue(score))*Math.max(0,Math.abs(score.value)-1)};
  const pv=review.pv.slice(1);
  return {...after,score,depth:review.depth,bestmove:pv[0]||null,lines:pv.length?[{multipv:1,score,depth:review.depth,pv}]:[]};
}
const values = {p:1,n:3,b:3,r:5,q:9,k:0};
const capturedSquare=move=>move.flags.includes('e') ? move.to[0]+move.from[1] : move.to;
const promotionGain=move=>move.promotion ? values[move.promotion]-values.p : 0;

// Legal same-square exchanges, with either side free to stop exchanging. This
// measures the initial material offered, not the eventual compensation in a PV.
function exchangeGain(chess, square, memo) {
  const victim=chess.get(square);
  if (!victim || victim.color===chess.turn() || victim.type==='k') return 0;
  const key=chess.fen()+'|'+square;
  if (memo.has(key)) return memo.get(key);
  let best=0;
  for (const capture of chess.moves({verbose:true})) {
    if (!capture.captured || capturedSquare(capture)!==square) continue;
    chess.move(uciMove(capture));
    const gain=values[capture.captured]+promotionGain(capture)-exchangeGain(chess,capture.to,memo);
    chess.undo();
    best=Math.max(best,gain);
  }
  memo.set(key,best);
  return best;
}

const sacrificeCache=new WeakMap();
export function sacrificeCandidates(move) {
  if (!move?.before || !move.after) return [];
  const signature=[move.before,move.after,move.from,move.to,move.color,move.piece,move.captured,move.promotion].join('|');
  const cached=sacrificeCache.get(move);
  if (cached?.signature===signature) return cached.candidates;
  const candidates=[];
  try {
    const original=new Chess(move.before),after=new Chess(move.after),enemy=move.color==='w'?'b':'w';
    const source=original.get(move.from),memo=new Map();
    if (source?.color!==move.color || source.type!==move.piece || after.turn()!==enemy) return [];
    const played=original.move(uciMove(move));
    if (played.after!==move.after || (played.captured||null)!==(move.captured||null)) return [];
    original.undo();
    const captures=after.moves({verbose:true}).filter(reply=>reply.captured);
    const moveGain=(values[move.captured]||0)+promotionGain(move);
    const fen=move.before.split(' ');fen[1]=enemy;fen[3]='-';
    const prior=new Chess(fen.join(' '));
    for (const square of new Set(captures.map(capturedSquare))) {
      const offered=after.get(square);
      if (!offered || offered.color!==move.color || offered.type==='k') continue;
      // Quiet pawn offers are common opening/positional play. Limit this
      // special classification to a moved pawn with a forcing continuation.
      if (offered.type==='p' && (square!==move.to || !after.isCheck() && !move.captured && !move.promotion)) continue;
      const offeredLoss=exchangeGain(after,square,memo);
      if (offeredLoss<=moveGain) continue;
      const sourceSquare=square===move.to ? move.from : square;
      const existingLoss=original.get(sourceSquare)?.color===move.color && original.isAttacked(sourceSquare,enemy)
        ? exchangeGain(prior,sourceSquare,memo) : 0;
      candidates.push({square,piece:offered.type,sourceSquare,cost:offeredLoss-moveGain,offeredLoss,existingLoss,moveGain,
        captures:captures.filter(capture=>capturedSquare(capture)===square).map(uciMove)});
    }
  } catch { /* Malformed positions cannot establish a sacrifice. */ }
  sacrificeCache.set(move,{signature,candidates});
  return candidates;
}

export function sacrificeEvidence(move) {
  if (move?.piece==='k') return null;
  const candidate=sacrificeCandidates(move).find(offer=>offer.square===move.to && offer.cost>offer.existingLoss);
  return candidate ? {...candidate,cost:candidate.cost-candidate.existingLoss} : null;
}

// Other-piece offers and an already exposed piece need actual engine evidence
// of compensation after the opponent accepts. Never replace the primary root
// score with this illustrative, capture-restricted counterfactual branch.
export function reviewedSacrificeEvidence(before, after, move) {
  if (!hasMoveReview(before,after,move)) return null;
  const review=after.moveReview.sacrificeReview;
  if (review?.version!==1 || review.status!=='verified' || review.fen!==move.after || review.rootFen!==move.before
    || review.uci!==uciMove(move) || review.configKey!==before.configKey
    || !Number.isInteger(before.depth) || before.depth<1
    || review.requestedDepth!==Math.min(16,Math.max(1,before.depth-1))
    || !Array.isArray(review.branches) || review.branches.length!==1) return null;
  const offers=sacrificeCandidates(move),captures=[...new Set(offers.flatMap(offer=>offer.captures))].sort();
  const restricted=Array.isArray(review.restrictedMoves) ? [...new Set(review.restrictedMoves)].sort() : [];
  if (!captures.length || captures.length!==restricted.length || captures.some((capture,index)=>capture!==restricted[index])) return null;
  for (const branch of review.branches||[]) {
    if (!branch.verified || branch.status!=='verified' || !branch.multipvComplete || !Number.isInteger(branch.depth)
      || branch.depth<review.requestedDepth || !['cp','mate'].includes(branch.score?.type) || !Number.isFinite(branch.score.value)
      || branch.score.type==='mate' && !['w','b'].includes(branch.score.winner)
      || !Array.isArray(branch.pv) || branch.pv[0]!==branch.capture || !captures.includes(branch.capture)
      || !['candidate','search'].includes(branch.source) || branch.bestResponse!==false
      || expectedPoints(branch.score,move.color)<0.50) continue;
    try {
      const chess=new Chess(move.after);
      for (const uci of branch.pv) chess.move(uci);
      return {offer:offers.find(offer=>offer.captures.includes(branch.capture)),branch};
    } catch { /* A partial/illegal PV cannot establish tactical compensation. */ }
  }
  return null;
}

function newSacrificeDecision(move, evidence, previousMove) {
  const offer=evidence?.offer;
  if (!offer) return false;
  // Moving an exposed piece to a new square can renew the sacrifice. Leaving
  // another piece en prise is a new decision only in response to a new attack.
  if (offer.square===move.to && offer.sourceSquare===move.from) return true;
  if (!previousMove || previousMove.color===move.color || previousMove.after!==move.before || offer.existingLoss<=0) return false;
  try {
    const prior=new Chess(previousMove.before),piece=prior.get(offer.square);
    if (prior.turn()!==previousMove.color || piece?.color!==move.color || piece.type!==offer.piece
      || prior.isAttacked(offer.square,previousMove.color)) return false;
    const played=prior.move(uciMove(previousMove));
    if (played.after!==move.before) return false;
    return new Chess(move.before).isAttacked(offer.square,previousMove.color);
  } catch { return false; }
}

function alreadyWinningWithoutSacrifice(before, move) {
  const fallback=()=>expectedPoints(before.score,move.color)>=0.90;
  if (!before.multipvComplete || !Number.isFinite(before.depth) || before.depth<1 || !move.before) return fallback();
  const first=before.lines?.find(line=>line.multipv===1 && line.pv?.[0]===before.bestmove && line.depth===before.depth);
  if (!first || !sameScore(first.score,before.score)) return fallback();
  let verified=0;
  for (const line of before.lines) {
    if (line.depth!==before.depth || !line.score || !line.pv?.[0] || line.pv[0]===uciMove(move)) continue;
    try {
      const chess=new Chess(move.before),alternative=chess.move(line.pv[0]);
      verified++;
      if (expectedPoints(line.score,move.color)>=0.90) {
        const offers=sacrificeCandidates(alternative);
        if (!offers.length) return true;
        // A proven mate that only preserves an earlier offer is already a
        // winning continuation; it does not demand a new sacrifice decision.
        if (line.score.type==='mate' && offers.every(offer=>offer.cost<=offer.existingLoss)) return true;
      }
    } catch { /* An illegal/stale alternative cannot establish an easy win. */ }
  }
  // Completed alternatives can themselves require a sacrifice. Their scores
  // do not prove a comfortable win without one. With no comparable candidate,
  // retain the conservative root-score fallback rather than inventing a line.
  return verified ? false : fallback();
}

const rootEvidenceCache=new WeakMap();
function gradingEvidenceSignature(before,after,move) {
  const review=after?.moveReview;
  return JSON.stringify({move:[move.before,move.after,uciMove(move),move.color,move.piece,move.captured,move.promotion],
    before:[before.score,before.depth,before.bestmove,before.configKey,before.multipvComplete,before.lines],
    review:review&&[review.version,review.fen,review.uci,review.configKey,review.beforeScore,review.beforeDepth,
      review.beforeBestmove,review.score,review.depth,review.pv,review.source]});
}

function rootEvidence(before,after,move,signature=gradingEvidenceSignature(before,after,move)) {
  const cached=rootEvidenceCache.get(move);
  if(cached?.before===before && cached.after===after && cached.signature===signature)return cached.result;
  let result=null;
  const review=after?.moveReview,first=before.lines?.find(line=>line.multipv===1 && line.depth===before.depth
    && line.pv?.[0]===before.bestmove && sameScore(line.score,before.score));
  if(before.multipvComplete && Number.isInteger(before.depth) && before.depth>0 && first
    && hasMoveReview(before,after,move) && review.depth===before.depth
    && ['candidate','search'].includes(review.source) && legalMoveRecord(move)) {
    try {
      const replay=pv=>{
        const chess=validatePosition(move.before),moves=[];
        for(const uci of pv) {
          if(chess.isGameOver())throw new Error('A continuation cannot extend a completed game.');
          moves.push(chess.move(uci));
        }
        return {moves,final:chess};
      };
      const played=replay(review.pv),best=replay(first.pv);
      if(played.moves[0]?.after===move.after)result={played,best};
    } catch { /* Partial or illegal root continuations are not grading evidence. */ }
  }
  rootEvidenceCache.set(move,{before,after,signature,result});
  return result;
}

function verifiedTopCandidate(before, move, after, signature) {
  if (before.bestmove===uciMove(move)) return true;
  // Expected points saturate in won/lost positions. Only an actual equal root
  // score at the same completed depth establishes a second best move.
  if (!before.multipvComplete || !Number.isFinite(before.depth) || before.depth<1) return false;
  const first=before.lines?.find(line=>line.multipv===1 && line.pv?.[0]===before.bestmove && line.depth===before.depth);
  if (!first || !sameScore(first.score,before.score)) return false;
  if (before.lines.some(line=>line.depth===before.depth && line.pv?.[0]===uciMove(move) && sameScore(line.score,first.score))) return true;
  // A third (or later) tied move can be absent from the overview's MultiPV.
  // Reuse its bound, equally deep root search only after checking the entire
  // recorded continuation. The separate child-position score is not evidence.
  const review=after?.moveReview;
  if (!hasMoveReview(before,after,move) || review.score.type!=='mate' || review.depth!==before.depth || !sameScore(review.score,before.score))return false;
  const evidence=rootEvidence(before,after,move,signature),played=evidence?.played;
  // A mate equality uses a completed mating line, not a truncated prefix
  // whose nominal distance has not yet been demonstrated on the board.
  return !!played && played.final.isCheckmate() && played.final.turn()!==review.score.winner
    && played.moves.filter(step=>step.color===review.score.winner).length===Math.abs(review.score.value);
}

function earlierExchangeCapturer(moves,end,capture) {
  let square=capturedSquare(capture),type=capture.captured;
  for(let index=end-1;index>=0;index--) {
    const step=moves[index];
    if(step.color===capture.color || step.to!==square || (step.promotion||step.piece)!==type)continue;
    if(step.captured)return true;
    square=step.from;type=step.piece;
  }
  return false;
}

const materialValue=(fen,color)=>new Chess(fen).board().flat().filter(Boolean)
  .reduce((sum,piece)=>sum+values[piece.type]*(piece.color===color?1:-1),0);
function nearbyExchangeLoss(move,line) {
  const moves=line.moves,initial=materialValue(move.before,move.color),snapshots=[];
  // A shared six-ply starting window makes the alternatives comparable.
  // Finish the capture, promotion, check reply and delayed recapture rather
  // than taking material from arbitrary remote PV endpoints.
  for(let index=0;index<Math.min(6,moves.length);index++) {
    if(!moves[index].captured && !moves[index].promotion)continue;
    let end=index+1;
    while(end<moves.length && (moves[end-1].san.endsWith('+')
      || (moves[end-1].captured||moves[end-1].promotion) && (moves[end].captured||moves[end].promotion||moves[end].san.endsWith('+'))
      || moves[end].captured && earlierExchangeCapturer(moves,end,moves[end])))end++;
    if(end>12)continue;
    const last=moves[end-1],position=new Chess(last.after);
    if(end===moves.length && !position.isGameOver() && (position.isCheck() || position.moves({verbose:true}).some(reply=>reply.captured
      && (last.captured && capturedSquare(reply)===last.to || earlierExchangeCapturer(moves,end,reply)))))continue;
    snapshots.push({start:index+1,end,loss:initial-materialValue(last.after,move.color),
      majorLost:moves.slice(index,end).some(step=>step.color!==move.color && ['r','q'].includes(step.captured))});
  }
  return snapshots.sort((a,b)=>b.loss-a.loss || a.end-b.end)[0]||{start:0,end:0,loss:0,majorLost:false};
}

function saturatedTacticalLoss(before,after,move,signature) {
  const review=after.moveReview;
  if(before.score.type!=='cp' || review?.score?.type!=='cp')return null;
  const points=expectedPoints(before.score,move.color),next=expectedPoints(review.score,move.color);
  // Keep the published expected-point bands unchanged. This supplementary
  // rule only protects decisive positions from hiding a new major-piece loss.
  if(points>.15 && points<.85 || next>=points || scoreValue(before.score,move.color)-scoreValue(review.score,move.color)<50)return null;
  const evidence=rootEvidence(before,after,move,signature);
  if(!evidence || evidence.played.final.isCheckmate() || evidence.best.final.isCheckmate())return null;
  const played=nearbyExchangeLoss(move,evidence.played),best=nearbyExchangeLoss(move,evidence.best);
  const bestLoss=Math.max(0,best.loss),additional=played.loss-bestLoss;
  // Four points is a rook given for a pawn. Smaller differences can reflect
  // deliberate exchanges and promotion timing; do not promote them to errors.
  return played.majorLost && additional>=4 ? {version:1,additional,played:{start:played.start,end:played.end,loss:played.loss},
    best:{start:best.start,end:best.end,loss:bestLoss},nearPlies:6,maxPlies:12}:null;
}

function directRecapture(move, previousMove) {
  return !!(previousMove && previousMove.color!==move.color && previousMove.after===move.before
    && previousMove.captured && move.captured && !move.promotion
    && previousMove.to===move.to && move.captured===(previousMove.promotion||previousMove.piece));
}

const legalRecordCache=new WeakMap();
function legalMoveRecord(move) {
  if (!move?.before || !move.after) return null;
  const signature=[move.before,move.after,uciMove(move),move.color,move.piece,move.captured,move.promotion].join('|');
  const cached=legalRecordCache.get(move);
  if (cached?.signature===signature) return cached.result;
  let result=null;
  try {
    const chess=validatePosition(move.before),beforeCheck=chess.isCheck();
    const pieces=()=>new Map(chess.board().flat().filter(Boolean).map(piece=>[piece.square,piece]));
    const beforePieces=pieces(),played=chess.move(uciMove(move));
    if (played.after===move.after && played.color===move.color && played.piece===move.piece
      && (played.captured||null)===(move.captured||null) && (played.promotion||null)===(move.promotion||null)) {
      result={...played,beforeCheck,beforePieces,afterPieces:pieces()};
    }
  } catch { /* Incomplete or illegal records cannot prove a recapture. */ }
  legalRecordCache.set(move,{signature,result});
  return result;
}

function delayedRecapture(move, moves, moveIndex) {
  if (!move?.captured || move.promotion || !Array.isArray(moves) || !Number.isInteger(moveIndex)
    || moveIndex<1 || moveIndex>=moves.length) return false;
  const current=moves[moveIndex];
  if (current?.before!==move.before || current.after!==move.after || uciMove(current)!==uciMove(move)) return false;
  const actual=legalMoveRecord(current);
  if (!actual || actual.color!==move.color || actual.piece!==move.piece || actual.captured!==move.captured) return false;
  const target=capturedSquare(actual),opponent=move.color==='w'?'b':'w';
  let boundary=move.before;
  for (let index=moveIndex-1;index>=0;index-=2) {
    const reply=moves[index];
    if (reply?.color!==opponent || reply.after!==boundary) return false;
    const actualReply=legalMoveRecord(reply);
    if (!actualReply) return false;
    if (reply.captured && reply.to===target && (reply.promotion||reply.piece)===actual.captured) return true;
    const middle=moves[index-1];
    if (middle?.color!==move.color || middle.after!==reply.before) return false;
    const actualMiddle=legalMoveRecord(middle);
    if (!actualMiddle) return false;
    // Only a checking intermezzo and its legal reply can delay the recapture.
    // A quiet move starts a separate decision, regardless of elapsed moves.
    if (!actualReply.beforeCheck) return false;
    for (const step of [actualMiddle,actualReply]) {
      if (step.from===target || step.to===target) return false;
      for (const board of [step.beforePieces,step.afterPieces]) {
        const piece=board.get(target);
        if (piece?.color!==opponent || piece.type!==actual.captured) return false;
      }
    }
    boundary=middle.before;
  }
  return false;
}

export function isRecapture(move, {previousMove,moves,moveIndex} = {}) {
  return directRecapture(move,previousMove) || delayedRecapture(move,moves,moveIndex);
}

function onlyLegalMove(move) {
  if (!move.before) return false;
  try { return new Chess(move.before).moves().length===1; }
  catch { return false; }
}

const mateMissCache=new WeakMap();
function missesMateInOne(move) {
  if (!move?.before || !move.after) return false;
  const signature=[move.before,move.after,uciMove(move),move.color,move.piece,move.captured,move.promotion].join('|');
  const cached=mateMissCache.get(move);
  if (cached?.signature===signature) return cached.result;
  let result=false;
  const actual=legalMoveRecord(move);
  if (actual && !actual.san.endsWith('#')) {
    try {
      const chess=new Chess(actual.before);
      result=!chess.isGameOver() && chess.moves().some(san=>san.endsWith('#'));
    } catch { /* An invalid board cannot prove a missed mating move. */ }
  }
  mateMissCache.set(move,{signature,result});
  return result;
}

function missedOpportunity(before, move, previous, previousMove, previousGrade) {
  if (!previousMove || previousMove.color===move.color || previousMove.after!==move.before
    || !hasMoveReview(previous,before,previousMove)) return false;
  const opponent=previousMove.color, assessed=assessedMoveResult(previous,before,previousMove);
  const opponentLoss=verifiedTopCandidate(previous,previousMove,before) ? 0
    : Math.max(0,expectedPoints(previous.score,opponent)-expectedPoints(assessed.score,opponent));
  // A clear opponent error can offer a win, a tactic, or a defensive recovery.
  // A missed opportunity can continue that exchange; ordinary inaccuracies
  // alone do not start a chain. Reuse the published grade bands, not absolute
  // winning/drawing point estimates from an undisclosed rating model.
  return opponentLoss>=0.10 || previousGrade?.key==='miss' && opponentLoss>=0.05;
}

export function classifyMove(before, after, move, {previous,previousMove,previousGrade,moves,moveIndex} = {}) {
  if (!before || !after || !move) return null;
  // History arrays can be edited in place during exploration. Cache the
  // derived decision as well as object identities so stale history cannot
  // retain (or invent) a recapture exemption.
  const recapture=isRecapture(move,{previousMove,moves,moveIndex});
  const signature=gradingEvidenceSignature(before,after,move);
  const mateMiss=missesMateInOne(move),candidate=verifiedTopCandidate(before,move,after,signature);
  const cached = gradeCache.get(move);
  if (cached?.before===before && cached.after===after && cached.previous===previous
    && cached.previousMove===previousMove && cached.previousGrade===previousGrade && cached.recapture===recapture
    && cached.mateMiss===mateMiss && cached.candidate===candidate && cached.signature===signature) return cached.grade;
  const assessed=assessedMoveResult(before,after,move);
  const sign = move.color === 'w' ? 1 : -1;
  let loss;
  if (before.score.type === 'mate' && assessed.score.type === 'mate' && Math.sign(scoreValue(before.score)) === Math.sign(scoreValue(assessed.score))) loss = 0;
  else loss = Math.max(0, (scoreValue(before.score) - scoreValue(assessed.score)) * sign);
  const best = candidate && !mateMiss;
  if (best) loss=0;
  const beforePoints=expectedPoints(before.score,move.color), afterPoints=expectedPoints(assessed.score,move.color);
  const pointsLoss=best ? 0 : Math.max(0,beforePoints-afterPoints);
  let key=best ? 'best' : pointsLoss<0.02 ? 'excellent' : pointsLoss<0.05 ? 'good' : pointsLoss<0.10 ? 'inaccuracy' : pointsLoss<0.20 ? 'mistake' : 'blunder';
  let severity=pointsLoss>=0.20 ? 3 : pointsLoss>=0.10 ? 2 : pointsLoss>=0.05 ? 1 : 0;
  let reason='';
  const second=before.multipvComplete && Number.isFinite(before.depth) && before.depth>0
    ? before.lines?.find(line=>line.multipv===2 && line.score && line.pv?.[0] && line.pv[0]!==before.bestmove && line.depth===before.depth) : null;
  if (mateMiss) {
    // Winning scores saturate at one expected point. A legally available
    // immediate finish is still a concrete missed chance, even if the played
    // move keeps a longer forced mate. Do not penalize mate distance generally.
    key='miss';severity=Math.max(2,severity);reason='한 수에 끝낼 수 있는 체크메이트 기회를 놓쳤습니다.';
  } else if (pointsLoss<0.02 && afterPoints>=0.50 && !isBookMove(move)
    && (sacrificeEvidence(move) || !recapture && newSacrificeDecision(move,reviewedSacrificeEvidence(before,after,move),previousMove))
    && !alreadyWinningWithoutSacrifice(before,move)) {
    key='brilliant'; reason='기물을 내줄 수 있는 수지만, 최선의 응수에도 유리하거나 대등한 국면을 유지합니다.';
  } else if (best && second && beforePoints-afterPoints<0.02 && beforePoints-expectedPoints(second.score,move.color)>=0.10
    && !recapture && !onlyLegalMove(move)) {
    key='great'; reason='다른 후보보다 예상 승점을 크게 지키는 결정적인 수입니다.';
  } else if (!best && pointsLoss>=0.05 && missedOpportunity(before,move,previous,previousMove,previousGrade)) {
    key='miss'; severity=Math.max(2,severity); reason='상대의 실수로 생긴 기회를 살리지 못했습니다.';
  } else if (pointsLoss<0.05 && isBookMove(move)) {
    key='book'; reason='등록된 오프닝 수순에 있는 이론 수입니다.';
  }
  const tacticalLoss=['excellent','good','inaccuracy'].includes(key)?saturatedTacticalLoss(before,after,move,signature):null;
  if(tacticalLoss) {
    key='mistake';severity=Math.max(2,severity);
    reason=`가까운 예상 교환에서 최선의 수보다 기물 점수를 ${tacticalLoss.additional}점 더 내줄 수 있습니다.`;
  }
  const grade={key,...MOVE_GRADES[key],loss,pointsLoss,severity,reason,...(tacticalLoss?{tacticalLoss}:{})};
  gradeCache.set(move,{before,after,previous,previousMove,previousGrade,recapture,mateMiss,candidate,signature,grade});
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
