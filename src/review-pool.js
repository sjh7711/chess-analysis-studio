const MAX_REVIEW_WORKERS = 8;
const cancelled = () => new DOMException('Cancelled', 'AbortError');
const abortReason = signal => signal?.reason ?? cancelled();

// Parallelize independent positions instead of making several engine threads
// search the same tree. Engines and their hash tables survive between map calls.
export class ReviewWorkerPool {
  constructor({ concurrency = 6, createWorker, signal } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_REVIEW_WORKERS) {
      throw new RangeError(`Review concurrency must be between 1 and ${MAX_REVIEW_WORKERS}.`);
    }
    if (typeof createWorker !== 'function') throw new TypeError('A review worker factory is required.');
    this.concurrency = concurrency;
    this.createWorker = createWorker;
    this.controller = new AbortController();
    this.workers = [];
    this.slots = [];
    this.cleanupErrors = [];
    this.active = false;
    this.closed = false;
    this.failure = undefined;
    this.signal = signal;
    this.onAbort = () => this.stop(abortReason(signal));
    signal?.addEventListener('abort', this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }

  release(state, cancel = false) {
    if (state.released) return state.released;
    // Mark it before calling user cleanup, which could itself trigger abort.
    state.released = Promise.resolve();
    if (cancel) {
      try { state.worker.cancel?.(); } catch (error) { this.cleanupErrors.push(error); }
    }
    try {
      state.released = Promise.resolve(state.worker.dispose?.()).catch(error => { this.cleanupErrors.push(error); });
    } catch (error) { this.cleanupErrors.push(error); }
    return state.released;
  }

  stop(error = cancelled(), cancel = true) {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.signal?.removeEventListener('abort', this.onAbort);
    this.controller.abort(error);
    for (const state of this.workers) this.release(state, cancel);
  }

  async workerAt(index) {
    if (!this.slots[index]) {
      this.slots[index] = Promise.resolve().then(() => {
        if (this.closed) throw this.failure;
        return this.createWorker(index, this.controller.signal);
      }).then(async worker => {
        if (!worker || typeof worker !== 'object') throw new TypeError('The review worker factory must return a worker.');
        const state = { worker, released: null };
        this.workers.push(state);
        if (this.closed) { await this.release(state, true); throw this.failure; }
        return state;
      });
    }
    return this.slots[index];
  }

  async map(items, { run, onResult } = {}) {
    if (!Array.isArray(items)) throw new TypeError('Review items must be an array.');
    if (typeof run !== 'function') throw new TypeError('A review job function is required.');
    if (onResult !== undefined && typeof onResult !== 'function') throw new TypeError('onResult must be a function.');
    if (this.closed) throw this.failure;
    if (this.active) throw new Error('A review pool phase is already running.');
    if (!items.length) return [];
    this.active = true;
    const results = new Array(items.length);
    let nextIndex = 0;

    const consume = async workerIndex => {
      try {
        const { worker } = await this.workerAt(workerIndex);
        while (!this.closed && nextIndex < items.length) {
          const index = nextIndex++;
          const item = items[index];
          const result = await run(worker, item, index, this.controller.signal);
          if (this.closed) break;
          results[index] = result;
          // Completion order may differ from input order. Use the original index
          // to store results and wait for adjacent positions before grading.
          await onResult?.(result, index, item);
        }
      } catch (error) { this.stop(error); }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(this.concurrency, items.length) }, (_, index) => consume(index)));
      if (this.closed) throw this.failure;
      return results;
    } finally { this.active = false; }
  }

  async dispose() {
    this.stop(cancelled(), this.active);
    // Include pending factories, so an engine finishing initialization after an
    // abort is disposed too, rather than escaping the pool's resource bound.
    await Promise.allSettled(this.slots);
    await Promise.all(this.workers.map(state => this.release(state)));
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
