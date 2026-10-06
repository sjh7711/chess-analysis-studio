import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, parseGame, gameAt } from '../src/chess-core.js';
import { pieceSnapshot, pieceTransitions } from '../src/pieces.js';
import { SAMPLE_PGN } from '../src/sample.js';

const moved=plans=>plans.filter(({from,to})=>from && to && from.square!==to.square);
const moves=plans=>moved(plans).map(({from,to})=>`${from.square}-${to.square}`).sort();

test('forward and backward navigation use the same pawn identity',()=>{
  const chess=new Chess(),before=pieceSnapshot(chess);
  chess.move('e4');const after=pieceSnapshot(chess);
  assert.deepEqual(moves(pieceTransitions(before,after)),['e2-e4']);
  assert.deepEqual(moves(pieceTransitions(after,before)),['e4-e2']);
  assert.equal(moved(pieceTransitions(before,after))[0].from.id,moved(pieceTransitions(before,after))[0].to.id);
});

test('both pieces in either castle animate in both directions',()=>{
  for (const [san,expected] of [['O-O',['e1-g1','h1-f1']],['O-O-O',['a1-d1','e1-c1']]]) {
    const chess=new Chess('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1'),before=pieceSnapshot(chess);
    chess.move(san);const after=pieceSnapshot(chess);
    assert.deepEqual(moves(pieceTransitions(before,after)),expected);
    assert.deepEqual(moves(pieceTransitions(after,before)),expected.map(s=>s.split('-').reverse().join('-')).sort());
  }
});

test('promotion keeps the pawn identity and changes its appearance at arrival',()=>{
  const chess=new Chess('7k/P7/8/8/8/8/8/4K3 w - - 0 1'),before=pieceSnapshot(chess);
  chess.move('a8=Q+');const after=pieceSnapshot(chess);
  const [{from,to}]=moved(pieceTransitions(before,after));
  assert.equal(from.id,to.id);assert.equal(from.type,'p');assert.equal(to.type,'q');
  const [reverse]=moved(pieceTransitions(after,before));
  assert.equal(reverse.from.type,'q');assert.equal(reverse.to.type,'p');
});

test('en passant fades the captured pawn on its own square and restores it on rewind',()=>{
  const chess=new Chess('7k/8/8/3pP3/8/8/8/4K3 w - d6 0 1'),before=pieceSnapshot(chess);
  chess.move('exd6');const after=pieceSnapshot(chess),forward=pieceTransitions(before,after);
  assert.deepEqual(moves(forward),['e5-d6']);
  assert.equal(forward.find(p=>!p.to).from.square,'d5');
  assert.equal(pieceTransitions(after,before).find(p=>!p.from).to.square,'d5');
});

test('large jumps and different branches preserve surviving pieces without reusing captured pawns',()=>{
  const root=new Chess(),before=pieceSnapshot(root);
  for (const move of ['e4','d5','exd5','Qxd5','Nc3','Qd8']) root.move(move);
  const after=pieceSnapshot(root),plans=pieceTransitions(before,after);
  assert.deepEqual(moves(plans),['b1-c3']);
  assert.deepEqual(plans.filter(p=>!p.to).map(p=>p.from.square).sort(),['d7','e2']);
  const branch=new Chess();branch.move('d4');
  const changed=pieceTransitions(after,pieceSnapshot(branch));
  assert.deepEqual(moves(changed),['c3-b1','d2-d4']);
  assert.deepEqual(changed.filter(p=>!p.from).map(p=>p.to.square).sort(),['d7','e2']);
});

test('identical pieces retain their identities when their squares cross',()=>{
  const a={id:'a',type:'r',color:'w',square:'a1'},b={id:'b',type:'r',color:'w',square:'h1'};
  assert.deepEqual(moves(pieceTransitions({key:'same',pieces:[a,b]},{key:'same',pieces:[{...a,square:'h1'},{...b,square:'a1'}]})),['a1-h1','h1-a1']);
});

test('an edited FEN preserves unchanged pieces and connects a moved piece',()=>{
  const before=pieceSnapshot(new Chess('4k3/8/8/8/8/8/8/R3K2R w - - 0 1'));
  const after=pieceSnapshot(new Chess('4k3/8/8/8/R7/8/8/4K2R w - - 0 1'));
  const plans=pieceTransitions(before,after);
  assert.deepEqual(moves(plans),['a1-a4']);
  assert.ok(plans.every(p=>p.from && p.to));
});

test('tracked snapshots agree with the actual board across captures and checks in the sample game',()=>{
  const game=parseGame(SAMPLE_PGN);
  for (const index of [0,13,26,37,52,59]) {
    const chess=gameAt(game,index),snapshot=pieceSnapshot(chess);
    const plain=pieces=>pieces.map(({square,type,color})=>`${square}:${color}${type}`).sort();
    assert.deepEqual(plain(snapshot.pieces),plain(chess.board().flat().filter(Boolean)));
    assert.equal(new Set(snapshot.pieces.map(p=>p.id)).size,snapshot.pieces.length);
  }
});
