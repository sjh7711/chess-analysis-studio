import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Chess, parseGame, uciMove } from '../src/chess-core.js';
import { describeMove } from '../src/insight.js';

const game=parseGame(readFileSync(new URL('./fixtures/review-example.pgn',import.meta.url),'utf8'));
const cp=(value,pv=[])=>({score:{type:'cp',value},bestmove:pv[0],lines:[{pv}],depth:16});
const at=(n,color)=>game.moves.find(m=>Number(m.before.split(' ')[5])===n && m.color===color);

test('provided 151-ply game produces short factual descriptions, including its final draw',()=>{
  assert.equal(game.moves.length,151);
  for (const move of game.moves) {
    const description=describeMove(move,null,null);
    assert.equal(description.grade,null);
    assert.ok(description.text.length>5 && description.text.length<180);
    assert.doesNotMatch(description.text,/undefined|NaN|이론/);
  }
  assert.match(describeMove(game.moves.at(-1),null,null).text,/기물.*무승부/);
});

test('Nf3 develops and attacks e5, while d6 defends that attacked pawn',()=>{
  const knight=at(2,'w'),pawn=at(2,'b');
  const development=describeMove(knight,cp(30,[uciMove(knight)]),cp(30));
  assert.equal(development.grade.key,'book');
  assert.match(development.text,/나이트를 중앙 쪽으로 전개/);
  assert.match(development.text,/e5의 폰을 공격/);
  assert.match(development.text,/d4 칸도 제어/);
  assert.match(describeMove(pawn,cp(30),cp(59)).text,/공격받던 e5의 폰을 지킵니다/);
});

test('a truncated capture line with a possible recapture does not claim a settled pawn loss',()=>{
  const move=at(17,'b');
  const description=describeMove(move,cp(-50,['d5c5']),cp(143,['f3e4']));
  assert.match(description.text,/바로 다음 수에 백 폰이 e4의 흑 폰을 잡을 수/);
  assert.match(description.text,/후속 응수가 부족/);
  assert.doesNotMatch(description.text,/수비 없이|잃을 수/);
  assert.doesNotMatch(description.text,/평가|1\.93|국면/);
});

test('a legal delayed queen loss is described, and a queen exchange is not a free loss',()=>{
  const chess=new Chess('4k2r/7p/8/8/7Q/8/8/4K3 w - - 0 1');
  const move=chess.move('Qxh7');
  assert.match(describeMove(move,cp(0,['h4e4']),cp(-800,['h8h7'])).text,/퀸이 상대 룩의 공격 범위에 놓여.*흑 룩이 h7의 백 퀸을 잡을 수/);
  const trade=new Chess('3qk3/8/8/8/8/8/8/3QK3 w - - 0 1');
  const exchange=trade.move('Qxd8+');
  const description=describeMove(exchange,cp(300,['e1e2']),cp(0,['e8d8']));
  assert.doesNotMatch(description.text,/수비 없이|잃을 수/);
});

test('a mismatch or illegal PV never invents a capture beyond its legal prefix',()=>{
  const move=at(17,'b');
  const invalid=cp(143,['f3e4','a8h8','h8d1']);
  assert.doesNotMatch(describeMove(move,cp(-50),invalid).text,/룩|퀸/);
  const mismatched={...invalid,bestmove:'h2h3'};
  assert.doesNotMatch(describeMove(move,cp(-50),mismatched).text,/fxe4|잡을 수|잃을 수/);
});

test('promotion and en passant descriptions identify the real captured square',()=>{
  assert.match(describeMove(at(37,'w'),null,null).text,/백 폰이 f8의 흑 룩을 잡고 퀸으로 승격/);
  const chess=new Chess('7k/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
  const move=chess.move('exd6');
  assert.match(describeMove(move,null,null).text,/앙파상으로 d5의 흑 폰을 잡습니다/);
});

test('a knight developed to the edge is not described as central development',()=>{
  const chess=new Chess('4k3/8/8/8/2p5/8/8/1N2K3 w - - 0 4');
  const move=chess.move('Na3');
  const comment=describeMove(move,null,null);
  assert.match(comment.text,/나이트를 전개하며 c4의 폰을 공격/);
  assert.doesNotMatch(comment.text,/중앙/);
});

test('loss explanations identify verified tactical causes rather than just naming the captured square',()=>{
  const cases=[
    {fen:'k7/8/3p4/4P3/8/5N2/8/4K3 w - - 0 10',move:'Nh4',pv:['d6e5'],cause:/폰을 지키던 나이트가 자리를 떠나.*e5의 백 폰을 잡/},
    {fen:'k7/8/2b5/3N4/4P3/8/8/4K3 w - - 0 10',move:'Nb4',pv:['c6e4'],cause:/비숍의 공격길이 열려.*e4의 백 폰을 잡/},
    {fen:'k7/8/8/5n2/8/8/2R1K3/7R w - - 0 10',move:'Rg1',pv:['f5d4','e2f2','d4c2'],cause:/나이트의 동시 공격.*c2의 백 룩을 잡/},
    {fen:'k1r5/8/8/8/8/8/6Q1/4K3 w - - 0 10',move:'Qg1',pv:['c8c1','e1f2','c1g1','f2g1'],cause:/체크에 대응하는 사이.*g1의 백 퀸을 잡/},
    {fen:'k3r3/8/5b2/8/8/2P5/4N3/4K2R w - - 0 10',move:'Rg1',pv:['f6c3','e1f1'],cause:/폰을 지키는 나이트가 왕을 보호하느라 되잡을 수 없어.*c3의 백 폰을 잡/},
    {fen:'k7/8/8/8/3p4/8/4P3/7K w - - 0 10',move:'e4',pv:['d4e3'],cause:/앙파상을 허용해.*e4의 백 폰을 잡/},
  ];
  for (const {fen,move:san,pv,cause} of cases) {
    const chess=new Chess(fen),move=chess.move(san);
    for (const uci of pv) assert.ok(chess.move(uci),'fixture continuation must be legal');
    const description=describeMove(move,cp(0),cp(-300,pv));
    assert.equal(description.grade.key,'blunder');
    assert.match(description.text,/^이 수로 인해/);
    assert.match(description.text,cause,san);
    assert.doesNotMatch(description.text,/예상 응수가 이어지면|undefined|NaN/);
  }
});
