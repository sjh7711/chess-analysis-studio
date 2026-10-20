import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess,classifyMove,uciMove} from '../src/chess-core.js';

function fixture({black=false,mate=false}={}) {
  const fen=mate?(black?'k6r/8/1RKQ4/8/8/8/8/8 b - - 0 30':'8/8/8/8/8/4qkr1/8/R6K w - - 0 30')
    :black?'3k3r/8/8/8/8/8/8/1K5Q b - - 0 30':'q5k1/8/8/8/8/8/8/R3K3 w - - 0 30';
  const chess=new Chess(fen),move=chess.move(mate?(black?'Rh7':'Ra2'):black?'Rg8':'Rb1'),sign=black?-1:1;
  const rootScore={type:'cp',value:70*sign},childScore=mate?{type:'mate',value:black?1:-1,winner:black?'w':'b'}:{type:'cp',value:-200*sign};
  const childPv=mate?[black?'d6b8':'e3g1']:black?['h1h4','d8c7']:['a8a5','e1f2'];
  const before={score:rootScore,depth:16,bestmove:uciMove(move),multipvComplete:true,configKey:'great-confidence',
    lines:[{multipv:1,depth:16,score:{...rootScore},pv:[uciMove(move),...childPv]},
      {multipv:2,depth:16,score:{type:'cp',value:-100*sign},pv:[mate?(black?'h8g8':'a1b1'):black?'d8c8':'e1f1']}]};
  const after={score:childScore,depth:16,bestmove:childPv[0],multipvComplete:true,configKey:before.configKey,
    lines:[{multipv:1,depth:16,score:{...childScore},pv:[...childPv]}],
    moveReview:{version:1,fen:move.before,uci:uciMove(move),configKey:before.configKey,beforeScore:{...rootScore},beforeDepth:16,
      beforeBestmove:before.bestmove,score:{...rootScore},depth:16,pv:[uciMove(move),...childPv],source:'best'}};
  const proof=new Chess(move.after);for(const uci of childPv)proof.move(uci);
  if(mate){assert.equal(proof.isCheckmate(),true);assert.notEqual(proof.turn(),childScore.winner);}
  return {move,before,after};
}

function unchanged(item) {
  const snapshot=JSON.stringify(item),grade=classifyMove(item.before,item.after,item.move);
  assert.equal(JSON.stringify(item),snapshot);return grade;
}

test('a bound best move keeps its ordinary score but does not receive great against a completed contradictory child search',()=>{
  for(const black of [false,true]) {
    const item=fixture({black}),grade=unchanged(item);
    assert.equal(grade.key,'best');assert.equal(grade.loss,0);assert.equal(grade.pointsLoss,0);
    assert.equal(item.after.score.value,black?200:-200);
  }
});

test('same-setting deeper child evidence can withhold great while a consistent child keeps it',()=>{
  const deeper=fixture();deeper.after.depth=18;deeper.after.lines[0].depth=18;
  assert.equal(unchanged(deeper).key,'best');
  const consistent=fixture();consistent.after.score.value=65;consistent.after.lines[0].score.value=65;
  assert.equal(unchanged(consistent).key,'great');
});

test('incomplete, shallower, differently configured or illegal child evidence cannot withhold great',()=>{
  for(const change of [
    item=>{item.after.multipvComplete=false;},
    item=>{item.after.depth=15;item.after.lines[0].depth=15;},
    item=>{item.after.configKey='another-engine';},
    item=>{item.after.lines[0].depth=15;},
    item=>{item.after.lines[0].score.value=-199;},
    item=>{item.after.lines[0].pv=['a1b1'];},
    item=>{item.after.lines[0].pv.push('a8a7');},
    item=>{item.move={...item.move,after:item.move.before};},
  ]) {
    const item=fixture();change(item);assert.equal(unchanged(item).key,'great');
  }
});

test('a child mating claim withholds great only when its whole legal PV proves the stated winner',()=>{
  for(const black of [false,true]) {
    const item=fixture({black,mate:true});assert.equal(unchanged(item).key,'best');
    item.after.score.winner=black?'b':'w';item.after.lines[0].score.winner=item.after.score.winner;
    assert.equal(unchanged(item).key,'great','a claim that reverses the actual mate winner is not evidence');
    const distance=fixture({black,mate:true});distance.after.score.value*=2;distance.after.lines[0].score.value*=2;
    assert.equal(unchanged(distance).key,'great','the mating distance must agree with the completed line');
    const partial=fixture({black,mate:true});partial.after.lines[0].pv=[];
    assert.equal(unchanged(partial).key,'great','a mate score without a proving continuation cannot withhold great');
  }
});

test('an in-place child update invalidates great confidence without mutating the root review',()=>{
  const item=fixture();item.after.score.value=65;item.after.lines[0].score.value=65;
  const root=JSON.stringify(item.after.moveReview);
  assert.equal(classifyMove(item.before,item.after,item.move).key,'great');
  item.after.score.value=-200;item.after.lines[0].score.value=-200;
  assert.equal(classifyMove(item.before,item.after,item.move).key,'best');
  item.after.lines[0].pv=['a1b1'];
  assert.equal(classifyMove(item.before,item.after,item.move).key,'great');
  assert.equal(JSON.stringify(item.after.moveReview),root);
});

test('unchanged confidence cache hits do not replay the child variation',()=>{
  const item=fixture(),grade=classifyMove(item.before,item.after,item.move),original=Chess.prototype.move;
  let calls=0;Chess.prototype.move=function(...args){calls++;return original.apply(this,args);};
  try {
    for(let index=0;index<100;index++)assert.equal(classifyMove(item.before,item.after,item.move),grade);
    assert.equal(calls,0);
  } finally {Chess.prototype.move=original;}
});
