import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../src/chess-core.js';
import { positionalPawnPurpose } from '../src/positional-purpose.js';

const played=(fen,san)=>new Chess(fen).move(san);
function unchanged(move) {
  const source=JSON.stringify(move),text=positionalPawnPurpose(move);
  assert.equal(JSON.stringify(move),source);
  return text;
}

test('advanced passed pawns explain promotion distance for either side',()=>{
  assert.equal(unchanged(played('7k/8/8/2P5/8/8/8/K7 w - - 0 1','c6')),
    '통과 폰을 c6로 전진시켜 승격까지 두 칸을 남겨둡니다.');
  assert.equal(unchanged(played('7k/2P5/8/8/8/8/8/K7 w - - 0 1','c8=Q')),'');
  assert.equal(unchanged(played('7k/8/8/8/8/5p2/8/K7 b - - 0 1','f2')),
    '통과 폰을 f2로 전진시켜 승격까지 한 칸을 남겨둡니다.');
});

test('an enemy pawn ahead on the file or neighboring files blocks a passed-pawn claim',()=>{
  for(const fen of ['7k/2p5/8/2P5/8/8/8/K7 w - - 0 1',
    '7k/1p6/8/2P5/8/8/8/K7 w - - 0 1',
    '7k/3p4/8/2P5/8/8/8/K7 w - - 0 1'])assert.equal(unchanged(played(fen,'c6')),'');
});

test('blocked promotion paths do not imply clear progress to promotion',()=>{
  const move=played('2r4k/8/8/2P5/8/8/8/K7 w - - 0 1','c6');
  assert.equal(unchanged(move),'');
});

test('quiet pawn moves explain one or two legally supported friendly pawns',()=>{
  const move=played('7k/8/8/8/2P1P3/8/3P4/K7 w - - 0 1','d3');
  assert.equal(unchanged(move),'c4·e4의 폰을 뒷받침하는 폰 사슬을 만듭니다.');
  const black=played('7k/3p4/8/2p5/8/8/8/K7 b - - 0 1','d6');
  assert.equal(unchanged(black),'c5의 폰을 뒷받침하는 폰 사슬을 만듭니다.');
});

test('a pinned pawn is not described as a legal defender',()=>{
  const move=played('3r3k/8/8/8/2P5/8/3P4/3K4 w - - 0 1','d3');
  assert.equal(unchanged(move),'');
});

test('captures, promotions, non-pawns and mismatched records retain the existing purpose fallback',()=>{
  for(const move of [played('7k/8/3p4/2P5/8/8/8/K7 w - - 0 1','cxd6'),
    played('7k/2P5/8/8/8/8/8/K7 w - - 0 1','c8=N'),
    played('7k/8/8/8/8/8/8/KN6 w - - 0 1','Nc3')])assert.equal(unchanged(move),'');
  const move=played('7k/8/8/2P5/8/8/8/K7 w - - 0 1','c6');
  for(const invalid of [{...move,after:move.before},{...move,color:'b'},{...move,from:'c4'},null])
    assert.equal(unchanged(invalid),'');
});
