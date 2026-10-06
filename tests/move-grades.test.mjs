import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, classifyMove, expectedPoints, MOVE_GRADES, uciMove } from '../src/chess-core.js';
const cp=(value,bestmove,lines=[])=>({score:{type:'cp',value},bestmove,lines});
const move={from:'e2',to:'e4',color:'w'};

test('ten move categories use expected-point loss with symmetric black evaluations',()=>{
  assert.equal(Object.keys(MOVE_GRADES).length,10);
  for(const [loss,key] of [[0,'best'],[10,'excellent'],[30,'good'],[75,'inaccuracy'],[150,'mistake'],[300,'blunder']]){
    assert.equal(classifyMove(cp(0),cp(-loss),move).key,key);
    assert.equal(classifyMove(cp(0),cp(loss),{...move,color:'b'}).key,key);
  }
  assert.equal(expectedPoints({type:'cp',value:0}),0.5);
  assert.equal(classifyMove(cp(800),cp(500),move).key,'inaccuracy');
});
test('great moves require a verified second candidate and a meaningful advantage over it',()=>{
  const before=cp(70,'e2e4',[{multipv:1,score:{type:'cp',value:70}},{multipv:2,score:{type:'cp',value:-100}}]);
  assert.equal(classifyMove(before,cp(70),move).key,'great');
  assert.equal(classifyMove(cp(70,'e2e4'),cp(70),move).key,'best');
  assert.notEqual(classifyMove(before,cp(-200),move).key,'great');
});
test('a good accepted bishop sacrifice is distinguished from a bad or unverified sacrifice',()=>{
  const chess=new Chess('r2q1rk1/ppp2ppp/2n5/3p4/3P4/3B1N2/PPP2PPP/R2Q1RK1 w - - 0 15');
  const sacrifice=chess.move('Bxh7+');
  const pv=['Kxh7','Ng5+','Kg8','Qh5'].map(san=>uciMove(chess.move(san)));
  const before=cp(0,uciMove(sacrifice)),after=cp(0,undefined,[{pv}]);
  assert.equal(classifyMove(before,after,sacrifice).key,'brilliant');
  assert.notEqual(classifyMove(before,cp(-300,undefined,[{pv}]),sacrifice).key,'brilliant');
  assert.notEqual(classifyMove(before,cp(0,undefined,[{pv:pv.slice(0,1)}]),sacrifice).key,'brilliant');
});
test('misses require the opponent to have created a new winning chance, or a missed forced mate',()=>{
  const before=cp(350),after=cp(0);
  assert.equal(classifyMove(before,after,move,{previous:cp(-50)}).key,'miss');
  assert.equal(classifyMove(before,after,move,{previous:cp(350)}).key,'blunder');
  assert.equal(classifyMove({score:{type:'mate',value:3,winner:'w'}},cp(900),move).key,'miss');
  assert.equal(classifyMove(cp(-900),{score:{type:'mate',value:-1,winner:'b'}},move).key,'blunder');
});
test('book moves need an actual opening match and do not hide engine-detected mistakes',()=>{
  const chess=new Chess(),e4=chess.move('e4');
  assert.equal(classifyMove(cp(30),cp(30),e4).key,'book');
  assert.equal(classifyMove(cp(30),cp(-300),e4).key,'blunder');
  const far={...e4,before:e4.before.replace('0 1','0 30')};
  assert.equal(classifyMove(cp(30),cp(30),far).key,'best');
});
