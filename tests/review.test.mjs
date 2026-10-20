import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, parseGame, hasMoveReview, assessedMoveResult, classifyMove, reviewedSacrificeEvidence, sacrificeCandidates, uciMove } from '../src/chess-core.js';
import { reviewMove } from '../src/review.js';
import { createInsightLine, explainMistake } from '../src/insight.js';

const cp=value=>({type:'cp',value});
const root=()=>{const chess=new Chess('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K1NR w KQkq - 0 30'),move=chess.move('Nf3');chess.undo();return{chess,move};};
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
  assert.equal(result.moveReview.sacrificeReview.status,'not-eligible');
  const offBook=new Chess('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K1NR w KQkq - 0 30'),played=offBook.move('e4');offBook.undo();
  const reviewed=await reviewMove(null,offBook,before,{score:cp(-700)},played,options);
  assert.equal(classifyMove(before,reviewed,played).key,'best');
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

const offeredPosition=(twoOffers=false)=>{
  const chess=new Chess(twoOffers?'2r4k/6q1/8/8/8/2N5/2B5/K4R2 b - - 0 29':'7k/6q1/8/8/8/2N5/8/K4R2 b - - 0 29');
  const previousMove=chess.move('Qf8');
  const move=chess.move('Nd5');chess.undo();
  const before={score:cp(0),depth:12,bestmove:uciMove(move),configKey:'review-v4:game:test',
    lines:[{multipv:1,score:cp(0),depth:12,pv:[uciMove(move),'f8f5']}]};
  const after={score:cp(20),depth:12,bestmove:'f8f5',multipvComplete:true,
    lines:[{multipv:1,score:cp(20),depth:12,pv:['f8f5','a1b2']}]};
  return{chess,move,before,after,previousMove};
};
const acceptedResult=(depth,changes={})=>({score:cp(15),depth,bestmove:'f8f1',multipvComplete:true,
  lines:[{multipv:1,score:cp(15),depth,pv:['f8f1','a1b2']}],...changes});

test('a bounded accepted-sacrifice search annotates an existing offer without changing the primary evaluation',async()=>{
  const {chess,move,before,after,previousMove}=offeredPosition(),calls=[];
  assert.equal(sacrificeCandidates(move)[0].existingLoss,5);
  const engine={async analyze(position,settings){calls.push({fen:position.fen(),history:position.history(),settings});return acceptedResult(settings.depth);}};
  const result=await reviewMove(engine,chess,before,after,move,{...options,movetime:1200});
  assert.deepEqual(calls,[{fen:move.after,history:['Qf8','Nd5'],settings:{...options,depth:11,movetime:500,multipv:1,searchMoves:['f8f1']}}]);
  assert.equal(chess.fen(),move.before);
  assert.equal(result.score,after.score);assert.equal(result.bestmove,after.bestmove);assert.equal(result.lines,after.lines);
  assert.equal(result.moveReview.score,before.score);assert.deepEqual(result.moveReview.pv,[uciMove(move),'f8f5']);
  const review=result.moveReview.sacrificeReview,branch=review.branches[0];
  assert.equal(review.status,'verified');assert.equal(review.fen,move.after);assert.equal(review.rootFen,move.before);
  assert.equal(review.uci,uciMove(move));assert.equal(review.configKey,before.configKey);
  assert.equal(branch.source,'search');assert.equal(branch.bestResponse,false);assert.deepEqual(branch.pv,['f8f1','a1b2']);
  assert.equal(reviewedSacrificeEvidence(before,result,move).offer.square,'f1');
  assert.equal(classifyMove(before,result,move,{previousMove}).key,'brilliant');
  assert.equal(classifyMove(before,result,move).key,'best','unrelated ongoing exposure alone is insufficient');
  assert.equal(await reviewMove(engine,chess,before,result,move,options),result);assert.equal(calls.length,1);
});

test('a completed existing capture candidate is reused without an extra engine search',async()=>{
  const {chess,move,before,after}=offeredPosition();
  after.lines.push({multipv:2,depth:12,score:cp(15),pv:['f8f1','a1b2']});
  const result=await reviewMove({analyze(){assert.fail('the only legal offered capture was already searched');}},chess,before,after,move,options);
  const branch=result.moveReview.sacrificeReview.branches[0];
  assert.equal(branch.source,'candidate');assert.equal(branch.depth,12);assert.equal(branch.verified,true);
  assert.ok(reviewedSacrificeEvidence(before,result,move));
});

test('several offers use one capture-restricted search when only a lower-ranked capture was cached',async()=>{
  const {chess,move,before,after}=offeredPosition(true),calls=[];
  after.lines.push({multipv:2,depth:12,score:cp(20),pv:['c8c2','a1b1']});
  const captures=[...new Set(sacrificeCandidates(move).flatMap(offer=>offer.captures))].sort();
  assert.deepEqual(captures,['c8c2','f8f1']);
  const result=await reviewMove({async analyze(position,settings){calls.push(settings);return acceptedResult(settings.depth);}},chess,before,after,move,options);
  assert.equal(calls.length,1);assert.deepEqual(calls[0].searchMoves,captures);
  assert.equal(result.moveReview.sacrificeReview.branches[0].source,'search');
});

test('a globally best cached capture covers several offers without another search',async()=>{
  const {chess,move,before,after}=offeredPosition(true);
  after.bestmove='f8f1';after.lines=[{multipv:1,depth:12,score:cp(15),pv:['f8f1','a1b2']}];
  const result=await reviewMove({analyze(){assert.fail('top candidate already accepts an offer');}},chess,before,after,move,options);
  assert.equal(result.moveReview.sacrificeReview.restrictedMoves.length,2);
  assert.equal(result.moveReview.sacrificeReview.branches[0].source,'candidate');
});

test('depth-limited or incomplete accepted branches cannot establish extra sacrifice evidence',async()=>{
  for(const changes of [{depth:10},{multipvComplete:false}]){
    const {chess,move,before,after}=offeredPosition();
    const engine={async analyze(position,settings){return acceptedResult(changes.depth||settings.depth,{multipvComplete:changes.multipvComplete??true});}};
    const result=await reviewMove(engine,chess,before,after,move,options);
    assert.equal(result.moveReview.sacrificeReview.status,'unverified');
    assert.equal(result.moveReview.sacrificeReview.branches[0].verified,false);
    assert.equal(reviewedSacrificeEvidence(before,result,move),null);
    assert.equal(classifyMove(before,result,move).key,'best');
  }
});

test('an unrelated or illegal capture PV never becomes accepted-sacrifice evidence',async()=>{
  for(const pv of [['f8f5','a1b2'],['f8f1','a1b1']]){
    const {chess,move,before,after}=offeredPosition();
    const result=await reviewMove({async analyze(position,settings){return acceptedResult(settings.depth,{bestmove:pv[0],lines:[{multipv:1,depth:settings.depth,score:cp(15),pv}]});}},chess,before,after,move,options);
    assert.equal(result.moveReview.sacrificeReview.status,'unverified');
    assert.deepEqual(result.moveReview.sacrificeReview.branches,[]);
    assert.equal(reviewedSacrificeEvidence(before,result,move),null);
    assert.equal(result.score,after.score);
  }
});

test('a losing accepted branch is retained as a conditional line but does not verify compensation',async()=>{
  const {chess,move,before,after}=offeredPosition();
  const result=await reviewMove({async analyze(position,settings){return acceptedResult(settings.depth,{lines:[{multipv:1,depth:settings.depth,score:cp(-40),pv:['f8f1','a1b2']}]});}},chess,before,after,move,options);
  assert.equal(result.moveReview.sacrificeReview.status,'verified');
  assert.equal(reviewedSacrificeEvidence(before,result,move),null);
  assert.equal(classifyMove(before,result,move).key,'best');
});

test('negative and non-near-best primary moves add no optional sacrifice searches',async()=>{
  for(const kind of ['negative','loss']){
    const {chess,move,before,after}=offeredPosition();
    if(kind==='negative'){before.score=cp(-10);before.lines[0].score=before.score;}
    else{before.score=cp(100);before.bestmove='f1f2';before.lines=[{multipv:2,depth:12,score:cp(0),pv:[uciMove(move),'f8f5']}];}
    const result=await reviewMove({analyze(){assert.fail('not a qualifying offer');}},chess,before,after,move,options);
    assert.equal(result.moveReview.sacrificeReview.status,'not-eligible');
  }
});

test('accepted-sacrifice analysis preserves history and observes cancellation',async()=>{
  const {chess,move,before,after}=offeredPosition();
  await assert.rejects(reviewMove({async analyze(){throw new DOMException('Cancelled','AbortError');}},chess,before,after,move,options),{name:'AbortError'});
  assert.equal(chess.fen(),move.before);assert.equal(after.moveReview,undefined);
});

test('an existing primary review without optional evidence can be enriched without repeating its search',async()=>{
  const {chess,move,before,after}=offeredPosition();
  const earlier=await reviewMove(null,chess,before,after,move,options);
  const cached={...earlier,moveReview:{...earlier.moveReview}};delete cached.moveReview.sacrificeReview;
  let calls=0;
  const result=await reviewMove({async analyze(position,settings){calls++;assert.equal(position.fen(),move.after);return acceptedResult(settings.depth);}},chess,before,cached,move,options);
  assert.equal(calls,1);assert.equal(result.moveReview.score,cached.moveReview.score);
  assert.ok(reviewedSacrificeEvidence(before,result,move));
});

test('the restricted engine position includes the real game history before the offer',async()=>{
  const seed=offeredPosition(),chess=seed.chess;
  for(const san of ['Ka2','Kh7','Ka1','Kh8'])chess.move(san);
  const move=chess.move('Nd5');chess.undo();let history;
  await reviewMove({async analyze(position,settings){history=position.history();return acceptedResult(settings.depth);}},chess,seed.before,seed.after,move,options);
  assert.deepEqual(history,['Qf8','Ka2','Kh7','Ka1','Kh8','Nd5']);assert.equal(chess.fen(),move.before);
});

test('accepted-sacrifice scores retain the black player perspective',async()=>{
  const chess=new Chess('k4r2/8/2n5/8/8/8/6Q1/7K w - - 0 30'),previousMove=chess.move('Qf1'),move=chess.move('Nd4');chess.undo();
  const before={score:cp(0),depth:12,bestmove:uciMove(move),configKey:'review-v4:game:black',lines:[{multipv:1,score:cp(0),depth:12,pv:[uciMove(move),'f1f4']}]};
  const after={score:cp(-20),depth:12,bestmove:'f1f4',multipvComplete:true,lines:[{multipv:1,score:cp(-20),depth:12,pv:['f1f4','a8b7']}]};
  const result=await reviewMove({async analyze(position,settings){assert.deepEqual(settings.searchMoves,['f1f8']);return{score:cp(-15),depth:settings.depth,bestmove:'f1f8',multipvComplete:true,lines:[{multipv:1,score:cp(-15),depth:settings.depth,pv:['f1f8','a8b7']}]};}},chess,before,after,move,options);
  assert.equal(reviewedSacrificeEvidence(before,result,move).branch.score.value,-15);
  assert.equal(classifyMove(before,result,move,{previousMove}).key,'brilliant');assert.equal(result.score.value,-20);
});
