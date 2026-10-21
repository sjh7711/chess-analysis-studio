import test from 'node:test';
import assert from 'node:assert/strict';
import { explorationChart } from '../src/exploration-chart.js';
import { parseGame, gameAt } from '../src/chess-core.js';
import { AnalysisLine } from '../src/study.js';

const cp = value => ({ score: { type: 'cp', value } });
const mate = (value, winner = 'w') => ({ score: { type: 'mate', value, winner } });
const game = parseGame('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *');
const evaluations = () => new Map(game.positions.map((_, index) => [index, cp(index * 10)]));

test('an exploration with no new moves retains the scored original history through its starting position', () => {
  const original = evaluations(), line = new AnalysisLine(gameAt(game, 4));
  const chart = explorationChart(game, line, original);
  assert.equal(chart.originIndex, 4); assert.equal(chart.cursor, 4); assert.equal(chart.count, 5);
  assert.deepEqual([...chart.results], [...original].slice(0, 5));
  assert.equal(chart.results.get(4), original.get(4), 'the original base score remains visible before a branch search');
});

test('new branch scores extend the original prefix and keep unknown branch positions as gaps', () => {
  const original = evaluations(), line = new AnalysisLine(gameAt(game, 2), ['g1f3', 'b8c6', 'f1c4']);
  const base = cp(45), last = cp(81);
  line.results.set(0, base); line.results.set(2, undefined); line.results.set(3, last); line.seek(2);
  const chart = explorationChart(game, line, original);
  assert.equal(chart.originIndex, 2); assert.equal(chart.cursor, 4); assert.equal(chart.count, 6);
  assert.deepEqual([...chart.results], [[0, original.get(0)], [1, original.get(1)], [2, base], [5, last]]);
  assert.equal(chart.results.has(3), false); assert.equal(chart.results.has(4), false);
});

test('the original future never leaks into an analyzed branch even when that branch follows recorded moves', () => {
  const original = evaluations(), line = new AnalysisLine(gameAt(game, 2), ['g1f3', 'b8c6']);
  line.results.set(1, cp(-30)); line.seek(1);
  const chart = explorationChart(game, line, original);
  assert.equal(chart.count, 5);
  assert.equal(chart.results.has(4), false, 'the recorded Nc6 score does not stand in for an unsearched branch step');
  assert.equal(chart.results.has(5), false); assert.equal(chart.results.has(6), false);
  assert.equal(chart.results.get(3), line.results.get(1));
});

test('an unmatched base produces only its branch chart rather than unrelated original scores', () => {
  const original = evaluations(), branchBase = gameAt(game, 1); branchBase.move('c5');
  const line = new AnalysisLine(branchBase, ['g1f3']);
  const ownBase = cp(-5), ownStep = cp(0);
  line.results.set(0, ownBase); line.results.set(1, ownStep); line.seek(1);
  const chart = explorationChart(game, line, original);
  assert.equal(chart.originIndex, 0); assert.equal(chart.cursor, 1); assert.equal(chart.count, 2);
  assert.deepEqual([...chart.results], [[0, ownBase], [1, ownStep]]);
});

test('an edited position remains branch-only even if its FEN happens to match an original game position', () => {
  const original = evaluations(), line = new AnalysisLine(gameAt(game, 3));
  line.kind = 'edited';
  const own = cp(17); line.results.set(0, own);
  const chart = explorationChart(game, line, original);
  assert.equal(chart.originIndex, 0); assert.equal(chart.cursor, 0); assert.equal(chart.count, 1);
  assert.deepEqual([...chart.results], [[0, own]]);
});

test('the preferred complete-history index wins over the first occurrence of the same FEN', () => {
  const source = { positions: ['start', 'repeat', 'middle', 'repeat', 'future'] };
  const original = new Map(source.positions.map((_, index) => [index, cp(index)]));
  const line = { base: { fen: () => 'repeat' }, prefixMoves: [1, 2, 3], results: new Map(), cursor: 0, steps: [] };
  const chart = explorationChart(source, line, original);
  assert.equal(chart.originIndex, 3); assert.equal(chart.count, 4); assert.equal(chart.cursor, 3);
  assert.deepEqual([...chart.results.keys()], [0, 1, 2, 3]);
});

test('a mismatched or unavailable history length falls back to an exact FEN match', () => {
  const original = evaluations(), line = new AnalysisLine(gameAt(game, 4));
  line.prefixMoves = [];
  assert.equal(explorationChart(game, line, original).originIndex, 4);
  delete line.prefixMoves;
  assert.equal(explorationChart(game, line, original).originIndex, 4);
});

test('zero centipawns and mate scores remain visible while missing and invalid scores are skipped', () => {
  const original = new Map([[0, cp(0)], [1, {}], [2, { score: undefined }], [3, mate(3)], [4, cp(Infinity)]]);
  const line = new AnalysisLine(gameAt(game, 4), ['f1c4', 'g8f6']);
  line.results.set(0, null); line.results.set(1, mate(0)); line.results.set(2, { score: null });
  const chart = explorationChart(game, line, original);
  assert.deepEqual([...chart.results], [[0, original.get(0)], [3, original.get(3)], [5, line.results.get(1)]]);
  assert.equal(chart.results.get(0).score.value, 0); assert.equal(chart.results.get(5).score.value, 0);
});

test('chart construction never mutates its source game, branch, or either result map', () => {
  const original = evaluations(), line = new AnalysisLine(gameAt(game, 2), ['g1f3', 'b8c6']);
  line.results.set(0, cp(50)); line.results.set(1, cp(60)); line.results.set(99, cp(999)); line.seek(1);
  const positions = [...game.positions], originalEntries = [...original], branchEntries = [...line.results];
  const base = line.base.fen(), steps = structuredClone(line.steps), prefix = structuredClone(line.prefixMoves);
  const chart = explorationChart(game, line, original);
  chart.results.delete(0); chart.results.set(20, cp(400));
  assert.deepEqual(game.positions, positions); assert.deepEqual([...original], originalEntries);
  assert.deepEqual([...line.results], branchEntries); assert.deepEqual(line.steps, steps);
  assert.deepEqual(structuredClone(line.prefixMoves), prefix); assert.equal(line.base.fen(), base); assert.equal(line.cursor, 1);
  assert.equal(chart.results.has(101), false, 'cached entries beyond the current branch length are excluded');
});
