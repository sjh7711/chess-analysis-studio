import { hasMoveReview, scoreValue, uciMove } from './chess-core.js';

// Grade the played move from the same root as the engine's best move. Scores
// from independently searched child positions are kept for the graph only.
export async function reviewMove(engine, chess, before, after, move, options = {}) {
  if (!move || !before || hasMoveReview(before,after,move)) return after;
  if (chess.fen()!==move.before) throw new Error('수 평가의 시작 국면이 일치하지 않습니다.');
  const uci=uciMove(move);
  let candidate,source;
  if (after.terminal) {
    let score=after.score;
    if (score.type==='mate' && score.winner===move.color) score={...score,value:Math.sign(scoreValue(score))*(Math.abs(score.value)+1)};
    candidate={score,depth:after.depth,pv:[uci]};source='terminal';
  } else if (before.bestmove===uci) {
    candidate={score:before.score,depth:before.depth,pv:before.lines?.find(line=>line.pv?.[0]===uci)?.pv||[uci]};source='best';
  } else {
    candidate=before.lines?.find(line=>line.depth===before.depth && line.pv?.[0]===uci);
    source='candidate';
    if (!candidate) {
      const requestedDepth=options.depth ?? 16;
      const rootDepth=Number.isInteger(before.depth) && before.depth>0 ? before.depth : requestedDepth;
      // A single restricted line often reaches the requested limit much faster
      // than MultiPV. Do not compare that deeper score with a shallower root.
      const depth=Math.min(requestedDepth,rootDepth);
      const result=await engine.analyze(chess,{...options,depth,multipv:1,searchMoves:[uci]});
      candidate=result.lines?.find(line=>line.pv?.[0]===uci);
      if (!candidate) {
        if (result.terminal) candidate={score:result.score,depth:result.depth,pv:[uci]};
        else throw new Error('실전 수의 비교 분석을 완료하지 못했습니다. 다시 분석해 주세요.');
      }
      source='search';
    }
  }
  return {...after,moveReview:{version:1,fen:move.before,uci,configKey:before.configKey,
    beforeScore:before.score,beforeDepth:before.depth,beforeBestmove:before.bestmove,
    score:candidate.score,depth:candidate.depth,pv:[...candidate.pv],source}};
}
