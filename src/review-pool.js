const MAX_REVIEW_WORKERS = 8;
const cancelled = () => new DOMException('Cancelled', 'AbortError');
const abortReason = signal => signal?.reason ?? cancelled();
const DEFAULT_WORKER_KEY = 'default';

function validConcurrency(concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_REVIEW_WORKERS) {
    throw new RangeError(`Review concurrency must be between 1 and ${MAX_REVIEW_WORKERS}.`);
  }
  return concurrency;
}

// One slot owns one engine and one complete search sequence at a time. Higher
// priority work gets the next available slot; running depth searches finish.
export class ReviewWorkerPool {
  constructor({ concurrency = 6, createWorker, signal } = {}) {
    this.concurrency = validConcurrency(concurrency);
    if (typeof createWorker !== 'function') throw new TypeError('A review worker factory is required.');
    this.createWorker = createWorker;
    this.controller = new AbortController();
    this.workers = new Set();
    this.slots = [];
    this.queue = [];
    this.tasks = new Set();
    this.cleanupErrors = [];
    this.active = false;
    this.closed = false;
    this.failure = undefined;
    this.running = 0;
    this.peak = 0;
    this.sequence = 0;
    this.pumpScheduled = false;
    this.signal = signal;
    this.onAbort = () => this.stop(abortReason(signal));
    signal?.addEventListener('abort', this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }

  get pending() { return this.queue.length; }
  get metrics() {
    return { running: this.running, pending: this.pending, peak: this.peak, concurrency: this.concurrency };
  }

  release(state, cancel = false) {
    if (state.released) return state.released;
    // Mark cleanup before invoking worker code, which can synchronously abort.
    let finish;
    state.released = new Promise(resolve => { finish = resolve; });
    const released = () => { this.workers.delete(state); finish(); };
    if (cancel) {
      try { state.worker.cancel?.(); } catch (error) { this.cleanupErrors.push(error); }
    }
    try {
      Promise.resolve(state.worker.dispose?.()).catch(error => { this.cleanupErrors.push(error); }).then(released);
    } catch (error) { this.cleanupErrors.push(error); released(); }
    return state.released;
  }

  setConcurrency(concurrency) {
    this.concurrency = validConcurrency(concurrency);
    for (const slot of this.slots) {
      if (slot && slot.index >= concurrency && !slot.busy && slot.state) {
        const state = slot.state;
        slot.state = null;
        slot.retiring = this.release(state);
      }
    }
    this.schedulePump();
    return this.concurrency;
  }

  stop(error = cancelled(), cancel = true) {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.signal?.removeEventListener('abort', this.onAbort);
    this.controller.abort(error);
    for (const task of [...this.tasks]) this.cancelTask(task, error, cancel);
    for (const state of this.workers) this.release(state, cancel);
  }

  cancelTask(task, error = cancelled(), cancel = true) {
    if (task.settled || task.controller.signal.aborted) return;
    task.controller.abort(error);
    if (task.status === 'queued') {
      const index = this.queue.indexOf(task);
      if (index !== -1) this.queue.splice(index, 1);
      this.finishTask(task, undefined, error, true);
    } else if (task.state) {
      // Discard only this lease's engine, and keep its slot occupied until both
      // the running call and disposal settle. Other leases continue untouched.
      this.release(task.state, cancel);
    }
  }

  finishTask(task, result, error, failed = false) {
    if (task.settled) return;
    task.settled = true;
    task.signal?.removeEventListener('abort', task.onAbort);
    task.group?.delete(task);
    this.tasks.delete(task);
    if (failed) task.reject(error);
    else task.resolve(result);
  }

  submit(spec = {}) {
    try { return this.enqueue(spec); }
    catch (error) { return Promise.reject(error); }
  }

  enqueue({ run, signal, priority = 0, workerKey = DEFAULT_WORKER_KEY, createWorker = this.createWorker }, onFailure, group) {
    if (typeof run !== 'function') throw new TypeError('A review job function is required.');
    if (typeof createWorker !== 'function') throw new TypeError('A review worker factory is required.');
    if (!Number.isFinite(priority)) throw new TypeError('Review priority must be finite.');
    if (this.closed) throw this.failure;
    if (signal?.aborted) throw abortReason(signal);
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const task = {
      run, signal, priority, workerKey, createWorker, onFailure, resolve, reject, promise, group,
      order: this.sequence++, controller: new AbortController(), status: 'queued', settled: false, state: null,
    };
    task.onAbort = () => this.cancelTask(task, abortReason(signal));
    if (group) group.add(task);
    else signal?.addEventListener('abort', task.onAbort, { once: true });
    this.tasks.add(task);
    this.queue.push(task);
    this.queue.sort((a, b) => b.priority - a.priority || a.order - b.order);
    this.schedulePump();
    return promise;
  }

  schedulePump() {
    if (this.closed || this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => { this.pumpScheduled = false; this.pump(); });
  }

  pump() {
    if (this.closed) return;
    for (let index = 0; index < this.concurrency && this.running < this.concurrency && this.queue.length; index++) {
      let slot = this.slots[index];
      if (!slot) this.slots[index] = slot = { index, state: null, retiring: null, busy: false, task: null };
      if (slot.busy) continue;
      const task = this.queue.shift();
      task.status = 'running';
      slot.busy = true;
      slot.task = task;
      this.running++;
      this.peak = Math.max(this.peak, this.running);
      // execute handles every rejection and settles the public task promise.
      slot.execution = this.execute(slot, task);
    }
  }

  async workerAt(slot, task) {
    await slot.retiring;
    if (slot.state && slot.state.workerKey !== task.workerKey) {
      const previous = slot.state;
      slot.state = null;
      await this.release(previous);
    }
    if (task.controller.signal.aborted) throw abortReason(task.controller.signal);
    if (!slot.state) {
      const worker = await task.createWorker(slot.index, task.controller.signal);
      if (!worker || typeof worker !== 'object') throw new TypeError('The review worker factory must return a worker.');
      const state = { worker, workerKey: task.workerKey, released: null };
      this.workers.add(state);
      slot.state = state;
    }
    task.state = slot.state;
    if (task.controller.signal.aborted || this.closed) {
      await this.release(task.state, true);
      throw this.closed ? this.failure : abortReason(task.controller.signal);
    }
    return task.state.worker;
  }

  async execute(slot, task) {
    let result, error, failed = false;
    try {
      const worker = await this.workerAt(slot, task);
      result = await task.run(worker, task.controller.signal);
      if (task.controller.signal.aborted) throw abortReason(task.controller.signal);
    } catch (caught) {
      failed = true;
      error = task.controller.signal.aborted ? abortReason(task.controller.signal) : caught;
      // A map can abort its own group before this slot is available again, so
      // a failed phase cannot accidentally start another queued background job.
      try { task.onFailure?.(error); } catch (failure) { this.cleanupErrors.push(failure); }
      if (task.state) await this.release(task.state, true);
    } finally {
      if (task.controller.signal.aborted && task.state) await this.release(task.state, true);
      if (task.state?.released && slot.state === task.state) slot.state = null;
      if ((this.closed || slot.index >= this.concurrency) && slot.state) {
        const state = slot.state;
        slot.state = null;
        await this.release(state);
      }
      slot.busy = false;
      slot.task = null;
      this.running--;
      this.finishTask(task, result, error, failed);
      this.schedulePump();
    }
  }

  async map(items, { run, onResult, signal, priority = 0, workerKey = DEFAULT_WORKER_KEY,
    createWorker = this.createWorker, isolateFailures = false } = {}) {
    if (!Array.isArray(items)) throw new TypeError('Review items must be an array.');
    if (typeof run !== 'function') throw new TypeError('A review job function is required.');
    if (onResult !== undefined && typeof onResult !== 'function') throw new TypeError('onResult must be a function.');
    if (this.closed) throw this.failure;
    if (this.active) throw new Error('A review pool phase is already running.');
    if (signal?.aborted) throw abortReason(signal);
    if (!items.length) return [];
    this.active = true;
    const group = new AbortController();
    const onAbort = () => group.abort(abortReason(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    const results = new Array(items.length), pending = [], members = new Set();
    // One listener per phase also keeps long games from attaching hundreds of
    // task listeners to the same AbortSignal.
    const cancelGroup = () => {
      for (const task of [...members]) this.cancelTask(task, abortReason(group.signal));
    };
    group.signal.addEventListener('abort', cancelGroup, { once: true });
    let failure, failed = false;
    const fail = error => {
      if (!failed) { failure = error; failed = true; }
      if (!group.signal.aborted) group.abort(error);
      if (!isolateFailures) this.stop(error);
    };
    try {
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        pending.push(this.enqueue({ signal: group.signal, priority, workerKey, createWorker,
          run: async (worker, jobSignal) => {
            const result = await run(worker, item, index, jobSignal);
            jobSignal.throwIfAborted();
            results[index] = result;
            await onResult?.(result, index, item);
            jobSignal.throwIfAborted();
            return result;
          },
        }, fail, members));
      }
      const settled = await Promise.allSettled(pending);
      if (failed) throw failure;
      if (signal?.aborted) throw abortReason(signal);
      const rejected = settled.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      return results;
    } catch (error) {
      fail(error);
      // Include all leases, not just the first rejected promise, before a next
      // map phase can begin or a caller can reuse engines after cancellation.
      await Promise.allSettled(pending);
      throw failure;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      group.signal.removeEventListener('abort', cancelGroup);
      this.active = false;
    }
  }

  async dispose() {
    this.stop(cancelled(), this.active || this.running > 0);
    await Promise.allSettled([...this.tasks].map(task => task.promise));
    await Promise.all([...this.workers].map(state => this.release(state)));
    if (this.cleanupErrors.length) throw this.cleanupErrors[0];
  }
}

export async function runReviewPool(items, { run, onResult, ...options } = {}) {
  const pool = new ReviewWorkerPool(options);
  let failed = false;
  try { return await pool.map(items, { run, onResult }); }
  catch (error) { failed = true; throw error; }
  finally {
    try { await pool.dispose(); }
    catch (error) { if (!failed) throw error; }
  }
}
