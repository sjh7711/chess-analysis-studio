import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeForeground } from '../src/foreground-analysis.js';
import { ReviewWorkerPool } from '../src/review-pool.js';
import { parseGame, gameAt, positionCommand, hasMoveReview, uciMove } from '../src/chess-core.js';

const game = parseGame('1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 a6 *');
const options = { searchMode: 'depth', depth: 10, multipv: 1 };
const configKey = 'foreground-fixed-depth';
const cp = value => ({ type: 'cp', value });
const turn = () => new Promise(setImmediate);
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const isCached = result => result?.configKey === configKey && result.depth === options.depth;
const context = extra => ({ parent: gameAt(game, 7), chess: gameAt(game, 8), move: game.moves[7],
  options, configKey, isCached, ...extra });

function fakeEngine({ beforeSearch = async () => {}, beforeReset = async () => {} } = {}) {
  const calls = [], events = [];
  const worker = {
    async reset() { events.push('reset'); await beforeReset(); },
    async analyze(chess, settings) {
      const restricted = Boolean(settings.searchMoves);
      const kind = restricted ? 'comparison' : chess.history().length === 7 ? 'parent' : 'child';
      const command = positionCommand(chess);
      const call = { kind, command, fen: chess.fen(), settings };
      calls.push(call); events.push(kind);
      await beforeSearch(call);
      const bestmove = restricted ? settings.searchMoves[0] : kind === 'parent' ? 'd7d5' : 'g1f3';
      const score = cp(kind === 'parent' ? 0 : 100);
      return { searchMode: 'depth', score, depth: settings.depth, bestmove, multipvComplete: true,
        lines: [{ multipv: 1, score, depth: settings.depth, pv: [bestmove] }] };
    },
    cancel() {}, dispose() {},
  };
  return { worker, calls, events };
}

test('an uncached branch parent, child, and real move comparison complete inside one exclusive foreground lease', async () => {
  const parentGate = deferred(), settings = context();
  const fake = fakeEngine({ beforeSearch: async call => { if (call.kind === 'parent') await parentGate.promise; } });
  let workers = 0;
  const pool = new ReviewWorkerPool({ concurrency: 1, createWorker: () => { workers++; return fake.worker; } });
  try {
    const pending = pool.submit({ priority: 10, run: (worker, signal) => analyzeForeground(worker, { ...settings, signal }) });
    await turn();
    let backgroundStarted = false;
    const background = pool.submit({ priority: 0, run: async () => {
      backgroundStarted = true; fake.events.push('background');
    } });
    assert.equal(backgroundStarted, false);
    parentGate.resolve();
    const output = await pending;
    await background;
    assert.equal(workers, 1);
    assert.deepEqual(fake.events, ['reset', 'parent', 'reset', 'child', 'comparison', 'background'],
      'another pool job cannot interleave between a parent evaluation and its move comparison');
    assert.deepEqual(fake.calls.map(call => call.kind), ['parent', 'child', 'comparison']);
    assert.equal(fake.calls[0].command, positionCommand(settings.parent));
    assert.equal(fake.calls[1].command, positionCommand(settings.chess));
    assert.equal(fake.calls[2].command, positionCommand(settings.parent));
    assert.match(fake.calls[0].command, /moves g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1$/,
      'the repeated positions remain in the engine input rather than being reconstructed from a FEN');
    assert.deepEqual(fake.calls[2].settings.searchMoves, [uciMove(settings.move)]);
    assert.equal(output.before.configKey, configKey);
    assert.equal(output.before.requestedDepth, options.depth);
    assert.equal(output.result.configKey, configKey);
    assert.equal(output.result.moveReview.source, 'search');
    assert.equal(hasMoveReview(output.before, output.result, settings.move), true);
    assert.equal(output.result.score.value, 100, 'the child graph score survives root-based move grading');
    assert.equal(settings.parent.fen(), settings.move.before);
    assert.equal(settings.chess.fen(), settings.move.after);
    assert.equal(settings.parent.history().length, 7);
    assert.equal(settings.chess.history().length, 8);
  } finally { parentGate.resolve(); await pool.dispose(); }
});

test('a cached graded branch reuses both roots and confidence evidence without another search or mutating the cache', async () => {
  const fake = fakeEngine(), settings = context();
  const completed = await analyzeForeground(fake.worker, settings);
  const snapshot = JSON.stringify(completed), searches = fake.calls.length, resets = fake.events.filter(event => event === 'reset').length;
  const reused = await analyzeForeground(fake.worker, context({ before: completed.before, cached: completed.result }));
  assert.equal(fake.calls.length, searches);
  assert.equal(fake.events.filter(event => event === 'reset').length, resets);
  assert.deepEqual(reused, completed);
  assert.equal(JSON.stringify(completed), snapshot, 'review helpers do not mutate the stored parent or child');
  assert.equal(hasMoveReview(reused.before, reused.result, settings.move), true);
});

test('forcing a branch refresh keeps a valid parent and searches only the child and its played-root comparison', async () => {
  const fake = fakeEngine(), settings = context();
  const completed = await analyzeForeground(fake.worker, settings);
  fake.calls.length = 0; fake.events.length = 0;
  const output = await analyzeForeground(fake.worker, context({ before: completed.before, cached: completed.result, force: true }));
  assert.deepEqual(fake.calls.map(call => call.kind), ['child', 'comparison']);
  assert.equal(output.before, completed.before);
  assert.equal(hasMoveReview(output.before, output.result, settings.move), true);
});

test('a stale parent is evaluated even when the child already has a valid completed score', async () => {
  const fake = fakeEngine(), settings = context();
  const completed = await analyzeForeground(fake.worker, settings);
  fake.calls.length = 0;
  const staleParent = { ...completed.before, configKey: 'old-policy' };
  const output = await analyzeForeground(fake.worker, context({ before: staleParent, cached: completed.result }));
  assert.deepEqual(fake.calls.map(call => call.kind), ['parent']);
  assert.equal(output.before.configKey, configKey);
  assert.equal(staleParent.configKey, 'old-policy');
  assert.equal(hasMoveReview(output.before, output.result, settings.move), true);
});

test('aborting while a branch reset or search finishes never publishes a late foreground result', async () => {
  for (const phase of ['reset', 'parent', 'child', 'comparison']) {
    const controller = new AbortController(), gate = deferred(), started = deferred();
    const fake = fakeEngine({
      beforeReset: async () => { if (phase === 'reset') { started.resolve(); await gate.promise; } },
      beforeSearch: async call => { if (call.kind === phase) { started.resolve(); await gate.promise; } },
    });
    const published = [];
    const pending = analyzeForeground(fake.worker, context({ signal: controller.signal }))
      .then(output => { published.push(output); return output; });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await started.promise; controller.abort(); gate.resolve(); await rejected;
    assert.deepEqual(published, [], `${phase} cancellation cannot update the visible branch`);
    assert.deepEqual(fake.calls.map(call => call.kind), phase === 'reset' ? [] :
      phase === 'parent' ? ['parent'] : phase === 'child' ? ['parent', 'child'] : ['parent', 'child', 'comparison']);
  }
});

test('a foreground root without a played move needs only its own evaluation', async () => {
  const fake = fakeEngine(), chess = gameAt(game, 8);
  const output = await analyzeForeground(fake.worker, { chess, options, configKey, isCached });
  assert.equal(output.before, undefined);
  assert.deepEqual(fake.calls.map(call => call.kind), ['child']);
  assert.equal(output.result.configKey, configKey);
  assert.equal(output.result.moveReview, undefined);
});

test('original overview roots retain their policy while precise and overview comparisons use their own options', async () => {
  for(const overview of [false,true]) {
    const fake=fakeEngine();
    const output=await analyzeForeground(fake.worker,context({overview,
      comparisonOptions:{...options,policy:'precise-comparison'},
      overviewOptions:{...options,policy:'overview-comparison'},
    }));
    assert.equal(output.before.overview,overview?true:undefined);
    assert.equal(output.result.overview,overview?true:undefined);
    assert.equal(fake.calls.find(call=>call.kind==='comparison').settings.policy,
      overview?'overview-comparison':'precise-comparison');
    assert.ok(hasMoveReview(output.before,output.result,game.moves[7]));
  }
});
