import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, parseGame, hasMoveReview, assessedMoveResult, classifyMove, uciMove } from '../src/chess-core.js';
import { reviewMove } from '../src/review.js';
import { createInsightLine, explainMistake } from '../src/insight.js';

const cp=value=>({type:'cp',value});
const root=()=>{const chess=new Chess(new Chess().fen().replace('0 1','0 30')),move=chess.move('Nf3');chess.undo();return{chess,move};};
const options={depth:16,movetime:1200,multipv:3};
const baseline=()=>({score:cp(50),depth:12,bestmove:'e2e4',configKey:'review-v2',lines:[{multipv:1,score:cp(50),depth:12,pv:['e2e4','e7e5']}]});

test('a played candidate uses the same completed root depth without another search',async()=>{
  const {chess,move}=root(),before=baseline(),after={score:cp(-400),depth:14,lines:[]};
  before.lines.push({multipv:2,score:cp(45),depth:12,pv:['g1f3','d7d5']});
  const result=await reviewMove({analyze(){assert.fail('candidate already verified');}},chess,before,after,move,options);
  assert.equal(result.moveReview.source,'candidate');assert.equal(hasMoveReview(before,result,move),true);
  assert.equal(result.score.value,-400); // Keep the separate board/graph evaluation.
  assert.equal(classifyMove(before,result,move).key,'excellent');
  assert.deepEqual(assessedMoveResult(before,result,move).lines[0].pv,['d7d5']);
});

test('a candidate at a different depth is searched from its root at the completed root depth',async()=>{
  const {chess,move}=root(),before=baseline(),after={score:cp(-400),depth:14,lines:[]},calls=[];
  before.lines.push({multipv:2,score:cp(45),depth:11,pv:['g1f3','d7d5']});
  const engine={async analyze(position,settings){calls.push({fen:position.fen(),settings});return{lines:[{multipv:1,score:cp(40),depth:settings.depth,pv:['g1f3','d7d5']}]};}};
  const result=await reviewMove(engine,chess,before,after,move,options);
  assert.deepEqual(calls,[{fen:move.before,settings:{...options,depth:12,multipv:1,searchMoves:['g1f3']}}]);
  assert.equal(result.moveReview.depth,before.depth);
  assert.equal(result.moveReview.source,'search');assert.equal(classifyMove(before,result,move).key,'excellent');
  assert.equal(await reviewMove(engine,chess,before,result,move,options),result);assert.equal(calls.length,1);
});

test('a restricted search never exceeds a lower depth explicitly requested by the caller',async()=>{
  const {chess,move}=root(),before=baseline(),after={score:cp(0),lines:[]};
  let settings;
  const engine={async analyze(position,value){settings=value;return{lines:[{score:cp(40),depth:value.depth,pv:['g1f3','d7d5']}]};}};
  await reviewMove(engine,chess,before,after,move,{...options,depth:8});
  assert.equal(settings.depth,8);
  assert.equal(settings.movetime,options.movetime);
});

test('a changed root result invalidates the attached move comparison',async()=>{
  const {chess,move}=root(),before=baseline();before.lines.push({multipv:2,score:cp(45),depth:12,pv:['g1f3']});
  const result=await reviewMove(null,chess,before,{score:cp(0)},move,options);
  for(const changed of [{...before,score:cp(60)},{...before,depth:13},{...before,bestmove:'d2d4'},{...before,configKey:'new-settings'}])assert.equal(hasMoveReview(changed,result,move),false);
  assert.equal(hasMoveReview(before,result,{...move,to:'h3'}),false);
});

test('the engine top move stays best without interpreting an independent child search as a loss',async()=>{
  const chess=new Chess(),move=chess.move('e4');chess.undo();const before=baseline();
  const result=await reviewMove({analyze(){assert.fail();}},chess,before,{score:cp(-700)},move,options);
  assert.equal(classifyMove(before,result,move).key,'book'); // Registered opening is its own category.
  assert.equal(classifyMove(before,result,{...move,before:move.before.replace('0 1','0 30')}).key,'best');
});

test('root mate PVs are shifted to the resulting position for explanations',async()=>{
  const chess=new Chess('7k/8/5KQ1/8/8/8/8/8 w - - 0 1'),move=chess.move('Qg7#');chess.undo();
  const before={score:{type:'mate',value:1,winner:'w'},depth:10,bestmove:uciMove(move),lines:[]};
  const after={score:{type:'mate',value:0,winner:'w'},depth:0,terminal:'체크메이트',lines:[]};
  const result=await reviewMove(null,chess,before,after,move,options);
  assert.deepEqual(assessedMoveResult(before,result,move).score,after.score);
  assert.deepEqual(assessedMoveResult(before,result,move).lines,[]);
});

test('failed or unrelated restricted PVs never produce a move grade',async()=>{
  const {chess,move}=root();
  await assert.rejects(reviewMove({async analyze(){return{lines:[{pv:['a2a3']}]};}},chess,baseline(),{score:cp(0)},move,options),/비교 분석/);
  chess.move('e4');await assert.rejects(reviewMove(null,chess,baseline(),{score:cp(0)},move,options),/시작 국면/);
});

test('mistake explanations and response exploration share the reviewed score and PV',async()=>{
  const game=parseGame('[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 30"]\n\n30. Nf3 *');
  const move=game.moves[0],chess=new Chess(move.before),before=baseline();
  const raw={score:cp(900),depth:16,bestmove:'e7e6',lines:[{pv:['e7e6'],score:cp(900),depth:16}]};
  const after=await reviewMove({async analyze(){return{lines:[{pv:['g1f3','d7d5'],score:cp(-500),depth:12}]};}},chess,before,raw,move,options);
  const insight=explainMistake(move,before,after);
  assert.equal(insight.grade.key,'blunder');assert.deepEqual(insight.response.pv,['d7d5']);
  const line=createInsightLine({game,index:1,insight,before,after},'response');
  assert.equal(line.results.get(0).score.value,-500);
  assert.equal(line.results.get(0).bestmove,'d7d5');
  assert.equal(line.steps[0].san,'d5');assert.equal(raw.score.value,900);
});
