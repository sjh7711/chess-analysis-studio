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
function fakeTimers() {
  let now = 0, sequence = 0;
  const scheduled = new Map();
  return {
    setTimeout(callback, delay) { const id = ++sequence; scheduled.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { scheduled.delete(id); },
    get pending() { return scheduled.size; },
    advance(duration) {
      const end = now + duration;
      while (true) {
        const next = [...scheduled].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next; now = timer.at; scheduled.delete(id); timer.callback();
      }
      now = end;
    },
  };
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

for (const concurrency of [1, 2, 4, 6, 8]) {
  test(`interactive throttling drains intact searches, shares the ${concurrency}-worker cap, and restores original analysis`, async () => {
    const workers = [], timers = fakeTimers(), starts = [], gates = Array.from({ length: concurrency * 2 + 3 }, deferred);
    const foregroundGate = deferred(); let foregroundStarted = false;
    const pool = new ReviewWorkerPool({ concurrency, createWorker: index => trackedWorker(index, workers),
      interactiveBackgroundLimit: 1, interactiveCooldownMs: 350, timers });
    try {
      const background = pool.map(gates.map((_, index) => index), { run: async (_, item) => {
        starts.push(item);
        if (foregroundStarted) assert.ok(pool.backgroundRunning <= 1);
        await gates[item].promise; return item;
      } });
      await turn(); assert.equal(starts.length, concurrency);
      const foreground = pool.submit({ priority: 10, run: async () => {
        foregroundStarted = true; await foregroundGate.promise; return 'exploration';
      } });
      assert.deepEqual(pool.interactiveMetrics, { foreground: 1, backgroundRunning: concurrency,
        backgroundLimit: Math.min(1, concurrency - 1), throttled: true, coolingDown: false });
      assert.ok(workers.every(worker => worker.cancelled === 0 && worker.disposed === 0));
      gates[0].resolve(); await turn(); assert.equal(foregroundStarted, true);
      for (let index = 1; index < concurrency; index++) { gates[index].resolve(); await turn(); }
      assert.equal(pool.backgroundRunning, Math.min(1, concurrency - 1));
      assert.equal(starts.length, concurrency + (concurrency > 1 ? 1 : 0));
      if (concurrency > 1) {
        gates[concurrency].resolve(); await turn();
        assert.equal(pool.backgroundRunning, 1); assert.equal(starts.length, concurrency + 2);
      }
      foregroundGate.resolve(); assert.equal(await foreground, 'exploration'); await turn();
      assert.equal(timers.pending, 1); assert.equal(pool.interactiveMetrics.coolingDown, true);
      const duringCooldown = starts.length;
      timers.advance(349); await turn(); assert.equal(starts.length, duringCooldown);
      foregroundStarted = false;
      timers.advance(1); await turn();
      assert.equal(pool.backgroundRunning, concurrency); assert.equal(pool.interactiveMetrics.throttled, false);
      gates.forEach(gate => gate.resolve());
      assert.deepEqual(await background, gates.map((_, index) => index));
      assert.equal(pool.peak, concurrency); assert.equal(pool.interactiveMetrics.foreground, 0);
      assert.equal(pool.backgroundRunning, 0); assert.ok(workers.every(worker => worker.cancelled === 0));
    } finally { foregroundGate.resolve(); gates.forEach(gate => gate.resolve()); await pool.dispose(); }
    assert.equal(timers.pending, 0);
  });
}

test('interactive foreground priority and FIFO remain intact while background admissions are throttled', async () => {
  const timers = fakeTimers(), visits = [], originalGate = deferred(), firstGate = deferred(), secondGate = deferred();
  const pool = new ReviewWorkerPool({ concurrency: 1, createWorker: () => ({}), interactiveBackgroundLimit: 1,
    interactiveCooldownMs: 350, timers });
  try {
    const background = pool.map([0, 1], { run: async (_, item) => {
      visits.push(`original ${item}`); if (item === 0) await originalGate.promise; return item;
    } });
    await turn();
    const first = pool.submit({ priority: 10, run: async () => { visits.push('first'); await firstGate.promise; return 1; } });
    const second = pool.submit({ priority: 10, run: async () => { visits.push('second'); await secondGate.promise; return 2; } });
    const urgent = pool.submit({ priority: 20, run: () => { visits.push('urgent'); return 3; } });
    originalGate.resolve(); assert.equal(await urgent, 3); await turn();
    assert.deepEqual(visits, ['original 0', 'urgent', 'first']);
    assert.equal(pool.interactiveMetrics.foreground, 2); assert.equal(timers.pending, 0);
    firstGate.resolve(); assert.equal(await first, 1); await turn(); assert.equal(visits.at(-1), 'second');
    secondGate.resolve(); assert.equal(await second, 2); await turn();
    assert.equal(timers.pending, 1); assert.ok(!visits.includes('original 1'));
    timers.advance(350); assert.deepEqual(await background, [0, 1]);
    assert.deepEqual(visits, ['original 0', 'urgent', 'first', 'second', 'original 1']);
  } finally { originalGate.resolve(); firstGate.resolve(); secondGate.resolve(); await pool.dispose(); }
});

test('interactive cooldown bridges sequential foreground requests and resumes background work after the last request', async () => {
  const timers = fakeTimers(), visits = [], foregroundGate = deferred();
  const pool = new ReviewWorkerPool({ concurrency: 1, createWorker: () => ({}), interactiveBackgroundLimit: 1,
    interactiveCooldownMs: 350, timers });
  try {
    assert.equal(await pool.submit({ priority: 10, run: () => 1 }), 1);
    const background = pool.map([0, 1], { run: (_, item) => { visits.push(item); return item; } });
    timers.advance(140); await turn(); assert.deepEqual(visits, []);
    const foreground = pool.submit({ priority: 10, run: () => foregroundGate.promise }); await turn();
    assert.equal(timers.pending, 0); timers.advance(500); await turn(); assert.deepEqual(visits, []);
    foregroundGate.resolve(2); assert.equal(await foreground, 2); await turn();
    assert.equal(timers.pending, 1); timers.advance(349); await turn(); assert.deepEqual(visits, []);
    timers.advance(1); assert.deepEqual(await background, [0, 1]); assert.deepEqual(visits, [0, 1]);
  } finally { foregroundGate.resolve(); await pool.dispose(); }
});

test('cancelling superseded queued foreground work retains remaining foreground demand and later clears the throttle', async () => {
  const timers = fakeTimers(), workers = [], originalGate = deferred(), latestGate = deferred();
  const obsoleteSignal = new AbortController(), latestSignal = new AbortController();
  const pool = new ReviewWorkerPool({ concurrency: 1, createWorker: index => trackedWorker(index, workers),
    interactiveBackgroundLimit: 1, interactiveCooldownMs: 350, timers });
  try {
    const background = pool.map([0, 1], { run: (_, item) => item === 0 ? originalGate.promise : item }); await turn();
    const obsolete = pool.submit({ priority: 10, signal: obsoleteSignal.signal, run: () => assert.fail('obsolete must not run') });
    const rejected = assert.rejects(obsolete, { name: 'AbortError' });
    const latest = pool.submit({ priority: 10, signal: latestSignal.signal, run: () => latestGate.promise });
    const latestRejected = assert.rejects(latest, { name: 'AbortError' });
    obsoleteSignal.abort(); await rejected;
    assert.equal(pool.interactiveMetrics.foreground, 1); assert.equal(timers.pending, 0);
    latestSignal.abort(); await latestRejected;
    assert.equal(pool.interactiveMetrics.foreground, 0); assert.equal(timers.pending, 1);
    assert.ok(workers.every(worker => worker.cancelled === 0));
    originalGate.resolve(0); await turn(); assert.equal(pool.running, 0); assert.equal(pool.pending, 1);
    timers.advance(350); assert.deepEqual(await background, [0, 1]);
  } finally { originalGate.resolve(0); latestGate.resolve(); await pool.dispose(); }
});

test('running foreground cancellation stays throttled through cleanup without aborting original searches', async () => {
  const timers = fakeTimers(), workers = [], foregroundGate = deferred(), cleanupGate = deferred(), originalGate = deferred();
  const signal = new AbortController(); let first = true;
  const pool = new ReviewWorkerPool({ concurrency: 2, interactiveBackgroundLimit: 1, interactiveCooldownMs: 350, timers,
    createWorker: index => {
      const worker = trackedWorker(index, workers);
      if (index === 0 && first) { first = false; worker.dispose = function () { this.disposed++; return cleanupGate.promise; }; }
      return worker;
    } });
  try {
    const foreground = pool.submit({ priority: 10, signal: signal.signal, run: () => foregroundGate.promise });
    const rejected = assert.rejects(foreground, { name: 'AbortError' });
    const background = pool.map([0, 1], { run: (_, item) => item === 0 ? originalGate.promise : item }); await turn();
    signal.abort(); foregroundGate.resolve(); await turn();
    assert.equal(pool.interactiveMetrics.foreground, 1); assert.equal(pool.backgroundRunning, 1);
    assert.equal(timers.pending, 0); assert.equal(workers[1].cancelled, 0);
    cleanupGate.resolve(); await rejected; await turn();
    assert.equal(pool.interactiveMetrics.foreground, 0); assert.equal(timers.pending, 1);
    assert.equal(pool.pending, 1); timers.advance(350); await turn(); assert.equal(pool.pending, 0);
    originalGate.resolve(0); assert.deepEqual(await background, [0, 1]);
  } finally { foregroundGate.resolve(); cleanupGate.resolve(); originalGate.resolve(0); await pool.dispose(); }
});

test('foreground failure restores background capacity and disposal clears a pending cooldown timer', async () => {
  const timers = fakeTimers(), originalGate = deferred(), error = new Error('exploration failed');
  const pool = new ReviewWorkerPool({ concurrency: 2, createWorker: () => ({}), interactiveBackgroundLimit: 1,
    interactiveCooldownMs: 350, timers });
  try {
    const foreground = pool.submit({ priority: 10, run: () => { throw error; } });
    const background = pool.map([0, 1], { run: (_, item) => item === 0 ? originalGate.promise : item });
    await assert.rejects(foreground, failure => failure === error); await turn();
    assert.equal(pool.closed, false); assert.equal(pool.interactiveMetrics.foreground, 0); assert.equal(timers.pending, 1);
    assert.equal(pool.pending, 1); timers.advance(350); await turn(); assert.equal(pool.pending, 0);
    originalGate.resolve(0); assert.deepEqual(await background, [0, 1]);
    assert.equal(await pool.submit({ priority: 10, run: () => 'next exploration' }), 'next exploration');
    assert.equal(timers.pending, 1);
  } finally { originalGate.resolve(0); await pool.dispose(); }
  assert.equal(timers.pending, 0); timers.advance(1000); assert.equal(pool.running, 0);
});

test('resizing interactive capacity recalculates the background allowance without preempting running work', async () => {
  const timers = fakeTimers(), originalGate = deferred(), foregroundGate = deferred(), visits = [];
  const pool = new ReviewWorkerPool({ concurrency: 2, createWorker: () => ({}), interactiveBackgroundLimit: 1,
    interactiveCooldownMs: 350, timers });
  try {
    const foreground = pool.submit({ priority: 10, run: () => foregroundGate.promise });
    const background = pool.map([0, 1, 2], { run: async (_, item) => {
      visits.push(item); if (item === 0) await originalGate.promise; return item;
    } });
    await turn(); pool.setConcurrency(1); assert.equal(pool.interactiveMetrics.backgroundLimit, 0);
    originalGate.resolve(0); await turn(); assert.deepEqual(visits, [0]); assert.equal(pool.running, 1);
    pool.setConcurrency(4); await turn(); assert.deepEqual(visits, [0, 1, 2]);
    assert.equal(pool.interactiveMetrics.backgroundLimit, 1); assert.deepEqual(await background, [0, 1, 2]);
    foregroundGate.resolve(3); assert.equal(await foreground, 3); timers.advance(350); await turn();
    assert.equal(pool.interactiveMetrics.backgroundLimit, 4); assert.equal(pool.interactiveMetrics.throttled, false);
    assert.ok(pool.peak <= 2);
  } finally { originalGate.resolve(0); foregroundGate.resolve(); await pool.dispose(); }
});

test('interactive policy is opt-in and rejects invalid configuration', async () => {
  for (const interactiveBackgroundLimit of [-1, 9, 0.5, NaN, Infinity]) {
    assert.throws(() => new ReviewWorkerPool({ createWorker: () => ({}), interactiveBackgroundLimit }), RangeError);
  }
  for (const interactiveCooldownMs of [-1, NaN, Infinity]) {
    assert.throws(() => new ReviewWorkerPool({ createWorker: () => ({}), interactiveCooldownMs }), RangeError);
  }
  assert.throws(() => new ReviewWorkerPool({ createWorker: () => ({}), timers: {} }), TypeError);
  const timers = fakeTimers(), gate = deferred();
  const pool = new ReviewWorkerPool({ concurrency: 2, createWorker: () => ({}), timers, interactiveCooldownMs: 350 });
  try {
    const foreground = pool.submit({ priority: 10, run: () => gate.promise });
    await turn();
    assert.deepEqual(pool.interactiveMetrics, { foreground: 1, backgroundRunning: 0, backgroundLimit: 2,
      throttled: false, coolingDown: false });
    assert.deepEqual(await pool.map([1, 2], { run: (_, item) => item }), [1, 2]);
    gate.resolve(); await foreground; assert.equal(timers.pending, 0);
  } finally { gate.resolve(); await pool.dispose(); }
});
