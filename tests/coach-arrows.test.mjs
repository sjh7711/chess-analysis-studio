import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../src/chess-core.js';
import { explanationArrows } from '../src/coach-arrows.js';

const central='중앙의 e4·d5 칸을 겨냥하며 나이트를 전개합니다.';
function played(fen,san) { return new Chess(fen).move(san); }
function verifyUnchanged(move,caption) {
  const source=JSON.stringify(move),value=explanationArrows(move,caption);
  assert.equal(JSON.stringify(move),source);
  assert.ok(value.length===0 || value.length===2);
  return value;
}

test('Nc3 shows d5 control and its real friendly e4 pawn support, with no source mutation',()=>{
  const move=played('r3kbnr/pp2pppp/n1p5/7b/B3P3/5P2/PPP3PP/RNBK2NR w kq - 2 8','Nc3');
  assert.deepEqual(verifyUnchanged(move,central),[
    {from:'c3',to:'e4',kind:'support'},{from:'c3',to:'d5',kind:'control'},
  ]);
});

test('Black central control uses its own pawn and the actual played destination',()=>{
  const chess=new Chess();['e4','e5','Nc3'].forEach(move=>chess.move(move));
  const move=chess.move('Nc6');
  assert.deepEqual(verifyUnchanged(move,'중앙의 d4·e5 칸을 제어하며 나이트를 전개합니다.'),[
    {from:'c6',to:'d4',kind:'control'},{from:'c6',to:'e5',kind:'support'},
  ]);
});

test('one target, unrelated squares and future/alternative prose retain the ordinary-arrow fallback',()=>{
  const move=played('r3kbnr/pp2pppp/n1p5/7b/B3P3/5P2/PPP3PP/RNBK2NR w kq - 2 8','Nc3');
  for(const caption of ['',null,'중앙의 d5 칸을 제어합니다.','나이트를 전개합니다.',
    '중앙의 e5·d4 칸을 제어합니다.',`대신 ${central}`,`상대가 잡으면 ${central}`,
    `다음 수에 ${central}`,`긴 예상 수순에서는 ${central}`])assert.deepEqual(verifyUnchanged(move,caption),[]);
});

test('a knight legally interposing a bishop check cannot then control two squares while pinned',()=>{
  const move=played('7k/8/8/8/3bP3/8/NK6/8 w - - 0 1','Nc3');
  const after=new Chess(move.after);
  assert.equal(after.isCheck(),false);
  assert.ok(after.attackers('e4','w').includes('c3'),'geometric attack alone is insufficient');
  assert.deepEqual(verifyUnchanged(move,central),[]);
});

test('an absolutely pinned rook does not produce two sideways attack arrows',()=>{
  const move=played('4r2k/8/8/8/8/4R3/1q5r/4K3 w - - 0 1','Re2');
  assert.deepEqual(verifyUnchanged(move,'b2의 퀸·h2의 룩을 동시에 공격합니다.'),[]);
});

test('two named valuable enemy targets yield a verified knight fork',()=>{
  const move=played('7k/2q5/8/2r3N1/8/8/8/7K w - - 0 1','Ne6');
  assert.deepEqual(verifyUnchanged(move,'c7의 퀸·c5의 룩을 동시에 공격합니다.'),[
    {from:'e6',to:'c7',kind:'attack'},{from:'e6',to:'c5',kind:'attack'},
  ]);
  assert.deepEqual(verifyUnchanged(move,'c7의 퀸·d5의 룩을 동시에 공격합니다.'),[]);
});

test('a checking knight and its named rook target yield two arrows without inventing a king capture',()=>{
  const move=played('8/3r3k/4N3/8/8/8/8/7K w - - 0 1','Nf8+');
  assert.deepEqual(verifyUnchanged(move,'체크하면서 d7의 룩도 겨냥합니다.'),[
    {from:'f8',to:'h7',kind:'check'},{from:'f8',to:'d7',kind:'attack'},
  ]);
});

test('a discovered check does not falsely originate from the moved knight',()=>{
  const move=played('k7/3r4/8/8/N7/8/8/R6K w - - 0 1','Nc5+');
  const after=new Chess(move.after);
  assert.equal(after.isCheck(),true);
  assert.deepEqual(after.attackers('a8','w'),['a1']);
  assert.deepEqual(verifyUnchanged(move,'체크하면서 d7의 룩도 겨냥합니다.'),[]);
});

test('a friendly central king is never replaced with a pretend enemy pawn',()=>{
  const move=played('7k/p7/8/1N6/4K3/8/8/8 w - - 0 1','Nc3');
  assert.equal(new Chess(move.after).get('e4').type,'k');
  assert.deepEqual(verifyUnchanged(move,central),[]);
  assert.equal(new Chess(move.after).get('e4').type,'k');
});

test('mismatched positions, source metadata and illegal moves cannot supply explanatory arrows',()=>{
  const move=played('r3kbnr/pp2pppp/n1p5/7b/B3P3/5P2/PPP3PP/RNBK2NR w kq - 2 8','Nc3');
  for(const invalid of [{...move,after:move.before},{...move,before:'not a FEN'},
    {...move,piece:'b'},{...move,color:'b'},{...move,from:'a1'},
    {...move,captured:'q'},{...move,flags:'c'},null])assert.deepEqual(verifyUnchanged(invalid,central),[]);
});

test('checkmate, stalemate and fifty-move terminal positions do not draw control arrows',()=>{
  for(const san of ['Qg7#','Qf7']) {
    const move=played('7k/8/5KQ1/8/8/8/8/8 w - - 0 1',san);
    assert.equal(new Chess(move.after).isGameOver(),true);
    assert.deepEqual(verifyUnchanged(move,'체크하면서 e4의 룩도 겨냥하고 중앙의 d4·e5 칸을 제어합니다.'),[]);
  }
  const move=played('r3kbnr/pp2pppp/n1p5/7b/B3P3/5P2/PPP3PP/RNBK2NR w kq - 99 8','Nc3');
  assert.equal(new Chess(move.after).isDrawByFiftyMoves(),true);
  assert.deepEqual(verifyUnchanged(move,central),[]);
});
