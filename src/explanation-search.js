import { assessedMoveResult, gameAt, reviewedSacrificeEvidence, sacrificeCandidates } from './chess-core.js';
import { insightIdentity } from './insight.js';

const POLICY = 'explanation-search-v1';
const BUDGETS = {12:800,16:1500,20:2500,24:4000};
const EXTENSIONS = {12:0,16:1000,20:1500,24:2000};
const abortError = () => new DOMException('설명 분석이 취소되었습니다.','AbortError');

export function explanationOptions(selectedDepth=16,sourceDepth=0,performance={}) {
  const selected=Object.hasOwn(BUDGETS,selectedDepth)?Number(selectedDepth):16;
  const source=Number.isInteger(sourceDepth)&&sourceDepth>0?sourceDepth:0;
  const explicit=Number.isFinite(performance.movetime)&&performance.movetime>0?performance.movetime:Infinity;
  const movetime=Math.min(BUDGETS[selected],explicit);
  const extensionTime=Math.min(EXTENSIONS[selected],Math.max(0,explicit-movetime));
  return {depth:Math.min(26,Math.max(18,selected+2,source+2)),movetime,extensionTime,
    multipv:1,hash:performance.hash||32,threads:performance.threads||1};
}

function settings(options) {
  const value={depth:options?.depth,movetime:options?.movetime,multipv:options?.multipv,
    extensionTime:options?.extensionTime??0,hash:options?.hash??32,threads:options?.threads??1};
  if (!Number.isInteger(value.depth)||value.depth<1||value.depth>26
    || !Number.isFinite(value.movetime)||value.movetime<=0||value.multipv!==1
    || !Number.isFinite(value.extensionTime)||value.extensionTime<0
    || !Number.isInteger(value.hash)||value.hash<1||!Number.isInteger(value.threads)||value.threads<1) {
    throw new Error('설명 분석에는 유효한 깊이, 시간 제한과 단일 후보 설정이 필요합니다.');
  }
  return value;
}

function request(context,kind,options,engineKey) {
  const identity=insightIdentity(context,kind);
  if (!identity||typeof engineKey!=='string'||!engineKey) throw new Error('설명 분석의 원본 국면이나 엔진이 일치하지 않습니다.');
  const {game,index}=context,move=game.moves[index-1],configuration=settings(options);
  const position=gameAt(game,kind==='alternative'?index-1:index);
  if (position.fen()!==(kind==='alternative'?move.before:move.after)) throw new Error('설명 분석의 시작 국면이 일치하지 않습니다.');
  const proof=kind==='sacrifice'?reviewedSacrificeEvidence(context.before,context.after,move):null;
  if (kind==='sacrifice'&&!proof) throw new Error('원본 분석에서 검증된 희생 수락 예시가 없습니다.');
  const restrictedMoves=kind==='sacrifice'?[...new Set(sacrificeCandidates(move).flatMap(offer=>offer.captures))].sort():[];
  if (kind==='sacrifice'&&!restrictedMoves.length) throw new Error('설명할 합법적인 희생 수락이 없습니다.');
  const sourceDepth=kind==='alternative'?context.before.depth:kind==='sacrifice'
    ? proof.branch.depth
    : assessedMoveResult(context.before,context.after,move).depth-1;
  const minimumDepth=Number.isInteger(sourceDepth)?Math.max(1,sourceDepth):1;
  return {identity,position,configuration,restrictedMoves,minimumDepth,
    key:JSON.stringify([POLICY,engineKey,identity,configuration,restrictedMoves])};
}

function bounded(value) {
  return !!(value?.lowerbound||value?.upperbound||value?.lowerBound||value?.upperBound
    || value?.bound&&value.bound!=='exact');
}

function validScore(score) {
  return ['cp','mate'].includes(score?.type)&&Number.isFinite(score.value)&&!bounded(score)
    && (score.type!=='mate'||Number.isInteger(score.value)&&['w','b'].includes(score.winner));
}

function sameScore(a,b) {
  return a.type===b.type&&a.value===b.value&&(a.winner??null)===(b.winner??null);
}

function snapshot(raw,job,elapsedMs) {
  const line=raw?.lines?.[0];
  if (raw?.multipvComplete!==true||bounded(raw)||!Number.isInteger(raw.depth)||raw.depth<1
    || !validScore(raw.score)||!Array.isArray(raw.lines)||raw.lines.length!==1
    || !line||line.multipv!==1||line.depth!==raw.depth||bounded(line)||!validScore(line.score)
    || !sameScore(raw.score,line.score)||!Array.isArray(line.pv)||!line.pv.length
    || line.pv.some(move=>typeof move!=='string'||!/^[a-h][1-8][a-h][1-8][nbrq]?$/.test(move))
    || line.pv[0]!==raw.bestmove||job.restrictedMoves.length&&!job.restrictedMoves.includes(raw.bestmove)) {
    throw new Error('완료된 설명 분석과 일치하는 평가 및 수순을 얻지 못했습니다.');
  }
  // Validate every move, not just the first move of a potentially stale PV.
  const chess=gameAt(job.context.game,job.kind==='alternative'?job.context.index-1:job.context.index);
  try { for (const move of line.pv) chess.move(move); }
  catch { throw new Error('설명 분석에 합법적이지 않은 수순이 포함되어 있습니다.'); }
  const score=Object.freeze({...raw.score});
  const lines=Object.freeze([Object.freeze({...line,score:Object.freeze({...line.score}),pv:Object.freeze([...line.pv])})]);
  const totalBudget=job.configuration.movetime+job.configuration.extensionTime;
  const searchGoal=Object.freeze({...job.configuration,totalBudget,restrictedMoves:Object.freeze([...job.restrictedMoves])});
  return Object.freeze({...raw,score,lines,explanationIdentity:job.identity,searchGoal,
    budget:totalBudget,totalBudget,elapsedMs:Math.max(0,Math.round(elapsedMs)),
    goalReached:raw.depth>=job.configuration.depth});
}

function provenTerminal(result,job) {
  const chess=gameAt(job.context.game,job.kind==='alternative'?job.context.index-1:job.context.index);
  for (const move of result.lines[0].pv) chess.move(move);
  if (chess.isCheckmate()) return result.score.type==='mate'&&result.score.winner===(chess.turn()==='w'?'b':'w');
  return chess.isDraw()&&result.score.type==='cp'&&result.score.value===0;
}

// App scheduling owns the worker and cancellation. This cache never changes a
// primary position result, grade, or an already-open playback sequence.
export class ExplanationSearch {
  constructor({limit=64}={}) {
    this.limit=Number.isInteger(limit)?Math.max(1,Math.min(64,limit)):64;
    this.cache=new Map();
    this.pending=null;
  }
  get(context,kind,options,engineKey) {
    let key;
    try { ({key}=request(context,kind,options,engineKey)); } catch { return null; }
    const value=this.cache.get(key);
    if (!value) return null;
    this.cache.delete(key);this.cache.set(key,value);
    return value;
  }
  refine(engine,context,kind,options,engineKey) {
    let job;
    try {
      job={...request(context,kind,options,engineKey),context,kind,engine,generation:engine?.searchGeneration};
      if (!engine?.analyze||engine.closed) throw new Error('설명 분석 엔진을 사용할 수 없습니다.');
    } catch (error) { return Promise.reject(error); }
    const cached=this.cache.get(job.key);
    if (cached) {
      this.cache.delete(job.key);this.cache.set(job.key,cached);
      return Promise.resolve(cached);
    }
    const current=this.pending;
    const cancelled=current&&(current.engine.closed||current.engine.searchGeneration!==current.generation);
    if (current&&!cancelled) {
      if (current.key===job.key) return current.promise;
      const error=new Error('다른 설명 분석이 진행 중입니다.');error.code='EXPLANATION_BUSY';
      return Promise.reject(error);
    }
    this.pending=job;
    job.promise=Promise.resolve().then(async()=>{
      if (engine.closed||engine.searchGeneration!==job.generation) throw abortError();
      const started=performance.now();
      const attempts=[];
      const run=async movetime=>{
        const at=performance.now(),{extensionTime,...configuration}=job.configuration;
        try {
          const position=gameAt(context.game,kind==='alternative'?context.index-1:context.index);
          const raw=await engine.analyze(position,{...configuration,movetime,
            ...(job.restrictedMoves.length?{searchMoves:[...job.restrictedMoves]}:{})});
          if (engine.closed||engine.searchGeneration!==job.generation) throw abortError();
          const result=snapshot(raw,job,performance.now()-started);
          attempts.push({movetime,elapsedMs:Math.max(0,Math.round(performance.now()-at)),depth:result.depth,valid:true});
          return result;
        } catch(error) {
          attempts.push({movetime,elapsedMs:Math.max(0,Math.round(performance.now()-at)),valid:false,errorCode:error.code||error.name});
          throw error;
        }
      };
      let candidate=await run(job.configuration.movetime);
      if (!candidate.goalReached&&job.configuration.extensionTime>0&&!provenTerminal(candidate,job)) {
        try {
          const extra=await run(job.configuration.extensionTime);
          if (extra.depth>candidate.depth)candidate=extra;
        } catch(error) {
          if (error.name==='AbortError'||engine.closed||engine.searchGeneration!==job.generation)throw error;
          // A complete first iteration remains useful if the bounded extension
          // fails or provides a partial/invalid result. Never replace it.
        }
      }
      if (insightIdentity(context,kind)!==job.identity) throw new Error('설명 분석 중 원본 평가가 변경되었습니다.');
      if (candidate.depth<job.minimumDepth) {
        const error=new Error('제한 시간 안에 기존 설명의 분석 깊이에 도달하지 못했습니다.');
        error.code='EXPLANATION_DEPTH_LIMITED';error.achievedDepth=candidate.depth;error.minimumDepth=job.minimumDepth;
        throw error;
      }
      const result=Object.freeze({...candidate,attempts:Object.freeze(attempts.map(value=>Object.freeze(value))),
        movetimeTotal:attempts.reduce((sum,value)=>sum+value.movetime,0),elapsedMs:Math.max(0,Math.round(performance.now()-started))});
      this.cache.set(job.key,result);
      while(this.cache.size>this.limit)this.cache.delete(this.cache.keys().next().value);
      return result;
    }).finally(()=>{if(this.pending===job)this.pending=null;});
    return job.promise;
  }
}
