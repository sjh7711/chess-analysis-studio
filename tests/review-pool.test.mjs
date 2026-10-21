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

test('foreground leases take the next free map slot, preserve FIFO priority, and share the same limit', async () => {
  const workers = [], starts = [], gates = [deferred(), deferred(), deferred()], foregroundGate = deferred();
  const pool = new ReviewWorkerPool({ concurrency: 2, createWorker: index => trackedWorker(index, workers) });
  try {
    const background = pool.map([0, 1, 2], {
      isolateFailures: true,
      run: async (worker, item) => { starts.push(`background ${item}`); await gates[item].promise; return item; },
    });
    await turn();
    const first = pool.submit({ priority: 10, run: async worker => {
      starts.push('foreground first'); assert.equal(worker.index, 1); await foregroundGate.promise; return 'first';
    } });
    const second = pool.submit({ priority: 10, run: () => { starts.push('foreground second'); return 'second'; } });
    assert.deepEqual(pool.metrics, { running: 2, pending: 3, peak: 2, concurrency: 2 });
    gates[1].resolve(); await turn();
    assert.deepEqual(starts, ['background 0', 'background 1', 'foreground first']);
    assert.equal(pool.running, 2);
    foregroundGate.resolve(); assert.equal(await first, 'first'); assert.equal(await second, 'second');
    await turn(); assert.deepEqual(starts.slice(-2), ['foreground second', 'background 2']);
    gates[0].resolve(); gates[2].resolve(); assert.deepEqual(await background, [0, 1, 2]);
    assert.equal(workers.length, 2); assert.equal(pool.peak, 2);
  } finally { await pool.dispose(); }
});

test('one worker interleaves prioritized exploration before the remaining original positions', async () => {
  const gate = deferred(), visits = [];
  const pool = new ReviewWorkerPool({ concurrency: 1, createWorker: () => ({}) });
  try {
    const background = pool.map([0, 1, 2], { run: async (_, item) => {
      visits.push(`original ${item}`); if (item === 0) await gate.promise; return item;
    } });
    await turn();
    const foreground = pool.submit({ priority: 10, run: () => { visits.push('exploration'); return 4; } });
    gate.resolve(); assert.equal(await foreground, 4); assert.deepEqual(await background, [0, 1, 2]);
    assert.deepEqual(visits, ['original 0', 'exploration', 'original 1', 'original 2']);
    assert.equal(pool.peak, 1);
  } finally { await pool.dispose(); }
});

test('aborting a queued foreground lease removes it without cancelling an occupied engine', async () => {
  const workers = [], gate = deferred(), signal = new AbortController(), visits = [];
  const pool = new ReviewWorkerPool({ concurrency: 1, createWorker: index => trackedWorker(index, workers) });
  try {
    const occupied = pool.submit({ run: () => gate.promise }); await turn();
    const obsolete = pool.submit({ signal: signal.signal, priority: 20, run: () => visits.push('obsolete') });
    const rejected = assert.rejects(obsolete, { name: 'AbortError' });
    const latest = pool.submit({ priority: 10, run: () => visits.push('latest') });
    signal.abort(); await rejected;
    assert.equal(pool.pending, 1); assert.equal(workers[0].cancelled, 0); assert.equal(workers[0].disposed, 0);
    gate.resolve('done'); assert.equal(await occupied, 'done'); await latest;
    assert.deepEqual(visits, ['latest']); assert.equal(workers.length, 1);
  } finally { await pool.dispose(); }
});

test('aborting a running foreground lease touches only its engine and waits for cleanup before reusing the slot', async () => {
  const workers = [], runGate = deferred(), peerGate = deferred(), cleanupGate = deferred(), starts = [];
  const signal = new AbortController(); let first = true;
  const pool = new ReviewWorkerPool({ concurrency: 2, createWorker: index => {
    const worker = trackedWorker(index, workers);
    if (index === 0 && first) {
      first = false; worker.dispose = function () { this.disposed++; return cleanupGate.promise; };
    }
    return worker;
  } });
  try {
    const foreground = pool.submit({ signal: signal.signal, run: () => { starts.push('foreground'); return runGate.promise; } });
    const rejected = assert.rejects(foreground, { name: 'AbortError' });
    const peer = pool.submit({ run: () => { starts.push('peer'); return peerGate.promise; } });
    await turn();
    const next = pool.submit({ priority: 10, run: () => { starts.push('next'); return 3; } });
    signal.abort();
    assert.equal(workers[0].cancelled, 1); assert.equal(workers[0].disposed, 1);
    assert.equal(workers[1].cancelled, 0); assert.equal(workers[1].disposed, 0);
    runGate.resolve('obsolete'); await turn(); assert.deepEqual(starts, ['foreground', 'peer']);
    assert.equal(pool.running, 2); assert.equal(workers.length, 2);
    cleanupGate.resolve(); await rejected; assert.equal(await next, 3);
    assert.deepEqual(starts, ['foreground', 'peer', 'next']); assert.equal(workers.length, 3);
    assert.equal(pool.workers.size, 2); assert.equal(pool.peak, 2);
    peerGate.resolve(2); assert.equal(await peer, 2);
  } finally { cleanupGate.resolve(); runGate.resolve(); peerGate.resolve(); await pool.dispose(); }
});

test('engine changes dispose the prior configuration before constructing the replacement in the same slot', async () => {
  const oldCleanup = deferred(), created = [], events = []; let live = 0, peak = 0;
  const factory = key => () => {
    created.push(key); events.push(`create ${key}`); live++; peak = Math.max(peak, live);
    return { key, async dispose() {
      events.push(`dispose ${key}`); if (key === 'lite') await oldCleanup.promise; live--;
    } };
  };
  const pool = new ReviewWorkerPool({ concurrency: 1, createWorker: factory('lite') });
  try {
    assert.equal(await pool.submit({ workerKey: 'lite', run: worker => worker.key }), 'lite');
    assert.equal(await pool.submit({ workerKey: 'lite', run: worker => worker.key }), 'lite');
    const full = pool.submit({ workerKey: 'full', createWorker: factory('full'), run: worker => worker.key });
    await turn(); assert.deepEqual(events, ['create lite', 'dispose lite']); assert.equal(live, 1);
    oldCleanup.resolve(); assert.equal(await full, 'full');
    assert.deepEqual(created, ['lite', 'full']); assert.equal(peak, 1); assert.equal(pool.workers.size, 1);
  } finally { oldCleanup.resolve(); await pool.dispose(); }
  assert.equal(live, 0); assert.equal(pool.workers.size, 0);
});

test('an isolated failed map drains its own leases while foreground and later phases remain usable', async () => {
  const gates = [deferred(), deferred()], workers = [], starts = [], error = new Error('background failure');
  const pool = new ReviewWorkerPool({ concurrency: 2, createWorker: index => trackedWorker(index, workers) });
  try {
    let settled = false;
    const background = pool.map([0, 1, 2], { isolateFailures: true,
      run: (_, item) => { starts.push(`background ${item}`); return gates[item].promise; },
    });
    const rejected = assert.rejects(background, failure => failure === error).then(() => { settled = true; });
    await turn();
    const foreground = pool.submit({ priority: 10, run: () => { starts.push('foreground'); return 4; } });
    gates[1].reject(error); await turn();
    assert.equal(settled, false); assert.equal(pool.closed, false);
    assert.equal(await foreground, 4); assert.ok(!starts.includes('background 2'));
    gates[0].resolve('late'); await rejected;
    assert.ok(workers.slice(0, 2).every(worker => worker.cancelled === 1 && worker.disposed === 1));
    assert.deepEqual(await pool.map([5, 6], { isolateFailures: true, run: (_, item) => item }), [5, 6]);
  } finally { gates[0].resolve(); await pool.dispose(); }
});

test('shrinking the shared limit counts retiring high slots before assigning a newly free low slot', async () => {
  const gates = [deferred(), deferred(), deferred()], workers = [], starts = [];
  const pool = new ReviewWorkerPool({ concurrency: 3, createWorker: index => trackedWorker(index, workers) });
  try {
    const background = pool.map([0, 1, 2, 3], { run: async (_, item) => {
      starts.push(item); if (item < 3) await gates[item].promise; return item;
    } });
    await turn(); pool.setConcurrency(1);
    gates[0].resolve(); await turn(); assert.deepEqual(starts, [0, 1, 2]); assert.equal(pool.running, 2);
    gates[1].resolve(); await turn(); assert.deepEqual(starts, [0, 1, 2]); assert.equal(pool.running, 1);
    gates[2].resolve(); assert.deepEqual(await background, [0, 1, 2, 3]);
    assert.deepEqual(starts, [0, 1, 2, 3]); assert.equal(pool.workers.size, 1);
    assert.ok(workers.filter(worker => worker.index > 0).every(worker => worker.disposed === 1));
    assert.throws(() => pool.setConcurrency(9), RangeError);
  } finally { gates.forEach(gate => gate.resolve()); await pool.dispose(); }
});

test('raising the shared limit launches only the added capacity and never duplicates an engine lease', async () => {
  const gates = [deferred(), deferred(), deferred()], starts = [];
  const pool = new ReviewWorkerPool({ concurrency: 1, createWorker: index => ({ index }) });
  try {
    const background = pool.map([0, 1, 2], { run: async (worker, item) => {
      starts.push([worker.index, item]); await gates[item].promise; return item;
    } });
    await turn(); assert.deepEqual(starts, [[0, 0]]);
    pool.setConcurrency(2); await turn(); assert.deepEqual(starts, [[0, 0], [1, 1]]);
    gates[0].resolve(); await turn(); assert.deepEqual(starts.at(-1), [0, 2]); assert.equal(pool.peak, 2);
    gates[1].resolve(); gates[2].resolve(); await background;
  } finally { gates.forEach(gate => gate.resolve()); await pool.dispose(); }
});
