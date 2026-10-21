import test from 'node:test';
import assert from 'node:assert/strict';
import {StockfishEngine} from '../src/engine.js';
import {Chess} from '../src/chess-core.js';
import {useSharedLite,workerUrl} from '../src/engine-options.js';

const turn=()=>new Promise(setImmediate);
function isolate(t,value) {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'crossOriginIsolated');
  Object.defineProperty(globalThis,'crossOriginIsolated',{value,configurable:true});
  t.after(()=>previous?Object.defineProperty(globalThis,'crossOriginIsolated',previous):delete globalThis.crossOriginIsolated);
}
function transport({sharedFailure,hold=false}={}) {
  const workers=[];
  class FakeWorker {
    constructor(url){
      if(sharedFailure==='constructor'&&!url.includes('-single'))throw new Error('Shared worker unavailable');
      this.url=url;this.commands=[];this.terminated=0;workers.push(this);
    }
    emit(data){this.onmessage?.({data});}
    postMessage(command){
      this.commands.push(command);
      if(hold)return;
      if(!this.url.includes('-single')&&sharedFailure){queueMicrotask(()=>this.onerror?.({message:'Shared worker unavailable'}));return;}
      if(command==='uci')queueMicrotask(()=>this.emit('uciok'));
      if(command==='isready')queueMicrotask(()=>this.emit('readyok'));
    }
    terminate(){this.terminated++;}
  }
  return {FakeWorker,workers};
}

test('optimized Lite selection requires isolation and shared memory without increasing search threads',async t=>{
  assert.equal(useSharedLite(1,true,true),true);assert.equal(useSharedLite(1,false,true),false);
  assert.equal(useSharedLite(1,true,false),false);assert.equal(useSharedLite(4,false,false),true);
  isolate(t,true);const {FakeWorker,workers}=transport(),engine=new StockfishEngine(FakeWorker,{threads:1,hash:32});
  try {
    await engine.ready;assert.equal(workers[0].url,'/engine/stockfish-19-lite.js?v=19.0.0');
    assert.deepEqual(workers[0].commands,['uci','setoption name Threads value 1','setoption name Hash value 32','isready']);
    assert.equal(engine.executionBuild,'stockfish-19-lite.js');
    assert.equal(await workerUrl('lite',{compatibility:true}),'/engine/stockfish-19-lite-single.js?v=19.0.0');
  }finally{engine.dispose();}
});

test('non-isolated browsers retain the existing single-thread compatibility build',async t=>{
  isolate(t,false);const {FakeWorker,workers}=transport(),engine=new StockfishEngine(FakeWorker);
  try{await engine.ready;assert.match(workers[0].url,/-lite-single\.js/);assert.equal(workers[0].commands.some(c=>c.startsWith('setoption name Threads')),false);}
  finally{engine.dispose();}
});

test('a shared-build initialization error falls back once and ignores late responses from its old worker',async t=>{
  isolate(t,true);const {FakeWorker,workers}=transport({sharedFailure:'event'}),engine=new StockfishEngine(FakeWorker);
  try{
    await engine.ready;assert.equal(workers.length,2);assert.equal(workers[0].terminated,1);
    assert.match(workers[1].url,/-lite-single\.js/);const commands=[...workers[1].commands];
    workers[0].emit('uciok\nreadyok');workers[0].onerror({message:'late'});
    assert.deepEqual(workers[1].commands,commands);assert.equal(engine.closed,false);
  }finally{engine.dispose();}
});

test('a synchronous shared-worker construction failure also keeps analysis available',async t=>{
  isolate(t,true);const {FakeWorker,workers}=transport({sharedFailure:'constructor'}),engine=new StockfishEngine(FakeWorker);
  try{await engine.ready;assert.equal(workers.length,1);assert.match(workers[0].url,/-lite-single\.js/);}
  finally{engine.dispose();}
});

test('a stalled shared initialization gets one bounded fallback, then fails without retrying forever',async t=>{
  isolate(t,true);t.mock.timers.enable({apis:['setTimeout']});
  const {FakeWorker,workers}=transport({hold:true}),engine=new StockfishEngine(FakeWorker);
  const rejected=assert.rejects(engine.ready,/엔진을 불러오지/);
  try{
    await turn();t.mock.timers.tick(20000);await turn();assert.equal(workers.length,2);
    t.mock.timers.tick(20000);await rejected;assert.equal(engine.closed,true);assert.equal(workers.length,2);
  }finally{engine.dispose();t.mock.timers.reset();}
});

test('a runtime failure cannot silently replace an active search with another build',async t=>{
  isolate(t,true);t.mock.method(console,'error',()=>{});
  const {FakeWorker,workers}=transport(),engine=new StockfishEngine(FakeWorker);
  try{
    await engine.ready;const query=engine.analyze(new Chess(),{searchMode:'depth',depth:20,multipv:1});
    const rejected=assert.rejects(query,/Stockfish/);await turn();workers[0].onerror({message:'runtime'});
    await rejected;assert.equal(workers.length,1);assert.equal(engine.closed,true);
  }finally{engine.dispose();}
});
