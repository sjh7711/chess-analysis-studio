import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, parseGame, uciMove } from '../src/chess-core.js';
import { createInsightLine, explainMistake } from '../src/insight.js';
import { SAMPLE_PGN } from '../src/sample.js';

const result = (score,pv=[]) => ({score,depth:16,bestmove:pv[0],lines:pv.length?[{pv,score,depth:16,multipv:1}]:[]});
const cp = (value,pv) => result({type:'cp',value},pv);
const mate = (value,winner,pv) => result({type:'mate',value,winner},pv);

test('explains mate in one from the supplied game and offers a legal alternative',()=>{
  const move=parseGame(SAMPLE_PGN).moves[44]; // 23. Qxh5?? Qe1#
  const explanation=explainMistake(move,cp(-823,['d1g1']),mate(-1,'b',['f2e1']));
  assert.equal(explanation.grade.key,'blunder');
  assert.match(explanation.summary,/흑 퀸이 f2에서 e1로 이동해 상대 왕을 체크메이트할 수 있습니다/);
  assert.match(explanation.summary,/대신 백 퀸이 d1에서 g1로 이동했어야 합니다/);
  assert.match(explanation.responseFact,/흑 퀸이 f2에서 e1로 이동해 상대 왕을 체크메이트/);
  assert.deepEqual(explanation.response.pv,['f2e1']);
  assert.deepEqual(explanation.alternative.pv,['d1g1']);
  assert.match(explanation.alternativeFact,/즉시 체크메이트를 막습니다/);
  assert.equal(explanation.lossText,'메이트 평가 변화');
  assert.equal(explanation.materialFact,'');
});

test('material explanation includes the pawn gained by the blunder, for either color',()=>{
  for(const color of ['w','b']) {
    const white=color==='w';
    const chess=new Chess(white?'4k2r/7p/8/8/7Q/8/8/4K3 w - - 0 1':'4k3/8/8/7q/8/8/7P/4K2R b - - 0 1');
    const move=chess.move(white?'h4h7':'h5h2');
    const explanation=explainMistake(move,cp(0,[white?'h4e4':'h5e5']),cp(white?-800:800,[white?'h8h7':'h1h2']));
    assert.equal(explanation.grade.loss,800);
    assert.match(explanation.materialFact,/8점 손해/);
    assert.match(explanation.responseFact,/퀸을 잡을 수 있습니다/);
    assert.match(explanation.reason,white?/백이 불리/:/흑이 불리/);
  }
});

test('a recaptured queen trade does not become a claim of losing a queen for free',()=>{
  const chess=new Chess('3qk3/8/8/8/8/8/8/3QK3 w - - 0 1');
  const move=chess.move('d1d4');
  const explanation=explainMistake(move,cp(0,['d1d8']),cp(-250,['d8d4','e1e2']));
  assert.match(explanation.summary,/퀸을 잡을 수/);
  const trade=new Chess('3qk3/8/8/8/8/8/8/3QK3 w - - 0 1');
  const capture=trade.move('d1d8');
  const balanced=explainMistake(capture,cp(300,['e1e2']),cp(0,['e8d8']));
  assert.match(balanced.materialFact,/기물 점수 차이는 유지/);
  assert.doesNotMatch(balanced.summary,/기물 점수|퀸을 잡는 수/);
});

test('missing, illegal and mismatched PVs cannot invent a continuation',()=>{
  const chess=new Chess();
  const move=chess.move('e2e4');
  const invalid=cp(-250,['e7e5','a1a8','d1h5']);
  const explanation=explainMistake(move,cp(0,['d2d4']),invalid);
  assert.deepEqual(explanation.response.pv,['e7e5']);
  const missing=explainMistake(move,cp(0,[]),cp(-250,[]));
  assert.equal(missing.responseFact,'');
  assert.equal(missing.alternativeFact,'');
  assert.equal(missing.materialFact,'');
  assert.deepEqual(missing.response.pv,[]);
  const stale={...invalid,bestmove:'c7c5'};
  assert.deepEqual(explainMistake(move,cp(0,['d2d4']),stale).response.pv,['c7c5']);
});

test('losing a forced mate is distinct from being mated',()=>{
  const chess=new Chess('7k/8/5KQ1/8/8/8/8/8 w - - 0 1');
  const move=chess.move('g6g4');
  const explanation=explainMistake(move,mate(1,'w',['g6g7']),cp(900,['h8h7']));
  assert.match(explanation.reason,/가능했던 강제 체크메이트 수순을 놓쳤습니다/);
  assert.doesNotMatch(explanation.reason,/허용/);
  assert.equal(explanation.lossText,'메이트 평가 변화');
});

test('no explanation is generated for unanalysed or best moves',()=>{
  const chess=new Chess();const move=chess.move('e2e4');
  assert.equal(explainMistake(move,null,cp(0,[])),null);
  assert.equal(explainMistake(move,cp(30,[uciMove(move)]),cp(20,['e7e5'])),null);
});

test('Rd8 explanation pairs the capture with check and a specific alternative without repeating the loss',()=>{
  const move=parseGame(SAMPLE_PGN).moves[53]; // 27... Rd8
  assert.equal(move.san,'Rd8');
  const explanation=explainMistake(move,cp(-1579,['f4f3']),cp(-672,['e5e6']));
  assert.equal(explanation.lossText,'흑의 평가 손실 9.07');
  assert.equal(explanation.reason,'');
  assert.equal(explanation.summary,'바로 다음 수에 백 퀸이 e6의 흑 폰을 잡고 상대 왕을 체크할 수 있습니다. 대신 흑 폰이 f4에서 f3로 이동했어야 합니다.');
  assert.doesNotMatch(explanation.summary,/9\.07|최선의 수보다|국면 평가/);
});

test('switching Rd8 response and alternative replays preserves their different starting boards and moves',()=>{
  const game=parseGame(SAMPLE_PGN), index=54, move=game.moves[index-1];
  const before=cp(-2152,['f2f1','h1h2','f4f3','e5e6']);
  const after=cp(-613,['e5h5','d8f8','h5f3','f2c5']);
  const context={game,index,before,after,insight:explainMistake(move,before,after)};
  const original=JSON.stringify(game);
  const response=createInsightLine(context,'response','full');
  assert.equal(response.base.get('d8').type,'r'); // The mistake Rd8 has already happened.
  assert.equal(response.base.get('f8'),undefined);
  assert.equal(response.base.turn(),'w');
  assert.deepEqual(response.steps.map(step=>step.san),['Qh5','Rf8','Qf3','Qc5']);
  response.seek(2);
  const alternative=createInsightLine(context,'alternative','full');
  assert.equal(alternative.base.get('f8').type,'r'); // Rewind before Rd8, regardless of response cursor.
  assert.equal(alternative.base.get('d8'),undefined);
  assert.equal(alternative.base.turn(),'b');
  assert.deepEqual(alternative.steps.map(step=>step.san),['Qf1+','Kh2','f3','Qxe6+']);
  assert.equal(alternative.seek(1).get('f1').type,'q');
  assert.equal(response.cursor,2);
  assert.equal(response.results.get(0).score.value,-613);
  assert.equal(alternative.results.get(0).score.value,-2152);
  const responseAgain=createInsightLine(context,'response');
  assert.equal(responseAgain.cursor,0);
  assert.equal(responseAgain.base.fen(),move.after);
  assert.equal(JSON.stringify(game),original);
});

test('a white mistake also starts the opponent response after the mistake and the alternative before it',()=>{
  const game=parseGame(SAMPLE_PGN), index=45, move=game.moves[index-1];
  const before=cp(-823,['d1g1']), after=mate(-1,'b',['f2e1']);
  const context={game,index,before,after,insight:explainMistake(move,before,after)};
  const response=createInsightLine(context,'response'), alternative=createInsightLine(context,'alternative');
  assert.equal(response.base.get('h5').type,'q');
  assert.equal(response.seek(1).isCheckmate(),true);
  assert.equal(alternative.base.get('d1').type,'q');
  assert.equal(alternative.seek(1).get('g1').type,'q');
  assert.equal(alternative.position().isCheckmate(),false);
  assert.equal(response.reviewKind,'response');
  assert.equal(alternative.reviewKind,'alternative');
});
