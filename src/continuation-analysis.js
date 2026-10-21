import { positionCommand, uciMove } from './chess-core.js';
import { cloneChess } from './study.js';
import { isPositionResultCached } from './analysis-cache.js';

const noop=()=>{};
const cancelled=()=>new DOMException('Continuation analysis cancelled.','AbortError');
const moveSignature=moves=>moves.map(move=>[move.before,move.uci||uciMove(move),move.after]);

function route(line) {
  return JSON.stringify([positionCommand(line.base),moveSignature(line.prefixMoves),moveSignature(line.steps)]);
}

function freezePolicy(value) {
  if(Array.isArray(value))return Object.freeze(value.map(freezePolicy));
  if(value&&typeof value==='object')return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key,item])=>[key,freezePolicy(item)])));
  return value;
}

function snapshot(spec) {
  const {game,line,pool,options,configKey}=spec;
  if(!game||!line||!(line.results instanceof Map)||!Array.isArray(line.steps)||!Array.isArray(line.prefixMoves)
    ||typeof pool?.submit!=='function'||typeof configKey!=='string'||!configKey
    ||!options||!Number.isInteger(options.depth)||options.depth<1)
    throw new TypeError('A continuation requires a game, line, pool, position policy and configuration key.');
  if(spec.createWorker!==undefined&&typeof spec.createWorker!=='function'
    ||spec.isCached!==undefined&&typeof spec.isCached!=='function'
    ||spec.owns!==undefined&&typeof spec.owns!=='function')
    throw new TypeError('Continuation factories and ownership/cache guards must be functions.');
  const chess=cloneChess(line.base),positions=[cloneChess(chess)];
  if(JSON.stringify(moveSignature(line.prefixMoves))!==JSON.stringify(moveSignature(chess.history({verbose:true}))))
    throw new Error('The continuation prefix does not match its real history.');
  for(const step of line.steps) {
    const token=step.uci||uciMove(step);
    if(chess.isGameOver()||chess.fen()!==step.before)throw new Error('The continuation route does not match its history.');
    const played=chess.move(token);
    if(played.after!==step.after)throw new Error('The continuation route contains an invalid position.');
    positions.push(cloneChess(chess));
  }
  const policy=freezePolicy(options);
  const preferredIndex=spec.preferredIndex??line.cursor;
  if(!Number.isInteger(preferredIndex)||preferredIndex<0||preferredIndex>=positions.length)
    throw new RangeError('The preferred continuation position must belong to its route.');
  const order=[...new Set([Math.max(0,preferredIndex-1),preferredIndex,
    ...positions.map((_,index)=>index)])];
  return Object.freeze({...spec,game,line,pool,results:line.results,options:policy,
    isCached:spec.isCached??isPositionResultCached,owns:spec.owns??(()=>true),
    route:route(line),policy:JSON.stringify(policy),positions:Object.freeze(positions),
    order:Object.freeze(order),positionKeys:Object.freeze(positions.map(positionCommand)),total:positions.length});
}

function matchesRoute(job) {
  try {return job.line.results===job.results&&route(job.line)===job.route;}
  catch {return false;}
}

function completedResult(raw,options) {
  if(!raw||!['cp','mate'].includes(raw.score?.type)||!Number.isFinite(raw.score.value)
    ||!raw.terminal&&(!raw.multipvComplete||!Number.isInteger(raw.depth)||raw.depth<1))
    throw new Error('A completed position evaluation is required for the continuation graph.');
  if(options.searchMode==='depth'&&!raw.terminal
    &&(raw.searchMode!=='depth'||raw.depth!==options.depth))
    throw new Error('The continuation graph cannot store an unfinished depth search.');
  return raw;
}

// A displayed example owns a complete graph job. Its lifetime follows the
// historical route, not the visible cursor, active tab or foreground search.
export class ContinuationAnalysis {
  constructor({onStart=noop,onResult=noop,onComplete=noop,onError=noop,onSettled=noop}={}) {
    this.callbacks={onStart,onResult,onComplete,onError,onSettled};
    if(Object.values(this.callbacks).some(callback=>typeof callback!=='function'))
      throw new TypeError('Continuation callbacks must be functions.');
    this.current=null;
    this.sequence=0;
    this.drain=Promise.resolve();
  }

  get active(){return this.current;}

  stop() {
    const job=this.current;
    if(job){this.current=null;job.abort.abort();}
    return job;
  }

  start(spec) {
    const captured=snapshot(spec),existing=this.current;
    if(existing&&!existing.abort.signal.aborted&&existing.game===captured.game&&existing.line===captured.line
      &&existing.results===captured.results&&existing.pool===captured.pool&&existing.workerKey===captured.workerKey
      &&existing.configKey===captured.configKey&&existing.route===captured.route&&existing.policy===captured.policy)
      return existing.promise;
    this.stop();
    const previous=this.drain;
    const job={...captured,spec:captured,id:++this.sequence,abort:new AbortController(),
      completed:0,analyzed:0,cached:0,status:'waiting'};
    this.current=job;
    const active=()=>this.current===job&&!job.abort.signal.aborted&&matchesRoute(job)&&job.owns(job);
    const check=()=>{
      if(!active()){job.abort.abort();throw cancelled();}
    };
    const pending=(async()=>{
      try {
        // Cancelling this sequential lease must finish its own disposal before
        // a replacement starts. The shared pool and other reviews stay alive.
        await previous;
        check();job.status='running';
        await this.callbacks.onStart(job);
        check();
        for(const index of job.order) {
          check();
          const existing=job.results.get(index),key=job.positionKeys[index];
          if(job.isCached(existing,job.configKey,index)
            &&(!existing?.continuationPosition||existing.continuationPosition===key)) {
            job.cached++;job.completed++;continue;
          }
          const result=await job.pool.submit({priority:1,signal:job.abort.signal,workerKey:job.workerKey,
            ...(job.createWorker?{createWorker:job.createWorker}:{}),
            run:async(worker,signal)=>{
              check();signal.throwIfAborted();
              await worker.reset?.();
              check();signal.throwIfAborted();
              const raw=await worker.analyze(cloneChess(job.positions[index]),job.options);
              check();signal.throwIfAborted();
              return {...completedResult(raw,job.options),requestedDepth:job.options.depth,configKey:job.configKey,
                overview:false,continuationPosition:key};
            }});
          check();
          // A normal foreground calculation may have completed this same
          // position while it was queued. Preserve its richer move review.
          const current=job.results.get(index);
          if(!(job.isCached(current,job.configKey,index)
            &&(!current?.continuationPosition||current.continuationPosition===key)))job.results.set(index,result);
          job.analyzed++;job.completed++;
          await this.callbacks.onResult(job,job.results.get(index),index);
        }
        check();job.status='complete';
        const outcome={line:job.line,results:job.results,analyzed:job.analyzed,cached:job.cached,
          completed:job.completed,total:job.total};
        await this.callbacks.onComplete(job,outcome);
        return outcome;
      }catch(error) {
        if(job.abort.signal.aborted||this.current!==job||!matchesRoute(job)||!job.owns(job)) {
          job.abort.abort();return null;
        }
        job.error=error;job.status='error';
        await this.callbacks.onError(job,error);
        return null;
      }finally {
        if(job.abort.signal.aborted)job.status='cancelled';
        if(this.current===job)this.current=null;
        await this.callbacks.onSettled(job);
      }
    })();
    job.promise=pending;
    this.drain=pending.catch(noop);
    return pending;
  }
}
