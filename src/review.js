import { Chess, expectedPoints, hasMoveReview, hasRankingReview, needsRankingReview, sacrificeCandidates, scoreValue, uciMove } from './chess-core.js';
import { isBookMove } from './opening-book.js';

function legalBranch(fen,line,captures) {
  if (!line?.pv?.length || !captures.includes(line.pv[0]) || !['cp','mate'].includes(line.score?.type)
    || !Number.isFinite(line.score.value) || !Number.isInteger(line.depth) || line.depth<1) return false;
  try {
    const chess=new Chess(fen);
    for (const move of line.pv) chess.move(move);
    return true;
  } catch { return false; }
}

function sameSacrificeBinding(review,before,move,depth) {
  return review?.version===1 && review.fen===move.after && review.rootFen===move.before
    && review.uci===uciMove(move) && review.configKey===before.configKey && review.requestedDepth===depth
    && ['verified','unverified','no-candidates','not-eligible'].includes(review.status);
}

async function reviewSacrifice(engine,chess,before,after,move,options) {
  const requestedDepth=Math.min(16,Math.max(1,(Number.isInteger(before.depth)?before.depth:1)-1));
  if (sameSacrificeBinding(after.moveReview.sacrificeReview,before,move,requestedDepth)) return after;
  const evidence={version:1,fen:move.after,rootFen:move.before,uci:uciMove(move),configKey:before.configKey,
    requestedDepth,restrictedMoves:[],branches:[],status:'not-eligible'};
  const primary=after.moveReview.score;
  const nearBest=Math.max(0,expectedPoints(before.score,move.color)-expectedPoints(primary,move.color))<0.02;
  if (!after.terminal && Number.isInteger(before.depth) && before.depth>0 && nearBest
    && scoreValue(before.score,move.color)>=0 && scoreValue(primary,move.color)>=0 && !isBookMove(move)) {
    const captures=[...new Set(sacrificeCandidates(move).flatMap(offer=>offer.captures))].sort();
    evidence.restrictedMoves=captures;
    evidence.status=captures.length?'unverified':'no-candidates';
    if (captures.length) {
      // Keep the game's repetition history for engine evaluation. A fresh FEN
      // alone would incorrectly discard claims after the offered capture.
      const history=chess.history({verbose:true});
      const position=new Chess(history[0]?.before||chess.fen());
      for (const step of history) position.move(uciMove(step));
      position.move(uciMove(move));
      if (position.fen()===move.after) {
        let source='candidate',complete=Boolean(after.multipvComplete);
        let line=complete ? after.lines?.find(item=>item.depth===after.depth
          && (item.multipv===1 || captures.length===1) && legalBranch(move.after,item,captures)) : null;
        if (!line && engine?.analyze) {
          source='search';
          const movetime=Math.min(500,Number.isFinite(options.movetime)&&options.movetime>0?options.movetime:500);
          const result=await engine.analyze(position,{...options,depth:requestedDepth,movetime,multipv:1,searchMoves:captures});
          complete=Boolean(result.multipvComplete);
          line=result.lines?.find(item=>item.pv?.[0]===result.bestmove && item.depth===result.depth
            && legalBranch(move.after,item,captures));
        }
        if (line) {
          const verified=complete && line.depth>=requestedDepth;
          evidence.branches=[{capture:line.pv[0],score:{...line.score},depth:line.depth,pv:[...line.pv],multipvComplete:complete,
            verified,status:verified?'verified':'depth-limited',source,bestResponse:false}];
          evidence.status=verified?'verified':'unverified';
        }
      }
    }
  }
  return {...after,moveReview:{...after.moveReview,sacrificeReview:evidence}};
}

async function reviewRanking(engine,chess,before,after,move,options) {
  if(!needsRankingReview(before,after,move,chess) || !engine?.analyze)return after;
  const review=after.moveReview,movetime=Math.min(1200,Number.isFinite(options.movetime)&&options.movetime>0?options.movetime:1200);
  const history=chess.history({verbose:true});
  const evidence={version:1,scope:'unrestricted-root',fen:move.before,afterFen:move.after,uci:uciMove(move),configKey:before.configKey,
    startFen:history[0]?.before||chess.fen(),historyMoves:history.map(uciMove),
    beforeScore:{...before.score},beforeDepth:before.depth,beforeBestmove:before.bestmove,
    playedScore:{...review.score},playedDepth:review.depth,playedPv:[...review.pv],playedSource:review.source,
    requestedDepth:before.depth,requestedMultipv:Math.min(3,before.lines.length),movetime,searchMoves:null,status:'unverified',result:null};
  try {
    // Independent one-root and MultiPV searches can disagree even at the same
    // depth. Recheck all legal roots using the original root's candidate count,
    // without warming this confirmation with the played-only search's table.
    await engine.reset?.();
    const settings={...options,depth:evidence.requestedDepth,movetime,multipv:evidence.requestedMultipv};
    delete settings.searchMoves;
    const result=await engine.analyze(chess,settings);
    evidence.result={score:result.score&&{...result.score},depth:result.depth,bestmove:result.bestmove,
      engineBestmove:result.engineBestmove,multipvComplete:result.multipvComplete,
      lines:Array.isArray(result.lines)?result.lines.map(line=>({...line,score:line.score&&{...line.score},pv:Array.isArray(line.pv)?[...line.pv]:line.pv})):[]};
    evidence.status=result.depth===before.depth?'complete':'depth-limited';
    const enriched={...after,moveReview:{...review,rankingReview:evidence}};
    if(hasRankingReview(before,enriched,move,chess))return enriched;
  } catch(error) {
    if(error.name==='AbortError')throw error;
    // Optional confidence checks may fail without discarding a sound primary
    // review. A bound attempted check is cached; it is never best-move proof.
  }
  evidence.result=null;evidence.status='unverified';
  return {...after,moveReview:{...review,rankingReview:evidence}};
}

// Grade the played move from the same root as the engine's best move. Scores
// from independently searched child positions are kept for the graph only.
export async function reviewMove(engine, chess, before, after, move, options = {}) {
  if (!move || !before) return after;
  if (chess.fen()!==move.before) throw new Error('수 평가의 시작 국면이 일치하지 않습니다.');
  if (hasMoveReview(before,after,move)) return reviewSacrifice(engine,chess,before,await reviewRanking(engine,chess,before,after,move,options),move,options);
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
  const reviewed={...after,moveReview:{version:1,fen:move.before,uci,configKey:before.configKey,
    beforeScore:before.score,beforeDepth:before.depth,beforeBestmove:before.bestmove,
    score:candidate.score,depth:candidate.depth,pv:[...candidate.pv],source}};
  return reviewSacrifice(engine,chess,before,await reviewRanking(engine,chess,before,reviewed,move,options),move,options);
}
