import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundReview } from '../src/background-review.js';

const turn = () => new Promise(setImmediate);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const spec = (extra = {}) => ({ game: { name: 'original' }, results: new Map(),
  options: { depth: 16, searchMode: 'depth', multipv: 2, hash: 32 },
  comparisonOptions: { depth: 16, searchMode: 'depth', multipv: 3, hash: 32 },
  configKey: 'game:depth16', overview: false, concurrency: 6,
  createEngine() { throw new Error('The orchestration fixture does not create engines.'); },
  ...extra });

test('foreground navigation and exploration changes do not detach the current game review', async () => {
  const gate = deferred(), events = [], foreground = { generation: 1, mode: null, tab: 'moves', cursor: 0 };
  let publish;
  const review = new BackgroundReview({
    run: async (game, options) => {
      publish = options.onResult;
      await gate.promise;
      options.onResult({ score: 3 }, 1, 'review');
      return { analyzed: 1, reviewed: 1, game };
    },
    onResult: (job, _, index, phase) => events.push([job.id, index, phase]),
    onComplete: job => events.push(['complete', job.id]),
  });
  const input = spec(), pending = review.start(input), job = review.active;
  await turn();
  publish({ score: 2 }, 0, 'position');
  Object.assign(foreground, { generation: 19, mode: 'explanation', tab: 'study', cursor: 7 });
  foreground.tab = 'review';
  gate.resolve();
  const outcome = await pending;
  assert.equal(outcome.game, input.game);
  assert.equal(review.active, null);
  assert.equal(job.results, input.results);
  assert.deepEqual([...input.results], [[0, { score: 2 }], [1, { score: 3 }]]);
  assert.equal(job.analyzed, 1); assert.equal(job.reviewed, 1);
  assert.deepEqual(events, [[job.id, 0, 'position'], [job.id, 1, 'review'], ['complete', job.id]]);
  assert.deepEqual(foreground, { generation: 19, mode: 'explanation', tab: 'review', cursor: 7 });
});

test('a requested job captures and deeply freezes search policy before UI settings can change', async () => {
  const input = spec({ options: { depth: 16, searchMoves: ['e2e4'], nested: { budget: 7 } } });
  let received;
  const review = new BackgroundReview({ run: async (game, options) => { received = { game, options }; return 'done'; } });
  const pending = review.start(input), job = review.active;
  input.options.depth = 24; input.options.searchMoves.push('d2d4'); input.options.nested.budget = 99;
  input.comparisonOptions.depth = 12; input.concurrency = 1; input.configKey = 'changed';
  await pending;
  assert.deepEqual(received.options.options, { depth: 16, searchMoves: ['e2e4'], nested: { budget: 7 } });
  assert.equal(received.options.comparisonOptions.depth, 16);
  assert.equal(received.options.concurrency, 6); assert.equal(received.options.configKey, 'game:depth16');
  assert.equal(received.game, input.game); assert.equal(received.options.results, input.results);
  assert.ok(Object.isFrozen(job.spec)); assert.ok(Object.isFrozen(job.options));
  assert.ok(Object.isFrozen(job.options.searchMoves)); assert.ok(Object.isFrozen(job.options.nested));
  assert.throws(() => { job.options.depth = 20; }, TypeError);
});

test('explicit stop detaches immediately, retains partial results, and suppresses stale publication and completion', async () => {
  const gate = deferred(), events = [];
  let publish;
  const review = new BackgroundReview({
    run: async (_, options) => { publish = options.onResult; await gate.promise; publish('late', 2, 'review'); return 'late outcome'; },
    onResult: (_, result) => events.push(result),
    onComplete: () => events.push('complete'), onError: () => events.push('error'),
    onSettled: job => events.push(['settled', job.id]),
  });
  const input = spec(), pending = review.start(input), job = review.active;
  await turn(); publish('saved', 0, 'position');
  assert.equal(review.stop(), job); assert.equal(review.active, null);
  assert.ok(job.abort.signal.aborted); assert.equal(review.stop(), null);
  gate.resolve(); assert.equal(await pending, null);
  assert.deepEqual([...input.results], [[0, 'saved']]);
  assert.deepEqual(events, ['saved', ['settled', job.id]]);
  assert.equal(job.status, 'cancelled'); assert.equal(job.analyzed, 1); assert.equal(job.reviewed, 0);
});

test('a replacement waits for previous asynchronous cleanup before starting workers', async () => {
  const cleaning = deferred(), cleanup = deferred(), events = [];
  let running = 0, maximum = 0;
  const review = new BackgroundReview({
    run: async (game, options) => {
      running++; maximum = Math.max(maximum, running); events.push(['run', game.name]);
      try {
        if (game.name === 'first') await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
        return game.name;
      } finally {
        if (game.name === 'first') { cleaning.resolve(); await cleanup.promise; }
        running--; events.push(['disposed', game.name]);
      }
    },
    onStart: job => events.push(['start', job.game.name]),
    onComplete: job => events.push(['complete', job.game.name]),
    onSettled: job => events.push(['settled', job.game.name]),
  });
  const first = review.start(spec({ game: { name: 'first' } })); await turn();
  const firstJob = review.active;
  const second = review.start(spec({ game: { name: 'second' } })), secondJob = review.active;
  await cleaning.promise;
  assert.ok(firstJob.abort.signal.aborted); assert.equal(secondJob.status, 'waiting');
  assert.equal(running, 1); assert.deepEqual(events, [['start', 'first'], ['run', 'first']]);
  cleanup.resolve();
  assert.equal(await first, null); assert.equal(await second, 'second');
  assert.equal(maximum, 1); assert.equal(running, 0);
  assert.deepEqual(events, [['start', 'first'], ['run', 'first'], ['disposed', 'first'], ['settled', 'first'],
    ['start', 'second'], ['run', 'second'], ['disposed', 'second'], ['complete', 'second'], ['settled', 'second']]);
});

test('multiple replacements skip superseded waiting jobs and settle each exactly once', async () => {
  const gate = deferred(), starts = [], settled = [];
  const review = new BackgroundReview({
    run: async game => { starts.push(game.name); if (game.name === 'first') await gate.promise; return game.name; },
    onSettled: job => settled.push(job.game.name),
  });
  const first = review.start(spec({ game: { name: 'first' } })); await turn();
  const second = review.start(spec({ game: { name: 'second' } }));
  const third = review.start(spec({ game: { name: 'third' } }));
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), [null, null, 'third']);
  assert.deepEqual(starts, ['first', 'third']); assert.deepEqual(settled, ['first', 'second', 'third']);
  assert.equal(review.active, null);
});

test('genuine active failures report once, clean active state, and allow a new successful job', async () => {
  const failure = new Error('search failed'), events = [];
  const review = new BackgroundReview({
    run: async game => { if (game.name === 'bad') throw failure; return 'success'; },
    onComplete: job => events.push(['complete', job.game.name]),
    onError: (job, error) => events.push(['error', job.game.name, error]),
    onSettled: job => events.push(['settled', job.game.name, job.status]),
  });
  const bad = review.start(spec({ game: { name: 'bad' } })), job = review.active;
  assert.equal(await bad, null); assert.equal(job.error, failure); assert.equal(review.active, null);
  assert.equal(await review.start(spec({ game: { name: 'good' } })), 'success');
  assert.deepEqual(events, [['error', 'bad', failure], ['settled', 'bad', 'error'],
    ['complete', 'good'], ['settled', 'good', 'complete']]);
});

test('abort errors from a detached job do not surface as active job failures', async () => {
  const events = [];
  const review = new BackgroundReview({
    run: async (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    onError: () => events.push('error'), onComplete: () => events.push('complete'), onSettled: () => events.push('settled'),
  });
  const pending = review.start(spec()); await turn(); review.stop();
  assert.equal(await pending, null); assert.deepEqual(events, ['settled']);
});

test('an asynchronous result callback is awaited before the completion notification', async () => {
  const gate = deferred(), events = [];
  const review = new BackgroundReview({
    run: async (_, { onResult }) => { await onResult('root', 0, 'position'); return 'done'; },
    onResult: async () => { events.push('publishing'); await gate.promise; events.push('published'); },
    onComplete: () => events.push('complete'), onSettled: () => events.push('settled'),
  });
  const pending = review.start(spec()); await turn(); assert.deepEqual(events, ['publishing']);
  gate.resolve(); assert.equal(await pending, 'done');
  assert.deepEqual(events, ['publishing', 'published', 'complete', 'settled']);
});

test('publication errors settle without completion and never poison the replacement drain', async () => {
  const failure = new Error('render failed'), errors = [], completed = [];
  const review = new BackgroundReview({
    run: async (_, { onResult }) => { await onResult('root', 0, 'position'); return 'done'; },
    onResult: job => { if (job.game.name === 'bad') throw failure; },
    onError: (_, error) => errors.push(error), onComplete: job => completed.push(job.game.name),
  });
  assert.equal(await review.start(spec({ game: { name: 'bad' } })), null);
  assert.equal(await review.start(spec({ game: { name: 'good' } })), 'done');
  assert.deepEqual(errors, [failure]); assert.deepEqual(completed, ['good']);
});
