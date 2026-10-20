import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess,classifyMove,uciMove,expectedPoints } from '../src/chess-core.js';

test('an incomplete stored move review does not crash the tactical-loss fallback',()=>{
  const move=new Chess('6k1/8/8/8/8/8/8/6KR w - - 0 30').move('Rh2');
  const before={score:{type:'cp',value:-900},lines:[]};
  for(const moveReview of [{},{score:null}]) {
    const after={score:{type:'cp',value:-950},lines:[],moveReview};
    assert.doesNotThrow(()=>classifyMove(before,after,move));
  }
});

const mate=(value,winner='w')=>({type:'mate',value,winner});
function result(score,pv=[],depth=16) {
  return {score,depth,bestmove:pv[0],multipvComplete:true,configKey:'grading-regression',
    lines:pv.length?[{multipv:1,depth,score,pv}]:[]};
}
function gradeUnchanged(move,before,after) {
  const source=JSON.stringify({move,before,after});
  const grade=classifyMove(before,after,move);
  assert.equal(JSON.stringify({move,before,after}),source);
  return grade;
}

test('a legal immediate mate missed by either side is a missed chance even when the longer mate stays winning',()=>{
  for(const item of [
    {fen:'7k/8/5KQ1/8/8/8/8/8 w - - 0 30',played:'Qg4',finish:'Qg7#',pv:'g6g7',winner:'w',sign:1},
    {fen:'8/8/8/8/8/5kq1/8/7K b - - 0 30',played:'Qg4',finish:'Qg2#',pv:'g3g2',winner:'b',sign:-1},
  ]) {
    const chess=new Chess(item.fen),move=chess.move(item.played);
    assert.ok(new Chess(item.fen).moves().includes(item.finish));
    assert.equal(chess.isCheckmate(),false);
    const before=result(mate(item.sign,item.winner),[item.pv]);
    const after=result(mate(item.sign*6,item.winner));
    const grade=gradeUnchanged(move,before,after);
    assert.equal(grade.key,'miss');
    assert.match(grade.reason,/한 수.*체크메이트.*놓쳤/);
    assert.equal(grade.loss,0,'mate distance does not become fabricated centipawn loss');
    assert.equal(grade.pointsLoss,0,'preserve the actual saturated winning-score conversion');
  }
});

test('playing the actual mate is not a missed chance',()=>{
  const move=new Chess('7k/8/5KQ1/8/8/8/8/8 w - - 0 30').move('Qg7#');
  const grade=gradeUnchanged(move,result(mate(1),[uciMove(move)]),result(mate(0)));
  assert.equal(grade.key,'best');
});

test('a longer mating score alone cannot invent an immediate missed finish',()=>{
  const move=new Chess('8/8/8/8/8/8/R7/K6k w - - 0 30').move('Rb2');
  assert.equal(new Chess(move.before).moves().some(san=>san.endsWith('#')),false);
  const grade=gradeUnchanged(move,result(mate(3),['a2a8']),result(mate(8)));
  assert.equal(grade.key,'excellent');
});

test('stale or illegal played records cannot prove a missed mate',()=>{
  const actual=new Chess('7k/8/5KQ1/8/8/8/8/8 w - - 0 30').move('Qg4');
  for(const move of [{...actual,after:actual.before},{...actual,from:'a1'},{...actual,color:'b'}]) {
    const grade=gradeUnchanged(move,result(mate(1),['g6g7']),result(mate(6)));
    assert.notEqual(grade.key,'miss');
  }
});

function tiedMate() {
  // A synthetic two-rook ending with several equally long king replies.
  const chess=new Chess('8/6k1/R7/1R6/8/8/8/4K3 b - - 0 30'),move=chess.move('Kf7');
  const score=mate(2),before=result(score,['g7f8','b5b7','f8e8','a6a8']);
  before.lines.push({multipv:2,depth:16,score:{...score},pv:['g7h8','b5b7','h8g8','a6a8']});
  const after=result({...score},['b5b7','f7f8','a6a8']);
  after.moveReview={version:1,fen:move.before,uci:uciMove(move),configKey:before.configKey,
    beforeScore:{...score},beforeDepth:before.depth,beforeBestmove:before.bestmove,
    score:{...score},depth:16,pv:['g7f7','b5b7','f7f8','a6a8'],source:'search'};
  return {move,before,after};
}

test('an equally deep bound root mate outside overview candidates is still best',()=>{
  const {move,before,after}=tiedMate();
  assert.ok(!before.lines.some(line=>line.pv[0]===uciMove(move)));
  const clone=new Chess(move.before);
  for(const uci of after.moveReview.pv)clone.move(uci);
  assert.equal(clone.isCheckmate(),true);
  assert.equal(gradeUnchanged(move,before,after).key,'best');
});

test('an incomplete, unrelated or different-depth root mate cannot establish a tie',()=>{
  const changes=[
    item=>{item.before.multipvComplete=false;},
    item=>{item.after.moveReview.depth=15;},
    item=>{item.after.moveReview.depth=17;},
    item=>{item.after.moveReview.configKey='another-config';},
    item=>{item.after.moveReview.fen=item.move.after;},
    item=>{item.after.moveReview.beforeBestmove='g7h8';},
    item=>{item.after.moveReview.beforeScore=mate(3);},
    item=>{item.after.moveReview.score=mate(3);},
    item=>{item.after.moveReview.score=mate(-2,'b');},
    item=>{item.after.moveReview.source='unverified';},
    item=>{item.after.moveReview.pv=['g7f7'];},
    item=>{item.after.moveReview.pv=['g7f7','b5b7','f7f8','a6h6'];},
    item=>{item.after.moveReview.pv.push('f8e8');},
    item=>{item.move.after=item.move.before;},
  ];
  for(const change of changes) {
    const item=tiedMate();change(item);
    assert.notEqual(gradeUnchanged(item.move,item.before,item.after).key,'best');
  }
});

test('mutating a bound root mate invalidates an already cached tie',()=>{
  const {move,before,after}=tiedMate();
  assert.equal(classifyMove(before,after,move).key,'best');
  after.moveReview.pv=['g7f7'];
  assert.equal(classifyMove(before,after,move).key,'excellent');
});

test('a separate child mate score and a new centipawn equality do not widen root-tie classification',()=>{
  const childOnly=tiedMate();delete childOnly.after.moveReview;
  assert.equal(gradeUnchanged(childOnly.move,childOnly.before,childOnly.after).key,'excellent');
  const cpTie=tiedMate(),score={type:'cp',value:2000};
  cpTie.before.score={...score};cpTie.after.score={...score};
  cpTie.before.lines.forEach(line=>{line.score={...score};});
  cpTie.after.moveReview.beforeScore={...score};cpTie.after.moveReview.score={...score};
  assert.equal(gradeUnchanged(cpTie.move,cpTie.before,cpTie.after).key,'excellent');
});

function tacticalFixture({color='w',promotion=false}={}) {
  const black=color==='b';
  const fen=promotion?'4K3/6Bp/8/8/8/7k/1p6/R7 w - - 0 30'
    :black?'3k3r/8/8/8/8/8/8/1K5Q b - - 0 30':'q5k1/8/8/8/8/8/8/R3K3 w - - 0 30';
  const chess=new Chess(fen),move=chess.move(promotion?'Kf8':black?'Rh2':'Ra7');
  const sign=black?-1:1;
  const bestPv=promotion?['a1b1','h3h2','e8f8']:black?['h8g8','h1h4','d8c7']:['a1b1','a8a5','e1f2'];
  const playedPv=promotion?['e8f8','b2a1q','g7a1','h3h2']:black?['h8h2','h1h2','d8c8','h2h4']:['a1a7','a8a7','e1f1','a7a5'];
  const before=result({type:'cp',value:-600*sign},bestPv);
  const after=result({type:'cp',value:-800*sign},playedPv.slice(1));
  after.moveReview={version:1,fen:move.before,uci:uciMove(move),configKey:before.configKey,
    beforeScore:{...before.score},beforeDepth:before.depth,beforeBestmove:before.bestmove,
    score:{...after.score},depth:before.depth,pv:playedPv,source:'search'};
  return {move,before,after};
}

test('a new settled major-piece loss is not hidden by saturated losing chances, for either side',()=>{
  for(const color of ['w','b']) {
    const {move,before,after}=tacticalFixture({color});
    const pointsLoss=expectedPoints(before.score,color)-expectedPoints(after.score,color);
    assert.ok(pointsLoss<.05,'the raw public band would call this only a good move');
    const grade=gradeUnchanged(move,before,after);
    assert.equal(grade.key,'mistake');
    assert.equal(grade.pointsLoss,pointsLoss,'the supplementary material rule never changes expected points');
    assert.equal(grade.loss,200);
    assert.equal(grade.tacticalLoss.additional,5);
    assert.deepEqual(grade.tacticalLoss.played,{start:2,end:2,loss:5});
    assert.equal(grade.tacticalLoss.best.loss,0);
    assert.match(grade.reason,/최선의 수보다.*5점/);
  }
});

test('promotion-capture and its recapture settle before a rook-for-pawn loss is measured',()=>{
  const {move,before,after}=tacticalFixture({promotion:true});
  const grade=gradeUnchanged(move,before,after),position=new Chess(move.after);
  assert.equal(position.move('bxa1=Q').promotion,'q');
  assert.equal(position.move('Bxa1').captured,'q');
  assert.equal(grade.key,'mistake');
  assert.equal(grade.tacticalLoss.additional,4,'promotion is not frozen as a fictitious thirteen-point loss');
  assert.equal(grade.tacticalLoss.played.end,3);
});

function delayedCaptureFixture({bestExchange=false}={}) {
  const fen=bestExchange?'q5k1/8/8/8/8/3p4/4P3/R3K3 w - - 0 30'
    :'q5k1/8/8/8/8/8/8/R3K3 w - - 0 30';
  const chess=new Chess(fen),move=chess.move('Ra7');
  const bestPv=bestExchange?['a1b1','d3e2','e1e2']:['a1b1','a8a5','e1f2'];
  const playedPv=['a1a7','a8b8','e1f1','b8a7','f1e1'];
  // Verify actual material facts independently of the grading helper.
  const bestPosition=new Chess(fen),playedPosition=new Chess(fen);
  const bestMoves=bestPv.map(uci=>bestPosition.move(uci));
  const playedMoves=playedPv.map(uci=>playedPosition.move(uci));
  assert.equal(playedMoves[3].captured,'r');
  assert.equal(bestMoves.some(step=>step.captured),bestExchange);
  if(bestExchange)assert.deepEqual(bestMoves.filter(step=>step.captured).map(step=>step.captured),['p','p']);
  const before=result({type:'cp',value:-600},bestPv),after=result({type:'cp',value:-800},playedPv.slice(1));
  after.moveReview={version:1,fen:move.before,uci:uciMove(move),configKey:before.configKey,
    beforeScore:{...before.score},beforeDepth:before.depth,beforeBestmove:before.bestmove,
    score:{...after.score},depth:before.depth,pv:playedPv,source:'search'};
  return {move,before,after};
}

test('absence of a near exchange in the best branch is not proof of zero loss for a delayed capture',()=>{
  const {move,before,after}=delayedCaptureFixture();
  const grade=gradeUnchanged(move,before,after);
  assert.equal(grade.key,'good');
  assert.equal(grade.tacticalLoss,undefined);
  assert.equal(grade.loss,200);
  assert.equal(grade.pointsLoss,expectedPoints(before.score,'w')-expectedPoints(after.score,'w'));
});

test('a proved settled best-branch exchange still supports the delayed major-loss comparison',()=>{
  const {move,before,after}=delayedCaptureFixture({bestExchange:true});
  const grade=gradeUnchanged(move,before,after);
  assert.equal(grade.key,'mistake');
  assert.equal(grade.tacticalLoss.additional,5);
  assert.deepEqual(grade.tacticalLoss.best,{start:2,end:3,loss:0});
  assert.deepEqual(grade.tacticalLoss.played,{start:4,end:4,loss:5});
  assert.equal(grade.pointsLoss,expectedPoints(before.score,'w')-expectedPoints(after.score,'w'));
});

test('a compensated queen recapture, an unproved suffix and a remote capture cannot invent a major loss',()=>{
  const moves=['a1a7','a8a7','f2a7','g8f7'];
  const chess=new Chess('q5k1/8/8/8/8/8/5B2/R3K3 w - - 0 30'),move=chess.move(moves[0]);
  const before=result({type:'cp',value:-600},['a1b1','a8a5','e1e2']);
  const after=result({type:'cp',value:-800},moves.slice(1));
  after.moveReview={version:1,fen:move.before,uci:uciMove(move),configKey:before.configKey,
    beforeScore:{...before.score},beforeDepth:16,beforeBestmove:before.bestmove,
    score:{...after.score},depth:16,pv:moves,source:'search'};
  assert.equal(gradeUnchanged(move,before,after).tacticalLoss,undefined);
  after.moveReview.pv=moves.slice(0,2);
  assert.equal(gradeUnchanged(move,before,after).tacticalLoss,undefined,'an available but missing recapture leaves the exchange unproved');
  const remote=tacticalFixture();
  remote.after.moveReview.pv=['a1a7','a8b8','e1f1','b8b6','a7a6','b6b8','a6a7','b8a7'];
  assert.equal(gradeUnchanged(remote.move,remote.before,remote.after).tacticalLoss,undefined,'an exchange starting after ply six is not near evidence');
});

test('new major-loss evidence requires complete same-depth roots and an entirely legal PV',()=>{
  for(const change of [
    item=>{item.before.multipvComplete=false;},
    item=>{item.after.moveReview.depth=15;},
    item=>{item.after.moveReview.configKey='stale';},
    item=>{item.after.moveReview.pv.push('a5a6');},
    item=>{item.after.moveReview.pv=['a1a7','a8a7','a7h7'];},
  ]) {
    const item=tacticalFixture();change(item);
    assert.equal(gradeUnchanged(item.move,item.before,item.after).tacticalLoss,undefined);
  }
});

test('a great defensive move can be slightly worse than equal, while contradictory child evidence stays guarded',()=>{
  const chess=new Chess('q5k1/8/8/8/8/8/8/R3K3 w - - 0 30'),move=chess.move('Rb1');
  const before=result({type:'cp',value:-65},['a1b1','a8a5','e1f2']);
  before.lines.push({multipv:2,depth:16,score:{type:'cp',value:-193},pv:['e1f1']});
  assert.equal(gradeUnchanged(move,before,result({type:'cp',value:-65})).key,'great');
  before.score={type:'cp',value:70};before.lines[0].score={...before.score};
  assert.notEqual(gradeUnchanged(move,before,result({type:'cp',value:-200})).key,'great');
});

test('cached root evidence avoids PV replay during repeated renders and revalidates an in-place change',()=>{
  const {move,before,after}=tacticalFixture();
  const grade=classifyMove(before,after,move),original=Chess.prototype.move;
  let calls=0;
  Chess.prototype.move=function(...args){calls++;return original.apply(this,args);};
  try {
    for(let index=0;index<100;index++)assert.equal(classifyMove(before,after,move),grade);
    assert.equal(calls,0,'unchanged cache hits do not replay the PV');
    after.moveReview.pv=['a1a7'];
    assert.equal(classifyMove(before,after,move).tacticalLoss,undefined);
    assert.ok(calls>0,'a changed PV is revalidated instead of keeping a stale error');
  } finally {Chess.prototype.move=original;}
});
