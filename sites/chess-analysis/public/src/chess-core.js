import { Chess, DEFAULT_POSITION, validateFen } from '../vendor/chess.js';
import { isBookMove } from './opening-book.js';
import { elementaryEndgameEvidence } from './endgame-evidence.js';
import { certifiedTacticalLoss } from './capture-proof.js';

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
export const GRADING_BASIS = 'Chess.com 공개 예상 승점 감소 구간: 우수한 수 0~2%p, 좋은 수 2~5%p, 부정확 5~10%p, 실수 10~20%p, 블런더 20%p 이상. 최선의 수는 엔진 1순위 또는 같은 완료 깊이에서 동일한 평가를 받은 후보입니다. 이 앱은 경계값부터 다음 등급을 적용하며, 예상 승점 환산·특수 분류·승점이 포화된 국면의 전술 손실 보정은 자체 추정입니다. 승점 감소가 작아도 최선보다 추가 주요 기물 손실이 검증되면 실수로 분류합니다. 피할 수 있었던 상대의 즉시 메이트 또는 모든 방어가 증명된 체크 시작 메이트2 허용과, 모든 합법 응수에 검증된 체크 시작 메이트2 기회를 놓친 경우도 별도 분류합니다. 자기 즉시 메이트를 놓치면 놓친 기회로 분류하되, 체크 후 상대의 유일한 합법 응수에 다음 수로 메이트하는 수순이 동일 깊이와 실제 대국 이력으로 검증되면 예외로 합니다. 비제한 수전·수후 검색은 같은 승자의 메이트인데 실전 제한검색만 CP인 경우, 실제 이력으로 최소 2단계 더 깊은 별도 검색의 완결 메이트가 확인되면 그 실전 수 평가에만 사용합니다. 이 별도 증거가 메이트3 이상을 확인한 경우에만, 모든 방어가 증명된 조용한 메이트2 기회 누락도 판정합니다. 원래 국면 점수와 최선 순위는 바꾸지 않습니다. Chess.com의 레이팅별 환산식과 CAPS2 정확도 계산식은 공개되지 않아 동일한 결과를 보장하지 않습니다.';

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

function rankingRoot(record) {
  if(typeof record.startFen!=='string' || !Array.isArray(record.historyMoves))return null;
  try {
    const chess=validatePosition(record.startFen);
    for(const uci of record.historyMoves) {
      if(typeof uci!=='string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci) || uciMove(chess.move(uci))!==uci)return null;
    }
    return chess.fen()===record.fen?chess:null;
  } catch { return null; }
}

function sameRankingHistory(record,chess) {
  if(!chess)return true;
  const history=chess.history({verbose:true});
  return chess.fen()===record.fen && record.startFen===(history[0]?.before||chess.fen())
    && record.historyMoves.length===history.length && record.historyMoves.every((uci,index)=>uci===uciMove(history[index]));
}

function rankingPv(fen,pv,record) {
  if(!Array.isArray(pv) || !pv.length)return null;
  try {
    const chess=record?rankingRoot(record):validatePosition(fen),steps=[];
    if(!chess)return null;
    for(const uci of pv) {
      if(typeof uci!=='string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci) || chess.isGameOver())return null;
      const step=chess.move(uci);
      if(uciMove(step)!==uci)return null;
      steps.push(step);
    }
    return {chess,steps};
  } catch { return null; }
}

function rankingEligible(before,after,move) {
  const review=after?.moveReview,first=before?.lines?.find(line=>line.multipv===1);
  return !!(hasMoveReview(before,after,move) && before.multipvComplete && Number.isInteger(before.depth) && before.depth>0
    && typeof before.configKey==='string' && before.configKey && before.score.type==='cp' && review.score.type==='cp'
    && review.source==='search' && review.depth===before.depth && before.bestmove!==uciMove(move)
    && first?.depth===before.depth && first.pv?.[0]===before.bestmove && sameScore(first.score,before.score)
    && scoreValue(review.score,move.color)>scoreValue(before.score,move.color) && legalMoveRecord(move)
    && rankingPv(move.before,first.pv) && rankingPv(move.before,review.pv));
}

function rankingBinding(before,after,move,chess) {
  const review=after?.moveReview,record=review?.rankingReview;
  return !!(rankingEligible(before,after,move) && record?.version===1 && record.scope==='unrestricted-root'
    && record.fen===move.before && record.afterFen===move.after && record.uci===uciMove(move)
    && record.configKey===before.configKey && record.beforeDepth===before.depth && record.beforeBestmove===before.bestmove
    && sameScore(record.beforeScore,before.score) && sameScore(record.playedScore,review.score)
    && record.playedDepth===review.depth && record.playedSource===review.source
    && Array.isArray(record.playedPv) && record.playedPv.length===review.pv.length && record.playedPv.every((uci,index)=>uci===review.pv[index])
    && record.requestedDepth===before.depth && record.requestedMultipv===Math.min(3,before.lines.length)
    && Number.isFinite(record.movetime) && record.movetime>0 && record.movetime<=1200
    && record.searchMoves===null && ['complete','depth-limited','unverified'].includes(record.status)
    && rankingRoot(record) && sameRankingHistory(record,chess));
}

function legalRankingResult(record) {
  const result=record.result,lines=result?.lines;
  if(!result?.multipvComplete || !Number.isInteger(result.depth) || result.depth<1
    || !Array.isArray(lines) || lines.length!==record.requestedMultipv || !lines.length
    || new Set(lines.map(line=>line.pv?.[0])).size!==lines.length)return false;
  const first=lines.find(line=>line.multipv===1);
  if(!first || first.pv?.[0]!==result.bestmove || !sameScore(first.score,result.score))return false;
  try {
    for(let index=0;index<lines.length;index++) {
      const line=lines.find(item=>item.multipv===index+1);
      if(!line || line.depth!==result.depth || !['cp','mate'].includes(line.score?.type)
        || !Number.isFinite(line.score.value) || !Array.isArray(line.pv) || !line.pv.length)return false;
      const branch=rankingPv(record.fen,line.pv,record);
      if(!branch)return false;
      const {chess,steps}=branch;
      if(line.score.type==='mate') {
        const winner=line.score.winner||(line.score.value>0?'w':'b');
        if(!['w','b'].includes(winner) || !chess.isCheckmate() || chess.turn()===winner
          || steps.filter(step=>step.color===winner).length!==Math.abs(line.score.value))return false;
      }
    }
    return true;
  } catch { return false; }
}

// This optional evidence never changes the independently stored position score
// or the played move's original restricted-search assessment.
export function hasRankingReview(before,after,move,chess) {
  if(!rankingBinding(before,after,move,chess))return false;
  const record=after.moveReview.rankingReview;
  if(record.status==='unverified')return record.result===null;
  if(!rankingPv(record.fen,after.moveReview.pv,record)
    || !rankingPv(record.fen,before.lines.find(line=>line.multipv===1).pv,record))return false;
  if(!legalRankingResult(record))return false;
  return record.status==='complete' ? record.result.depth===record.requestedDepth : record.result.depth<record.requestedDepth;
}

export function needsRankingReview(before,after,move,chess) {
  return rankingEligible(before,after,move) && !hasRankingReview(before,after,move,chess);
}

function copyHistoryPosition(chess) {
  const history=chess.history({verbose:true}),copy=validatePosition(history[0]?.before||chess.fen());
  for(const step of history){if(copy.isGameOver())return null;copy.move(uciMove(step));}
  return copy;
}

function playedMateBranch(chess,pv) {
  if(!chess || !Array.isArray(pv) || !pv.length)return null;
  try {
    const steps=[];
    for(const uci of pv){
      if(typeof uci!=='string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci) || chess.isGameOver())return null;
      const step=chess.move(uci);if(uciMove(step)!==uci)return null;steps.push(step);
    }
    return {chess,steps};
  } catch { return null; }
}

function provesMate(branch,score,winner) {
  return !!(branch && score?.type==='mate' && score.winner===winner && Number.isInteger(score.value)
    && score.value!==0 && Math.sign(score.value)===(winner==='w'?1:-1)
    && branch.chess.isCheckmate() && branch.chess.turn()!==winner
    && branch.steps.filter(step=>step.color===winner).length===Math.abs(score.value));
}

function mateReviewEligible(before,after,move,chess) {
  const review=after?.moveReview,winner=move?.color;
  if(!hasMoveReview(before,after,move) || review.source!=='search' || review.score.type!=='cp'
    || review.depth!==before.depth || !before.multipvComplete || !after.multipvComplete
    || !Number.isInteger(before.depth) || before.depth<1 || !Number.isInteger(after.depth) || after.depth<before.depth
    || Math.min(22,before.depth+4)<before.depth+2
    || typeof before.configKey!=='string' || !before.configKey || after.configKey!==before.configKey
    || before.score.type!=='mate' || before.score.winner!==winner || after.score.type!=='mate' || after.score.winner!==winner
    || !legalMoveRecord(move) || missesMateInOne(move))return false;
  const first=before.lines?.find(line=>line.multipv===1 && line.depth===before.depth
    && line.pv?.[0]===before.bestmove && sameScore(line.score,before.score));
  const child=after.lines?.find(line=>line.multipv===1 && line.depth===after.depth
    && line.pv?.[0]===after.bestmove && sameScore(line.score,after.score));
  if(!first || !child || !chess || chess.fen()!==move.before || chess.isGameOver())return false;
  try {
    const root=copyHistoryPosition(chess),actual=copyHistoryPosition(chess),primary=copyHistoryPosition(chess);
    if(!root || !actual || !primary)return false;
    const best=playedMateBranch(root,first.pv);
    actual.move(uciMove(move));if(actual.fen()!==move.after || actual.isGameOver())return false;
    return provesMate(best,before.score,winner) && provesMate(playedMateBranch(actual,child.pv),after.score,winner)
      && !!playedMateBranch(primary,review.pv);
  } catch { return false; }
}

const mateReviewCache=new WeakMap();
function mateReviewValidation(before,after,move) {
  if(!before || !after || !move)return null;
  const review=after.moveReview,record=review?.mateReview;if(!record)return null;
  const signature=gradingEvidenceSignature(before,after,move),cached=mateReviewCache.get(move);
  if(cached?.before===before && cached.after===after && cached.signature===signature)return cached;
  let valid=false,consumable=null,history=[];
  try {
    const root=rankingRoot(record),first=before.lines?.find(line=>line.multipv===1),child=after.lines?.find(line=>line.multipv===1);
    const samePv=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((uci,index)=>uci===b[index]);
    if(record.version===1 && record.scope==='played-mate-proof' && record.fen===move.before && record.afterFen===move.after
      && record.uci===uciMove(move) && record.configKey===before.configKey
      && record.beforeDepth===before.depth && record.beforeBestmove===before.bestmove && sameScore(record.beforeScore,before.score)
      && samePv(record.beforePv,first?.pv) && record.childDepth===after.depth && record.childBestmove===after.bestmove
      && sameScore(record.childScore,after.score) && samePv(record.childPv,child?.pv)
      && record.playedDepth===review.depth && record.playedSource===review.source && sameScore(record.playedScore,review.score)
      && samePv(record.playedPv,review.pv) && record.requestedDepth===Math.min(22,before.depth+4)
      && record.minimumDepth===before.depth+2 && record.requestedMultipv===1
      && samePv(record.searchMoves,[uciMove(move)]) && Number.isFinite(record.movetime) && record.movetime>0 && record.movetime<=1200
      && ['complete','depth-limited','unverified'].includes(record.status) && root && mateReviewEligible(before,after,move,root)) {
      history=root.history({verbose:true});
      if(record.status==='unverified')valid=record.result===null;
      else {
        const result=record.result,line=result?.lines?.find(item=>item.multipv===1);
        if(Number.isInteger(result?.depth) && result.depth>0 && result.lines.length===1 && line
          && line.depth===result.depth && result.bestmove===uciMove(move) && line.pv?.[0]===uciMove(move)
          && sameScore(line.score,result.score) && ['cp','mate'].includes(result.score?.type) && Number.isFinite(result.score.value)) {
          const branch=playedMateBranch(root,line.pv),complete=!!result.multipvComplete && result.depth>=record.minimumDepth;
          const legal=!!branch && (result.score.type==='mate'?provesMate(branch,result.score,move.color):!branch.chess.isCheckmate());
          valid=legal && (record.status==='complete'?complete:!complete);
          if(valid && complete && provesMate(branch,result.score,move.color))consumable=result;
        }
      }
    }
  } catch { /* Stale, partial or history-inconsistent evidence is not consumed. */ }
  const result={before,after,signature,valid,consumable,history};mateReviewCache.set(move,result);return result;
}

function sameMateReviewHistory(entry,move,context) {
  if(!context)return true;
  const record=entry.after.moveReview.mateReview;
  if(typeof context.history==='function')return sameRankingHistory(record,context);
  if(context.moves===undefined && context.moveIndex===undefined)return true;
  const {moves,moveIndex}=context;
  return Array.isArray(moves) && Number.isInteger(moveIndex) && moveIndex>=0 && moveIndex<moves.length
    && record.startFen===(moves[0]?.before||move.before) && entry.history.length===moveIndex
    && moves[moveIndex]?.before===move.before && moves[moveIndex]?.after===move.after && uciMove(moves[moveIndex])===uciMove(move)
    && entry.history.every((step,index)=>moves[index]?.before===step.before && moves[index]?.after===step.after
      && uciMove(moves[index])===uciMove(step));
}

// The original position and played-only records remain immutable. Optional
// deeper proof repairs a mate/CP horizon conflict only for this played root.
export function hasMateReview(before,after,move,chess) {
  const entry=mateReviewValidation(before,after,move);
  return !!(entry?.valid && sameMateReviewHistory(entry,move,chess));
}

export function validatedMateReview(before,after,move,chess) {
  const entry=mateReviewValidation(before,after,move);
  return entry?.valid && sameMateReviewHistory(entry,move,chess)?entry.consumable:null;
}

export function needsMateReview(before,after,move,chess) {
  if(hasMateReview(before,after,move,chess))return false;
  try {return mateReviewEligible(before,after,move,chess||validatePosition(move.before));}
  catch {return false;}
}

// A root-restricted search includes the played move. Convert its PV and mate
// distance to the resulting position before building explanations/replays.
export function assessedMoveResult(before, after, move, context) {
  if (!hasMoveReview(before,after,move)) return after;
  const proof=validatedMateReview(before,after,move,context),review=proof?{...proof,pv:proof.lines[0].pv}:after.moveReview;
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
    child:[after.score,after.depth,after.bestmove,after.configKey,after.multipvComplete,after.lines],
    review:review&&[review.version,review.fen,review.uci,review.configKey,review.beforeScore,review.beforeDepth,
      review.beforeBestmove,review.score,review.depth,review.pv,review.source,review.rankingReview,review.mateReview]});
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

const rankingEvidenceCache=new WeakMap();
function confirmedTopCandidate(before,after,move,signature) {
  const cached=rankingEvidenceCache.get(move);
  if(cached?.before===before && cached.after===after && cached.signature===signature)return cached.result;
  const record=after?.moveReview?.rankingReview;
  let result=false;
  if(record?.status==='complete' && hasRankingReview(before,after,move)) {
    const confirmation=record.result,actual=confirmation.lines.find(line=>line.pv[0]===uciMove(move));
    result=!!actual && (confirmation.bestmove===uciMove(move) || sameScore(actual.score,confirmation.score));
  }
  rankingEvidenceCache.set(move,{before,after,signature,result});
  return result;
}

function verifiedTopCandidate(before, move, after, signature=gradingEvidenceSignature(before,after,move)) {
  if (before.bestmove===uciMove(move)) return true;
  // Expected points saturate in won/lost positions. Only an actual equal root
  // score at the same completed depth establishes a second best move.
  if (!before.multipvComplete || !Number.isFinite(before.depth) || before.depth<1) return false;
  const first=before.lines?.find(line=>line.multipv===1 && line.pv?.[0]===before.bestmove && line.depth===before.depth);
  if (!first || !sameScore(first.score,before.score)) return false;
  if (before.lines.some(line=>line.depth===before.depth && line.pv?.[0]===uciMove(move) && sameScore(line.score,first.score))) return true;
  // A separate played-only score cannot establish a centipawn tie or a new
  // best move. Only a bound, complete unrestricted search can confirm either.
  if(confirmedTopCandidate(before,after,move,signature))return true;
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
function nearbyExchangeLoss(move,line,majorOnly=false) {
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
  // A later pawn-only window can have a larger cumulative deficit without
  // containing the earlier major-piece capture. It must not mask the actual
  // major-loss window when that is the event being assessed.
  return snapshots.filter(snapshot=>!majorOnly || snapshot.majorLost)
    .sort((a,b)=>b.loss-a.loss || a.end-b.end)[0]||{start:0,end:0,loss:0,majorLost:false};
}

function saturatedTacticalLoss(before,after,move,signature,moves,moveIndex) {
  const review=after.moveReview;
  if(before.score.type!=='cp' || review?.score?.type!=='cp')return null;
  const points=expectedPoints(before.score,move.color),next=expectedPoints(review.score,move.color);
  // Keep the published expected-point bands unchanged. This supplementary
  // rule only protects decisive positions from hiding a new major-piece loss.
  if(points>.15 && points<.85 || next>=points || scoreValue(before.score,move.color)-scoreValue(review.score,move.color)<50)return null;
  const evidence=rootEvidence(before,after,move,signature);
  if(!evidence || evidence.played.final.isCheckmate() || evidence.best.final.isCheckmate())return null;
  const played=nearbyExchangeLoss(move,evidence.played,true),best=nearbyExchangeLoss(move,evidence.best);
  const bestLoss=Math.max(0,best.loss),additional=played.loss-bestLoss;
  // No near exchange in the best line is absent evidence, not a proved zero
  // against a delayed loss. Keep the clear exception of a major piece taken
  // on the opponent's very next move, with its exchange already settled.
  // Capturing a pawn first must not hide an immediate queen/rook loss merely
  // because that same exchange starts at ply one. For this added case, defer
  // when the complete legal line contains a promotion as possible compensation.
  const immediateMajor=evidence.played.moves[1]?.color!==move.color
    && ['r','q'].includes(evidence.played.moves[1]?.captured);
  const capturedThenLost=played.start===1 && move.captured
    && !evidence.played.moves.some(step=>step.color===move.color && step.promotion);
  const immediateException=immediateMajor && (played.start===2 || capturedThenLost);
  // Four points is a rook given for a pawn. Smaller differences can reflect
  // deliberate exchanges and promotion timing; do not promote them to errors.
  if((best.start!==0 || immediateException) && played.majorLost && additional>=4)
    return {version:1,additional,played:{start:played.start,end:played.end,loss:played.loss},
      best:{start:best.start,end:best.end,loss:bestLoss},nearPlies:6,maxPlies:12};
  // A material concession in an already winning position can be a sound
  // simplification. The new minor-piece certificate only repairs saturation
  // on the losing side; the existing major-piece rule above is unchanged.
  if(points>.15)return null;
  const ordinaryPlayed=nearbyExchangeLoss(move,evidence.played);
  if(ordinaryPlayed.loss-bestLoss<3 || !Array.isArray(moves) || !Number.isInteger(moveIndex)
    || moveIndex<0 || moveIndex>=moves.length || moveIndex>512)return null;
  try {
    if(moves[moveIndex]?.before!==move.before || moves[moveIndex]?.after!==move.after
      || uciMove(moves[moveIndex])!==uciMove(move))return null;
    const root=validatePosition(moves[0]?.before||move.before);
    for(const step of moves.slice(0,moveIndex)) {
      if(root.isGameOver() || root.fen()!==step.before || root.move(uciMove(step)).after!==step.after)return null;
    }
    if(root.fen()!==move.before)return null;
    return certifiedTacticalLoss({root,move,bestUci:before.bestmove,
      playedPv:evidence.played.moves.map(uciMove),bestPv:evidence.best.moves.map(uciMove),
      playedSnapshot:ordinaryPlayed,bestSnapshot:best,minimum:3});
  } catch {return null;}
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

const forcingMateCache=new WeakMap();
function verifiedForcingMateContinuation(before,after,move,moves,moveIndex,signature) {
  const review=after?.moveReview,winner=move?.color,sign=winner==='w'?1:-1;
  // Only a next-turn finish is exempt. A longer checking sequence, a quiet
  // move, or a selected mating line among multiple replies is still a miss.
  if(before?.score?.type!=='mate' || before.score.winner!==winner || before.score.value!==sign
    || !before.multipvComplete || !Number.isInteger(before.depth) || before.depth<1
    || typeof before.configKey!=='string' || !before.configKey
    || !hasMoveReview(before,after,move) || review.depth!==before.depth
    || !['candidate','search'].includes(review.source) || review.score.type!=='mate'
    || review.score.winner!==winner || review.score.value!==sign*2 || review.pv.length!==3
    || !Array.isArray(moves) || !Number.isInteger(moveIndex) || moveIndex<0 || moveIndex>=moves.length)return false;
  const first=before.lines?.find(line=>line.multipv===1 && line.depth===before.depth
    && line.pv?.[0]===before.bestmove && sameScore(line.score,before.score));
  if(!first || first.pv.length!==1 || !legalMoveRecord(move))return false;
  const historySignature=JSON.stringify(moves.slice(0,moveIndex+1).map(step=>
    [step?.before,step?.after,step?.from,step?.to,step?.promotion]));
  const cached=forcingMateCache.get(move);
  if(cached?.before===before && cached.after===after && cached.moves===moves && cached.moveIndex===moveIndex
    && cached.signature===signature && cached.historySignature===historySignature)return cached.result;
  const result=(()=>{
    try {
      const current=moves[moveIndex];
      if(current?.before!==move.before || current.after!==move.after || uciMove(current)!==uciMove(move))return false;
      const chess=validatePosition(moves[0]?.before||move.before);
      for(const step of moves.slice(0,moveIndex)) {
        if(chess.isGameOver() || chess.fen()!==step.before)return false;
        if(chess.move(uciMove(step)).after!==step.after)return false;
      }
      if(chess.fen()!==move.before || chess.isGameOver())return false;
      // Full history is retained for both alternatives, so a repetition or
      // fifty-move draw cannot be mistaken for an inevitable finish.
      chess.move(before.bestmove);
      if(!chess.isCheckmate() || chess.turn()===winner)return false;
      chess.undo();
      let ownMoves=0;
      for(const [index,uci] of review.pv.entries()) {
        if(chess.isGameOver())return false;
        const turn=chess.turn();
        if(turn!==winner) {
          const replies=chess.moves({verbose:true});
          if(replies.length!==1 || uciMove(replies[0])!==uci)return false;
        }
        const played=chess.move(uci);
        if(index===0 && played.after!==move.after)return false;
        if(turn===winner) {
          ownMoves++;
          if(!chess.isCheck())return false;
        }
      }
      return chess.isCheckmate() && chess.turn()!==winner && ownMoves===Math.abs(review.score.value);
    } catch { return false; }
  })();
  forcingMateCache.set(move,{before,after,moves,moveIndex,signature,historySignature,result});
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

function childSearchContradictsGreat(before,after,move) {
  // A separate child score does not replace the bound root comparison. It can
  // only withhold a special award when a completed, equally deep search gives
  // contradictory evidence. Its legal continuation must belong to this board.
  if(!hasMoveReview(before,after,move) || !after.multipvComplete || after.configKey!==before.configKey
    || !Number.isInteger(after.depth) || after.depth<before.depth
    || !['cp','mate'].includes(after.score?.type) || !Number.isFinite(after.score.value)
    || expectedPoints(before.score,move.color)-expectedPoints(after.score,move.color)<0.02)return false;
  const first=after.lines?.find(line=>line.multipv===1 && line.depth===after.depth
    && line.pv?.[0]===after.bestmove && sameScore(line.score,after.score));
  if(!first || !legalMoveRecord(move))return false;
  try {
    const chess=validatePosition(move.after),steps=[];
    for(const uci of first.pv) {
      if(chess.isGameOver())return false;
      steps.push(chess.move(uci));
    }
    if(after.score.type==='mate') {
      const winner=after.score.winner||(after.score.value>0?'w':'b');
      if(!chess.isCheckmate() || chess.turn()===winner
        || steps.filter(step=>step.color===winner).length!==Math.abs(after.score.value))return false;
    }
    return true;
  } catch { return false; }
}

const shortMateEvidenceCache=new WeakMap();
function mateTwoCertificates(position,first,checkingOnly=true) {
  const chess=copyHistoryPosition(position);if(!chess || chess.isGameOver())return null;
  try {
    if(typeof first!=='string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(first))return null;
    chess.move(first);if(checkingOnly && !chess.isCheck() || chess.isGameOver())return null;
    const certificates=[];
    for(const defense of chess.moves({verbose:true})) {
      chess.move(uciMove(defense));
      const finish=!chess.isGameOver()&&chess.moves({verbose:true}).find(step=>step.san.endsWith('#'));
      chess.undo();if(!finish)return null;
      certificates.push({reply:uciMove(defense),finish:uciMove(finish)});
    }
    return certificates.length?certificates:null;
  } catch {return null;}
}

function shortMateEvidence(before,after,move,moves,moveIndex,signature) {
  const review=after.moveReview,winner=move.color,enemy=winner==='w'?'b':'w';
  const allowedDistance=review?.score?.type==='mate'?Math.abs(review.score.value):0;
  const allowsMate=before.score.type==='cp' && expectedPoints(before.score,winner)<=.15
    && review?.score?.type==='mate' && review.score.winner===enemy
    && [1,2].includes(allowedDistance) && review.score.value===(enemy==='w'?allowedDistance:-allowedDistance)
    && review.pv?.length===2*allowedDistance;
  const confirmedLonger=before.score.type==='mate' && Math.abs(before.score.value)===2 && review?.score?.type==='cp'
    ?validatedMateReview(before,after,move,{moves,moveIndex}):null;
  const elementaryMate=before.score.type==='mate' && before.score.winner===move.color
    && elementaryEndgameEvidence(move,{moves,moveIndex});
  const extendedMate=confirmedLonger && Math.abs(confirmedLonger.score.value)>=3 || elementaryMate;
  const missesMate=before.score.type==='mate' && before.score.winner===winner
    && before.score.value===(winner==='w'?2:-2) && review?.score?.type==='cp'
    && (after.score.type==='cp' && Number.isFinite(after.score.value) || extendedMate)
    && after.multipvComplete && after.configKey===before.configKey && Number.isInteger(after.depth) && after.depth>=before.depth;
  if(!allowsMate && !missesMate)return null;
  const first=before.lines?.find(line=>line.multipv===1 && line.depth===before.depth
    && line.pv?.[0]===before.bestmove && sameScore(line.score,before.score));
  if(!first || !before.multipvComplete || !Number.isInteger(before.depth) || before.depth<1
    || typeof before.configKey!=='string' || !before.configKey || before.bestmove===uciMove(move)
    || !hasMoveReview(before,after,move) || review.depth!==before.depth
    || !['candidate','search'].includes(review.source) || !legalMoveRecord(move)
    || !Array.isArray(moves) || !Number.isInteger(moveIndex) || moveIndex<0 || moveIndex>=moves.length)return null;
  const historySignature=JSON.stringify(moves.slice(0,moveIndex+1).map(step=>
    [step?.before,step?.after,step?.from,step?.to,step?.promotion]));
  const cached=shortMateEvidenceCache.get(move);
  if(cached?.before===before && cached.after===after && cached.moves===moves && cached.moveIndex===moveIndex
    && cached.signature===signature && cached.historySignature===historySignature)return cached.result;
  const result=(()=>{
    try {
      const current=moves[moveIndex];
      if(current?.before!==move.before || current.after!==move.after || uciMove(current)!==uciMove(move))return null;
      const root=()=>{
        const chess=validatePosition(moves[0]?.before||move.before);
        for(const step of moves.slice(0,moveIndex)) {
          if(chess.isGameOver() || chess.fen()!==step.before || chess.move(uciMove(step)).after!==step.after)return null;
        }
        return chess.fen()===move.before && !chess.isGameOver()?chess:null;
      };
      const replay=pv=>playedMateBranch(root(),pv)?.chess||null;
      const position=root();if(!position || position.moves().length===1)return null;
      const playedEnd=replay(review.pv),bestEnd=replay(first.pv);
      if(!playedEnd || !bestEnd)return null;
      const matingMoves=chess=>chess.isGameOver()?[]:chess.moves({verbose:true}).filter(step=>step.san.endsWith('#'));
      if(allowsMate) {
        if(!playedEnd.isCheckmate() || playedEnd.turn()!==winner)return null;
        position.move(uciMove(move));if(position.fen()!==move.after || position.isGameOver())return null;
        const finishes=matingMoves(position);
        const alternative=root();alternative.move(before.bestmove);
        if(alternative.isGameOver() || matingMoves(alternative).length)return null;
        if(allowedDistance===1)return finishes.length?{version:1,kind:'allowed-mate-in-one',finishes:finishes.map(uciMove),alternative:before.bestmove}:null;
        const certificates=mateTwoCertificates(position,review.pv[1]);if(!certificates)return null;
        // The alternative must avoid every checking mate in two, rather than
        // merely avoid the attacker's selected continuation from the PV.
        for(const attack of alternative.moves({verbose:true})) {
          if(attack.san.endsWith('+') && mateTwoCertificates(alternative,uciMove(attack)))return null;
        }
        return {version:1,kind:'allowed-mate-in-two',first:review.pv[1],certificates,alternative:before.bestmove};
      }
      // Prove mate in two over every legal defender reply, not merely the
      // selected PV. Quiet setups require independent longer-mate proof;
      // the original CP/CP rule remains restricted to checking setups.
      if(first.pv.length!==3 || !bestEnd.isCheckmate() || bestEnd.turn()===winner || playedEnd.isCheckmate())return null;
      const certificates=mateTwoCertificates(position,before.bestmove,!extendedMate);if(!certificates)return null;
      const checkingStart=position.move(before.bestmove).san.endsWith('+');
      const actual=root();actual.move(uciMove(move));if(actual.fen()!==move.after || actual.isGameOver())return null;
      const escape=actual.moves({verbose:true}).find(defense=>{
        actual.move(uciMove(defense));const finished=actual.isCheckmate() && actual.turn()!==winner;
        const preserves=finished || !actual.isGameOver() && matingMoves(actual).length>0;actual.undo();return !preserves;
      });
      const child=after.lines?.find(line=>line.multipv===1 && line.depth===after.depth
        && line.pv?.[0]===after.bestmove && sameScore(line.score,after.score));
      if(!escape || !child)return null;
      for(const uci of child.pv){if(actual.isGameOver())return null;actual.move(uci);}
      if(actual.isCheckmate() && !extendedMate)return null;
      return {version:1,kind:'missed-verified-mate-in-two',first:before.bestmove,certificates,escapingDefense:uciMove(escape),checkingStart};
    } catch { return null; }
  })();
  shortMateEvidenceCache.set(move,{before,after,moves,moveIndex,signature,historySignature,result});
  return result;
}

export function classifyMove(before, after, move, {previous,previousMove,previousGrade,moves,moveIndex} = {}) {
  if (!before || !after || !move) return null;
  // History arrays can be edited in place during exploration. Cache the
  // derived decision as well as object identities so stale history cannot
  // retain (or invent) a recapture exemption.
  const recapture=isRecapture(move,{previousMove,moves,moveIndex});
  const signature=gradingEvidenceSignature(before,after,move);
  const mateMiss=missesMateInOne(move) && !verifiedForcingMateContinuation(before,after,move,moves,moveIndex,signature),
    candidate=verifiedTopCandidate(before,move,after,signature);
  const shortMate=shortMateEvidence(before,after,move,moves,moveIndex,signature);
  const mateProof=validatedMateReview(before,after,move,{moves,moveIndex});
  const endgameEvidence=elementaryEndgameEvidence(move,{moves,moveIndex});
  // A capture certificate can depend on a draw claim in the actual history.
  // Bind its positive and negative cache entries to that history as well as
  // to the engine score/PV signature, including in-place exploration edits.
  const captureHistory=before.score.type==='cp' && after.moveReview?.score?.type==='cp'
    && expectedPoints(before.score,move.color)<=.15 && Math.abs(before.score.value-after.moveReview.score.value)>=50
    && Array.isArray(moves) && Number.isInteger(moveIndex) && moveIndex>=0 && moveIndex<=512
    ?JSON.stringify(moves.slice(0,moveIndex+1).map(step=>step?[step.before,step.after,step.from,step.to,step.promotion]:null)):null;
  const cached = gradeCache.get(move);
  if (cached?.before===before && cached.after===after && cached.previous===previous
    && cached.previousMove===previousMove && cached.previousGrade===previousGrade && cached.recapture===recapture
    && cached.mateMiss===mateMiss && cached.candidate===candidate && cached.shortMate===shortMate
    && cached.mateProof===mateProof && cached.endgameEvidence===endgameEvidence && cached.captureHistory===captureHistory
    && cached.signature===signature) return cached.grade;
  const assessed=assessedMoveResult(before,after,move,{moves,moveIndex});
  const sign = move.color === 'w' ? 1 : -1;
  let loss;
  if (before.score.type === 'mate' && assessed.score.type === 'mate' && Math.sign(scoreValue(before.score)) === Math.sign(scoreValue(assessed.score))) loss = 0;
  else loss = Math.max(0, (scoreValue(before.score) - scoreValue(assessed.score)) * sign);
  const best = candidate && !mateMiss;
  if (best || endgameEvidence) loss=0;
  const beforePoints=endgameEvidence ? Number(endgameEvidence.winner===move.color):expectedPoints(before.score,move.color),
    afterPoints=endgameEvidence ? Number(endgameEvidence.winner===move.color):expectedPoints(assessed.score,move.color);
  const pointsLoss=best ? 0 : Math.max(0,beforePoints-afterPoints);
  let key=best ? 'best' : pointsLoss<0.02 ? 'excellent' : pointsLoss<0.05 ? 'good' : pointsLoss<0.10 ? 'inaccuracy' : pointsLoss<0.20 ? 'mistake' : 'blunder';
  let severity=pointsLoss>=0.20 ? 3 : pointsLoss>=0.10 ? 2 : pointsLoss>=0.05 ? 1 : 0;
  let reason='';
  const second=before.multipvComplete && Number.isFinite(before.depth) && before.depth>0
    ? before.lines?.find(line=>line.multipv===2 && line.score && line.pv?.[0] && line.pv[0]!==before.bestmove && line.depth===before.depth) : null;
  if (mateMiss) {
    // Winning scores saturate at one expected point. A legally available
    // immediate finish is still a concrete missed chance. Only the separately
    // verified check/unique-reply/next-turn mate is exempt; longer mates are
    // not. Do not penalize mate distance generally.
    key='miss';severity=Math.max(2,severity);reason='한 수에 끝낼 수 있는 체크메이트 기회를 놓쳤습니다.';
  } else if (pointsLoss<0.02 && afterPoints>=0.50 && !isBookMove(move)
    && (sacrificeEvidence(move) || !recapture && newSacrificeDecision(move,reviewedSacrificeEvidence(before,after,move),previousMove))
    && !alreadyWinningWithoutSacrifice(before,move)) {
    key='brilliant'; reason='기물을 내줄 수 있는 수지만, 최선의 응수에도 유리하거나 대등한 국면을 유지합니다.';
  } else if (!endgameEvidence && best && second && beforePoints-afterPoints<0.02 && beforePoints-expectedPoints(second.score,move.color)>=0.10
    && !recapture && !onlyLegalMove(move) && !childSearchContradictsGreat(before,after,move)
    && !confirmedTopCandidate(before,after,move,signature)) {
    key='great'; reason='다른 후보보다 예상 승점을 크게 지키는 결정적인 수입니다.';
  } else if (!best && pointsLoss>=0.05 && missedOpportunity(before,move,previous,previousMove,previousGrade)) {
    key='miss'; severity=Math.max(2,severity); reason='상대의 실수로 생긴 기회를 살리지 못했습니다.';
  } else if (pointsLoss<0.05 && isBookMove(move)) {
    key='book'; reason='등록된 오프닝 수순에 있는 이론 수입니다.';
  }
  const mateEvidence=!['miss','mistake','blunder'].includes(key)?shortMate:null;
  if(mateEvidence) {
    key=mateEvidence.kind.startsWith('allowed-mate')?'mistake':'miss';severity=Math.max(2,severity);
    reason=key==='mistake'?(mateEvidence.kind==='allowed-mate-in-one'?'다른 수로 피할 수 있었던 상대의 한 수 체크메이트를 허용했습니다.'
      :'다른 수로 피할 수 있었지만, 상대가 체크로 시작해 모든 합법 응수에 다음 수로 메이트할 수 있게 했습니다.')
      :mateEvidence.checkingStart===false?'상대의 모든 합법 응수에 다음 수로 메이트할 수 있었지만, 그 마무리를 놓쳤습니다.'
        :'체크로 시작해 상대의 모든 합법 응수에 다음 수로 메이트할 수 있었지만, 그 마무리를 놓쳤습니다.';
  }
  const tacticalLoss=['excellent','good','inaccuracy'].includes(key)?saturatedTacticalLoss(before,after,move,signature,moves,moveIndex):null;
  if(tacticalLoss) {
    key='mistake';severity=Math.max(2,severity);
    reason=`가까운 예상 교환에서 최선의 수보다 기물 점수를 ${tacticalLoss.additional}점 더 내줄 수 있습니다.`;
  }
  const grade={key,...MOVE_GRADES[key],loss,pointsLoss,severity,reason,...(endgameEvidence?{endgameEvidence}:{}),...(mateEvidence?{mateEvidence}:{}),...(tacticalLoss?{tacticalLoss}:{})};
  gradeCache.set(move,{before,after,previous,previousMove,previousGrade,recapture,mateMiss,candidate,shortMate,mateProof,endgameEvidence,captureHistory,signature,grade});
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
