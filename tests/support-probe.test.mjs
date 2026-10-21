import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, gameAt, parseGame, uciMove } from '../src/chess-core.js';
import { createInsightLine, describeHumanMove, explainMove } from '../src/insight.js';

const cp=(value,pv)=>({score:{type:'cp',value},depth:16,bestmove:pv[0],multipvComplete:true,
  lines:[{score:{type:'cp',value},depth:16,pv,multipv:1}]});

test('rook support on the first or eighth rank uses a legal hypothetical capture target',()=>{
  for(const [fen,uci,rank]of [
    ['6k1/8/8/8/8/8/4R1K1/R7 w - - 0 1','e2e1','1'],
    ['r7/4r1k1/8/8/8/8/8/6K1 b - - 0 1','e7e8','8'],
  ]) {
    const move=new Chess(fen).move(uci),original=JSON.stringify(move);
    assert.match(describeHumanMove(move),new RegExp(`${rank}번째 가로줄에 두 룩을 연결해 서로 지키게 합니다`));
    assert.equal(JSON.stringify(move),original);
    assert.equal(new Chess(move.after).fen(),move.after);
  }
});

test('a rook pinned to its king still cannot provide mutual support on a back rank',()=>{
  const move=new Chess('6k1/8/8/8/8/8/1R6/r4RK1 w - - 0 1').move('b2f2');
  assert.doesNotMatch(describeHumanMove(move),/두 룩을 연결|서로 지키/);
});

test('a placeholder attack on the king does not invalidate the recapture which removes it',()=>{
  // The hypothetical knight on e2 attacks g1, but Re1xe2 removes that attack.
  const move=new Chess('6k1/8/8/8/8/8/3R4/4R1K1 w - - 0 1').move('d2e2');
  assert.match(describeHumanMove(move),/e파일에 두 룩을 연결해 서로 지키게 합니다/);
});

test('a pre-existing back-rank connection is not described as newly created',()=>{
  const move=new Chess('6k1/8/8/8/8/8/6K1/R6R w - - 0 1').move('h1f1');
  assert.doesNotMatch(describeHumanMove(move),/두 룩을 연결|서로 지키/);
});

test('a legal full explanation opens every step when a later move connects back-rank rooks',()=>{
  const fen='6k1/8/8/8/8/8/4R1K1/R7 w - - 0 1';
  const game=parseGame(`[SetUp "1"]\n[FEN "${fen}"]\n\n1. Re3 *`),index=1,move=game.moves[0];
  const response=['g8f7','e3e1','f7g6'],before=cp(0,['e2e3',...response]),after=cp(0,response);
  const context={game,index,before,after};
  context.insight=explainMove(move,before,after,{game,index});
  const original=JSON.stringify({game,before,after});
  const core=createInsightLine(context,'response','core'),full=createInsightLine(context,'response','full');
  assert.equal(core.steps.length,1);
  assert.deepEqual(full.steps.map(step=>step.uci),response);
  assert.match(full.steps[1].explanation,/1번째 가로줄에 두 룩을 연결/);
  const expected=gameAt(game,index);
  for(const [offset,uci]of response.entries()) {
    expected.move(uci);
    assert.equal(full.seek(offset+1).fen(),expected.fen());
  }
  assert.equal(full.base.history().length,1);
  assert.equal(JSON.stringify({game,before,after}),original);
});

test('a malformed real continuation remains rejected rather than bypassing FEN validation',()=>{
  const fen='6k1/8/8/8/8/8/4R1K1/R7 w - - 0 1';
  const game=parseGame(`[SetUp "1"]\n[FEN "${fen}"]\n\n1. Re3 *`),move=game.moves[0];
  const before=cp(0,[uciMove(move)]),after=cp(0,['g8g1']);
  const context={game,index:1,before,after};
  context.insight=explainMove(move,before,after,{game,index:1});
  assert.equal(context.insight.response.invalid,true);
  assert.equal(createInsightLine(context,'response','full'),null);
  assert.throws(()=>new Chess('p5k1/8/8/8/8/8/6K1/R7 w - - 0 1'),/pawns are on the edge rows/);
});
