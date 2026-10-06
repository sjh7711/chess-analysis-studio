import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Chess, parseGame } from '../src/chess-core.js';
import { moveText } from '../src/study.js';
import { describeMove, explainMistake, moveLabel } from '../src/insight.js';

const game=parseGame(readFileSync(new URL('./fixtures/review-example.pgn',import.meta.url),'utf8'));
const cp=(value,pv=[])=>({score:{type:'cp',value},bestmove:pv[0],lines:[{pv}],depth:16});

test('Bxe6 identifies the black bishop and the actual captured white rook',()=>{
  const move=game.moves[47];
  assert.equal(move.san,'Bxe6');
  assert.equal(moveText(move),'흑 비숍이 e6의 백 룩을 잡습니다.');
  assert.equal(describeMove(move,null,null).text,moveText(move));
  assert.equal(moveLabel(move),'흑의 24번째 수 · 비숍 c8에서 e6로');
});

test('both castling sides name the king and rook destinations without O-O notation',()=>{
  const fen='r3k2r/8/8/8/8/8/8/R3K2R';
  const white=new Chess(`${fen} w KQkq - 0 1`).move('O-O');
  const black=new Chess(`${fen} b KQkq - 0 1`).move('O-O-O');
  assert.equal(moveText(white),'백 킹이 e1에서 g1로 이동하고 룩도 h1에서 f1로 옮겨 캐슬링합니다.');
  assert.equal(moveText(black,'alternative'),'흑 킹이 e8에서 c8로 이동하고 룩도 a8에서 d8로 옮겨 캐슬링했어야 합니다.');
});

test('capture promotion, check, and en passant retain all move effects in words',()=>{
  const promotion=game.moves[72];
  assert.equal(promotion.san,'gxf8=Q');
  assert.equal(moveText(promotion),'백 폰이 f8의 흑 룩을 잡고 퀸으로 승격합니다.');
  const under=new Chess('1r5k/P7/8/8/8/8/8/7K w - - 0 1').move('axb8=N');
  assert.equal(moveText(under),'백 폰이 b8의 흑 룩을 잡고 나이트로 승격합니다.');
  const check=game.moves[46];
  assert.match(moveText(check),/백 룩이.*체크합니다\./);
  const ep=new Chess('7k/8/8/3pP3/8/8/8/4K3 w - d6 0 1').move('exd6');
  assert.equal(moveText(ep),'백 폰이 e5에서 d6로 이동해 앙파상으로 d5의 흑 폰을 잡습니다.');
});

test('coach and insight prose never expose SAN for legal continuations from the supplied game',()=>{
  for(let index=0;index<game.moves.length-1;index++) {
    const move=game.moves[index],next=game.moves[index+1];
    const before=cp(0);
    const after=cp(move.color==='w'?-200:200,[next.from+next.to+(next.promotion||'')]);
    const insight=explainMistake(move,before,after);
    for(const text of [describeMove(move,before,after).text,insight.summary,moveLabel(move)]) {
      assert.doesNotMatch(text,/(?:[KQRBN][a-h1-8]?x?[a-h][1-8]|O-O|=[QRBN]|\d+\.\.\.)/);
    }
  }
});
