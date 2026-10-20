import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, gameAt, parseGame, sacrificeCandidates, uciMove } from '../src/chess-core.js';
import { insightIdentity } from '../src/insight.js';
import { ExplanationSearch, explanationOptions } from '../src/explanation-search.js';

const cp=value=>({type:'cp',value});
const engineKey='Stockfish19/full/hash32/thread1';
const options=explanationOptions(16,16);
function legalPv(position,count=3,first) {
  const chess=new Chess(position.fen()),pv=[];
  if(first){chess.move(first);pv.push(first);}
  while(pv.length<count&&!chess.isGameOver()) {
    const move=chess.moves({verbose:true})[0];if(!move)break;
    const uci=uciMove(move);chess.move(uci);pv.push(uci);
  }
  return pv;
}
function result(position,depth,changes={}) {
  const pv=legalPv(position),score=cp(30);
  return {score,depth,bestmove:pv[0],multipvComplete:true,
    lines:[{multipv:1,score:{...score},depth,pv}],...changes};
}
function context(pgn='1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 *') {
  const game=parseGame(pgn),index=game.moves.length,move=game.moves[index-1];
  const pv=legalPv(gameAt(game,index));
  const before={score:cp(25),depth:16,bestmove:uciMove(move),configKey:'primary-v4',multipvComplete:true,
    lines:[{multipv:1,score:cp(25),depth:16,pv:[uciMove(move),...pv]}]};
  const after={score:cp(20),depth:16,bestmove:pv[0],configKey:'primary-v4',multipvComplete:true,
    lines:[{multipv:1,score:cp(20),depth:16,pv}],
    moveReview:{version:1,fen:move.before,uci:uciMove(move),configKey:before.configKey,
      beforeScore:{...before.score},beforeDepth:before.depth,beforeBestmove:before.bestmove,
      score:cp(25),depth:16,pv:[uciMove(move),...pv],source:'best'}};
  return {game,index,before,after,insight:{}};
}
function sacrificeContext() {
  const value=context('[SetUp "1"]\n[FEN "2r4k/6q1/8/8/8/2N5/2B5/K4R2 b - - 0 29"]\n\n29... Qf8 30. Nd5 *');
  const {game,index,before,after}=value,move=game.moves[index-1];
  const captures=[...new Set(sacrificeCandidates(move).flatMap(offer=>offer.captures))].sort();
  const capture='f8f1',pv=legalPv(gameAt(game,index),3,capture);
  after.moveReview.sacrificeReview={version:1,fen:move.after,rootFen:move.before,uci:uciMove(move),
    configKey:before.configKey,requestedDepth:15,restrictedMoves:captures,status:'verified',
    branches:[{capture,score:cp(15),depth:16,pv,multipvComplete:true,verified:true,status:'verified',source:'search',bestResponse:false}]};
  return value;
}
function immediate(calls=[]) {
  return {searchGeneration:0,async analyze(position,settings){calls.push({fen:position.fen(),history:position.history(),settings});return result(position,settings.depth);}};
}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('adaptive explanation goals and budgets honor both selected depth and explicit total time',()=>{
  for(const [selected,depth,movetime,extensionTime] of [[12,18,800,0],[16,18,1500,1000],[20,22,2500,1500],[24,26,4000,2000]]) {
    assert.deepEqual(explanationOptions(selected,0),{depth,movetime,extensionTime,multipv:1,hash:32,threads:1});
  }
  assert.equal(explanationOptions(12,24).depth,26);
  assert.deepEqual(explanationOptions(16,16,{movetime:1800,hash:64,threads:2}),
    {depth:18,movetime:1500,extensionTime:300,multipv:1,hash:64,threads:2});
  assert.equal(explanationOptions(16,16,{movetime:500}).movetime,500);
  assert.equal(explanationOptions(16,16,{movetime:500}).extensionTime,0);
  assert.equal(explanationOptions(24,24,{movetime:30000}).extensionTime,2000);
});

test('response and alternative searches preserve the real game history and keep all primary data unchanged',async()=>{
  const source=context(),original=JSON.stringify(source),calls=[],engine=immediate(calls),search=new ExplanationSearch();
  const response=await search.refine(engine,source,'response',options,engineKey);
  const alternative=await search.refine(engine,source,'alternative',options,engineKey);
  assert.deepEqual(calls[0].history,['Nf3','Nf6','Ng1','Ng8','Nf3']);
  assert.deepEqual(calls[1].history,['Nf3','Nf6','Ng1','Ng8']);
  assert.equal(calls[0].fen,source.game.moves.at(-1).after);
  assert.equal(calls[1].fen,source.game.moves.at(-1).before);
  assert.equal(calls[0].settings.multipv,1);assert.equal('extensionTime' in calls[0].settings,false);
  assert.equal(response.explanationIdentity,insightIdentity(source,'response'));
  assert.notEqual(response.explanationIdentity,alternative.explanationIdentity);
  assert.equal(response.goalReached,true);assert.equal(response.attempts.length,1);
  assert.equal(response.totalBudget,2500);assert.equal(response.movetimeTotal,1500);
  assert.equal(JSON.stringify(source),original);
  assert.ok(Object.isFrozen(response.lines[0].pv));
  assert.throws(()=>{response.score.value=900;},TypeError);
});

test('sacrifice search restricts all validated offered captures, not just the displayed example',async()=>{
  const source=sacrificeContext(),calls=[],search=new ExplanationSearch();
  assert.deepEqual(source.after.moveReview.sacrificeReview.restrictedMoves,['c8c2','f8f1']);
  const engine={async analyze(position,settings){calls.push({history:position.history(),settings});
    const raw=result(position,settings.depth),pv=legalPv(position,3,settings.searchMoves[0]);
    return {...raw,bestmove:pv[0],lines:[{...raw.lines[0],pv}]};}};
  const value=await search.refine(engine,source,'sacrifice',options,engineKey);
  assert.deepEqual(calls[0].settings.searchMoves,['c8c2','f8f1']);
  assert.deepEqual(calls[0].history,['Qf8','Nd5']);
  assert.deepEqual(value.searchGoal.restrictedMoves,['c8c2','f8f1']);
  assert.equal(value.bestmove,'c8c2');
  delete source.after.moveReview.sacrificeReview;
  await assert.rejects(search.refine(engine,source,'sacrifice',options,engineKey),/검증된 희생/);
});

test('completed snapshots are cached with engine, policy, options and original review identity',async()=>{
  const source=context(),search=new ExplanationSearch(),calls=[],engine=immediate(calls);
  const first=await search.refine(engine,source,'response',options,engineKey);
  assert.equal(search.get(source,'response',options,engineKey),first);
  assert.equal(await search.refine(engine,source,'response',options,engineKey),first);assert.equal(calls.length,1);
  for(const [changed,key] of [[{...options,movetime:1499},engineKey],[{...options,extensionTime:999},engineKey],
    [{...options,depth:20},engineKey],[{...options,hash:64},engineKey],[{...options,threads:2},engineKey],[options,'other-engine']]) {
    assert.equal(search.get(source,'response',changed,key),null);
  }
  source.before.score=cp(24);source.after.moveReview.beforeScore=cp(24);
  assert.equal(search.get(source,'response',options,engineKey),null);
});

test('identical FENs with different repetition histories do not share an explanation cache',async()=>{
  const long=context(),move=long.game.moves.at(-1);
  const short=context(`[SetUp "1"]\n[FEN "${move.before}"]\n\n3. Nf3 *`);
  assert.equal(long.game.moves.at(-1).after,short.game.moves.at(-1).after);
  const search=new ExplanationSearch(),calls=[],engine=immediate(calls);
  await search.refine(engine,long,'response',options,engineKey);
  assert.equal(search.get(short,'response',options,engineKey),null);
  await search.refine(engine,short,'response',options,engineKey);assert.equal(calls.length,2);
});

test('LRU cache remains bounded and a hit preserves the recently used entry',async()=>{
  const search=new ExplanationSearch({limit:2}),source=context(),engine=immediate();
  await search.refine(engine,source,'response',options,'a');
  await search.refine(engine,source,'response',options,'b');
  assert.ok(search.get(source,'response',options,'a'));
  await search.refine(engine,source,'response',options,'c');
  assert.equal(search.get(source,'response',options,'b'),null);
  assert.ok(search.get(source,'response',options,'a'));assert.ok(search.get(source,'response',options,'c'));
  assert.equal(new ExplanationSearch({limit:100}).limit,64);
});

test('same in-flight request shares its promise while distinct concurrent requests are rejected',async()=>{
  const wait=deferred(),source=context(),search=new ExplanationSearch();let position,calls=0;
  const engine={searchGeneration:0,analyze(chess){position=chess;calls++;return wait.promise;}};
  const first=search.refine(engine,source,'response',options,engineKey);
  assert.equal(search.refine(engine,source,'response',options,engineKey),first);
  await assert.rejects(search.refine(engine,source,'alternative',options,engineKey),error=>error.code==='EXPLANATION_BUSY');
  assert.equal(calls,1);wait.resolve(result(position,18));await first;
  assert.equal(search.pending,null);
});

test('external engine cancellation allows a new request and never caches the obsolete result',async()=>{
  const waits=[deferred(),deferred()],positions=[],source=context(),search=new ExplanationSearch();
  const engine={searchGeneration:0,analyze(chess){positions.push(chess);return waits[positions.length-1].promise;}};
  const first=search.refine(engine,source,'response',options,engineKey);await Promise.resolve();
  const cancelled=assert.rejects(first,error=>error.name==='AbortError');
  engine.searchGeneration++;
  const next=search.refine(engine,source,'alternative',options,engineKey);await Promise.resolve();
  waits[0].resolve(result(positions[0],18));await cancelled;
  assert.equal(search.get(source,'response',options,engineKey),null);
  assert.notEqual(search.pending,null,'an older finally cannot clear the replacement job');
  waits[1].resolve(result(positions[1],18));await next;
  assert.ok(search.get(source,'alternative',options,engineKey));
});

test('a source evaluation change while searching rejects the result and permits a later retry',async()=>{
  const wait=deferred(),source=context(),search=new ExplanationSearch();let position;
  const engine={analyze(chess){position=chess;return wait.promise;}};
  const pending=search.refine(engine,source,'response',options,engineKey);await Promise.resolve();
  source.before.depth++;source.after.moveReview.beforeDepth++;
  wait.resolve(result(position,18));await assert.rejects(pending,/원본 평가/);
  assert.equal(search.cache.size,0);
  await search.refine(immediate(),source,'response',options,engineKey);
});

test('incomplete, bound, mismatched and illegal trailing PV results never enter the cache',async()=>{
  const changes=[raw=>({...raw,multipvComplete:false}),raw=>({...raw,lowerbound:true}),
    raw=>({...raw,score:{...raw.score,upperbound:true}}),raw=>({...raw,bestmove:'h7h6'}),
    raw=>({...raw,lines:[{...raw.lines[0],depth:17}]}),raw=>({...raw,lines:[{...raw.lines[0],score:cp(999)}]}),
    raw=>({...raw,lines:[{...raw.lines[0],pv:[...raw.lines[0].pv,'a1a8']}]}),
    raw=>({...raw,bestmove:'a6',lines:[{...raw.lines[0],pv:['a6']}]}),
    raw=>({...raw,lines:[{...raw.lines[0],multipv:2}]})];
  for(const change of changes) {
    const source=context(),search=new ExplanationSearch();
    const engine={async analyze(position){return change(result(position,18));}};
    await assert.rejects(search.refine(engine,source,'response',options,engineKey));
    assert.equal(search.get(source,'response',options,engineKey),null);assert.equal(search.pending,null);
  }
});

test('an initial engine failure leaves no cached snapshot and does not block a later retry',async()=>{
  const source=context(),search=new ExplanationSearch();let calls=0;
  const engine={async analyze(position){calls++;if(calls===1)throw new Error('worker failure');return result(position,18);}};
  await assert.rejects(search.refine(engine,source,'response',options,engineKey),/worker failure/);
  assert.equal(search.cache.size,0);assert.equal(search.pending,null);
  assert.equal((await search.refine(engine,source,'response',options,engineKey)).depth,18);
  assert.equal(calls,2);
});

test('only a depth-limited first snapshot triggers one warm extension and the deeper result wins',async()=>{
  const source=context(),search=new ExplanationSearch(),calls=[];
  const engine={async analyze(position,settings){calls.push({history:position.history(),settings});return result(position,calls.length===1?17:18,{score:cp(calls.length===1?345:448),lines:[{multipv:1,score:cp(calls.length===1?345:448),depth:calls.length===1?17:18,pv:legalPv(position)}]});}};
  const value=await search.refine(engine,source,'response',options,engineKey);
  assert.deepEqual(calls.map(call=>call.settings.movetime),[1500,1000]);
  assert.deepEqual(calls[0].history,calls[1].history);
  assert.equal(value.depth,18);assert.equal(value.score.value,448);assert.equal(value.lines[0].score.value,448);
  assert.equal(value.attempts.length,2);assert.equal(value.movetimeTotal,2500);assert.equal(value.goalReached,true);
  assert.equal(await search.refine(engine,source,'response',options,engineKey),value);assert.equal(calls.length,2);
});

test('invalid or shallower extensions preserve the complete first snapshot',async()=>{
  for(const failure of ['incomplete','shallower','error']) {
    const source=context(),search=new ExplanationSearch();let calls=0;
    const engine={async analyze(position){calls++;if(calls===1)return result(position,17);
      if(failure==='error')throw new Error('temporary extension failure');
      return result(position,16,{multipvComplete:failure!=='incomplete'});}};
    const value=await search.refine(engine,source,'response',options,engineKey);
    assert.equal(value.depth,17);assert.equal(value.goalReached,false);assert.equal(value.attempts.length,2);
    assert.equal(value.attempts[1].valid,failure==='shallower');assert.equal(calls,2);
  }
});

test('abort during extension discards even a valid first snapshot',async()=>{
  const source=context(),search=new ExplanationSearch();let calls=0;
  const engine={async analyze(position){calls++;if(calls===1)return result(position,17);throw new DOMException('cancel','AbortError');}};
  await assert.rejects(search.refine(engine,source,'response',options,engineKey),error=>error.name==='AbortError');
  assert.equal(search.cache.size,0);assert.equal(search.pending,null);assert.equal(calls,2);
});

test('explicit time limits prevent extensions and child depth is compared after the played ply',async()=>{
  const source=context(),search=new ExplanationSearch(),limited=explanationOptions(16,16,{movetime:500});let calls=0;
  const engine={async analyze(position){calls++;return result(position,15);}};
  const value=await search.refine(engine,source,'response',limited,engineKey);
  assert.equal(value.depth,source.after.moveReview.depth-1);assert.equal(value.goalReached,false);
  assert.equal(value.attempts.length,1);assert.equal(value.totalBudget,500);
  await assert.rejects(search.refine(engine,source,'alternative',limited,engineKey),error=>error.code==='EXPLANATION_DEPTH_LIMITED'&&error.minimumDepth===16);
  assert.equal(search.get(source,'alternative',limited,engineKey),null);assert.equal(calls,2);
});

test('a proven terminal PV does not consume an unnecessary extension',async()=>{
  const source=context('[SetUp "1"]\n[FEN "7k/8/5KQ1/8/8/8/8/8 w - - 0 30"]\n\n30. Qg7# *');
  const search=new ExplanationSearch();let calls=0;
  const engine={async analyze(){calls++;const score={type:'mate',value:1,winner:'w'};
    return {score,depth:17,bestmove:'g6g7',multipvComplete:true,lines:[{multipv:1,score:{...score},depth:17,pv:['g6g7']}]};}};
  const value=await search.refine(engine,source,'alternative',options,engineKey);
  assert.equal(value.attempts.length,1);assert.equal(value.goalReached,false);assert.equal(calls,1);
});

test('a terminal PV contradicting its score cannot skip the adaptive extension',async()=>{
  const source=context('[SetUp "1"]\n[FEN "7k/8/5KQ1/8/8/8/8/8 w - - 0 30"]\n\n30. Qg7# *');
  for(const firstScore of [cp(30),{type:'mate',value:-1,winner:'b'}]) {
    const search=new ExplanationSearch();let calls=0;
    const engine={async analyze(){calls++;const score=calls===1?firstScore:{type:'mate',value:1,winner:'w'},depth=calls===1?17:18;
      return {score,depth,bestmove:'g6g7',multipvComplete:true,lines:[{multipv:1,score:{...score},depth,pv:['g6g7']}]};}};
    const value=await search.refine(engine,source,'alternative',options,engineKey);
    assert.equal(calls,2);assert.equal(value.goalReached,true);assert.equal(value.score.winner,'w');
  }
});
