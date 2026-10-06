import test from 'node:test';
import assert from 'node:assert/strict';
import { StockfishEngine } from '../src/engine.js';
import { Chess } from '../src/chess-core.js';
import { DEFAULT_PERFORMANCE, reviewOptions, searchOptions } from '../src/engine-options.js';

test('fast overview has a separate bounded budget while detailed searches retain user settings',()=>{
  assert.deepEqual(reviewOptions(16),{depth:16,movetime:600,multipv:2,hash:32,threads:1});
  const custom={...DEFAULT_PERFORMANCE,movetime:30000,multipv:5};
  assert.equal(reviewOptions(24,custom).movetime,1500);
  assert.equal(searchOptions(24,custom).movetime,30000);
  assert.deepEqual(reviewOptions(24,{...custom,reviewMode:'precise'}),searchOptions(24,custom));
});
test('cancel drains stale bestmove before reusing the worker and never returns the old score',async()=>{
  let worker,created=0,terminated=0;
  const messages=[];
  class FakeWorker {
    constructor(){worker=this;created++;}
    postMessage(command){messages.push(command);if(command==='uci')queueMicrotask(()=>this.onmessage({data:'uciok'}));if(command==='isready')queueMicrotask(()=>this.onmessage({data:'readyok'}));}
    terminate(){terminated++;}
    emit(data){this.onmessage({data});}
  }
  const engine=new StockfishEngine(FakeWorker);
  try{
    await engine.ready;
    const old=engine.analyze(new Chess());
    const rejected=assert.rejects(old,{name:'AbortError'});
    await new Promise(setImmediate);
    engine.cancel();
    await rejected;
    const next=engine.analyze(new Chess());
    await new Promise(setImmediate);
    assert.equal(messages.filter(m=>m.startsWith('go ')).length,1);
    worker.emit('info depth 12 score cp 999 pv d2d4');
    worker.emit('bestmove d2d4');
    await new Promise(setImmediate);
    assert.equal(messages.filter(m=>m.startsWith('go ')).length,2);
    worker.emit('info depth 14 score cp 25 pv e2e4');
    worker.emit('bestmove e2e4');
    assert.equal((await next).score.value,25);
    assert.equal(created,1);assert.equal(terminated,0);
  }finally{engine.dispose();}
  assert.equal(terminated,1);
});
test('cancellation before initialization rejects the queued search without killing the worker',async()=>{
  let worker;
  class FakeWorker {constructor(){worker=this;}postMessage(){}terminate(){}}
  const engine=new StockfishEngine(FakeWorker);
  try{
    const pending=engine.analyze(new Chess());
    const rejected=assert.rejects(pending,{name:'AbortError'});
    engine.cancel();
    await new Promise(setImmediate);
    worker.onmessage({data:'uciok'});worker.onmessage({data:'readyok'});
    await rejected;
    assert.equal(engine.closed,false);
  }finally{engine.dispose();}
});
