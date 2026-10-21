import { reviewGame } from './game-review.js';

const noop = () => {};

function searchSnapshot(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(searchSnapshot));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, searchSnapshot(item)])));
  }
  return value;
}

// The whole-game job belongs to its game and result map, not the currently
// displayed tab, board cursor, or foreground engine generation.
export class BackgroundReview {
  constructor({ run = reviewGame, onStart = noop, onResult = noop,
    onComplete = noop, onError = noop, onSettled = noop } = {}) {
    this.run = run;
    this.callbacks = { onStart, onResult, onComplete, onError, onSettled };
    this.current = null;
    this.sequence = 0;
    this.drain = Promise.resolve();
  }

  get active() { return this.current; }

  stop() {
    const job = this.current;
    if (job) {
      this.current = null;
      job.abort.abort();
    }
    return job;
  }

  async start(spec) {
    const captured = Object.freeze({ ...spec, results: spec.results ?? new Map(),
      options: searchSnapshot(spec.options),
      comparisonOptions: searchSnapshot(spec.comparisonOptions ?? spec.options) });
    this.stop();
    const previous = this.drain;
    const job = { ...captured, spec: captured, id: ++this.sequence,
      abort: new AbortController(), analyzed: 0, reviewed: 0, status: 'waiting' };
    this.current = job;
    const isActive = () => this.current === job && !job.abort.signal.aborted;
    const pending = (async () => {
      try {
        // A replacement is visible immediately, but starts no workers until
        // the superseded run has returned and disposed all of its workers.
        await previous;
        if (!isActive()) return null;
        job.status = 'running';
        await this.callbacks.onStart(job);
        if (!isActive()) return null;
        const { game, ...configuration } = captured;
        const outcome = await this.run(game, { ...configuration, signal: job.abort.signal,
          onResult: (result, index, phase) => {
            if (!isActive()) return;
            captured.results.set(index, result);
            if (phase === 'position') job.analyzed++;
            if (phase === 'review') job.reviewed++;
            return this.callbacks.onResult(job, result, index, phase);
          } });
        if (!isActive()) return null;
        job.status = 'complete';
        await this.callbacks.onComplete(job, outcome);
        return outcome;
      } catch (error) {
        if (!isActive()) return null;
        job.error = error;
        job.status = 'error';
        await this.callbacks.onError(job, error);
        return null;
      } finally {
        if (job.abort.signal.aborted) job.status = 'cancelled';
        if (this.current === job) this.current = null;
        await this.callbacks.onSettled(job);
      }
    })();
    job.promise = pending;
    // Callback failures must not strand a later replacement behind a rejected
    // drain promise. The original start still reports such callback errors.
    this.drain = pending.catch(noop);
    return pending;
  }
}
