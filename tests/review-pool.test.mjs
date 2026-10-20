import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewWorkerPool, runReviewPool } from '../src/review-pool.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(setImmediate);
function trackedWorker(index, workers) {
  const worker = { index, cancelled: 0, disposed: 0, cancel() { this.cancelled++; }, dispose() { this.disposed++; } };
  workers.push(worker);
  return worker;
}

test('independent jobs run concurrently, one at a time per worker, and return in input order', async () => {
  const workers = [], gates = Array.from({ length: 5 }, deferred), starts = [], completions = [];
  const busy = new Set();
  const pending = runReviewPool(['a', 'b', 'c', 'd', 'e'], {
    concurrency: 2,
    createWorker: index => trackedWorker(index, workers),
    run: async (worker, item, index) => {
      assert.ok(!busy.has(worker.index)); busy.add(worker.index); starts.push([worker.index, index]);
      await gates[index].promise; busy.delete(worker.index); return item.toUpperCase();
    },
    onResult: (result, index, item) => completions.push([result, index, item]),
  });
  await turn(); assert.deepEqual(starts, [[0, 0], [1, 1]]);
  gates[1].resolve(); await turn(); assert.deepEqual(starts.at(-1), [1, 2]);
  gates[2].resolve(); await turn(); assert.deepEqual(starts.at(-1), [1, 3]);
  gates[0].resolve(); await turn(); assert.deepEqual(starts.at(-1), [0, 4]);
  gates[4].resolve(); gates[3].resolve();
  assert.deepEqual(await pending, ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(completions.slice(0, 3), [['B', 1, 'b'], ['C', 2, 'c'], ['A', 0, 'a']]);
  assert.equal(workers.length, 2);
  assert.ok(workers.every(worker => worker.disposed === 1 && worker.cancelled === 0));
});

test('a one-worker fallback remains sequential and no unused workers are created', async () => {
  const workers = [], visits = [];
  const results = await runReviewPool([4, 5, 6], {
    concurrency: 1, createWorker: index => trackedWorker(index, workers),
    run: async (worker, item, index) => { visits.push([worker.index, index]); return item * 2; },
  });
  assert.deepEqual(results, [8, 10, 12]); assert.deepEqual(visits, [[0, 0], [0, 1], [0, 2]]);
  assert.equal(workers.length, 1); assert.equal(workers[0].disposed, 1);
  let created = 0;
  await runReviewPool([1, 2], { concurrency: 6, createWorker: () => { created++; return {}; }, run: (_, item) => item });
  assert.equal(created, 2);
  assert.deepEqual(await runReviewPool([], { createWorker: () => { throw new Error('unused'); }, run: () => {} }), []);
});

test('a pool reuses the same workers and their state across review phases', async () => {
  const workers = [];
  const pool = new ReviewWorkerPool({ concurrency: 2, createWorker: index => trackedWorker(index, workers) });
  try {
    await pool.map([0, 1], { run: worker => { worker.cached = true; return worker.index; } });
    assert.equal(workers.length, 2); assert.ok(workers.every(worker => worker.disposed === 0));
    const results = await pool.map([2, 3], { run: worker => { assert.equal(worker.cached, true); return worker.index; } });
    assert.equal(workers.length, 2); assert.deepEqual(results, [0, 1]);
  } finally { await pool.dispose(); }
  assert.ok(workers.every(worker => worker.disposed === 1 && worker.cancelled === 0));
  await pool.dispose(); assert.ok(workers.every(worker => worker.disposed === 1));
  await assert.rejects(pool.map([4], { run: () => 0 }), { name: 'AbortError' });
});

test('overlapping phases reject without disrupting the phase already running', async () => {
  const gate = deferred(), pool = new ReviewWorkerPool({ concurrency: 1, createWorker: () => ({}) });
  try {
    const pending = pool.map([1], { run: () => gate.promise });
    await assert.rejects(pool.map([2], { run: () => 2 }), /already running/);
    gate.resolve(1); assert.deepEqual(await pending, [1]);
  } finally { await pool.dispose(); }
});

test('external abort stops all active workers and suppresses late completion callbacks', async () => {
  const workers = [], gates = [deferred(), deferred()], signal = new AbortController(), callbacks = [];
  const pending = runReviewPool([0, 1, 2], {
    concurrency: 2, signal: signal.signal, createWorker: index => trackedWorker(index, workers),
    run: (_, item, index, jobSignal) => { assert.equal(jobSignal.aborted, false); return gates[index].promise; },
    onResult: (_, index) => callbacks.push(index),
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await turn(); signal.abort();
  assert.ok(workers.every(worker => worker.cancelled === 1 && worker.disposed === 1));
  gates[0].resolve('late'); gates[1].resolve('late'); await rejected;
  assert.deepEqual(callbacks, []);
});

test('abort also releases a worker whose asynchronous creation finishes later', async () => {
  const signal = new AbortController(), gate = deferred(), worker = trackedWorker(0, []);
  let runs = 0;
  const pending = runReviewPool([0], {
    signal: signal.signal, createWorker: () => gate.promise, run: () => { runs++; },
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await turn(); signal.abort(); gate.resolve(worker); await rejected;
  assert.equal(runs, 0); assert.equal(worker.cancelled, 1); assert.equal(worker.disposed, 1);
});

test('one failing job aborts peers, keeps the original error, and never assigns another job', async () => {
  const workers = [], gates = [deferred(), deferred()], starts = [], callbacks = [], failure = new Error('engine failed');
  const pending = runReviewPool([0, 1, 2], {
    concurrency: 2, createWorker: index => trackedWorker(index, workers),
    run: (_, item, index) => { starts.push(index); return gates[index].promise; },
    onResult: (_, index) => callbacks.push(index),
  });
  const rejected = assert.rejects(pending, error => error === failure);
  await turn(); gates[1].reject(failure); await turn(); gates[0].resolve('late'); await rejected;
  assert.deepEqual(starts, [0, 1]); assert.deepEqual(callbacks, []);
  assert.ok(workers.every(worker => worker.cancelled === 1 && worker.disposed === 1));
});

test('factory and completion callback failures clean up every created worker', async () => {
  const workers = [], failure = new Error('callback failed');
  await assert.rejects(runReviewPool([0], {
    createWorker: index => trackedWorker(index, workers), run: () => 1,
    onResult: () => { throw failure; },
  }), error => error === failure);
  assert.equal(workers[0].disposed, 1); assert.equal(workers[0].cancelled, 1);
  const created = [], gate = deferred();
  const pending = runReviewPool([0, 1], {
    createWorker: index => index === 0 ? gate.promise : Promise.reject(failure), run: () => 1,
  });
  const rejected = assert.rejects(pending, error => error === failure);
  await turn(); gate.resolve(trackedWorker(0, created)); await rejected;
  assert.equal(created[0].disposed, 1); assert.equal(created[0].cancelled, 1);
});

test('already aborted signals do not create workers, and invalid resource limits reject', async () => {
  const signal = new AbortController(); signal.abort();
  await assert.rejects(runReviewPool([0], {
    signal: signal.signal, createWorker: () => { throw new Error('must not create'); }, run: () => {},
  }), { name: 'AbortError' });
  for (const concurrency of [0, -1, 9, 1.5, NaN, Infinity]) {
    await assert.rejects(runReviewPool([0], { concurrency, createWorker: () => ({}), run: () => {} }), RangeError);
  }
});
