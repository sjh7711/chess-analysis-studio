import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGame, gameAt, hasMoveReview, positionCommand, uciMove } from '../src/chess-core.js';
import { reviewGame } from '../src/game-review.js';
import { ReviewWorkerPool } from '../src/review-pool.js';

const game = parseGame('1. e4 e5 2. Nf3 Nc6 *');
const options = { depth: 10, movetime: 222, multipv: 2 };
const comparisonOptions = { depth: 12, movetime: 333, multipv: 3 };
const configKey = 'independent-review-test';
const cp = value => ({ type: 'cp', value });
const turn = () => new Promise(setImmediate);
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

function fakeEngines({ gates, scoreChanges = {}, beforeSearch = () => {} } = {}) {
  const calls = [], workers = [];
  const createEngine = id => {
    const worker = { id, cancelled: 0, disposed: 0, resets: 0, cached: null,
      cancel() { this.cancelled++; }, dispose() { this.disposed++; },
      async reset() { this.resets++; this.cached = null; },
      async analyze(chess, settings) {
        const index = chess.history().length;
        const restricted = Boolean(settings.searchMoves);
        assert.equal(this.cached, null, 'each independent job starts with cleared worker state');
        assert.ok(this.resets > 0); this.cached = index;
        calls.push({ worker: id, index, restricted, settings, reset: this.resets, history: positionCommand(chess) });
        beforeSearch({ index, restricted, calls });
        assert.equal(positionCommand(chess), positionCommand(gameAt(game, index)), 'every job retains the complete input history');
        if (!restricted) await gates?.[index]?.promise;
        const played = game.moves[index] && uciMove(game.moves[index]);
        const bestmove = restricted ? settings.searchMoves[0]
          : uciMove(chess.moves({ verbose: true }).find(move => uciMove(move) !== played));
        const depth = restricted ? settings.depth : 8 - index % 2;
        const score = cp(100 + index + (scoreChanges[index] || 0));
        return { score, depth, bestmove, multipvComplete: true,
          lines: [{ multipv: 1, score, depth, pv: [bestmove] }] };
      },
    };
    workers.push(worker); return worker;
  };
  return { createEngine, calls, workers };
}

test('all independent source positions finish once before move comparisons, even with out-of-order completions', async () => {
  const gates = game.positions.map(deferred), events = [];
  const fake = fakeEngines({ gates, beforeSearch: ({ restricted, calls }) => {
    if (restricted) assert.equal(calls.filter(call => !call.restricted).length, game.positions.length);
  } });
  const pending = reviewGame(game, { concurrency: 2, createEngine: fake.createEngine,
    options, comparisonOptions, configKey,
    onResult: (result, index, phase) => events.push({ result, index, phase }),
  });
  await turn();
  gates[1].resolve(); gates[2].resolve(); gates[3].resolve(); await turn();
  assert.deepEqual(events.map(event => [event.index, event.phase]), [[1, 'position'], [2, 'position'], [3, 'position']]);
  assert.equal(fake.calls.filter(call => call.restricted).length, 0, 'phase 2 waits for every source evaluation');
  gates[0].resolve(); gates[4].resolve();
  const outcome = await pending;
  assert.equal(outcome.analyzed, game.positions.length); assert.equal(outcome.reviewed, game.moves.length);
  assert.deepEqual(fake.calls.filter(call => !call.restricted).map(call => call.index).sort(), [0, 1, 2, 3, 4]);
  assert.deepEqual(fake.calls.filter(call => call.restricted).map(call => call.index).sort(), [0, 1, 2, 3]);
  const firstReview = events.findIndex(event => event.phase === 'review');
  assert.equal(firstReview, game.positions.length);
  for (let index = 1; index < game.positions.length; index++) {
    const before = outcome.results.get(index - 1), after = outcome.results.get(index), move = game.moves[index - 1];
    assert.equal(hasMoveReview(before, after, move), true);
    assert.equal(after.score.value, 100 + index, 'move grading preserves the independent graph score');
    assert.equal(after.moveReview.beforeScore, before.score);
    assert.equal(after.moveReview.beforeDepth, before.depth);
    assert.equal(after.moveReview.configKey, configKey);
    assert.equal(after.moveReview.depth, before.depth, 'restricted comparisons use the completed root depth');
    assert.equal(before.configKey, configKey); assert.equal(before.requestedDepth, options.depth);
  }
  assert.equal(fake.workers.length, 2, 'both phases reuse the same workers');
  assert.equal(fake.workers.reduce((sum, worker) => sum + worker.resets, 0), game.positions.length + game.moves.length);
  for (const worker of fake.workers) {
    const ownCalls = fake.calls.filter(call => call.worker === worker.id);
    assert.deepEqual(ownCalls.map(call => call.reset), ownCalls.map((_, index) => index + 1), 'each reused worker has a fresh cache exactly once per job');
  }
  assert.ok(fake.workers.every(worker => worker.disposed === 1));
});

test('a completed cached review performs no redundant position or comparison searches', async () => {
  const initial = fakeEngines();
  const completed = await reviewGame(game, { concurrency: 2, createEngine: initial.createEngine, options, comparisonOptions, configKey });
  const resumed = fakeEngines();
  const outcome = await reviewGame(game, { concurrency: 6, createEngine: resumed.createEngine,
    results: completed.results, isCached: result => result?.configKey === configKey,
    options, comparisonOptions, configKey,
  });
  assert.equal(outcome.analyzed, 0); assert.equal(outcome.reviewed, 0);
  assert.deepEqual(resumed.calls, []); assert.deepEqual(resumed.workers, []);
  assert.deepEqual([...outcome.results], [...completed.results]);
});

test('partial cache resume searches only the missing root and its invalidated comparisons', async () => {
  const initial = fakeEngines();
  const completed = await reviewGame(game, { concurrency: 2, createEngine: initial.createEngine, options, comparisonOptions, configKey });
  const cache = new Map(completed.results); cache.delete(2);
  const originalEntries = [...cache];
  const resumed = fakeEngines({ scoreChanges: { 2: 25 } });
  const outcome = await reviewGame(game, { concurrency: 6, createEngine: resumed.createEngine,
    results: cache, isCached: result => result?.configKey === configKey,
    options, comparisonOptions, configKey,
  });
  assert.deepEqual(resumed.calls.filter(call => !call.restricted).map(call => call.index), [2]);
  assert.deepEqual(resumed.calls.filter(call => call.restricted).map(call => call.index).sort(), [1, 2]);
  assert.equal(outcome.analyzed, 1); assert.equal(outcome.reviewed, 2);
  assert.equal(resumed.workers.reduce((sum, worker) => sum + worker.resets, 0), 3, 'cached positions and comparisons do not reset or search');
  assert.deepEqual([...cache], originalEntries, 'the caller cache is not mutated by the pipeline');
  assert.equal(outcome.results.get(1), completed.results.get(1));
  assert.equal(outcome.results.get(4), completed.results.get(4));
  for (const index of [2, 3]) assert.equal(hasMoveReview(outcome.results.get(index - 1), outcome.results.get(index), game.moves[index - 1]), true);
});

test('overview roots keep their overview comparison budget while detailed roots use the detailed budget', async () => {
  const fake = fakeEngines();
  const outcome = await reviewGame(game, { concurrency: 2, createEngine: fake.createEngine,
    options, comparisonOptions, configKey, overview: true,
  });
  assert.ok(fake.calls.filter(call => call.restricted).every(call => call.settings.movetime === options.movetime));
  assert.ok([...outcome.results.values()].every(result => result.overview === true));
});

test('aborting the review does not publish results finishing after cancellation or start phase 2', async () => {
  const gates = game.positions.map(deferred), controller = new AbortController(), events = [];
  const fake = fakeEngines({ gates });
  const pending = reviewGame(game, { concurrency: 2, createEngine: fake.createEngine,
    signal: controller.signal, options, comparisonOptions, configKey,
    onResult: (_, index, phase) => events.push([index, phase]),
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await turn(); controller.abort(); gates.forEach(gate => gate.resolve()); await rejected;
  assert.deepEqual(events, []); assert.equal(fake.calls.filter(call => call.restricted).length, 0);
  assert.ok(fake.workers.every(worker => worker.cancelled === 1 && worker.disposed === 1));
});

test('an asynchronous publication failure stops the pipeline and the review awaits resource cleanup', async () => {
  const fake = fakeEngines(), cleanup = deferred(), publicationFailure = new Error('publication failed');
  let settled = false, disposed = false;
  const pending = reviewGame(game, { concurrency: 1,
    createEngine: id => {
      const worker = fake.createEngine(id);
      worker.dispose = async () => { disposed = true; await cleanup.promise; worker.disposed++; };
      return worker;
    },
    options, comparisonOptions, configKey,
    onResult: async () => { throw publicationFailure; },
  });
  const rejected = assert.rejects(pending, error => error === publicationFailure).then(() => { settled = true; });
  await turn();
  assert.equal(disposed, true); assert.equal(settled, false, 'the caller does not resume while engine cleanup is pending');
  assert.deepEqual(fake.calls.map(call => [call.index, call.restricted]), [[0, false]], 'no later position or comparison starts after publication failure');
  cleanup.resolve(); await rejected; assert.equal(fake.workers[0].disposed, 1);
});

test('cancellation during a reset never starts its stale position search', async () => {
  const controller = new AbortController(), reset = deferred();
  let resetStarted = false, searches = 0, disposed = 0;
  const pending = reviewGame(game, { concurrency: 1, signal: controller.signal,
    createEngine: () => ({
      async reset() { resetStarted = true; await reset.promise; },
      analyze() { searches++; throw new Error('stale search started'); },
      cancel() {}, dispose() { disposed++; },
    }),
    options, comparisonOptions, configKey,
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await turn(); assert.equal(resetStarted, true); controller.abort(); reset.resolve(); await rejected;
  assert.equal(searches, 0); assert.equal(disposed, 1);
});

test('fixed-depth game review never publishes a partial or foreign-policy source position',async()=>{
  for(const mutate of [result=>{result.depth--;},result=>{result.multipvComplete=false;},result=>{delete result.searchMode;}]) {
    const events=[],saved=new Map(),snapshot=JSON.stringify([...saved]);let calls=0,disposed=0;
    const worker={async reset(){},async analyze(chess,settings){
      calls++;assert.equal(settings.searchMode,'depth');
      const result={searchMode:'depth',score:cp(20),depth:10,bestmove:'e2e4',multipvComplete:true,
        lines:[{multipv:1,score:cp(20),depth:10,pv:['e2e4']} ]};
      mutate(result);return result;
    },cancel(){},dispose(){disposed++;}};
    await assert.rejects(reviewGame(game,{concurrency:1,createEngine:()=>worker,results:saved,
      options:{searchMode:'depth',depth:10,multipv:1},configKey:'synthetic-fixed-policy',
      onResult:(result,index,phase)=>events.push({result,index,phase})}));
    assert.deepEqual(events,[]);assert.equal(calls,1);assert.equal(disposed,1);
    assert.equal(JSON.stringify([...saved]),snapshot,'a failed source cannot become a resumable cache entry');
  }
});

test('a failed fixed-depth confidence search does not publish a reviewed move or mutate source cache',async()=>{
  const fixedGame=parseGame('1. a3 *'),saved=new Map(),events=[],failure=new Error('ranking verification unavailable');
  let rootSearches=0,disposed=0;
  const worker={async reset(){},async analyze(chess,settings){
    assert.equal(settings.searchMode,'depth');assert.equal('movetime' in settings,false);
    const child=chess.history().length===1;
    if(settings.searchMoves)return {searchMode:'depth',score:cp(120),depth:10,bestmove:'a2a3',multipvComplete:true,
      lines:[{multipv:1,score:cp(120),depth:10,pv:['a2a3','a7a6']}]};
    if(!child&&++rootSearches>1)throw failure;
    const score=cp(child?900:100),bestmove=child?'a7a6':'b1c3',second=child?'h7h6':'g1f3';
    return {searchMode:'depth',score,depth:10,bestmove,multipvComplete:true,
      lines:[{multipv:1,score:{...score},depth:10,pv:child?[bestmove]:[bestmove,'a7a6']},
        {multipv:2,score:cp(child?890:80),depth:10,pv:[second]}]};
  },cancel(){},dispose(){disposed++;}};
  const settings={searchMode:'depth',depth:10,multipv:2};
  await assert.rejects(reviewGame(fixedGame,{concurrency:1,createEngine:()=>worker,results:saved,
    options:settings,comparisonOptions:settings,configKey:'synthetic-fixed-confidence',
    onResult:(result,index,phase)=>events.push({result,index,phase})}),error=>error===failure);
  assert.deepEqual(events.map(event=>[event.index,event.phase]),[[0,'position'],[1,'position']]);
  assert.ok(events.every(event=>event.result.moveReview===undefined),'an incomplete confidence job cannot publish a grade input');
  assert.equal(saved.size,0);assert.equal(disposed,1);
});

test('interactive work takes the next shared slot while the original review finishes with unchanged roots and grades', async () => {
  const baseline = fakeEngines();
  const expected = await reviewGame(game, { concurrency: 1, createEngine: baseline.createEngine,
    options, comparisonOptions, configKey });
  const gates = game.positions.map(deferred), foregroundGate = deferred(), events = [];
  const fake = fakeEngines({ gates });
  const pool = new ReviewWorkerPool({ concurrency: 2, createWorker: fake.createEngine });
  try {
    const pending = reviewGame(game, { pool, workerKey: 'review-lite', createEngine: fake.createEngine,
      options, comparisonOptions, configKey,
      onResult: (_, index, phase) => events.push([index, phase]),
    });
    await turn();
    assert.deepEqual(fake.calls.map(call => call.index), [0, 1]);
    let foregroundStarted = false, foregroundFinished = false;
    const foreground = pool.submit({ priority: 10, workerKey: 'review-lite', createWorker: fake.createEngine,
      run: async worker => {
        await worker.reset(); foregroundStarted = true;
        await foregroundGate.promise; foregroundFinished = true;
        return 'exploration completed';
      },
    });
    gates[0].resolve(); await turn();
    assert.equal(foregroundStarted, true, 'the next free slot serves exploration before another original position');
    assert.equal(foregroundFinished, false);
    assert.deepEqual(fake.calls.map(call => call.index), [0, 1], 'no third task runs outside the configured two slots');
    assert.equal(events.filter(([, phase]) => phase === 'position').length, 1);
    assert.equal(fake.workers.length, 2);
    foregroundGate.resolve();
    assert.equal(await foreground, 'exploration completed');
    gates.forEach(gate => gate.resolve());
    const actual = await pending;
    assert.deepEqual(actual, expected, 'foreground contention changes neither source evaluations nor move classifications');
    assert.ok(fake.workers.every(worker => worker.disposed === 0 && worker.cancelled === 0),
      'finishing a game does not tear down application-owned shared engines');
    assert.equal(await pool.submit({ priority: 10, workerKey: 'review-lite', createWorker: fake.createEngine,
      run: async () => 'still available' }), 'still available');
  } finally {
    foregroundGate.resolve(); gates.forEach(gate => gate.resolve());
    await pool.dispose();
  }
  assert.ok(fake.workers.every(worker => worker.disposed === 1));
});

test('shared review forwards its cancellation and worker configuration to both phases without taking pool ownership', async () => {
  const controller = new AbortController(), fake = fakeEngines(), phases = [];
  let disposed = 0;
  const pool = {
    async map(items, settings) {
      assert.equal(settings.signal, controller.signal);
      assert.equal(settings.priority, 0);
      assert.equal(settings.workerKey, 'lite:64');
      assert.equal(settings.createWorker, fake.createEngine);
      assert.equal(settings.isolateFailures, true);
      phases.push(items);
      const worker = fake.createEngine(0), values = [];
      for (const [offset, item] of items.entries()) {
        const result = await settings.run(worker, item, offset, controller.signal);
        await settings.onResult(result, offset, item); values.push(result);
      }
      return values;
    },
    async dispose() { disposed++; },
  };
  const outcome = await reviewGame(game, { pool, workerKey: 'lite:64', signal: controller.signal,
    createEngine: fake.createEngine, options, comparisonOptions, configKey });
  assert.equal(outcome.analyzed, game.positions.length);
  assert.equal(outcome.reviewed, game.moves.length);
  assert.deepEqual(phases, [[0, 1, 2, 3, 4], [1, 2, 3, 4]]);
  assert.equal(disposed, 0);
});

test('cancelling a shared original review leaves queued foreground work and the application pool usable', async () => {
  const controller = new AbortController(), gates = game.positions.map(deferred), events = [];
  const fake = fakeEngines({ gates });
  const pool = new ReviewWorkerPool({ concurrency: 2, createWorker: fake.createEngine });
  try {
    const pending = reviewGame(game, { pool, workerKey: 'review-lite', signal: controller.signal,
      createEngine: fake.createEngine, options, comparisonOptions, configKey,
      onResult: (_, index, phase) => events.push([index, phase]),
    });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await turn();
    const foreground = pool.submit({ priority: 10, workerKey: 'review-lite', createWorker: fake.createEngine,
      run: async worker => { await worker.reset(); return 'independent exploration'; },
    });
    controller.abort(); gates.forEach(gate => gate.resolve());
    await rejected;
    assert.equal(await foreground, 'independent exploration');
    assert.deepEqual(events, [], 'cancelled original-game jobs do not publish stale roots');
    assert.equal(await pool.submit({ priority: 10, workerKey: 'review-lite', createWorker: fake.createEngine,
      run: async () => 'usable after cancellation' }), 'usable after cancellation');
  } finally {
    gates.forEach(gate => gate.resolve()); await pool.dispose();
  }
});
