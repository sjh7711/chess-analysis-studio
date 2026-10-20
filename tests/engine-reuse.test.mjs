import test from 'node:test';
import assert from 'node:assert/strict';
import { StockfishEngine } from '../src/engine.js';
import { Chess } from '../src/chess-core.js';
import { DEFAULT_PERFORMANCE, normalizePerformance, reviewOptions, searchOptions } from '../src/engine-options.js';

async function withEngine(run) {
  let worker;
  const messages = [];
  class FakeWorker {
    constructor() { worker = this; }
    postMessage(command) {
      messages.push(command);
      if (command === 'uci') queueMicrotask(() => this.emit('uciok'));
      if (command === 'isready') queueMicrotask(() => this.emit('readyok'));
    }
    emit(data) { this.onmessage({ data }); }
    terminate() {}
  }
  const engine = new StockfishEngine(FakeWorker);
  try { await engine.ready; await run({ engine, worker, messages }); }
  finally { engine.dispose(); }
}

const started = () => new Promise(setImmediate);
const info = (depth, rank, score, pv) => `info depth ${depth} multipv ${rank} score cp ${score} pv ${pv}`;

test('fast overview has a separate bounded budget while detailed searches retain user settings',()=>{
  assert.deepEqual(reviewOptions(16,{...DEFAULT_PERFORMANCE,reviewMode:'fast'}),{depth:16,movetime:600,multipv:2,hash:32,threads:1});
  const custom={...DEFAULT_PERFORMANCE,reviewMode:'fast',movetime:30000,multipv:5};
  assert.equal(reviewOptions(24,custom).movetime,1500);
  assert.equal(searchOptions(24,custom).movetime,30000);
  assert.deepEqual(reviewOptions(24,{...custom,reviewMode:'precise'}),searchOptions(24,custom));
});

test('resolved automatic and manual parallel task counts reach both review and position search options',()=>{
  const automatic=normalizePerformance({threadMode:'auto',reviewMode:'fast'},6,16);
  assert.equal(automatic.threads,6);assert.equal(automatic.threadMode,'auto');
  assert.deepEqual(reviewOptions(16,automatic),{depth:16,movetime:600,multipv:2,hash:32,threads:6});
  const manual=normalizePerformance({threadMode:'manual',threads:5,reviewMode:'precise'},6,16);
  assert.equal(searchOptions(20,manual).threads,5);assert.equal(reviewOptions(20,manual).threads,5);
});

test('a timed stop returns the last complete MultiPV depth without mixing a newer partial iteration', async () => {
  await withEngine(async ({ engine, worker }) => {
    const progress = [];
    const pending = engine.analyze(new Chess(), { multipv: 3, onInfo: line => progress.push(line) });
    await started();
    worker.emit([
      info(10, 1, 36, 'e2e4 e7e5'), info(10, 2, 20, 'd2d4 d7d5'), info(10, 3, 10, 'g1f3 d7d5'),
      info(11, 1, 50, 'd2d4 d7d5'), info(11, 2, 44, 'e2e4 e7e5'),
      'bestmove d2d4',
    ].join('\n'));
    const result = await pending;
    assert.equal(progress.length, 5, 'onInfo still reports unfinished search progress');
    assert.deepEqual(result.lines.map(line => line.depth), [10, 10, 10]);
    assert.deepEqual(result.lines.map(line => line.pv[0]), ['e2e4', 'd2d4', 'g1f3']);
    assert.equal(result.bestmove, 'e2e4');
    assert.equal(result.score.value, 36);
    assert.equal(result.depth, 10);
    assert.equal(result.engineBestmove, 'd2d4', 'the raw UCI choice is retained separately');
    assert.equal(result.multipvComplete, true);
    assert.equal(result.bestmove, result.lines[0].pv[0]);
    assert.deepEqual(result.score, result.lines[0].score);
  });
});

test('the deepest complete iteration supplies the score and PV of its best move', async () => {
  await withEngine(async ({ engine, worker }) => {
    const chess = new Chess(); chess.move('e4');
    const pending = engine.analyze(chess, { multipv: 2 });
    await started();
    worker.emit([
      info(9, 1, 15, 'e7e5 g1f3'), info(9, 2, 10, 'c7c5 g1f3'),
      info(10, 1, 55, 'c7c5 g1f3'), info(10, 2, 20, 'e7e5 g1f3'),
      'bestmove c7c5 ponder g1f3',
    ].join('\n'));
    const result = await pending;
    assert.equal(result.bestmove, 'c7c5');
    assert.equal(result.engineBestmove, 'c7c5');
    assert.equal(result.score.value, -55, 'engine scores remain white-relative');
    assert.deepEqual(result.lines.map(line => line.depth), [10, 10]);
    assert.deepEqual(result.lines[0].pv, ['c7c5', 'g1f3']);
  });
});

test('a replacement batch at the same depth cannot overwrite part of a complete candidate set', async () => {
  await withEngine(async ({ engine, worker }) => {
    const pending = engine.analyze(new Chess(), { multipv: 2 });
    await started();
    worker.emit([
      info(10, 1, 36, 'e2e4 e7e5'), info(10, 2, 20, 'd2d4 d7d5'),
      info(10, 1, 50, 'g1f3 d7d5'), 'bestmove g1f3',
    ].join('\n'));
    const result = await pending;
    assert.deepEqual(result.lines.map(line => [line.pv[0], line.score.value]), [['e2e4', 36], ['d2d4', 20]]);
  });
});

test('duplicate root moves do not count as a completed MultiPV iteration', async () => {
  await withEngine(async ({ engine, worker }) => {
    const pending = engine.analyze(new Chess(), { multipv: 2 });
    await started();
    worker.emit([
      info(9, 1, 36, 'e2e4 e7e5'), info(9, 2, 20, 'd2d4 d7d5'),
      info(10, 1, 50, 'd2d4 d7d5'), info(10, 2, 44, 'd2d4 g8f6'),
      'bestmove d2d4',
    ].join('\n'));
    assert.deepEqual((await pending).lines.map(line => line.depth), [9, 9]);
  });
});

test('fewer legal root moves than MultiPV still form a complete iteration', async () => {
  await withEngine(async ({ engine, worker, messages }) => {
    const pending = engine.analyze(new Chess('8/8/8/8/8/8/2k5/Kr6 w - - 0 1'), { multipv: 5 });
    await started();
    assert.ok(messages.includes('setoption name MultiPV value 1'));
    worker.emit(`${info(12, 1, -500, 'a1a2 b1b2')}\nbestmove a1a2`);
    const result = await pending;
    assert.equal(result.multipvComplete, true);
    assert.equal(result.lines.length, 1);
    assert.equal(result.bestmove, 'a1a2');
    assert.equal(result.score.value, -500);
  });
});

test('without a complete iteration, the final UCI move returns only its own matching score and PV', async () => {
  await withEngine(async ({ engine, worker }) => {
    const pending = engine.analyze(new Chess(), { multipv: 3 });
    await started();
    worker.emit(`${info(10, 1, 50, 'e2e4 e7e5')}\n${info(10, 2, 44, 'd2d4 d7d5')}\nbestmove d2d4`);
    const result = await pending;
    assert.equal(result.multipvComplete, false);
    assert.equal(result.bestmove, 'd2d4');
    assert.equal(result.score.value, 44);
    assert.deepEqual(result.lines.map(line => [line.multipv, line.pv[0]]), [[1, 'd2d4']]);
  });
});

test('without a complete iteration or a score for the final move, the engine rejects a contradictory result', async () => {
  await withEngine(async ({ engine, worker }) => {
    const pending = engine.analyze(new Chess(), { multipv: 3 });
    const rejected = assert.rejects(pending, /최선수와 일치하는 평가/);
    await started();
    worker.emit(`${info(10, 1, 50, 'e2e4 e7e5')}\nbestmove d2d4`);
    await rejected;
  });
});

test('searchMoves restricts root moves, deduplicates UCI tokens, and returns their root-relative evaluations', async () => {
  await withEngine(async ({ engine, worker, messages }) => {
    const pending = engine.analyze(new Chess(), { depth: 18, movetime: 250, multipv: 5, searchMoves: ['e2e4', 'd2d4', 'e2e4'] });
    await started();
    assert.ok(messages.includes('setoption name MultiPV value 2'));
    assert.ok(messages.includes('go depth 18 movetime 250 searchmoves e2e4 d2d4'));
    worker.emit([
      info(12, 1, 30, 'd2d4 d7d5'), info(12, 2, 22, 'e2e4 e7e5'),
      info(13, 1, 99, 'g1f3 d7d5'), 'bestmove d2d4',
    ].join('\n'));
    const result = await pending;
    assert.equal(result.multipvComplete, true);
    assert.deepEqual(result.lines.map(line => line.pv[0]), ['d2d4', 'e2e4']);
    assert.equal(result.score.value, 30);
    assert.equal(result.depth, 12);
  });
});

test('a single searchMoves root produces a complete score even when MultiPV is greater than one', async () => {
  await withEngine(async ({ engine, worker, messages }) => {
    const pending = engine.analyze(new Chess(), { multipv: 5, searchMoves: ['e2e4'] });
    await started();
    assert.ok(messages.includes('setoption name MultiPV value 1'));
    worker.emit(`${info(8, 1, -40, 'e2e4 c7c5')}\nbestmove e2e4`);
    const result = await pending;
    assert.equal(result.multipvComplete, true);
    assert.equal(result.score.value, -40);
    assert.deepEqual(result.lines[0].pv, ['e2e4', 'c7c5']);
  });
});

test('invalid searchMoves cannot inject UCI commands or silently trigger an unrestricted search', async () => {
  await withEngine(async ({ engine, messages }) => {
    for (const searchMoves of [[], null, 'e2e4', ['e2e5'], ['e2e4\nquit'], ['e2e4', 1]]) {
      await assert.rejects(engine.analyze(new Chess(), { searchMoves }), /합법적인 UCI 수/);
    }
    assert.equal(messages.filter(command => command.startsWith('go ')).length, 0);
    assert.equal(engine.pending, null);
    assert.equal(engine.closed, false);
  });
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
    const old=engine.analyze(new Chess(),{searchMoves:['d2d4']});
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
    assert.ok(messages.filter(m=>m.startsWith('go '))[0].includes('searchmoves d2d4'));
    assert.ok(!messages.filter(m=>m.startsWith('go '))[1].includes('searchmoves'));
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

function holdResetAcknowledgement(worker,messages) {
  const send=worker.postMessage.bind(worker);
  worker.postMessage=command=>{if(command==='isready')messages.push(command);else send(command);};
}

test('reset clears search state and blocks the next query until its separate ready acknowledgement',async()=>{
  await withEngine(async({engine,worker,messages})=>{
    holdResetAcknowledgement(worker,messages);
    const reset=engine.reset(),query=engine.analyze(new Chess(),{multipv:1});
    await started();
    assert.deepEqual(messages.slice(-2),['ucinewgame','isready']);
    assert.equal(messages.some(command=>command.startsWith('go ')),false);
    assert.ok(engine.resetPending);assert.equal(engine.initialized,true);
    worker.emit('readyok');await reset;await started();
    assert.equal(messages.filter(command=>command.startsWith('go ')).length,1);
    assert.equal(messages.some(command=>command.includes('Clear Hash')),false);
    worker.emit(`${info(12,1,25,'e2e4 e7e5')}\nbestmove e2e4`);
    assert.equal((await query).score.value,25);assert.equal(engine.resetPending,null);
  });
});

test('a reset queued behind a search reserves idle before another queued query can start',async()=>{
  await withEngine(async({engine,worker,messages})=>{
    holdResetAcknowledgement(worker,messages);
    const first=engine.analyze(new Chess(),{multipv:1});await started();
    const reset=engine.reset(),next=engine.analyze(new Chess(),{multipv:1});await started();
    assert.equal(messages.includes('ucinewgame'),false);
    worker.emit(`${info(10,1,10,'d2d4')}\nbestmove d2d4`);await first;await started();
    assert.deepEqual(messages.slice(-2),['ucinewgame','isready']);
    assert.equal(messages.filter(command=>command.startsWith('go ')).length,1);
    worker.emit('readyok');await reset;await started();
    assert.equal(messages.filter(command=>command.startsWith('go ')).length,2);
    worker.emit(`${info(11,1,20,'e2e4')}\nbestmove e2e4`);await next;
  });
});

test('cancel rejects a reset immediately but drains its late readyok before reusing the worker',async()=>{
  await withEngine(async({engine,worker,messages})=>{
    holdResetAcknowledgement(worker,messages);
    const reset=engine.reset(),cancelled=assert.rejects(reset,{name:'AbortError'});await started();
    engine.cancel();await cancelled;
    const next=engine.analyze(new Chess(),{multipv:1});await started();
    assert.equal(messages.some(command=>command.startsWith('go ')),false);
    assert.equal(messages.includes('stop'),false,'there is no active search to stop during reset');
    worker.emit('readyok');await started();
    assert.equal(messages.filter(command=>command.startsWith('go ')).length,1);
    worker.emit(`${info(12,1,30,'e2e4')}\nbestmove e2e4`);await next;
    assert.equal(engine.closed,false);
  });
});

test('disposing or failing during reset rejects its barrier and releases queued work safely',async()=>{
  for(const dispose of [true,false])await withEngine(async({engine,worker,messages})=>{
    holdResetAcknowledgement(worker,messages);
    const reset=engine.reset(),rejected=assert.rejects(reset,dispose?{name:'AbortError'}:/응답을 읽지/);
    const next=engine.analyze(new Chess()),nextRejected=assert.rejects(next,{name:'AbortError'});await started();
    if(dispose)engine.dispose();else worker.onmessageerror();
    await rejected;await nextRejected;
    assert.equal(engine.resetPending,null);assert.equal(engine.closed,true);
    assert.equal(messages.some(command=>command.startsWith('go ')),false);
  });
});

test('reset canceled during initialization never sends a new-game command after initialization completes',async()=>{
  let worker;
  const messages=[];
  class FakeWorker {constructor(){worker=this;}postMessage(command){messages.push(command);}terminate(){}}
  const engine=new StockfishEngine(FakeWorker);
  try {
    const reset=engine.reset(),rejected=assert.rejects(reset,{name:'AbortError'});engine.cancel();
    await started();worker.onmessage({data:'uciok'});worker.onmessage({data:'readyok'});await rejected;
    assert.equal(messages.includes('ucinewgame'),false);assert.equal(engine.closed,false);
  } finally {engine.dispose();}
});
