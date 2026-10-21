import test from 'node:test';
import assert from 'node:assert/strict';
import { isPositionResultCached } from '../src/analysis-cache.js';
import { analyzeForeground } from '../src/foreground-analysis.js';
import { AnalysisLine } from '../src/study.js';
import { seedExplorationBase } from '../src/exploration-chart.js';
import { parseGame, gameAt, classifyMove, hasMoveReview, hasRankingReview, positionCommand } from '../src/chess-core.js';
import { analysisKey, searchOptions, gameReviewOptions, normalizePerformance } from '../src/engine-options.js';

const game = parseGame('1. a3 h6 2. h3 a6 *');
const parent = gameAt(game, 3), child = gameAt(game, 4), move = game.moves[3];
const performance = normalizePerformance({ threadMode: 'manual', threads: 1, multipv: 3, reviewMode: 'precise' }, 8, 16);
const options = searchOptions(16, performance);
const key = analysisKey('lite', 16, performance);
const gameKey = analysisKey('lite', 16, performance, 'game');
const isCached = result => isPositionResultCached(result, key);
const cp = value => ({ type: 'cp', value });

// Each unrestricted root has a fixed, cold result for its search policy.
// A restricted played move scores better than the root candidates so the
// real reviewMove must also produce and bind a complete ranking confirmation.
function fakeEngine() {
  const calls = [], resets = [];
  const worker = {
    async reset() { resets.push(calls.length); },
    async analyze(chess, settings) {
      calls.push({ command: positionCommand(chess), settings: { ...settings } });
      const restricted = !!settings.searchMoves;
      const root = chess.fen() === parent.fen();
      assert.ok(root || chess.fen() === child.fen());
      const candidates = restricted ? settings.searchMoves
        : root ? ['d7d5', 'e7e5', 'c7c5'] : ['g1f3', 'b1c3', 'g2g3'];
      const scores = restricted ? [-30] : root ? [0, 10, 20] : [-15, -25, -35];
      const lines = candidates.slice(0, settings.multipv).map((uci, index) => ({
        multipv: index + 1, score: cp(scores[index]), depth: settings.depth, pv: [uci],
      }));
      return { searchMode: 'depth', depth: settings.depth, score: lines[0].score,
        bestmove: lines[0].pv[0], multipvComplete: true, lines };
    },
  };
  return { worker, calls, resets };
}

function originalRoot({ fast = false } = {}) {
  const settings = gameReviewOptions(16, { ...performance, reviewMode: fast ? 'fast' : 'precise' });
  return { searchMode: 'depth', depth: settings.depth, requestedDepth: 16,
    configKey: fast ? analysisKey('lite', 16, { ...performance, reviewMode: 'fast' }, 'game') : gameKey,
    overview: fast, score: cp(400), bestmove: 'e7e5', multipvComplete: true,
    lines: ['e7e5', 'd7d5'].map((uci, index) => ({ multipv: index + 1,
      score: cp(400 + index * 10), depth: settings.depth, pv: [uci] })) };
}

async function analyzeLine(line, fake = fakeEngine(), cached) {
  const output = await analyzeForeground(fake.worker, { parent: line.position(0), chess: line.position(1), move,
    before: line.results.get(0), cached, options, configKey: key, isCached });
  const grade = classifyMove(output.before, output.result, move, { moves: game.moves, moveIndex: 3 });
  return { ...output, grade, fake };
}

test('manual-branch cache accepts only its exact position key and rejects overview roots', () => {
  assert.equal(isPositionResultCached(undefined, key), false);
  assert.equal(isPositionResultCached(null, key), false);
  assert.equal(isPositionResultCached({ configKey: key }, key), true);
  assert.equal(isPositionResultCached({ configKey: key, overview: false }, key), true);
  assert.equal(isPositionResultCached({ configKey: key, overview: true }, key), false);
  assert.equal(isPositionResultCached(originalRoot(), key), false);
  assert.equal(isPositionResultCached(originalRoot({ fast: true }), key), false);
  for (const changed of [
    analysisKey('lite', 16, { ...performance, hash: 64 }),
    analysisKey('lite', 16, { ...performance, multipv: 2 }),
    analysisKey('lite', 20, performance),
    analysisKey('full', 16, performance),
  ]) assert.equal(isPositionResultCached({ configKey: changed }, key), false);
});

test('missing, inherited game, seeded fast game, and valid position parents produce identical branch evidence and grades', async () => {
  const firstLine = new AnalysisLine(parent); firstLine.play('a7a6');
  const canonical = await analyzeLine(firstLine);
  assert.equal(canonical.before.configKey, key);
  assert.equal(canonical.result.configKey, key);
  assert.equal(canonical.before.depth, options.depth);
  assert.equal(canonical.before.lines.length, options.multipv);
  assert.equal(canonical.before.score.value, 0);
  assert.ok(hasMoveReview(canonical.before, canonical.result, move));
  assert.ok(hasRankingReview(canonical.before, canonical.result, move, parent));
  assert.equal(canonical.result.moveReview.configKey, key);
  assert.equal(canonical.result.moveReview.rankingReview.configKey, key);
  assert.equal(canonical.result.moveReview.rankingReview.requestedDepth, options.depth);
  assert.equal(canonical.result.moveReview.rankingReview.requestedMultipv, options.multipv);
  assert.equal(canonical.grade.key, 'excellent');
  const sources = new Map([[3, originalRoot()], [4, originalRoot({ fast: true })]]);
  const sourceSnapshot = structuredClone([...sources]);
  for (const scenario of ['inherited game', 'seeded fast game', 'valid position']) {
    const line = new AnalysisLine(parent, [], scenario === 'inherited game' ? sources.get(3)
      : scenario === 'valid position' ? canonical.before : null);
    if (scenario === 'seeded fast game') {
      const seedMap = new Map([[3, sources.get(4)]]);
      assert.equal(seedExplorationBase(game, line, seedMap), true);
      assert.equal(line.results.get(0), sources.get(4));
      assert.equal(line.results.get(0).depth, 14);
    }
    line.play('a7a6');
    const inheritedSnapshot = structuredClone([...line.results]);
    const actual = await analyzeLine(line);
    assert.deepEqual(actual.before, canonical.before, scenario);
    assert.deepEqual(actual.result, canonical.result, scenario);
    assert.deepEqual(actual.grade, canonical.grade, scenario);
    assert.deepEqual([...line.results], inheritedSnapshot, `${scenario} must not mutate its input cache`);
    assert.deepEqual([...sources], sourceSnapshot, `${scenario} must not mutate original-game results`);
    assert.equal(actual.fake.calls.filter(call => !call.settings.searchMoves
      && call.command === positionCommand(parent)).length, scenario === 'valid position' ? 1 : 2,
    'a correct cached parent avoids only the primary root search; ranking still uses the same policy');
  }
});

test('a complete valid position branch reuses its scores and confidence evidence without another search', async () => {
  const line = new AnalysisLine(parent); line.play('a7a6');
  const canonical = await analyzeLine(line);
  const cachedLine = new AnalysisLine(parent, [], canonical.before); cachedLine.play('a7a6');
  const snapshot = structuredClone({ before: canonical.before, result: canonical.result });
  const reused = await analyzeLine(cachedLine, fakeEngine(), canonical.result);
  assert.deepEqual(reused.before, canonical.before);
  assert.deepEqual(reused.result, canonical.result);
  assert.deepEqual(reused.grade, canonical.grade);
  assert.deepEqual(reused.fake.calls, []);
  assert.deepEqual(reused.fake.resets, []);
  assert.deepEqual({ before: canonical.before, result: canonical.result }, snapshot);
});

test('a mismatched cached child is recomputed under the same position policy as its parent', async () => {
  const line = new AnalysisLine(parent); line.play('a7a6');
  const canonical = await analyzeLine(line);
  const cachedLine = new AnalysisLine(parent, [], canonical.before); cachedLine.play('a7a6');
  const stale = { ...canonical.result, configKey: analysisKey('lite', 16, { ...performance, hash: 64 }) };
  const snapshot = structuredClone(stale);
  const actual = await analyzeLine(cachedLine, fakeEngine(), stale);
  assert.deepEqual(actual.result, canonical.result);
  assert.deepEqual(actual.grade, canonical.grade);
  assert.ok(actual.fake.calls.some(call => call.command === positionCommand(child)));
  assert.deepEqual(stale, snapshot);
});

test('terminal scores are reusable across search keys and do not allocate a new search', async () => {
  const terminal = { terminal: '체크메이트', depth: 0, score: { type: 'mate', value: 0, winner: 'w' }, lines: [], bestmove: null };
  assert.equal(isPositionResultCached(terminal, key), true);
  assert.equal(isPositionResultCached({ ...terminal, configKey: gameKey, overview: true }, key), true);
  const fake = fakeEngine();
  const output = await analyzeForeground(fake.worker, { chess: child, cached: terminal,
    options, configKey: key, isCached });
  assert.deepEqual(output.result, terminal);
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(fake.resets, []);
});
