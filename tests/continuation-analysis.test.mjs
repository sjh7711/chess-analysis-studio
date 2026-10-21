import test from 'node:test';
import assert from 'node:assert/strict';
import { ContinuationAnalysis } from '../src/continuation-analysis.js';
import { ReviewWorkerPool } from '../src/review-pool.js';
import { Chess, gameAt, parseGame, positionCommand, terminalResult, uciMove } from '../src/chess-core.js';
import { AnalysisLine } from '../src/study.js';

const turn=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function until(predicate) {for(let count=0;count<50;count++){if(predicate())return;await turn();}assert.fail('Expected asynchronous state was not reached');}
const options={depth:16,searchMode:'depth',multipv:3,hash:32,threads:1};
const result=(chess,settings,value=30)=>{
  if(chess.isGameOver())return terminalResult(chess);
  const pv=[uciMove(chess.moves({verbose:true})[0])],score={type:'cp',value};
  return {score,depth:settings.depth,searchMode:'depth',multipvComplete:true,bestmove:pv[0],
    lines:[{score,depth:settings.depth,multipv:1,pv}]};
};

function fixture({moves=['e2e4','e7e5','g1f3'],gates=[],concurrency=1,createResult=result,callbacks={}}={}) {
  const game=parseGame('1. a3 a6 *'),line=new AnalysisLine(gameAt(game,2),moves),calls=[],workers=[];
  const pool=new ReviewWorkerPool({concurrency,createWorker:index=>{
    const worker={index,cancelled:0,disposed:0,resets:0,
      reset(){this.resets++;},cancel(){this.cancelled++;},dispose(){this.disposed++;},
      async analyze(chess,settings){const call={chess,settings,position:positionCommand(chess),worker};calls.push(call);
        const gate=gates[calls.length-1];if(gate)await gate.promise;
        return createResult(chess,settings,30+calls.indexOf(call));}};
    workers.push(worker);return worker;
  }});
  const analysis=new ContinuationAnalysis(callbacks),spec={game,line,pool,workerKey:'lite:32:1',options:{...options},configKey:'position:16'};
  return {game,line,pool,calls,workers,analysis,spec};
}

test('the entire route finishes while its cursor and visible tab move elsewhere',async()=>{
  const gate=deferred(),events=[],f=fixture({gates:[gate],callbacks:{onResult:(job,_,index)=>events.push(index)}});
  const steps=JSON.stringify(f.line.steps),original=JSON.stringify(f.game),originalResults=new Map([[2,{score:999}]]);
  f.line.sourceScore={type:'cp',value:999};
  f.line.results.set(0,{score:{type:'cp',value:999},configKey:'original-game',depth:16});
  try {
    const pending=f.analysis.start(f.spec),job=f.analysis.active;
    await until(()=>f.calls.length===1);
    f.line.seek(3);const visible={tab:'moves'};f.line.seek(1);visible.tab='review';
    gate.resolve();const outcome=await pending;
    assert.equal(outcome.completed,4);assert.equal(outcome.analyzed,4);assert.equal(job.total,4);
    assert.equal(job.status,'complete');assert.equal(f.analysis.active,null);
    assert.deepEqual(events,[0,1,2,3]);assert.equal(f.line.cursor,1);assert.equal(visible.tab,'review');
    assert.equal(JSON.stringify(f.line.steps),steps);assert.equal(JSON.stringify(f.game),original);
    assert.deepEqual([...originalResults],[[2,{score:999}]]);assert.equal(f.line.sourceScore.value,999);
    assert.equal(f.line.results.get(0).score.value,30);
    assert.ok(f.calls.every(call=>call.settings.depth===16&&call.position.includes('a2a3 a7a6')));
    assert.ok(f.workers.every(worker=>worker.resets>=1));
    assert.ok([...f.line.results.values()].every(value=>value.configKey==='position:16'&&value.continuationPosition));
  }finally {await f.pool.dispose();}
});

test('equivalent starts reuse the active promise and capture an immutable search policy',async()=>{
  const gate=deferred(),f=fixture({gates:[gate]});
  try {
    f.spec.options.nested={searchMoves:['e2e4']};
    const pending=f.analysis.start(f.spec),job=f.analysis.active;
    const again=f.analysis.start({...f.spec,options:{...f.spec.options,nested:{searchMoves:['e2e4']}}});
    assert.equal(again,pending);assert.equal(f.analysis.active,job);
    f.spec.options.depth=24;f.spec.options.nested.searchMoves.push('d2d4');
    f.line.seek(2);gate.resolve();await pending;
    assert.ok(f.calls.every(call=>call.settings.depth===16));
    assert.deepEqual(job.options.nested.searchMoves,['e2e4']);assert.ok(Object.isFrozen(job.options.nested.searchMoves));
    assert.equal(f.calls.length,4);
  }finally {await f.pool.dispose();}
});

test('a new sweep evaluates the selected parent and position first without making later cursor changes restart it',async()=>{
  const gate=deferred(),f=fixture({moves:['e2e4','e7e5','g1f3','b8c6','f1b5','g8f6'],gates:[gate]});
  try {
    f.line.seek(5);
    const expected=[4,5,0,1,2,3,6].map(index=>positionCommand(f.line.position(index)));
    const pending=f.analysis.start(f.spec);await until(()=>f.calls.length===1);
    assert.equal(f.calls[0].position,expected[0]);
    f.line.seek(1);
    assert.equal(f.analysis.start({...f.spec,preferredIndex:1}),pending);
    gate.resolve();await pending;
    assert.deepEqual(f.calls.map(call=>call.position),expected);assert.equal(f.line.cursor,1);
  }finally {gate.resolve();await f.pool.dispose();}
});

test('manual divergence rejects a late old suffix and reuses valid unchanged prefix evaluations',async()=>{
  const gate=deferred(),publications=[],f=fixture({gates:[null,null,gate],callbacks:{onResult:(job,_,index)=>publications.push([job.id,index])}});
  try {
    const first=f.analysis.start(f.spec),firstJob=f.analysis.active;
    await until(()=>f.calls.length===3);
    const root=f.line.results.get(0),prefix=f.line.results.get(1);
    f.line.seek(1);f.line.play('c7c5');
    const second=f.analysis.start(f.spec),secondJob=f.analysis.active;
    assert.notEqual(firstJob,secondJob);assert.ok(firstJob.abort.signal.aborted);
    gate.resolve();assert.equal(await first,null);
    const outcome=await second;
    assert.equal(firstJob.status,'cancelled');assert.equal(outcome.cached,2);assert.equal(outcome.analyzed,1);
    assert.equal(f.line.results.get(0),root);assert.equal(f.line.results.get(1),prefix);
    assert.match(f.line.results.get(2).continuationPosition,/e2e4 c7c5$/);
    assert.deepEqual(publications.filter(([id])=>id===firstJob.id),[[firstJob.id,0],[firstJob.id,1]]);
    assert.equal(f.line.cursor,2);assert.deepEqual(f.line.steps.map(step=>step.uci),['e2e4','c7c5']);
    assert.equal(f.calls.length,4);
  }finally {await f.pool.dispose();}
});

test('an unannounced route change automatically suppresses its in-flight result and completion',async()=>{
  const gate=deferred(),events=[],f=fixture({gates:[gate],callbacks:{onResult:()=>events.push('result'),
    onComplete:()=>events.push('complete'),onError:()=>events.push('error'),onSettled:job=>events.push(job.status)}});
  try {
    const pending=f.analysis.start(f.spec),job=f.analysis.active;
    await until(()=>f.calls.length===1);f.line.seek(0);f.line.play('d2d4');gate.resolve();
    assert.equal(await pending,null);assert.equal(f.line.results.size,0);
    assert.equal(job.status,'cancelled');assert.deepEqual(events,['cancelled']);
  }finally {await f.pool.dispose();}
});

test('a replacement full line waits for the previous owned lease without cancelling unrelated shared work',async()=>{
  const oldGate=deferred(),unrelatedGate=deferred(),f=fixture({gates:[oldGate],concurrency:2});
  try {
    const unrelated=f.pool.submit({priority:0,run:async()=>{await unrelatedGate.promise;return 'original review';}});
    const first=f.analysis.start(f.spec);
    await until(()=>f.calls.length===1);
    const replacement=new AnalysisLine(gameAt(f.game,2),['d2d4','d7d5']);
    const second=f.analysis.start({...f.spec,line:replacement}),job=f.analysis.active;
    await turn();assert.equal(job.status,'waiting');assert.equal(f.pool.closed,false);
    oldGate.resolve();assert.equal(await first,null);await second;
    assert.equal(f.line.results.size,0);assert.equal(replacement.results.size,3);
    assert.equal(f.pool.closed,false);assert.equal(f.pool.running,1);
    unrelatedGate.resolve();assert.equal(await unrelated,'original review');
    assert.equal(f.workers.filter(worker=>worker.cancelled).length,1);
  }finally {unrelatedGate.resolve();oldGate.resolve();await f.pool.dispose();}
});

test('changed settings invalidate previous evaluations and never publish the older search',async()=>{
  const gate=deferred(),f=fixture({gates:[gate]});
  try {
    const first=f.analysis.start(f.spec);await until(()=>f.calls.length===1);
    const second=f.analysis.start({...f.spec,options:{...options,depth:20},configKey:'position:20'});
    gate.resolve();assert.equal(await first,null);await second;
    assert.ok([...f.line.results.values()].every(value=>value.configKey==='position:20'&&value.depth===20));
    assert.equal(f.calls.length,5);
  }finally {await f.pool.dispose();}
});

test('ownership or result-map replacement prevents publication into a detached route',async()=>{
  for(const change of ['owner','map','history']) {
    const gate=deferred(),f=fixture({gates:[gate]});let owner=true;
    try {
      const pending=f.analysis.start({...f.spec,owns:()=>owner});await until(()=>f.calls.length===1);
      const original=f.line.results;
      if(change==='owner')owner=false;
      if(change==='map')f.line.results=new Map();
      if(change==='history')f.line.base=new Chess(f.line.base.fen());
      gate.resolve();assert.equal(await pending,null);assert.equal(original.size,0);
      assert.equal(f.line.results.size,0);assert.equal(f.analysis.active,null);
    }finally {gate.resolve();await f.pool.dispose();}
  }
});

test('strict position cache skips compatible scores but rejects inherited overview or wrong-history entries',async()=>{
  const f=fixture();
  try {
    f.line.results.set(0,{score:{type:'cp',value:500},configKey:'position:16',overview:true});
    f.line.results.set(1,{score:{type:'cp',value:500},configKey:'position:16',continuationPosition:'unrelated history'});
    const valid={score:{type:'cp',value:80},configKey:'position:16',continuationPosition:positionCommand(f.line.position(2))};
    f.line.results.set(2,valid);
    const outcome=await f.analysis.start(f.spec);
    assert.equal(outcome.cached,1);assert.equal(outcome.analyzed,3);assert.equal(f.line.results.get(2),valid);
    assert.notEqual(f.line.results.get(0).score.value,500);assert.notEqual(f.line.results.get(1).score.value,500);
  }finally {await f.pool.dispose();}
});

test('a richer foreground evaluation completed during the lease is retained instead of losing its move review',async()=>{
  const gate=deferred(),f=fixture({gates:[gate]});
  try {
    const pending=f.analysis.start(f.spec);await until(()=>f.calls.length===1);
    const foreground={...result(f.line.position(0),options,99),configKey:'position:16',moveReview:{verified:true}};
    f.line.results.set(0,foreground);gate.resolve();await pending;
    assert.equal(f.line.results.get(0),foreground);assert.deepEqual(f.line.results.get(0).moveReview,{verified:true});
  }finally {await f.pool.dispose();}
});

test('unfinished searches report once and do not fabricate a graph score from the source evaluation',async()=>{
  for(const invalid of [{depth:15},{multipvComplete:false},{searchMode:undefined},{score:{type:'cp',value:NaN}}]) {
    const errors=[],f=fixture({createResult:(chess,settings)=>({...result(chess,settings),...invalid}),
      callbacks:{onError:(_,error)=>errors.push(error)}});
    try {
      f.line.sourceScore={type:'cp',value:900};const pending=f.analysis.start(f.spec),job=f.analysis.active;
      assert.equal(await pending,null);assert.equal(job.status,'error');assert.equal(errors.length,1);
      assert.equal(f.line.results.size,0);assert.equal(f.line.sourceScore.value,900);
    }finally {await f.pool.dispose();}
  }
});

test('terminal positions are valid and completed compatible graphs need no repeated engine work',async()=>{
  const f=fixture(),base=new Chess('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1');
  try {
    const line=new AnalysisLine(base,['f7g7']),spec={...f.spec,line};
    await f.analysis.start(spec);assert.ok(line.results.get(1).terminal);
    const count=f.calls.length,outcome=await f.analysis.start(spec);
    assert.equal(outcome.cached,2);assert.equal(outcome.analyzed,0);assert.equal(f.calls.length,count);
  }finally {await f.pool.dispose();}
});

test('explicit stop removes queued continuation work while preserving the original review map',async()=>{
  const gate=deferred(),f=fixture();
  try {
    const original=f.pool.map([1,2],{run:async(_,item)=>{if(item===1)await gate.promise;return item;}});
    await until(()=>f.pool.running===1);
    const pending=f.analysis.start(f.spec),job=f.analysis.active;await turn();
    assert.equal(f.pool.pending,2);assert.equal(f.analysis.stop(),job);assert.equal(f.analysis.active,null);
    assert.equal(await pending,null);assert.equal(job.status,'cancelled');assert.equal(f.calls.length,0);
    gate.resolve();assert.deepEqual(await original,[1,2]);assert.equal(f.pool.closed,false);
  }finally {gate.resolve();await f.pool.dispose();}
});

test('foreground requests get the next slot ahead of continuation and original work without exceeding the pool limit',async()=>{
  const gate=deferred(),order=[],f=fixture({gates:[gate]});
  try {
    const continuation=f.analysis.start(f.spec);await until(()=>f.calls.length===1);
    const original=f.pool.map([1,2],{run:async(_,index)=>{order.push(`original ${index}`);return index;}});
    const foreground=f.pool.submit({priority:10,run:async()=>{order.push('foreground');return 'ready';}});
    gate.resolve();assert.equal(await foreground,'ready');await continuation;await original;
    assert.equal(order[0],'foreground');assert.equal(f.pool.metrics.peak,1);
    assert.equal(f.line.results.size,4);assert.equal(f.pool.closed,false);
  }finally {gate.resolve();await f.pool.dispose();}
});

test('a cancelled waiting replacement cannot start and callback cleanup failures do not strand subsequent jobs',async()=>{
  const gate=deferred(),settled=[],f=fixture({gates:[gate],callbacks:{onSettled:job=>{settled.push(job.id);if(job.id===1)throw new Error('cleanup callback');}}});
  try {
    const first=f.analysis.start(f.spec);const rejected=assert.rejects(first,/cleanup callback/);
    await until(()=>f.calls.length===1);
    const second=f.analysis.start({...f.spec,line:new AnalysisLine(gameAt(f.game,2),['d2d4'])});
    const third=f.analysis.start({...f.spec,line:new AnalysisLine(gameAt(f.game,2),['c2c4'])});
    gate.resolve();await rejected;assert.equal(await second,null);assert.equal((await third).completed,2);
    assert.deepEqual(settled,[1,2,3]);assert.equal(f.calls.length,3);
  }finally {gate.resolve();await f.pool.dispose();}
});

test('inconsistent real histories are rejected without mutating the current active job',async()=>{
  const gate=deferred(),f=fixture({gates:[gate]});
  try {
    const pending=f.analysis.start(f.spec),job=f.analysis.active;
    const bad=new AnalysisLine(gameAt(f.game,2),['d2d4']);bad.steps[0].after='invalid';
    assert.throws(()=>f.analysis.start({...f.spec,line:bad}),/invalid position/);
    assert.equal(f.analysis.active,job);gate.resolve();await pending;
  }finally {gate.resolve();await f.pool.dispose();}
});
