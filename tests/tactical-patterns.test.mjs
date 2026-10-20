import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../src/chess-core.js';
import { tacticalPatterns } from '../src/tactical-patterns.js';
import { describeMove } from '../src/insight.js';

const played=(fen,san)=>new Chess(fen).move(san);
const discoveryFen='4r1k1/8/2P5/8/B7/8/8/6K1 w - - 0 20';
function unchanged(move) {
  const original=JSON.stringify(move),before=new Chess(move.before),after=new Chess(move.after);
  const previous=before.fen(),next=after.fen(),result=tacticalPatterns(move);
  assert.equal(JSON.stringify(move),original);
  assert.equal(before.fen(),previous);assert.equal(after.fen(),next);
  assert.deepEqual(before.history(),[]);assert.deepEqual(after.history(),[]);
  return result;
}

test('clearing a pawn reveals the stationary bishop attack on the actual rear rook',()=>{
  const move=played(discoveryFen,'c7'),result=unchanged(move);
  assert.deepEqual(result.discovered,[{color:'w',attackerSquare:'a4',attackerType:'b',targetSquare:'e8',targetType:'r'}]);
  assert.deepEqual(result.skewers,[]);
  assert.match(describeMove(move,null,null).text,/c6.*비워.*a4의 비숍.*e8의 룩.*공격/);
  const chess=new Chess(move.after);chess.move('Kh7');
  assert.equal(chess.move('Bxe8').captured,'r','the opened attack is a legal capture after a possible reply');
});

test('a pinned bishop, a second blocker, and an already existing attack do not become discovered attacks',()=>{
  for(const move of [
    played('r3r1k1/8/2P5/8/B7/8/8/K7 w - - 0 20','c7'),
    played('4r1k1/3N4/2P5/8/B7/8/8/6K1 w - - 0 20','c7'),
    played('4r1k1/8/8/8/B7/8/5P2/6K1 w - - 0 20','f3'),
  ])assert.deepEqual(unchanged(move).discovered,[]);
});

test('a discovered check is not mistaken for an attack on an invented major piece',()=>{
  const move=played('4k3/8/2P5/8/B7/8/8/6K1 w - - 0 20','c7+');
  assert.equal(new Chess(move.after).isCheck(),true);
  assert.deepEqual(unchanged(move).discovered,[]);
  assert.deepEqual(unchanged(move).skewers,[]);
  assert.doesNotMatch(describeMove(move,null,null).text,/e8의 룩|비숍이.*룩을/);
});

test('moving the same pawn when no rook is on the opened diagonal cannot invent the rook attack',()=>{
  // The same pawn advance can have a different purpose in another position.
  const move=played('6k1/8/2Pr4/5r2/B7/8/8/6K1 w - - 0 20','c7');
  assert.deepEqual(unchanged(move).discovered,[]);
  assert.doesNotMatch(describeMove(move,null,null).text,/e8의 룩|a4의 비숍.*공격/);
});

test('a checking rook identifies the king and rear rook, without promising that the opponent must lose it',()=>{
  const move=played('8/7R/3r2k1/6P1/8/8/8/4K3 w - - 0 20','Rh6+');
  const result=unchanged(move);
  assert.deepEqual(result.skewers,[{color:'w',attackerSquare:'h6',attackerType:'r',kingSquare:'g6',targetSquare:'d6',targetType:'r'}]);
  const caption=describeMove(move,null,null).text;
  assert.match(caption,/h6의 룩.*체크.*g6의 왕 뒤 d6의 룩.*같은 공격선/);
  assert.doesNotMatch(caption,/반드시|강제로|잡을 수밖에|잃습니다|얻습니다/);
  const reply=new Chess(move.after);reply.move('Kg7');
  assert.equal(reply.move('Rxd6').captured,'r');
});

test('checking skewers also verify vertical and diagonal attack lines',()=>{
  for(const {fen,san,attacker,king,target} of [
    {fen:'4r3/8/8/4k3/8/8/R7/7K w - - 0 20',san:'Re2+',attacker:'e2',king:'e5',target:'e8'},
    {fen:'7K/8/8/8/5r2/8/1B1k4/R7 w - - 0 20',san:'Bc1+',attacker:'c1',king:'d2',target:'f4'},
  ]) {
    const result=unchanged(played(fen,san));
    assert.equal(result.skewers.length,1);
    assert.equal(result.skewers[0].attackerSquare,attacker);
    assert.equal(result.skewers[0].kingSquare,king);
    assert.equal(result.skewers[0].targetSquare,target);
  }
});

test('a pinned checker or a nonchecking line does not promise a legal rear-piece attack',()=>{
  for(const move of [
    played('7r/7R/3r2k1/6P1/8/8/8/7K w - - 0 20','Rh6+'),
    played('8/7R/3r4/6k1/8/8/8/4K3 w - - 0 20','Rh6'),
    played('8/7R/3r1pk1/6P1/8/8/8/4K3 w - - 0 20','Rh6+'),
  ])assert.deepEqual(unchanged(move).skewers,[]);
});

test('mismatched records and illegal positions are rejected, including cached objects edited in place',()=>{
  const move=played(discoveryFen,'c7');
  assert.equal(unchanged(move).discovered.length,1);
  for(const invalid of [null,{...move,from:'b6'},{...move,to:'c8'},{...move,piece:'n'},{...move,color:'b'},
    {...move,captured:'r'},{...move,promotion:'q'},{...move,san:'c8=Q'},{...move,flags:'c'},
    {...move,after:move.before},{...move,before:move.before.replace(' w - ',' w K ')}])assert.equal(tacticalPatterns(invalid),null);
  const saved=move.san;move.san='c8=Q';assert.equal(tacticalPatterns(move),null);
  move.san=saved;assert.equal(unchanged(move).discovered.length,1);
});

test('interposing a bishop names the actual queen attack it blocks before secondary purposes',()=>{
  const move=played('3b3k/Q2b4/8/8/8/8/8/6K1 b - - 0 20','Bc7'),result=unchanged(move);
  assert.deepEqual(result.blocks,[{kind:'block',color:'b',blockSquare:'c7',attackerSquare:'a7',attackerType:'q',
    protectedSquare:'d7',protectedType:'b'}]);
  assert.match(describeMove(move,null,null).text,/c7.*a7의 퀸.*d7의 비숍.*공격하던 길.*막/);
  const before=new Chess(move.before);before.move('Kh7');assert.equal(before.move('Qxd7').captured,'b');
  assert.throws(()=>new Chess(move.after).move('Qxd7'),'the original queen capture is now blocked');
});

test('a blocker is not credited for an already blocked or illegally pinned enemy attack',()=>{
  for(const move of [
    played('3b3k/Qp1b4/8/8/8/8/8/6K1 b - - 0 20','Bc7'),
    played('r2b3k/Q2b4/8/8/8/8/8/K7 b - - 0 20','Bc7'),
    played('3b3k/Q2b4/8/8/8/8/8/6K1 b - - 0 20','Be7'),
  ])assert.deepEqual(unchanged(move).blocks,[]);
});

test('a second interposition unpins the knight only when it gains a real legal move off the pin line',()=>{
  const move=played('r1bqkbnr/ppp1pppp/2n5/1B1p4/8/8/PPPPPPPP/RNBQK1NR b KQkq - 1 3','Bd7');
  const result=unchanged(move);
  assert.ok(result.blocks.some(pattern=>pattern.kind==='unpin'&&pattern.protectedSquare==='c6'&&pattern.attackerSquare==='b5'));
  assert.match(describeMove(move,null,null).text,/d7.*비숍.*c6의 나이트.*핀을 풉/);
  const before=new Chess(move.before);assert.throws(()=>before.move('Nb4'));
  const after=new Chess(move.after);after.move('h3');assert.equal(after.move('Nb4').piece,'n');
  for(const negative of [
    played('2b2k2/8/2n5/1B6/8/8/8/6K1 b - - 0 20','Bd7'),
    played('2b1k3/8/2n5/1B6/8/8/8/6K1 b - - 0 20','Be6'),
  ])assert.deepEqual(unchanged(negative).blocks,[]);
});

test('an attacked rook escape keeps its legally verified defence of the promotion square',()=>{
  const move=played('3r3k/4P3/8/8/8/8/8/4R1K1 b - - 0 20','Ra8'),result=unchanged(move);
  assert.deepEqual(result.promotionEscapes,[{color:'b',from:'d8',to:'a8',piece:'r',pawnSquare:'e7',promotionSquare:'e8',
    attackerSquare:'e7',attackerType:'p'}]);
  assert.match(describeMove(move,null,null).text,/공격받던 룩을 a8로 피하면서 e8 승격칸도 계속 지킵/);
  for(const [fen,origin] of [[move.before,'d8'],[move.after,'a8']]) {
    const fields=fen.split(' ');fields[1]='w';
    const position=new Chess(fields.join(' '));position.move('e8=Q+');
    assert.equal(position.move({from:origin,to:'e8'}).captured,'q');
  }
});

test('losing promotion control, a blocked promotion, a nonescaping move or a distant pawn cannot claim maintained defence',()=>{
  for(const move of [
    played('3r3k/4P3/8/8/8/8/8/4R1K1 b - - 0 20','Rd7'),
    played('3rb2k/4P3/8/8/8/8/8/6K1 b - - 0 20','Ra8'),
    played('3r3k/4P3/2Q5/8/8/8/8/6K1 b - - 0 20','Ra8'),
    played('3r3k/8/4P3/8/8/8/8/6K1 b - - 0 20','Ra8'),
  ])assert.deepEqual(unchanged(move).promotionEscapes,[]);
});

test('vacating a knight opens a new queen recapture to defend the previously unprotected bishop',()=>{
  // Carlsen-Guha, 15.Nf3: the d2 knight clears Qd1-d3, besides attacking Ne5.
  const move=played('r4rk1/ppq2ppp/5n2/3pn3/5b2/2PB3P/PP1N1PP1/R1BQR1K1 w - - 0 15','Nf3');
  assert.deepEqual(unchanged(move).discoveredDefenses,[{color:'w',defenderSquare:'d1',defenderType:'q',
    protectedSquare:'d3',protectedType:'b',attackerSquare:'e5',attackerType:'n'}]);
  const previous=new Chess(move.before),fields=previous.fen().split(' ');fields[1]='b';
  const capture=new Chess(fields.join(' '));capture.move('Nxd3');
  assert.equal(capture.moves({verbose:true}).some(reply=>reply.captured&&reply.to==='d3'),false);
  const following=new Chess(move.after);following.move('Nxd3');assert.equal(following.move('Qxd3').captured,'n');
  assert.match(describeMove(move,null,null).text,/d2.*비워.*d1의 퀸.*d3의 비숍.*지키/);
  assert.doesNotMatch(describeMove(move,null,null).text,/e5의 나이트를 공격/);
});

test('vacating a king reveals rook defence that makes the former enemy-king capture illegal',()=>{
  // Carlsen-Guha, 54.Kf6: Kf5 had blocked Rg5-d5, allowing ...Kxd5.
  const move=played('8/5p2/3k4/3P1KRP/5P2/7r/8/8 w - - 5 54','Kf6');
  assert.deepEqual(unchanged(move).discoveredDefenses,[{color:'w',defenderSquare:'g5',defenderType:'r',
    protectedSquare:'d5',protectedType:'p',attackerSquare:'d6',attackerType:'k'}]);
  const fields=move.before.split(' ');fields[1]='b';
  assert.equal(new Chess(fields.join(' ')).move('Kxd5').captured,'p');
  assert.throws(()=>new Chess(move.after).move('Kxd5'));
  assert.match(describeMove(move,null,null).text,/f5.*비워.*g5의 룩.*d5의 폰.*지키/);
  assert.doesNotMatch(describeMove(move,null,null).text,/f7의 폰을 공격/);
});

test('new defence requires a real previous unanswered capture, a clear ray and a legal unpinned defender',()=>{
  for(const [fen,san] of [
    ['6k1/8/8/4n3/8/3B4/3N4/2KQ3r w - - 0 20','Nf3'], // pinned queen
    ['6k1/8/8/5n2/3B4/3P4/3N4/3Q2K1 w - - 0 20','Nf3'], // second blocker
    ['6k1/8/8/4n3/8/3B4/8/1N1Q2K1 w - - 0 20','Nc3'], // already clear
    ['6k1/8/8/8/8/3B4/3N4/3Q2K1 w - - 0 20','Nf3'], // no prior attack
    ['6k1/8/8/4n3/8/3B4/2PN4/3Q2K1 w - - 0 20','Nf3'], // already recapturable
  ])assert.deepEqual(unchanged(played(fen,san)).discoveredDefenses,[]);
});

test('a bishop can block a verified queen capture of a pawn before its secondary attack',()=>{
  // Carlsen-Guha, 19.Bb3: block Qb6-b2 while also attacking Pd5.
  const move=played('r3r1k1/pp3ppp/1q3n2/3p4/8/2P2Q1P/PPB2PP1/2R1R1K1 w - - 3 19','Bb3');
  assert.ok(unchanged(move).blocks.some(item=>item.kind==='block'&&item.protectedSquare==='b2'&&item.protectedType==='p'
    &&item.attackerSquare==='b6'));
  const fields=move.before.split(' ');fields[1]='b';
  assert.equal(new Chess(fields.join(' ')).move('Qxb2').captured,'p');
  assert.throws(()=>new Chess(move.after).move('Qxb2'));
  assert.match(describeMove(move,null,null).text,/b3.*b6의 퀸.*b2의 폰.*공격하던 길.*막/);
  for(const negative of [
    played('6k1/8/1q6/8/1p6/8/PPB2P2/6K1 w - - 0 20','Bb3'),
    played('6k1/8/1q6/8/8/8/PPB2P2/1R4K1 w - - 0 20','Bd3'),
  ])assert.deepEqual(unchanged(negative).blocks,[]);
});
