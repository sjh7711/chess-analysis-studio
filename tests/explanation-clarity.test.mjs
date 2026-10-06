import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, parseGame, uciMove } from '../src/chess-core.js';
import { SAMPLE_PGN } from '../src/sample.js';
import { createInsightLine, explainMistake, describeMove } from '../src/insight.js';

const cp=(value,pv=[])=>({score:{type:'cp',value},bestmove:pv[0],lines:[{pv}],depth:16});
const sanLine=(fen,moves)=>{const chess=new Chess(fen);return moves.map(move=>uciMove(chess.move(move)));};

test('Ra5 explains the immediate pawn capture and defaults to one move, not the entire PV',()=>{
  const game=parseGame(SAMPLE_PGN), index=33, move=game.moves[index-1];
  const pv=sanLine(move.after,['Bxb4','Ra2','bxc4','dxc4','Bc5','Ba3','Rxb1','Qxb1']);
  const before=cp(-322),after=cp(-448,pv),insight=explainMistake(move,before,after);
  assert.equal(move.san,'Ra5');
  assert.equal(insight.grade.key,'inaccuracy');
  assert.equal(insight.response.consequence.ply,1);
  assert.match(insight.responseFact,/바로 다음 수에 흑 비숍이 b4의 백 폰/);
  assert.equal(insight.response.focus.length,1);
  const context={game,index,before,after,insight};
  const core=createInsightLine(context,'response'),full=createInsightLine(context,'response','full');
  assert.deepEqual(core.steps.map(m=>m.san),['Bxb4']);
  assert.equal(core.fullLength,8);
  assert.equal(core.seek(99).get('b4').type,'b');
  assert.equal(core.cursor,1);
  assert.equal(full.steps.length,8);
  assert.equal(full.base.fen(),core.base.fen());
  assert.equal(full.reviewScope,'full');
  assert.match(describeMove(move,before,after).text,/폰을 지키던 룩.*바로 다음 수/);
});

test('the core includes a recapture and reports a balanced exchange without a false queen-loss claim',()=>{
  const chess=new Chess('3qk3/8/8/8/8/8/8/3QK3 w - - 0 1');
  const move=chess.move('Qd2');
  const before=cp(0),after=cp(-150,sanLine(move.after,['Qxd2+','Kxd2','Ke7']));
  const insight=explainMistake(move,before,after);
  assert.equal(insight.response.focus.length,2);
  assert.equal(insight.response.focus.incomplete,false);
  assert.equal(insight.response.consequence,null);
  assert.match(insight.response.focus.note,/교환.*차이는 유지/);
  assert.doesNotMatch(describeMove(move,before,after).text,/퀸을 잃을/);
});

test('an unfinished exchange is marked uncertain instead of being called a material loss',()=>{
  const chess=new Chess('3qk3/8/8/8/8/8/8/3QK3 w - - 0 1'),move=chess.move('Qd2');
  const before=cp(0),after=cp(-150,['d8d2']);
  const insight=explainMistake(move,before,after);
  assert.equal(insight.response.focus.incomplete,true);
  assert.equal(insight.response.consequence,null);
  assert.match(insight.response.focus.note,/후속 응수가 부족/);
  assert.doesNotMatch(describeMove(move,before,after).text,/잃을 수|9점 손해/);
});

test('a seven-ply loss is labeled a conditional long-term risk and does not lengthen the core',()=>{
  const chess=new Chess('k6r/8/8/8/4P3/8/P7/1K6 w - - 0 10'),move=chess.move('a3');
  const pv=sanLine(move.after,['Rh7','Kb2','Rh6','Kb1','Rh4','Kb2','Rxe4']);
  const before=cp(0),after=cp(-200,pv),insight=explainMistake(move,before,after);
  assert.equal(insight.response.consequence.ply,7);
  assert.equal(insight.response.consequence.distant,true);
  assert.equal(insight.response.focus.length,1);
  assert.match(insight.riskFact,/7번째 이동.*흑 룩이 e4의 백 폰을 잡을 수/);
  assert.match(describeMove(move,before,after).text,/이후 선택에 따라 달라질/);
  assert.doesNotMatch(describeMove(move,before,after).text,/이 수로 인해/);
});

test('a nearby fork plays through the loss and retains its explicit timing',()=>{
  const chess=new Chess('k7/8/8/5n2/8/8/2R1K3/7R w - - 0 10'),move=chess.move('Rg1');
  const before=cp(0),after=cp(-300,['f5d4','e2f2','d4c2']);
  const insight=explainMistake(move,before,after);
  assert.equal(insight.response.consequence.ply,3);
  assert.equal(insight.response.focus.length,3);
  assert.match(insight.responseFact,/동시 공격.*이어지는 응수에서 흑 나이트가 c2의 백 룩을 잡을 수 있습니다\./);
  assert.equal(insight.riskFact,'');
});

test('full and core alternatives start before the reviewed move and cannot overwrite the response',()=>{
  const game=parseGame(SAMPLE_PGN),index=54,move=game.moves[index-1];
  const before=cp(-2152,['f2f1','h1h2','f4f3','e5e6']),after=cp(-613,['e5h5','d8f8','h5f3','f2c5']);
  const context={game,index,before,after,insight:explainMistake(move,before,after)};
  const response=createInsightLine(context,'response'),alternative=createInsightLine(context,'alternative');
  assert.equal(response.base.fen(),move.after);
  assert.equal(alternative.base.fen(),move.before);
  assert.deepEqual(alternative.steps.map(m=>m.san),['Qf1+','Kh2']);
  assert.equal(createInsightLine(context,'alternative','full').steps.length,4);
  assert.equal(response.cursor,0);
  assert.equal(createInsightLine(context,'response','invalid'),null);
});

test('grading remains based on expected-point loss, independent of capture distance',()=>{
  const chess=new Chess('k6r/8/8/8/4P3/8/P7/1K6 w - - 0 10'),move=chess.move('a3');
  const long=sanLine(move.after,['Rh7','Kb2','Rh6','Kb1','Rh4','Kb2','Rxe4']);
  for(const [loss,label] of [[75,'inaccuracy'],[150,'mistake'],[300,'blunder']]) {
    assert.equal(explainMistake(move,cp(0),cp(-loss,long)).grade.key,label);
    assert.equal(explainMistake(move,cp(0),cp(-loss,['h8h7'])).grade.key,label);
  }
});

test('a quiet alternative stops at its first move rather than including an unrelated later capture',()=>{
  const game=parseGame(SAMPLE_PGN),move=game.moves[32];
  const before=cp(-322,sanLine(move.before,['Ra2','bxc4','dxc4']));
  const insight=explainMistake(move,before,cp(-448,['c5b4']));
  assert.equal(insight.alternative.focus.length,1);
  assert.equal(insight.alternative.focus.note,'');
});
