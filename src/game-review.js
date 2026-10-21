import { gameAt, hasMoveReview } from './chess-core.js';
import { reviewMove } from './review.js';
import { ReviewWorkerPool } from './review-pool.js';

// A comparison needs its two completed source positions, not every position in
// the game. Ready comparisons can fill slots while a difficult root finishes.
// Independent primary scores stay separate from enriched comparison records.
export async function reviewGame(game, {concurrency=1, createEngine, signal, pool:sharedPool, workerKey='default',
  results=new Map(), isCached=()=>false, options, comparisonOptions=options,
  configKey, overview=false, onResult=()=>{}, onProgress} = {}) {
  const abort=new AbortController(),runSignal=abort.signal;
  let failure,failed=false;
  const fail=error=>{
    if(!failed){failed=true;failure=error;}
    if(!runSignal.aborted)abort.abort(error);
  };
  const onAbort=()=>fail(signal.reason??new DOMException('Cancelled','AbortError'));
  signal?.addEventListener('abort',onAbort,{once:true});
  if(signal?.aborted)onAbort();
  const working=new Map(results),primary=new Map(results),accepted=new Set(),scheduled=new Set(),reviews=[];
  const pool=sharedPool||new ReviewWorkerPool({concurrency,createWorker:createEngine,signal:runSignal});
  // An application-owned pool shares its capacity with interactive analysis.
  // Its lifetime and other jobs must survive this particular game finishing.
  const poolOptions={signal:runSignal,priority:0,workerKey,createWorker:createEngine,...(sharedPool?{isolateFailures:true}:{})};
  let analyzed=0,reviewed=0;
  let reporting=true;
  const taskSignals=new Map();
  const progress=(event,jobSignal)=>{
    if(!reporting||runSignal.aborted||jobSignal?.aborted||typeof onProgress!=='function')return;
    // Progress is observational: a renderer or telemetry callback must never
    // reject a completed engine evaluation or change its scoring policy.
    try {Promise.resolve(onProgress(event)).catch(()=>{});}catch { /* Ignore observer failures. */ }
  };
  const reportWorker=(worker,phase,index,jobSignal)=>{
    let active=true;
    const available=()=>active&&reporting&&!runSignal.aborted&&!jobSignal?.aborted;
    if(typeof onProgress!=='function')return {worker,close(){active=false;}};
    const reported={
      ...(typeof worker.reset==='function'?{reset:(...args)=>worker.reset(...args)}:{}),
      ...(typeof worker.analyze==='function'?{analyze:(chess,settings={})=>{
        if(available())progress({phase,index,type:'search',requestedDepth:settings.depth,multipv:settings.multipv},jobSignal);
        const original=settings.onInfo,originalSearchInfo=settings.onSearchInfo;
        let searching=true,rawSeen=false;
        const reportInfo=info=>{
          const metrics={};
          for(const key of ['depth','seldepth','multipv','nodes','nps','time','hashfull'])
            if(Number.isFinite(info?.[key]))metrics[key]=info[key];
          progress({phase,index,type:'info',requestedDepth:settings.depth,...metrics},jobSignal);
        };
        try {
          return Promise.resolve(worker.analyze(chess,{...settings,
            onSearchInfo:info=>{
              if(!searching||!available())return;
              rawSeen=true;reportInfo(info);
              // Raw search telemetry is a separate observational channel. A
              // failing observer cannot reject or alter engine evidence.
              try {Promise.resolve(originalSearchInfo?.(info)).catch(()=>{});}catch { /* Ignore observer failures. */ }
            },
            onInfo:info=>{
              if(!searching||!available())return;
              // Older test/worker adapters expose only completed score lines.
              // Real workers report raw telemetry first, avoiding duplicate
              // progress while retaining the existing scored-info callback.
              if(!rawSeen)reportInfo(info);
              original?.(info);
          }})).finally(()=>{searching=false;});
        }catch(error){searching=false;throw error;}
      }}:{}),
    };
    return {worker:reported,close(){active=false;}};
  };
  const publish=async(result,index,phase)=>{
    runSignal.throwIfAborted();
    working.set(index,result);
    await onResult(result,index,phase);
    runSignal.throwIfAborted();
  };
  let reviewPhase=false;
  const beginReviews=()=>{
    if(!reviewPhase){reviewPhase=true;progress({phase:'review',index:null,type:'start'});}
  };
  const scheduleReview=index=>{
    if(runSignal.aborted||index<1||index>game.moves.length||scheduled.has(index)
      ||!accepted.has(index-1)||!accepted.has(index))return;
    const before=primary.get(index-1),after=primary.get(index),move=game.moves[index-1];
    if(hasMoveReview(before,working.get(index),move))return;
    scheduled.add(index);beginReviews();
    // Individual leases coexist with the root map. The same background priority
    // preserves FIFO fairness and never consumes a second pool.map phase.
    const promise=pool.submit({signal:runSignal,priority:0,workerKey,createWorker:createEngine,
      run:async(worker,jobSignal)=>{
        const reported=reportWorker(worker,'review',index,jobSignal);
        progress({phase:'review',index,type:'start'},jobSignal);
        try {
          await reported.worker.reset?.();jobSignal.throwIfAborted();
          const result=await reviewMove(reported.worker,gameAt(game,index-1),before,after,move,
            before.overview?options:comparisonOptions);
          jobSignal.throwIfAborted();runSignal.throwIfAborted();
          reviewed++;await publish(result,index,'review');
          progress({phase:'review',index,type:'complete',depth:result.moveReview?.depth,
            requestedDepth:before.overview?options.depth:comparisonOptions.depth},jobSignal);
          return result;
        }catch(error){fail(error);throw error;}
        finally {reported.close();}
      }});
    // Attach rejection handling immediately; a root may take much longer than
    // a ready comparison. Its failure cancels this run, not unrelated leases.
    reviews.push(promise.catch(error=>{fail(error);return null;}));
  };
  try {
    const positions=game.positions.map((_,index)=>index).filter(index=>{
      if(isCached(primary.get(index))){accepted.add(index);return false;}
      return true;
    });
    progress({phase:'position',index:null,type:'start'});
    for(let index=1;index<=game.moves.length;index++)scheduleReview(index);
    await pool.map(positions,{
      ...poolOptions,
      run:async(worker,index,_,jobSignal)=>{
        taskSignals.set(`position:${index}`,jobSignal);
        const reported=reportWorker(worker,'position',index,jobSignal);
        progress({phase:'position',index,type:'start'},jobSignal);
        try {
          // A job starts with the same empty transposition table and history on
          // every worker. Assignment order must not seed a different evaluation.
          await reported.worker.reset?.();
          jobSignal.throwIfAborted();
          const result=await reported.worker.analyze(gameAt(game,index),options);
          if(options.searchMode==='depth'&&!result.terminal
            &&(result.searchMode!=='depth'||!result.multipvComplete||result.depth!==options.depth))
            throw new Error('설정한 깊이를 완료하지 않은 국면은 리뷰에 저장할 수 없습니다.');
          return {...result,requestedDepth:options.depth,configKey,overview};
        }catch(error){fail(error);throw error;}
        finally {reported.close();}
      },
      onResult:async(result,_,index)=>{
        try {
          analyzed++;primary.set(index,result);
          await publish(result,index,'position');
          accepted.add(index);
          progress({phase:'position',index,type:'complete',depth:result.depth,requestedDepth:options.depth},taskSignals.get(`position:${index}`));
          taskSignals.delete(`position:${index}`);
          scheduleReview(index);scheduleReview(index+1);
        }catch(error){fail(error);throw error;}
      },
    });
    runSignal.throwIfAborted();beginReviews();
    for(let index=1;index<=game.moves.length;index++)scheduleReview(index);
    await Promise.all(reviews);
    if(failed)throw failure;
    runSignal.throwIfAborted();
    for(let index=1;index<=game.moves.length;index++)if(!hasMoveReview(primary.get(index-1),working.get(index),game.moves[index-1]))
      throw new Error('완료된 원본 국면에 대한 수 검토가 누락되었습니다. 다시 분석해 주세요.');
    return {results:working,analyzed,reviewed};
  }catch(error){
    fail(error);await Promise.all(reviews);throw failure;
  }finally {
    reporting=false;taskSignals.clear();signal?.removeEventListener('abort',onAbort);
    if(!sharedPool)await pool.dispose();
  }
}
