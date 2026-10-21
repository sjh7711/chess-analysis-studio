import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingOnlineSnapshot } from '../src/online-game-cache.js';
import { parseGame, gameAt, uciMove, hasMoveReview } from '../src/chess-core.js';
import { restoreResults } from '../src/study.js';
import { analysisKey, gameReviewOptions, normalizePerformance } from '../src/engine-options.js';
import { reviewGame } from '../src/game-review.js';
import { analyzeForeground } from '../src/foreground-analysis.js';

const game = parseGame('[White "Old white"]\n[Black "Old black"]\n\n1. e4 e5 *');
const performance = normalizePerformance({ reviewMode: 'precise', threads: 1 }, 8, 16);
const options = gameReviewOptions(20, performance);
const configKey = analysisKey('lite', 20, performance, 'game');
const isCached = result => result?.configKey === configKey && !result.overview;
const cp = value => ({ type: 'cp', value });

function primary(index) {
  const chess = gameAt(game, index);
  const bestmove = uciMove(game.moves[index] ?? chess.moves({ verbose: true })[0]);
  return { searchMode: 'depth', depth: 20, requestedDepth: 20, configKey,
    score: cp(0), bestmove, overview: false, multipvComplete: true,
    lines: [{ multipv: 1, depth: 20, score: cp(0), pv: [bestmove] }] };
}

function snapshot() {
  const results = game.positions.map((_, index) => [index, primary(index)]);
  for (let index = 1; index < results.length; index++) {
    const before = results[index - 1][1], move = game.moves[index - 1];
    results[index][1].moveReview = { version: 1, fen: move.before, uci: uciMove(move),
      configKey, beforeDepth: before.depth, beforeBestmove: before.bestmove,
      beforeScore: before.score, score: before.score, depth: before.depth,
      source: 'best', pv: [uciMove(move)], sacrificeReview: { version: 1,
        fen: move.after, rootFen: move.before, uci: uciMove(move), configKey,
        requestedDepth: 16, restrictedMoves: [], branches: [], status: 'not-eligible' } };
  }
  return JSON.parse(JSON.stringify({ analysisVersion: 2, input: game.input, kind: 'pgn',
    engine: 'Stockfish 19 Lite', depth: '20', performance, index: 1, results }));
}

test('fresh online headers and comments retain the exact history cache and selected move', () => {
  const saved = snapshot(), original = structuredClone(saved);
  const fetched = parseGame('[White "Current white"]\n[Black "Current black"]\n[Date "2026.10.22"]\n\n1. e4 {updated engine comment} e5 *');
  assert.equal(matchingOnlineSnapshot(fetched, saved), saved);
  assert.equal(saved.index, 1);
  assert.equal(fetched.headers.White, 'Current white');
  assert.equal(fetched.headers.Black, 'Current black');
  assert.equal(fetched.headers.Date, '2026.10.22');
  assert.notEqual(fetched.input, saved.input, 'the fetched game remains the source of current metadata');
  assert.deepEqual(saved, original, 'matching must not rewrite the persisted analysis');
});

test('identical final positions reached through different complete histories do not match', () => {
  const first = parseGame('1. Nf3 Nf6 2. Ng1 Ng8 *');
  const second = parseGame('1. Nc3 Nc6 2. Nb1 Nb8 *');
  assert.equal(first.positions.at(-1), second.positions.at(-1));
  assert.equal(matchingOnlineSnapshot(second, { input: first.input, kind: first.kind }), null);
  for (const pgn of ['1. e4 *', '1. e4 e5 2. Nf3 *', '1. e4 c5 *'])
    assert.equal(matchingOnlineSnapshot(parseGame(pgn), snapshot()), null);
});

test('all starting FEN fields and promotion choices are part of the cache identity', () => {
  const fen = game.startFen;
  const saved = { input: fen, kind: 'fen', results: [] };
  assert.equal(matchingOnlineSnapshot(parseGame(fen, 'fen'), saved), saved);
  for (const changed of [fen.replace('0 1', '1 1'), fen.replace('0 1', '0 2'), fen.replace('KQkq', 'KQ')])
    assert.equal(matchingOnlineSnapshot(parseGame(changed, 'fen'), saved), null);
  const setup = '[SetUp "1"]\n[FEN "8/P6k/8/8/8/8/8/4K3 w - - 0 1"]\n\n';
  const queen = parseGame(setup + '1. a8=Q *');
  const knight = parseGame(setup + '1. a8=N *');
  assert.equal(queen.moves[0].from, knight.moves[0].from);
  assert.equal(queen.moves[0].to, knight.moves[0].to);
  assert.equal(matchingOnlineSnapshot(knight, { input: queen.input, kind: 'pgn' }), null);
});

test('missing, malformed, and unsupported snapshots fall back to a fresh online game', () => {
  for (const saved of [null, {}, { input: 42 }, { input: '' }, { input: '1. e9 *' },
    { input: game.input, kind: 'unsupported' }, { input: '[Variant "Atomic"]\n\n1. e4 e5 *' }])
    assert.equal(matchingOnlineSnapshot(game, saved), null);
  assert.ok(matchingOnlineSnapshot(game, { input: game.input }), 'legacy missing-kind PGN snapshots still match');
});

test('a completed matching snapshot needs no foreground or whole-game engine searches on reload', async () => {
  const saved = matchingOnlineSnapshot(game, snapshot());
  const results = restoreResults(saved, game.positions.length);
  const before = results.get(saved.index - 1), cached = results.get(saved.index);
  const worker = { analyze() { assert.fail('a completed foreground cache must not be recomputed'); } };
  const foreground = await analyzeForeground(worker, { parent: gameAt(game, saved.index - 1),
    chess: gameAt(game, saved.index), move: game.moves[saved.index - 1], before, cached,
    options, configKey, isCached });
  assert.deepEqual(foreground.result, cached);
  const outcome = await reviewGame(game, { results, options, configKey, isCached,
    createEngine() { assert.fail('a completed game must not allocate an engine'); } });
  assert.equal(outcome.analyzed, 0);
  assert.equal(outcome.reviewed, 0);
  assert.deepEqual([...outcome.results], saved.results);
  for (let index = 1; index < game.positions.length; index++)
    assert.ok(hasMoveReview(outcome.results.get(index - 1), outcome.results.get(index), game.moves[index - 1]));
});

test('an unfinished matching snapshot resumes only its missing root and comparison', async () => {
  const saved = snapshot(); saved.results.pop();
  assert.equal(matchingOnlineSnapshot(game, saved), saved);
  const results = restoreResults(saved, game.positions.length), calls = [];
  const preserved = structuredClone([...results]);
  const outcome = await reviewGame(game, { results, options, configKey, isCached,
    createEngine: () => ({ reset() {}, async analyze(chess, settings) {
      const index = chess.history().length;
      calls.push({ index, depth: settings.depth });
      return primary(index);
    } }) });
  assert.deepEqual(calls, [{ index: 2, depth: 20 }]);
  assert.equal(outcome.analyzed, 1);
  assert.equal(outcome.reviewed, 1);
  assert.deepEqual([...results], preserved, 'the existing cache is not cleared to resume');
  assert.ok(hasMoveReview(outcome.results.get(1), outcome.results.get(2), game.moves[1]));
  assert.equal(saved.index, 1);
});

test('matching history does not bypass the existing engine and search-policy validation', async () => {
  const wrongEngine = snapshot(); wrongEngine.engine = 'Stockfish 19';
  assert.equal(matchingOnlineSnapshot(game, wrongEngine), wrongEngine);
  assert.equal(restoreResults(wrongEngine, game.positions.length).size, 0);
  for (const changedKey of [analysisKey('lite', 16, performance, 'game'),
    analysisKey('lite', 20, { ...performance, hash: 64 }, 'game'),
    analysisKey('lite', 20, { ...performance, multipv: 1 }, 'game'),
    configKey.replace('review-v8', 'review-v7')]) {
    const saved = snapshot();
    for (const [, result] of saved.results) result.configKey = changedKey;
    const matching = matchingOnlineSnapshot(game, saved);
    const restored = restoreResults(matching, game.positions.length);
    assert.equal([...restored.values()].some(isCached), false);
    const calls = [];
    const outcome = await reviewGame(game, { results: restored, options, configKey, isCached,
      createEngine: () => ({ reset() {}, async analyze(chess) {
        const index = chess.history().length; calls.push(index); return primary(index);
      } }) });
    assert.deepEqual(calls, [0, 1, 2]);
    assert.equal(outcome.analyzed, game.positions.length);
    assert.ok([...outcome.results.values()].every(isCached));
  }
});
