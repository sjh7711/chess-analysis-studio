import test from 'node:test';
import assert from 'node:assert/strict';
import {StockfishEngine} from '../src/engine.js';
import {Chess} from '../src/chess-core.js';

const turn=()=>new Promise(setImmediate);
async function protocol(run) {
  let worker;const commands=[];
  class FakeWorker {
    constructor(){worker=this;}
    postMessage(command){commands.push(command);if(command==='uci')queueMicrotask(()=>this.emit('uciok'));if(command==='isready')queueMicrotask(()=>this.emit('readyok'));}
    emit(data){this.onmessage({data});}
    terminate(){}
  }
  const engine=new StockfishEngine(FakeWorker);
  try {await engine.ready;await run({engine,worker,commands});}finally {engine.dispose();}
}
const options={depth:20,searchMode:'depth',multipv:1};
const complete='info depth 20 seldepth 55 multipv 1 score cp 23 nodes 15000000 nps 600000 time 25000 hashfull 993 pv e2e4 e7e5';

test('bound and current-move activity remains visible without publishing an unfinished score or PV',async()=>{
  await protocol(async({engine,worker,commands})=>{
    const activity=[],scores=[];
    const query=engine.analyze(new Chess(),{...options,onInfo:info=>scores.push(info),onSearchInfo:info=>activity.push(info)});
    let settled=false;query.then(()=>{settled=true;});await turn();
    worker.emit('info depth 20 seldepth 55 multipv 1 score cp 900 lowerbound nodes 12000000 nps 600000 time 20000 hashfull 990 pv d2d4 d7d5');
    worker.emit('info depth 20 currmove e2e4 currmovenumber 1 nodes 14000000 nps 600000 time 23000');
    assert.equal(scores.length,0);assert.equal(settled,false);
    assert.deepEqual(activity,[{depth:20,seldepth:55,multipv:1,nodes:12000000,nps:600000,time:20000,hashfull:990},{depth:20,nodes:14000000,nps:600000,time:23000}]);
    assert.equal(activity.some(info=>'score' in info||'pv' in info),false);
    worker.emit(complete+'\nbestmove e2e4');const result=await query;
    assert.equal(result.score.value,23);assert.equal(result.depth,20);assert.equal(scores.length,1);
    assert.deepEqual(commands.filter(command=>command.startsWith('go ')),['go depth 20']);
  });
});

test('telemetry observer failures cannot fail or alter a completed exact-depth search',async()=>{
  for(const observer of [()=>{throw new Error('renderer');},()=>Promise.reject(new Error('async renderer'))]) {
    await protocol(async({engine,worker})=>{
      const query=engine.analyze(new Chess(),{...options,onSearchInfo:observer});await turn();
      worker.emit(complete+'\nbestmove e2e4');assert.equal((await query).score.value,23);await turn();
    });
  }
});

test('cancelled and settled searches do not report late activity',async()=>{
  await protocol(async({engine,worker})=>{
    const activity=[];const query=engine.analyze(new Chess(),{...options,onSearchInfo:info=>activity.push(info)});
    const rejected=assert.rejects(query,{name:'AbortError'});await turn();engine.cancel();
    worker.emit(complete+'\nbestmove e2e4');await rejected;
    worker.emit(complete);assert.equal(activity.length,0);
  });
});

test('diagnostic strings and malformed metrics cannot invent search activity',async()=>{
  await protocol(async({engine,worker})=>{
    const activity=[];const query=engine.analyze(new Chess(),{...options,onSearchInfo:info=>activity.push(info)});await turn();
    worker.emit('info string depth 999 nodes 99999999');worker.emit('info depth -1 nodes 1e9 time nan');worker.emit('info nodes 99999999999999999999999999');
    assert.equal(activity.length,0);
    worker.emit(complete+'\nbestmove e2e4');await query;assert.equal(activity.length,1);
  });
});
