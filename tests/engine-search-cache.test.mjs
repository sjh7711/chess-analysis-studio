import test from 'node:test';
import assert from 'node:assert/strict';
import {StockfishEngine} from '../src/engine.js';
import {Chess} from '../src/chess-core.js';
import {CompletedSearchCache} from '../src/search-result-cache.js';

const turn=()=>new Promise(setImmediate);
const options={searchMode:'depth',depth:16,multipv:2};
function protocol({hold=false}={}) {
  const workers=[];
  class FakeWorker {
    constructor(url){this.url=url;this.commands=[];workers.push(this);}
    emit(data){this.onmessage?.({data});}
    finish(){this.emit('info depth 16 multipv 1 score cp 30 nodes 500 pv e2e4 e7e5\ninfo depth 16 multipv 2 score cp 20 nodes 500 pv d2d4 d7d5\nbestmove e2e4');}
    postMessage(command){this.commands.push(command);if(command==='uci')queueMicrotask(()=>this.emit('uciok'));if(command==='isready')queueMicrotask(()=>this.emit('readyok'));if(command.startsWith('go ')&&!hold)queueMicrotask(()=>this.finish());}
    terminate(){}
  }
  return {FakeWorker,workers,queries:()=>workers.flatMap(w=>w.commands.filter(c=>c.startsWith('go ')))};
}

test('different workers reuse an identical complete cold query without repeating its search or changing raw evidence',async()=>{
  const cache=new CompletedSearchCache(),wire=protocol(),a=new StockfishEngine(wire.FakeWorker,{resultCache:cache}),b=new StockfishEngine(wire.FakeWorker,{resultCache:cache});
  try{
    const original=await a.analyze(new Chess(),options),expected=structuredClone(original);
    original.lines[0].pv[0]='e1e8';original.moveReview={score:{type:'cp',value:999}};
    const reused=await b.analyze(new Chess(),{...options,threads:6,movetime:1});
    assert.deepEqual(reused,expected);assert.deepEqual(wire.queries(),['go depth 16']);
    assert.equal(cache.metrics.hits,1);assert.equal(cache.metrics.writes,1);
    assert.equal(wire.workers[1].commands.includes('ucinewgame'),false,'a cache hit needs no engine reset/search');
  }finally{a.dispose();b.dispose();}
});

test('effective constructor hash determines reuse even when per-query scheduling settings say otherwise',async()=>{
  const cache=new CompletedSearchCache(),wire=protocol(),a=new StockfishEngine(wire.FakeWorker,{hash:32,resultCache:cache}),b=new StockfishEngine(wire.FakeWorker,{hash:64,resultCache:cache});
  try{
    await a.analyze(new Chess(),{...options,hash:64});await b.analyze(new Chess(),{...options,hash:32});
    assert.equal(wire.queries().length,2);await a.analyze(new Chess(),{...options,hash:128,threads:8});
    assert.equal(wire.queries().length,2);assert.equal(cache.metrics.hits,1);
  }finally{a.dispose();b.dispose();}
});

test('time-limited searches never consume or populate deterministic completed-query evidence',async()=>{
  const cache=new CompletedSearchCache(),wire=protocol(),engine=new StockfishEngine(wire.FakeWorker,{resultCache:cache});
  try{
    await engine.analyze(new Chess(),options);await engine.analyze(new Chess(),{depth:16,movetime:100,multipv:2});
    assert.deepEqual(wire.queries(),['go depth 16','go depth 16 movetime 100']);assert.equal(cache.metrics.writes,1);assert.equal(cache.metrics.hits,0);
  }finally{engine.dispose();}
});

test('cancelled work and queued cache hits cannot escape the engine cancellation generation',async()=>{
  const cache=new CompletedSearchCache(),wire=protocol({hold:true}),engine=new StockfishEngine(wire.FakeWorker,{resultCache:cache});
  try{
    const cancelled=engine.analyze(new Chess(),options),rejected=assert.rejects(cancelled,{name:'AbortError'});await turn();
    engine.cancel();wire.workers[0].finish();await rejected;assert.equal(cache.metrics.writes,0);
    const fresh=engine.analyze(new Chess(),options);await turn();wire.workers[0].finish();await fresh;
    const pendingHit=engine.analyze(new Chess(),options),rejectedHit=assert.rejects(pendingHit,{name:'AbortError'});engine.cancel();await rejectedHit;
    assert.equal(wire.queries().length,2);assert.equal(cache.metrics.hits,0);
  }finally{engine.dispose();}
});

test('partial fixed-depth responses cannot be cached for a later exact query',async()=>{
  const cache=new CompletedSearchCache(),wire=protocol({hold:true}),engine=new StockfishEngine(wire.FakeWorker,{resultCache:cache});
  try{
    const query=engine.analyze(new Chess(),options),rejected=assert.rejects(query,{code:'INCOMPLETE_DEPTH'});await turn();
    wire.workers[0].emit('info depth 15 multipv 1 score cp 999 pv e2e4 e7e5\ninfo depth 15 multipv 2 score cp 998 pv d2d4 d7d5\nbestmove e2e4');
    await rejected;assert.equal(cache.metrics.entries,0);
    const fresh=engine.analyze(new Chess(),options);await turn();wire.workers[0].finish();assert.equal((await fresh).score.value,30);assert.equal(wire.queries().length,2);
  }finally{engine.dispose();}
});

test('unavailable caches cannot fail a sound depth-complete engine result',async()=>{
  const wire=protocol(),engine=new StockfishEngine(wire.FakeWorker,{resultCache:{get(){throw new Error('read');},set(){throw new Error('write');}}});
  try{assert.equal((await engine.analyze(new Chess(),options)).depth,16);assert.equal(wire.queries().length,1);}
  finally{engine.dispose();}
});

test('editing caller-owned history or options after submission cannot poison the exact-query cache',async()=>{
  const cache=new CompletedSearchCache(),wire=protocol(),engine=new StockfishEngine(wire.FakeWorker,{resultCache:cache});
  try{
    const chess=new Chess(),settings={...options,searchMoves:['e2e4','d2d4']};
    const pending=engine.analyze(chess,settings);chess.move('Nf3');settings.depth=18;settings.searchMoves.reverse();
    const result=await pending;assert.equal(result.depth,16);
    assert.equal(wire.workers[0].commands.find(c=>c.startsWith('position ')),'position fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    assert.deepEqual(wire.queries(),['go depth 16 searchmoves e2e4 d2d4']);
    assert.deepEqual(await engine.analyze(new Chess(),{...options,searchMoves:['e2e4','d2d4']}),result);
    assert.equal(wire.queries().length,1);assert.equal(cache.metrics.hits,1);
  }finally{engine.dispose();}
});
