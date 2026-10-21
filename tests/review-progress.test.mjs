import test from 'node:test';
import assert from 'node:assert/strict';
import { gameAt, parseGame, terminalResult, uciMove } from '../src/chess-core.js';
import { analysisKey, normalizePerformance } from '../src/engine-options.js';
import { reviewProgress } from '../src/review-progress.js';
import { SAMPLE_PGN } from '../src/sample.js';

const game=parseGame('1. e4 e5 2. Nf3 Nc6 *');
const performance=normalizePerformance({threadMode:'manual',threads:1,multipv:3},8,16);
const gameKey=analysisKey('lite',20,performance,'game');
const positionKey=analysisKey('lite',20,performance,'position');
const accepted=result=>Boolean(result?.terminal||result?.configKey===gameKey&&!result?.overview);

function evaluatedGame(source=game,key=gameKey) {
  return new Map(source.positions.map((_,index)=>[index,{configKey:key,score:{type:'cp',value:index*10},
    depth:20,bestmove:source.moves[index]?uciMove(source.moves[index]):null,lines:[]} ]));
}
function addReview(results,index,source=game) {
  const before=results.get(index-1),after=results.get(index),move=source.moves[index-1],uci=uciMove(move);
  results.set(index,{...after,moveReview:{version:1,fen:move.before,uci,configKey:before.configKey,
    beforeDepth:before.depth,beforeBestmove:before.bestmove,beforeScore:{...before.score},
    score:{type:'cp',value:before.score.value},pv:[uci]}});
}

test('position-policy scores do not falsely report half of a stricter whole-game review as done',()=>{
  assert.notEqual(gameKey,positionKey);
  assert.match(gameKey,/:game:lite:depth:20:2:/);
  assert.match(positionKey,/:position:lite:depth:20:3:/);
  const results=evaluatedGame(game,positionKey);
  for(let index=1;index<=game.moves.length;index++)addReview(results,index);
  assert.deepEqual(reviewProgress(game,results,accepted),{evaluated:0,reviewed:0,positionTotal:5,
    reviewTotal:4,done:0,total:9,phase:'position'});
  const displayCache=result=>result?.configKey===positionKey||accepted(result);
  assert.equal(reviewProgress(game,results,displayCache).done,9,'display-compatible data is not the captured game policy');
});

test('matching complete position evaluations and bound move reviews are counted independently',()=>{
  const results=evaluatedGame();
  assert.deepEqual(reviewProgress(game,results,accepted),{evaluated:5,reviewed:0,positionTotal:5,
    reviewTotal:4,done:5,total:9,phase:'review'});
  addReview(results,1);addReview(results,3);
  assert.equal(reviewProgress(game,results,accepted).reviewed,2);
  assert.equal(reviewProgress(game,results,accepted).done,7);
  addReview(results,2);addReview(results,4);
  assert.deepEqual(reviewProgress(game,results,accepted),{evaluated:5,reviewed:4,positionTotal:5,
    reviewTotal:4,done:9,total:9,phase:'review'});
});

test('a move requires both adjacent roots to satisfy the exact captured policy',()=>{
  for(const invalid of ['missing-parent','foreign-parent','foreign-child','overview-parent']) {
    const results=evaluatedGame();addReview(results,2);
    if(invalid==='missing-parent')results.delete(1);
    if(invalid==='foreign-parent')results.set(1,{...results.get(1),configKey:positionKey});
    if(invalid==='foreign-child')results.set(2,{...results.get(2),configKey:positionKey});
    if(invalid==='overview-parent')results.set(1,{...results.get(1),overview:true});
    const progress=reviewProgress(game,results,accepted);
    assert.equal(progress.reviewed,0,invalid);assert.equal(progress.evaluated,4,invalid);
    assert.equal(progress.phase,'position');assert.equal(progress.done,4);
  }
});

test('incomplete and stale move proof is not progress even when every position is cached',()=>{
  for(const change of [
    after=>delete after.moveReview,
    after=>delete after.moveReview.pv,
    after=>after.moveReview.beforeDepth=16,
    after=>after.moveReview.beforeBestmove='a2a3',
    after=>after.moveReview.beforeScore.value+=100,
    after=>after.moveReview.configKey=positionKey,
    after=>after.moveReview.fen=game.positions[0],
    after=>after.moveReview.uci='a2a3',
  ]) {
    const results=evaluatedGame();addReview(results,2);change(results.get(2));
    const progress=reviewProgress(game,results,accepted);
    assert.equal(progress.evaluated,5);assert.equal(progress.reviewed,0);
    assert.equal(progress.done,5);assert.equal(progress.phase,'review');
  }
});

test('terminal positions are accepted by the captured policy without manufacturing their move review',()=>{
  const mateGame=parseGame('1. f3 e5 2. g4 Qh4# 0-1'),results=evaluatedGame(mateGame);
  results.set(4,terminalResult(gameAt(mateGame,4)));
  for(let index=1;index<4;index++)addReview(results,index,mateGame);
  let progress=reviewProgress(mateGame,results,accepted);
  assert.equal(progress.evaluated,5);assert.equal(progress.reviewed,3);assert.equal(progress.done,8);
  addReview(results,4,mateGame);progress=reviewProgress(mateGame,results,accepted);
  assert.equal(progress.reviewed,4);assert.equal(progress.done,progress.total);
});

test('a zero-move FEN needs only its evaluated root, including a terminal root',()=>{
  for(const fen of [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    '7k/8/6K1/8/8/8/8/8 w - - 0 1',
  ]) {
    const source=parseGame(fen,'fen'),results=new Map();
    assert.deepEqual(reviewProgress(source,results,accepted),{evaluated:0,reviewed:0,
      positionTotal:1,reviewTotal:0,done:0,total:1,phase:'position'});
    results.set(0,terminalResult(gameAt(source,0))||evaluatedGame(source).get(0));
    assert.deepEqual(reviewProgress(source,results,accepted),{evaluated:1,reviewed:0,
      positionTotal:1,reviewTotal:0,done:1,total:1,phase:'review'});
  }
});

test('long-game progress reports the real phase boundary and never advances for partial work or unrelated entries',()=>{
  const source=parseGame(SAMPLE_PGN),results=evaluatedGame(source);
  const original=JSON.stringify([...results]);
  const first=reviewProgress(source,results,accepted);
  results.set(source.positions.length+50,{configKey:gameKey,score:{type:'cp',value:0}});
  assert.deepEqual(reviewProgress(source,results,accepted),first);
  assert.equal(first.done,source.positions.length);assert.equal(first.total,source.positions.length+source.moves.length);
  assert.equal(first.phase,'review');assert.equal(Math.round(first.done/first.total*100),50);
  assert.equal(JSON.stringify([...results].slice(0,source.positions.length)),original,'progress is read-only');
  const missing=new Map();
  assert.equal(reviewProgress(source,missing,accepted).done,0);
  assert.throws(()=>reviewProgress(source,results),/cache policy/);
});
