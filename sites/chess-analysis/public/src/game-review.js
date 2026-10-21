import { gameAt, hasMoveReview } from './chess-core.js';
import { reviewMove } from './review.js';
import { ReviewWorkerPool } from './review-pool.js';

// Positions are independent. Move comparisons begin only after both of their
// source evaluations exist, and never replace those source scores with a PV
// from another worker. Each position and each missing comparison runs once.
export async function reviewGame(game, {concurrency=1, createEngine, signal, pool:sharedPool, workerKey='default',
  results=new Map(), isCached=()=>false, options, comparisonOptions=options,
  configKey, overview=false, onResult=()=>{}} = {}) {
  const working=new Map(results), pool=sharedPool||new ReviewWorkerPool({concurrency,createWorker:createEngine,signal});
  // An application-owned pool shares its capacity with interactive analysis.
  // Its lifetime and other jobs must survive this particular game finishing.
  const poolOptions=sharedPool?{signal,priority:0,workerKey,createWorker:createEngine,isolateFailures:true}:{};
  let analyzed=0,reviewed=0;
  const publish=(result,index,phase)=>{
    signal?.throwIfAborted();
    working.set(index,result);
    return onResult(result,index,phase);
  };
  try {
    const positions=game.positions.map((_,index)=>index).filter(index=>!isCached(working.get(index)));
    await pool.map(positions,{
      ...poolOptions,
      run:async(worker,index,_,jobSignal)=>{
        // A job starts with the same empty transposition table and history on
        // every worker. Assignment order must not seed a different evaluation.
        await worker.reset?.();
        jobSignal.throwIfAborted();
        const result=await worker.analyze(gameAt(game,index),options);
        if(options.searchMode==='depth'&&!result.terminal
          &&(result.searchMode!=='depth'||!result.multipvComplete||result.depth!==options.depth))
          throw new Error('설정한 깊이를 완료하지 않은 국면은 리뷰에 저장할 수 없습니다.');
        return {...result,requestedDepth:options.depth,configKey,overview};
      },
      onResult:(result,_,index)=>{analyzed++;return publish(result,index,'position');},
    });
    signal?.throwIfAborted();
    const moves=game.moves.map((move,index)=>index+1).filter(index=>
      !hasMoveReview(working.get(index-1),working.get(index),game.moves[index-1]));
    await pool.map(moves,{
      ...poolOptions,
      run:async(worker,index,_,jobSignal)=>{
        await worker.reset?.();
        jobSignal.throwIfAborted();
        const before=working.get(index-1),after=working.get(index);
        return reviewMove(worker,gameAt(game,index-1),before,after,game.moves[index-1],
          before.overview?options:comparisonOptions);
      },
      onResult:(result,_,index)=>{reviewed++;return publish(result,index,'review');},
    });
    return {results:working,analyzed,reviewed};
  } finally { if(!sharedPool)await pool.dispose(); }
}
