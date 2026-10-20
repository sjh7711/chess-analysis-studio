import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, parseGame, uciMove } from '../src/chess-core.js';
import { describeHumanMove, describeMove, explainMove } from '../src/insight.js';

const cp=(value,move)=>({score:{type:'cp',value},depth:16,bestmove:uciMove(move),lines:[{pv:[uciMove(move)]}]});
const move=(fen,san)=>new Chess(fen).move(san);
const opening='1. d4 d5 2. c4 c6 3. Nf3 Nf6 4. Nc3 e6 5. e3 Nbd7 6. Bd3 dxc4 7. Bxc4 b5 8. Bd3 Bd6 9. O-O O-O *';

test('Nc3 explains the actual central purpose before any grading language',()=>{
  const game=parseGame(opening),played=game.moves[6],before=cp(29,played),after={...cp(29,game.moves[7])};
  const description=describeMove(played,before,after),insight=explainMove(played,before,after);
  assert.match(description.text,/^d5의 폰을 공격하고 e4 칸도 제어하며 나이트를 전개합니다\.$/);
  assert.equal(describeHumanMove(played),description.text);
  assert.equal(insight.summary,description.text);
  assert.doesNotMatch(insight.summary,/가장 높은 평가|예상 승점|최선수|b1에서 c3/);
});

test('a check-and-rook attack is described without claiming a forced gain',()=>{
  // Kasparov–Topalov, Wijk aan Zee 1999, before 35.Qb2+.
  const played=move('3r3r/1R3p1p/6p1/1p6/2q5/5PPB/3k3P/QK6 w - - 2 35','Qb2+');
  assert.equal(describeHumanMove(played),'체크하면서 h8의 룩도 겨냥합니다.');
  assert.doesNotMatch(describeHumanMove(played),/킹·|이깁|잡을 수밖에|강제|예상 승점/);
});

test('pawn development names both its real support and the bishop path it opens',()=>{
  const game=parseGame(opening),e6=game.moves[7],e3=game.moves[8];
  assert.match(describeHumanMove(e6),/^d5의 폰을 뒷받침하고 f8의 비숍이 나올 길을 엽니다\./);
  const white=describeHumanMove(e3);
  assert.match(white,/d4의 폰을 뒷받침하고 f1의 비숍이 나올 길/);
  assert.match(white,/c1의 비숍이 갈 수 있는 대각선은 좁아집니다/);
  assert.doesNotMatch(white,/c4의 폰을 뒷받침|반드시|유리해집|최선/);
});

test('recaptures require matching move history and do not promise that an exchange is finished',()=>{
  const game=parseGame(opening),played=game.moves[12],previousMove=game.moves[11];
  assert.equal(played.san,'Bxc4');
  assert.equal(describeHumanMove(played,{previousMove}),'c4의 폰을 되잡습니다.');
  assert.doesNotMatch(describeHumanMove(played),/되잡|교환.*끝|이득/);
  assert.doesNotMatch(describeHumanMove(played,{previousMove:{...previousMove,after:previousMove.before}}),/되잡/);
});

test('castling explains the two pieces without promising that the king is always safe',()=>{
  const game=parseGame(opening),white=game.moves[16],black=game.moves[17];
  assert.equal(describeHumanMove(white),'캐슬링해 왕을 g1로 옮기고 룩을 f1로 꺼냅니다.');
  assert.equal(describeHumanMove(black),'캐슬링해 왕을 g8로 옮기고 룩을 f8로 꺼냅니다.');
  assert.doesNotMatch(describeHumanMove(white),/안전해집|확보|더 안전|반드시/);
});

test('a rook pinned to its own king is not credited with a false queen-and-knight fork',()=>{
  const played=move('k3r3/8/8/8/8/1q4n1/4R3/4K3 w - - 0 20','Re3');
  const comment=describeHumanMove(played);
  assert.match(comment,/폰이 없는 e파일/);
  assert.doesNotMatch(comment,/b3|g3|퀸|나이트|동시에/);
});

test('a pinned pawn does not claim to defend a bishop or control a central capture square',()=>{
  const played=move('k3r3/8/8/5n2/3B4/8/4P3/4K3 w - - 0 20','e3');
  assert.doesNotMatch(describeHumanMove(played),/비숍.*지킵|d4.*제어|d4.*겨냥/);
});

test('escaping a pseudo-attack by a pinned enemy is not presented as a needed rescue',()=>{
  const played=move('4k3/4n3/2B5/8/8/8/7p/4R2K w - - 0 20','Bb5');
  assert.doesNotMatch(describeHumanMove(played),/공격받던|피합니다/);
});

test('an actual attack can be escaped and an actual attacked pawn can be defended',()=>{
  const escaped=move('k7/8/8/8/2p5/1N6/8/4K3 w - - 0 20','Na1');
  assert.match(describeHumanMove(escaped),/공격받던 나이트를 a1로 피합니다/);
  const guarded=move('k7/8/8/8/3P3r/8/8/4K1N1 w - - 0 20','Nf3');
  assert.match(describeHumanMove(guarded),/공격받던 d4의 폰을 지킵니다/);
});
