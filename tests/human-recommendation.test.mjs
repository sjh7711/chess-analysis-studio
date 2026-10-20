import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../src/chess-core.js';
import { humanRecommendation } from '../src/human-recommendation.js';

const cp = value => ({type:'cp',value});
const line = (multipv,value,pv,depth=16) => ({multipv,score:cp(value),pv,depth});
function result(lines,extra={}) { return {score:lines[0].score,bestmove:lines[0].pv[0],depth:lines[0].depth,multipvComplete:true,lines,...extra}; }
function opening() { const chess = new Chess(); chess.move('e4'); chess.move('f6'); return chess; }
function fixture() { return result([line(1,150,['d1h5','g7g6']),line(2,140,['b1c3','e7e5'])]); }

test('a near-best developing move is preferred to an early queen check, preserving the engine ranking',()=>{
  const chess = opening(), evaluation = fixture();
  const chosen = humanRecommendation(chess,evaluation);
  assert.equal(chosen.move.san,'Nc3');
  assert.equal(chosen.line,evaluation.lines[1]);
  assert.equal(chosen.engineLine,evaluation.lines[0]);
  assert.equal(chosen.engineMove.san,'Qh5+');
  assert.equal(chosen.isEngineBest,false);
  assert.equal(chosen.lossCp,10);
  assert.ok(chosen.pointsLoss < 0.01);
  assert.match(chosen.reason,/시작 줄의 나이트.*c3.*전개/);
});

test('both the centipawn cap and the expected-point cap apply independently',()=>{
  for (const values of [[150,124],[0,-11]]) {
    const evaluation = fixture();
    evaluation.lines.forEach((item,index)=>item.score=cp(values[index])); evaluation.score=evaluation.lines[0].score;
    assert.equal(humanRecommendation(opening(),evaluation).isEngineBest,true);
  }
  const evaluation = fixture();
  evaluation.lines[0].score=evaluation.score=cp(0);evaluation.lines[1].score=cp(-10);
  assert.equal(humanRecommendation(opening(),evaluation).move.san,'Nc3');
});

test('black candidates use Black loss although all stored scores remain White-relative',()=>{
  const chess = new Chess(); ['e4','e5','f3'].forEach(move=>chess.move(move));
  const chosen=humanRecommendation(chess,result([line(1,-150,['d8h4','g2g3']),line(2,-140,['b8c6','d2d4'])]));
  assert.equal(chosen.move.san,'Nc6');
  assert.equal(chosen.lossCp,10);
  assert.ok(chosen.pointsLoss > 0 && chosen.pointsLoss < 0.01);
});

test('a mate evaluation never yields to a human-style alternative, including a longer mate',()=>{
  for (const alternative of [cp(1000),{type:'mate',value:4,winner:'w'},{type:'mate',value:-2,winner:'b'}]) {
    const evaluation=fixture();
    evaluation.lines[0].score=evaluation.score={type:'mate',value:3,winner:'w'};
    evaluation.lines[1].score=alternative;
    assert.equal(humanRecommendation(opening(),evaluation).isEngineBest,true);
  }
});

test('incomplete snapshots, mismatched primary depth/score/bestmove and bounded primary values are rejected',()=>{
  for (const mutate of [
    value=>value.multipvComplete=false,
    value=>value.depth=15,
    value=>value.score=cp(151),
    value=>value.bestmove='b1c3',
    value=>value.lines[0].lowerbound=true,
    value=>value.score={type:'cp',value:150,upperbound:true},
    value=>value.lines[0].multipv=2,
    value=>value.depth=NaN,
  ]) {
    const evaluation=fixture();mutate(evaluation);
    assert.equal(humanRecommendation(opening(),evaluation),null);
  }
});

test('an untrustworthy secondary line falls back to the unchanged engine best',()=>{
  for (const mutate of [
    value=>value.depth=15,
    value=>value.lowerbound=true,
    value=>value.score={type:'unknown',value:140},
    value=>value.score.value=NaN,
    value=>value.pv=['b1c3','e7e6','e1e8'],
    value=>value.pv=['d1h5','g7g6'],
    value=>value.pv=['b1c3','e7e5','b1c3'],
  ]) {
    const evaluation=fixture();mutate(evaluation.lines[1]);
    assert.equal(humanRecommendation(opening(),evaluation).isEngineBest,true);
  }
});

test('the whole primary PV is legal, not just its root move',()=>{
  const evaluation=fixture();evaluation.lines[0].pv.push('h5h8');
  assert.equal(humanRecommendation(opening(),evaluation),null);
});

test('history is retained and a draw claim endpoint cannot be continued as a fictitious PV',()=>{
  const chess = new Chess();
  ['Nf3','Nf6','Ng1','Ng8','Nf3','Nf6','Ng1','Ng8'].forEach(move=>chess.move(move));
  assert.equal(humanRecommendation(chess,result([line(1,0,['g1f3'])])),null);
  const beforeDraw=new Chess();
  ['Nf3','Nf6','Ng1','Ng8','Nf3','Nf6','Ng1'].forEach(move=>beforeDraw.move(move));
  assert.equal(humanRecommendation(beforeDraw,result([line(1,0,['f6g8','g1f3'])])),null);
});

test('a developing alternative which immediately hangs the knight is not promoted',()=>{
  const chess=new Chess('4k3/8/8/8/4p3/8/8/3QK1N1 w - - 0 1');
  const chosen=humanRecommendation(chess,result([line(1,150,['d1d2','e8f7']),line(2,140,['g1f3','e4f3'])]));
  assert.equal(chosen.isEngineBest,true);
});

test('equal recaptures do not count as hanging material',()=>{
  const chess = new Chess('4k3/1b6/8/8/8/8/6P1/3QK1N1 w - - 0 1');
  const chosen=humanRecommendation(chess,result([line(1,150,['d1h5','e8e7']),line(2,140,['g1f3','b7f3','g2f3'])]));
  assert.equal(chosen.move.san,'Nf3');
});

test('a pinned geometric attacker is not mistaken for a legal winning capture',()=>{
  const chess = new Chess('1k6/8/8/1b6/8/8/8/1R1QKB2 w - - 0 1');
  const chosen=humanRecommendation(chess,result([line(1,150,['d1h5','b8c8']),line(2,140,['f1d3','b8c8'])]));
  assert.equal(chosen.move.san,'Bd3');
  assert.match(chosen.reason,/비숍.*전개/);
});

test('escaping a legal capture threat is described without promising general safety',()=>{
  const chess = new Chess('4k3/8/8/8/8/3b4/8/1N1QK3 w - - 0 1');
  const chosen=humanRecommendation(chess,result([line(1,150,['d1h5','e8e7']),line(2,140,['b1c3','e8e7'])]));
  assert.equal(chosen.move.san,'Nc3');
  assert.ok(chosen.facts.some(fact=>/잡을 수 있던 b1.*c3.*피합니다/.test(fact)));
  assert.ok(chosen.facts.every(fact=>!/안전|강제|승리/.test(fact)));
});

test('a simple recapture has a literal reason from the actual previous move',()=>{
  const chess=new Chess('3rk3/8/8/8/8/8/3P4/3QK3 b - - 0 1');chess.move('Rxd2');
  const chosen=humanRecommendation(chess,result([line(1,150,['d1e2','d2e2']),line(2,140,['d1d2','e8f8'])]));
  assert.equal(chosen.move.san,'Qxd2');
  assert.match(chosen.reason,/d2.*룩.*바로 되잡/);
});

test('legal castling can be recommended with only the actual king and rook destinations claimed',()=>{
  const chess=new Chess('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
  const chosen=humanRecommendation(chess,result([line(1,200,['h1h2','e8d7']),line(2,190,['e1g1','e8d7'])]));
  assert.equal(chosen.move.san,'O-O');
  assert.match(chosen.reason,/킹을 g1.*룩을 f1/);
  assert.doesNotMatch(chosen.reason,/안전|강제|승리/);
});

test('with one candidate or no stronger natural feature, the engine best stays first',()=>{
  const evaluation=fixture();evaluation.lines=evaluation.lines.slice(0,1);
  assert.equal(humanRecommendation(opening(),evaluation).isEngineBest,true);
  const chess=new Chess();
  const tied=result([line(1,150,['b1c3','e7e5']),line(2,140,['g1f3','e7e5'])]);
  assert.equal(humanRecommendation(chess,tied).move.san,'Nc3');
});

test('position and result data remain untouched and repeated recommendations are deterministic',()=>{
  const chess=opening(),evaluation=fixture(),fen=chess.fen(),history=chess.history(),snapshot=structuredClone(evaluation);
  for(let index=0;index<3;index++) assert.equal(humanRecommendation(chess,evaluation).move.san,'Nc3');
  assert.equal(chess.fen(),fen);assert.deepEqual(chess.history(),history);assert.deepEqual(evaluation,snapshot);
});

test('invalid positions, terminal boards, unknown primary scores and an identity mismatch yield no recommendation',()=>{
  assert.equal(humanRecommendation('bad fen',fixture()),null);
  assert.equal(humanRecommendation('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1',fixture()),null);
  const evaluation=fixture();evaluation.score=evaluation.lines[0].score={type:'unknown',value:150};
  assert.equal(humanRecommendation(opening(),evaluation),null);
  assert.equal(humanRecommendation(opening(),{...fixture(),fen:new Chess().fen()}),null);
  assert.equal(humanRecommendation(opening(),{...fixture(),lines:[null]}),null);
});
