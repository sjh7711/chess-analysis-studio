import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess,classifyMove,uciMove} from '../src/chess-core.js';

const whiteFen='7k/8/5KQ1/8/8/8/8/8 w - - 0 30';
const blackFen='8/8/8/8/8/1qk5/8/K7 b - - 0 30';
function fixture({black=false,fen=black?blackFen:whiteFen,history=[],best=black?'b3b2':'g6g7',pv=black?['b3a3','a1b1','a3b2']:['g6h6','h8g8','h6g7']}={}) {
  const chess=new Chess(fen),moves=history.map(san=>chess.move(san)),move=chess.move(pv[0]);moves.push(move);
  const winner=move.color,sign=winner==='w'?1:-1,rootScore={type:'mate',value:sign,winner},playedScore={type:'mate',value:sign*2,winner};
  const before={score:{...rootScore},depth:16,bestmove:best,multipvComplete:true,configKey:'forced-mate-test',
    lines:[{multipv:1,depth:16,score:{...rootScore},pv:[best]},{multipv:2,depth:16,score:{...playedScore},pv:[...pv]}]};
  const after={score:{...rootScore},depth:16,bestmove:pv[1],multipvComplete:true,configKey:before.configKey,
    lines:[{multipv:1,depth:16,score:{...rootScore},pv:pv.slice(1)}],moveReview:{version:1,fen:move.before,uci:uciMove(move),configKey:before.configKey,
      beforeScore:{...rootScore},beforeDepth:16,beforeBestmove:best,score:{...playedScore},depth:16,pv:[...pv],source:'candidate'}};
  return {move,before,after,context:{moves,moveIndex:moves.length-1}};
}
function gradeUnchanged(item) {
  const snapshot=JSON.stringify(item),grade=classifyMove(item.before,item.after,item.move,item.context);
  assert.equal(JSON.stringify(item),snapshot);return grade;
}

test('one forced checking reply followed immediately by mate is excellent for either color',()=>{
  for(const black of [false,true]) {
    const item=fixture({black}),position=new Chess(item.move.before);
    position.move(item.before.bestmove);assert.equal(position.isCheckmate(),true);
    const actual=new Chess(item.move.after);assert.equal(actual.isCheck(),true);assert.equal(actual.moves().length,1);
    for(const uci of item.after.moveReview.pv.slice(1))actual.move(uci);
    assert.equal(actual.isCheckmate(),true);assert.notEqual(actual.turn(),item.move.color);
    const grade=gradeUnchanged(item);assert.equal(grade.key,'excellent');assert.equal(grade.loss,0);assert.equal(grade.pointsLoss,0);
  }
});

test('a quiet move postponing mate remains a missed finish',()=>{
  const item=fixture({pv:['g6g4','h8h7','g4g7']});
  assert.equal(new Chess(item.move.after).isCheck(),false);assert.equal(gradeUnchanged(item).key,'miss');
});

test('even a fully forced checking mate in three is outside the immediate-next-turn exception',()=>{
  const item=fixture({fen:'7k/8/5KQ1/8/1B6/8/8/8 w - - 0 30',pv:['g6h6','h8g8','h6g6','g8h8','g6g7']});
  item.after.moveReview.score.value=3;item.before.lines[1].score.value=3;
  item.after.score.value=2;item.after.lines[0].score.value=2;
  const actual=new Chess(item.move.before);
  for(const uci of item.after.moveReview.pv){const attacking=actual.turn()==='w';if(!attacking)assert.equal(actual.moves().length,1);actual.move(uci);if(attacking)assert.equal(actual.isCheck(),true);}
  assert.equal(actual.isCheckmate(),true);assert.equal(gradeUnchanged(item).key,'miss');
});

test('a legal mating PV does not excuse a checking move with another defender reply',()=>{
  const item=fixture({fen:'6k1/8/7Q/5N2/8/8/8/K3R3 w - - 0 30',best:'h6g7',pv:['h6h7','g8f8','h7g7']});
  const chess=new Chess(item.move.after);assert.ok(chess.moves().length>1);
  for(const uci of item.after.moveReview.pv.slice(1))chess.move(uci);assert.equal(chess.isCheckmate(),true);
  assert.equal(gradeUnchanged(item).key,'miss');
});

test('wrong distance, score direction, binding, depth and incomplete or illegal PVs cannot establish the exception',()=>{
  for(const change of [
    item=>{item.after.moveReview.score.value=3;},
    item=>{item.after.moveReview.score.winner='b';},
    item=>{item.after.moveReview.score.value=-2;},
    item=>{item.after.moveReview.fen=item.move.after;},
    item=>{item.after.moveReview.configKey='other-engine';},
    item=>{delete item.before.configKey;delete item.after.moveReview.configKey;},
    item=>{item.after.moveReview.depth=15;},
    item=>{item.before.multipvComplete=false;},
    item=>{item.before.lines[0].score.value=2;},
    item=>{item.before.lines[0].pv.push('h8h7');},
    item=>{item.after.moveReview.pv.pop();},
    item=>{item.after.moveReview.pv[1]='h8h7';},
    item=>{item.after.moveReview.pv.push('g8h8');},
    item=>{item.context={};},
  ]) {
    const item=fixture();change(item);assert.equal(gradeUnchanged(item).key,'miss');
  }
});

test('the exception respects an actual third repetition caused by the checking move',()=>{
  const seed=new Chess(whiteFen);seed.move('Qh6+');
  const item=fixture({fen:seed.fen(),history:['Kg8','Qg6+','Kh8','Qh6+','Kg8','Qg6+','Kh8']});
  const actual=new Chess(seed.fen());for(const move of item.context.moves.slice(0,-1))actual.move(uciMove(move));
  assert.equal(actual.isGameOver(),false);actual.move(uciMove(item.move));assert.equal(actual.isThreefoldRepetition(),true);
  assert.equal(gradeUnchanged(item).key,'miss');
});

test('a checking delay reaching the fifty-move limit is not a proven forced finish',()=>{
  const item=fixture({fen:whiteFen.replace('0 30','99 30')}),actual=new Chess(item.move.before);actual.move(uciMove(item.move));
  assert.equal(actual.isDrawByFiftyMoves(),true);assert.equal(gradeUnchanged(item).key,'miss');
});

test('editing a previously proved PV or history invalidates the forced-finish exception',()=>{
  const item=fixture();assert.equal(gradeUnchanged(item).key,'excellent');
  item.after.moveReview.pv.pop();assert.equal(gradeUnchanged(item).key,'miss');
  const unrelated=fixture();assert.equal(gradeUnchanged(unrelated).key,'excellent');
  unrelated.context.moves=[{...unrelated.move,before:blackFen},unrelated.move];unrelated.context.moveIndex=1;
  assert.equal(gradeUnchanged(unrelated).key,'miss');
  const mutated=fixture();assert.equal(gradeUnchanged(mutated).key,'excellent');
  mutated.context.moves[0]={...mutated.move,after:blackFen};assert.equal(gradeUnchanged(mutated).key,'miss');
});

test('unchanged forced-finish checks reuse validation without replaying the history',()=>{
  const item=fixture(),grade=classifyMove(item.before,item.after,item.move,item.context),original=Chess.prototype.move;let calls=0;
  Chess.prototype.move=function(...args){calls++;return original.apply(this,args);};
  try{for(let index=0;index<100;index++)assert.equal(classifyMove(item.before,item.after,item.move,item.context),grade);assert.equal(calls,0);}
  finally{Chess.prototype.move=original;}
});
