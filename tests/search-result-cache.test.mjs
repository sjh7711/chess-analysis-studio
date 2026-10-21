import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, positionCommand, terminalResult, uciMove } from '../src/chess-core.js';
import { CompletedSearchCache, exactSearchKey, SEARCH_CACHE_REVISION } from '../src/search-result-cache.js';

const query = (changes = {}) => ({engineId:'lite', hash:32, threads:1, searchMode:'depth',
  position:positionCommand(new Chess()), depth:16, multipv:2, ...changes});
function result(chess = new Chess(), {depth = 16, multipv = 2, searchMoves} = {}) {
  const roots = searchMoves ? [...new Set(searchMoves)] : chess.moves({verbose:true}).map(uciMove);
  const lines = roots.slice(0, multipv).map((root, index) => {
    const probe = new Chess(chess.fen()); probe.move(root);
    const reply = probe.moves({verbose:true})[0];
    return {depth, multipv:index + 1, score:{type:'cp', value:30 - index * 10},
      nodes:500 + index, pv:[root, ...(reply ? [uciMove(reply)] : [])]};
  });
  return {score:{...lines[0].score}, depth, requestedDepth:depth, searchMode:'depth',
    multipvComplete:true, bestmove:lines[0].pv[0], engineBestmove:lines[0].pv[0], lines};
}

test('an exact completed result is reusable across consumers without sharing mutable evidence', () => {
  const cache = new CompletedSearchCache(), key = exactSearchKey(query()), raw = result(), expected = structuredClone(raw);
  assert.equal(cache.get(key), undefined); assert.equal(cache.set(key, raw), true);
  raw.score.value = 900; raw.lines[0].pv[0] = 'e1e8';
  const firstConsumer = cache.get(key); assert.deepEqual(firstConsumer, expected);
  firstConsumer.lines[0].score.value = -999; firstConsumer.lines[0].pv.push('a1a8');
  firstConsumer.moveReview = {score:{type:'cp', value:999}};
  assert.deepEqual(cache.get(key), expected);
  assert.deepEqual(cache.metrics, {hits:2, misses:1, writes:1, rejections:0, evictions:0,
    entries:1, bytes:cache.metrics.bytes});
  assert.ok(cache.metrics.bytes > key.length);
});

test('keys distinguish every effective search input, build revision and restricted-root order', () => {
  const cache = new CompletedSearchCache(), original = exactSearchKey(query()); cache.set(original, result());
  assert.ok(original.includes(SEARCH_CACHE_REVISION));
  for (const change of [{engineId:'full'}, {hash:64}, {depth:18}, {multipv:1},
    {revision:'stockfish.js-19.0.0-cold-v2'}, {searchMoves:['e2e4','d2d4']},
    {searchMoves:['d2d4','e2e4']}, {searchMoves:['e2e4','e2e4','d2d4']}]) {
    const different = exactSearchKey(query(change)); assert.notEqual(different, original);
    assert.equal(cache.get(different), undefined);
  }
  assert.notEqual(exactSearchKey(query({searchMoves:['e2e4','d2d4']})),
    exactSearchKey(query({searchMoves:['d2d4','e2e4']})));
});

test('the same final FEN reached with a repetition history never aliases a fresh FEN', () => {
  const history = new Chess(); for (const move of ['Nf3','Nf6','Ng1','Ng8']) history.move(move);
  const fresh = new Chess(history.fen()); assert.equal(history.fen(), fresh.fen());
  const historicalKey = exactSearchKey(query({position:positionCommand(history)}));
  const freshKey = exactSearchKey(query({position:positionCommand(fresh)}));
  assert.notEqual(historicalKey, freshKey);
  const cache = new CompletedSearchCache(); assert.equal(cache.set(historicalKey, result(history)), true);
  assert.equal(cache.get(freshKey), undefined);
  assert.deepEqual(cache.get(historicalKey), result(history));
});

test('time-limited, multithreaded and malformed query configurations are ineligible', () => {
  for (const change of [{searchMode:undefined}, {searchMode:'time'}, {threads:2}, {threads:0},
    {engineId:'unknown'}, {hash:0}, {hash:NaN}, {depth:0}, {depth:129}, {depth:1.5},
    {multipv:0}, {revision:''}, {position:'position startpos'}, {position:'position fen '},
    {searchMoves:[]}, {searchMoves:['e9e4']}, {searchMoves:'e2e4'}]) {
    assert.equal(exactSearchKey(query(change)), null);
  }
});

test('partial, differently deep, bound, cancelled and enriched results are never stored', () => {
  const cache = new CompletedSearchCache(), key = exactSearchKey(query()), valid = result();
  const changes = [{depth:15}, {depth:18}, {requestedDepth:15}, {requestedDepth:undefined},
    {searchMode:'time'}, {multipvComplete:false}, {lowerbound:true}, {upperBound:true},
    {bound:'lower'}, {cancelled:true}, {aborted:true}, {overview:false}, {configKey:'review-v8'},
    {moveReview:{}}, {score:{type:'cp', value:NaN}}, {lines:[valid.lines[0]]},
    {lines:valid.lines.map((line, i) => ({...line, depth:i ? 15 : 16}))},
    {lines:valid.lines.map(line => ({...line, lowerbound:true}))},
    {lines:valid.lines.map(line => ({...line, score:{...line.score, upperbound:true}}))},
    {score:{type:'cp', value:31}}, {bestmove:'e1e8'}, {engineBestmove:'e1e8'}];
  for (const change of changes) {
    assert.equal(cache.set(key, {...structuredClone(valid), ...change}), false);
    assert.equal(cache.get(key), undefined);
  }
  assert.equal(cache.metrics.entries, 0); assert.equal(cache.metrics.rejections, changes.length);
});

test('each complete candidate must have a unique allowed legal root and a legal PV at its own rank', () => {
  const cache = new CompletedSearchCache(), key = exactSearchKey(query()), valid = result();
  for (const edit of [
    lines => {lines[1].pv = [...lines[0].pv];},
    lines => {lines[1].multipv = 1;},
    lines => {lines[1].pv = ['e2e5'];},
    lines => {lines[1].pv = [lines[1].pv[0], 'e7e4'];},
    lines => {lines[1].pv = [];},
    lines => {lines[1].score = {type:'mate', value:3};},
  ]) {
    const malformed = structuredClone(valid); edit(malformed.lines);
    assert.equal(cache.set(key, malformed), false);
  }
  const moves = ['e2e4','d2d4'], restricted = query({searchMoves:moves});
  assert.equal(cache.set(exactSearchKey(restricted), result(new Chess(), restricted)), true);
  assert.equal(cache.set(exactSearchKey(query({searchMoves:['e2e4']})), result()), false);
});

test('requested MultiPV is clipped only to the actual legal restricted-root count', () => {
  const cache = new CompletedSearchCache(), settings = query({multipv:5, searchMoves:['e2e4','e2e4','d2d4']});
  const raw = result(new Chess(), settings);
  assert.equal(raw.lines.length, 2); assert.equal(cache.set(exactSearchKey(settings), raw), true);
  assert.deepEqual(cache.get(exactSearchKey(settings)), raw);
});

test('invalid histories and terminal positions cannot enter the completed-query cache', () => {
  const cache = new CompletedSearchCache(), valid = result();
  for (const position of ['position fen invalid', `${positionCommand(new Chess())} moves e2e5`,
    `${positionCommand(new Chess())} moves e2e4 `, `${positionCommand(new Chess())} moves e2e4 moves e7e5`]) {
    assert.equal(cache.set(exactSearchKey(query({position})), valid), false);
  }
  const terminal = new Chess('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1');
  assert.ok(terminalResult(terminal));
  assert.equal(cache.set(exactSearchKey(query({position:positionCommand(terminal)})), terminalResult(terminal)), false);
  const repeated = new Chess(); for (let i = 0; i < 2; i++) for (const move of ['Nf3','Nf6','Ng1','Ng8']) repeated.move(move);
  assert.equal(repeated.isThreefoldRepetition(), true);
  assert.equal(cache.set(exactSearchKey(query({position:positionCommand(repeated)})), valid), false);
  assert.equal(cache.metrics.entries, 0);
});

test('entry-count eviction follows actual reads rather than insertion order', () => {
  const cache = new CompletedSearchCache({maxEntries:2}), a = exactSearchKey(query()),
    b = exactSearchKey(query({hash:64})), c = exactSearchKey(query({hash:128}));
  assert.equal(cache.set(a, result()), true); assert.equal(cache.set(b, result()), true);
  assert.ok(cache.get(a)); assert.equal(cache.set(c, result()), true);
  assert.equal(cache.get(b), undefined); assert.ok(cache.get(a)); assert.ok(cache.get(c));
  assert.equal(cache.metrics.entries, 2); assert.equal(cache.metrics.evictions, 1);
});

test('byte eviction, replacement and oversized rejection keep accounting bounded', () => {
  const probe = new CompletedSearchCache(), key = exactSearchKey(query()), raw = result();
  probe.set(key, raw); const size = probe.metrics.bytes;
  const cache = new CompletedSearchCache({maxBytes:size * 2}), other = exactSearchKey(query({hash:64}));
  assert.equal(cache.set(key, raw), true); assert.equal(cache.set(other, raw), true);
  assert.ok(cache.metrics.bytes <= size * 2);
  const replacement = {...raw, note:'larger result'};
  assert.equal(cache.set(other, replacement), true); assert.equal(cache.metrics.entries, 1);
  assert.equal(cache.get(key), undefined); assert.ok(cache.get(other));
  const previousBytes = cache.metrics.bytes, huge = {...raw, note:'가'.repeat(size)};
  assert.equal(cache.set(other, huge), false); assert.equal(cache.metrics.bytes, previousBytes);
  assert.deepEqual(cache.get(other), replacement);
});

test('metrics are independent snapshots and clearing removes results and accounting', () => {
  const cache = new CompletedSearchCache(), key = exactSearchKey(query()); cache.set(key, result()); cache.get(key);
  const metrics = cache.metrics; metrics.entries = 900; metrics.hits = 900;
  assert.equal(cache.metrics.entries, 1); assert.equal(cache.metrics.hits, 1);
  cache.clear(); assert.deepEqual(cache.metrics, {hits:0, misses:0, writes:0, rejections:0, evictions:0, entries:0, bytes:0});
  assert.equal(cache.get(key), undefined);
});

test('invalid cache limits and uncloneable results fail safely', () => {
  for (const limits of [{maxEntries:0}, {maxEntries:1.5}, {maxBytes:0}, {maxBytes:Infinity}])
    assert.throws(() => new CompletedSearchCache(limits), RangeError);
  const cache = new CompletedSearchCache(), key = exactSearchKey(query());
  assert.equal(cache.set(key, {...result(), callback(){}}), false);
  assert.equal(cache.set(null, result()), false);
  assert.equal(cache.set('not a query key', result()), false);
  assert.equal(cache.metrics.entries, 0);
});
