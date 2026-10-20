import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, parseGame, gameAt, uciMove } from '../src/chess-core.js';
import { describeMove, explainMove, createInsightLine } from '../src/insight.js';
import { materialBalance } from '../src/study.js';

// Public Rotlevi–Rubinstein 1907. The short legal PVs and position scores below
// are taken from the Lite depth-16 / 1200ms review, not proprietary captions.
const ROTLEVI = `1. d4 d5 2. Nf3 e6 3. e3 c5 4. c4 Nc6 5. Nc3 Nf6
6. dxc5 Bxc5 7. a3 a6 8. b4 Bd6 9. Bb2 O-O 10. Qd2 Qe7
11. Bd3 dxc4 12. Bxc4 b5 13. Bd3 Rd8 14. Qe2 Bb7 15. O-O Ne5
16. Nxe5 Bxe5 17. f4 Bc7 18. e4 Rac8 19. e5 Bb6+ 20. Kh1 Ng4
21. Be4 Qh4 22. g3 Rxc3 23. gxh4 Rd2 24. Qxd2 Bxe4+ 25. Qg2 Rh3 0-1`;

function cp(value,pv=[],configKey='independent-caption-audit') {
  const score={type:'cp',value};
  return {score,depth:16,bestmove:pv[0]||null,multipvComplete:true,configKey,
    lines:pv.length?[{multipv:1,depth:16,score,pv}]:[]};
}

function fixture(index,value,pv) {
  const game=parseGame(ROTLEVI),move=game.moves[index-1];
  return {game,index,move,before:cp(value,[uciMove(move)]),after:cp(value,pv),
    moves:game.moves,moveIndex:index-1,previousMove:game.moves[index-2]};
}

function unchanged(context,read) {
  const original=JSON.stringify(context),position=gameAt(context.game,context.index);
  const fen=position.fen(),history=position.history({verbose:true});
  const value=read();
  assert.equal(JSON.stringify(context),original,'teaching prose must not alter the source review or game');
  assert.equal(position.fen(),fen);
  assert.deepEqual(position.history({verbose:true}),history);
  return value;
}

const material=chess=>materialBalance(chess.board().flat()).difference;

for(const {index,value,pv,san,amount} of [
  {index:23,value:-63,pv:['b7b5'],san:'Bxc4',amount:1},
  {index:32,value:-59,pv:['f1d1'],san:'Bxe5',amount:3},
]) test(`${san} does not turn an equal completed recapture into a new ${amount}-point profit`,()=>{
  const context=fixture(index,value,pv),{game,move,before,after}=context;
  assert.equal(move.san,san);
  assert.equal(game.moves[index-2].captured,move.captured);
  assert.equal(material(gameAt(game,index-2)),material(gameAt(game,index)),
    'the two real captures restore the material balance that preceded this exchange');
  const insight=unchanged(context,()=>explainMove(move,before,after,context));
  assert.ok(insight);
  assert.match(insight.response.focus.note,/교환|유지|동등|같/);
  assert.doesNotMatch(insight.response.focus.note,new RegExp(`${amount}점 이득`));
});

test('20.Kh1 explains escaping the actual bishop check, preserving the reviewed position',()=>{
  const context=fixture(39,-349,['f6g4']),{game,move,before,after}=context;
  const initial=gameAt(game,38),final=gameAt(game,39);
  assert.equal(move.san,'Kh1');
  assert.equal(initial.isCheck(),true);
  assert.equal(initial.get('b6').type,'b');
  assert.equal(final.isCheck(),false);
  const caption=unchanged(context,()=>describeMove(move,before,after,context).text);
  assert.match(caption,/체크/);
  assert.match(caption,/피|벗|해소|대응/);
});

test('25.Qg2 explains blocking the checking diagonal rather than only attacking its bishop',()=>{
  const context=fixture(49,-1902,['c3h3']),{game,move,before,after}=context;
  const initial=gameAt(game,48),final=gameAt(game,49);
  assert.equal(move.san,'Qg2');
  assert.equal(initial.isCheck(),true);
  assert.equal(initial.get('e4').type,'b');
  assert.equal(final.get('e4').type,'b','the checking bishop was not captured');
  assert.equal(final.get('g2').type,'q');
  assert.equal(final.isCheck(),false,'the queen now blocks e4–f3–g2–h1');
  const caption=unchanged(context,()=>describeMove(move,before,after,context).text);
  assert.match(caption,/체크/);
  assert.match(caption,/막|차단|사이/);
});

test('Opera 13.Rxd7 never uses a later bishop check as the cause of an earlier queen capture',()=>{
  const position=new Chess('3rkb1r/p2nqppp/5n2/1B2p1B1/4P3/1Q6/PPP2PPP/2KR3R w k - 3 13');
  const move=position.move('Rxd7'),uci=uciMove(move);
  const game={startFen:move.before,moves:[move],positions:[move.before,move.after],headers:{}};
  const before=cp(732,[uci,'d8d7']),after=cp(720,['d8d7','h1d1']);
  const branchPv=['f6d7','g5e7','f8e7','b5d7','d8d7','b3b8','d7d8','b8b5','e8f8','b5e5','h7h5','h1d1','d8e8','e5c7'];
  after.moveReview={version:1,fen:move.before,uci,configKey:before.configKey,
    beforeScore:before.score,beforeDepth:16,beforeBestmove:uci,
    score:before.score,depth:16,pv:[uci,'d8d7','h1d1'],source:'best',
    sacrificeReview:{version:1,status:'verified',fen:move.after,rootFen:move.before,uci,configKey:before.configKey,
      requestedDepth:15,restrictedMoves:['d8d7','e7d7','f6d7'],branches:[{
        capture:'f6d7',score:{type:'cp',value:720},depth:16,pv:branchPv,multipvComplete:true,
        verified:true,status:'verified',source:'candidate',bestResponse:false,
      }]}};
  const context={game,index:1,move,before,after};
  const insight=unchanged(context,()=>explainMove(move,before,after,context));
  const line=unchanged(context,()=>createInsightLine({...context,insight},'sacrifice','full'));
  assert.ok(insight.sacrifice);
  assert.deepEqual(line.steps.slice(0,4).map(step=>step.san),['Nxd7','Bxe7','Bxe7','Bxd7+']);
  assert.equal(line.steps[1].captured,'q');
  assert.equal(new Chess(line.steps[1].after).isCheck(),false);
  assert.equal(new Chess(line.steps[3].after).isCheck(),true);
  assert.match(insight.sacrificeFact,/e7.*퀸/);
  assert.doesNotMatch(insight.sacrificeFact,/체크한 뒤.*e7.*퀸/,
    'Bxd7+ happens after Bxe7, so it cannot set up that earlier queen capture');
  assert.doesNotMatch(insight.sacrificeFact,/긴 예상 수순에서는.*e7.*퀸/,
    'the queen is captured on the immediate answering move; only settlement is later');
  assert.equal(line.cursor,0);
  assert.equal(line.position().fen(),move.after);
});

test('the third real repetition is explained as a draw using game history, not only its final FEN',()=>{
  const game=parseGame('1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 *'),index=game.moves.length;
  const move=game.moves[index-1],before=cp(0,[uciMove(move)]),after=cp(0,[]),context={game,index,move,before,after};
  assert.equal(gameAt(game,index).isThreefoldRepetition(),true);
  assert.equal(new Chess(move.after).isThreefoldRepetition(),false,'FEN alone loses the repetition claim');
  const caption=unchanged(context,()=>describeMove(move,before,after,context).text);
  assert.match(caption,/반복|동형/);
  assert.match(caption,/무승부/);
  const insight=unchanged(context,()=>explainMove(move,before,after,context));
  assert.deepEqual(insight.response.moves,[],'a completed draw must not produce a fictitious next move');
});

test('the fifty-move boundary is reported at 100 halfmoves, without prematurely drawing at 99',()=>{
  for(const clock of [98,99]) {
    const start=`7k/8/8/8/8/8/R7/7K w - - ${clock} 50`,chess=new Chess(start),move=chess.move('Rb2');
    const game={startFen:start,moves:[move],positions:[start,move.after],headers:{}},index=1;
    const before=cp(0,[uciMove(move)]),after=cp(0,[]),context={game,index,move,before,after};
    assert.equal(gameAt(game,index).isDrawByFiftyMoves(),clock===99);
    const caption=unchanged(context,()=>describeMove(move,before,after,context).text);
    if(clock===99) {assert.match(caption,/50/);assert.match(caption,/무승부/);}
    else assert.doesNotMatch(caption,/50수|무승부/);
  }
});

test('Fischer 46.Ke4 includes the delayed knight recapture and attributes the lost pawn to its real capture',()=>{
  const start='1R6/8/3B1pk1/1P1n2p1/6Pp/1r1P1K1P/5P2/8 w - - 3 46';
  const move=new Chess(start).move('Ke4');
  const game={startFen:start,moves:[move],positions:[start,move.after],headers:{}};
  const before=cp(311,['b5b6']);
  const pv=['b3b5','b8b5','d5c3','e4e3','c3b5','d6b4','f6f5','f2f3',
    'g6f6','b4a5','b5a7','a5d8','f6g6','d8b6','a7c6','b6c5','g6f6',
    'd3d4','f6e6','e3d3','f5g4','f3g4'];
  const after=cp(136,pv),context={game,index:1,move,before,after};
  const insight=unchanged(context,()=>explainMove(move,before,after,context));
  const core=unchanged(context,()=>createInsightLine({...context,insight},'response'));
  const full=unchanged(context,()=>createInsightLine({...context,insight},'response','full'));
  assert.deepEqual(core.steps.map(step=>step.san),['Rxb5','Rxb5','Nc3+','Ke3','Nxb5']);
  assert.equal(material(new Chess(core.steps.at(-1).after)),material(new Chess(start))-1,
    'both rooks are gone and White has lost one pawn, not gained a temporary rook');
  assert.match(insight.response.focus.note,/백 1점 손해/);
  assert.doesNotMatch(insight.response.focus.note,/4점 이득/);
  assert.equal(insight.response.consequence.ply,1);
  assert.equal(insight.response.consequence.capture.to,'b5');
  assert.equal(insight.response.consequence.capture.captured,'p');
  assert.equal(insight.response.consequence.distant,false);
  assert.deepEqual(full.steps.slice(20,22).map(step=>step.san),['fxg4','fxg4']);
  assert.equal(material(new Chess(full.steps[19].after)),material(new Chess(full.steps[21].after)),
    'the later equal pawn exchange cannot be the cause of the already lost b5 pawn');
  assert.doesNotMatch(`${insight.summary} ${insight.riskFact}`,/21번째|g4의 백 폰/);
  assert.equal(core.position().fen(),move.after);
  assert.equal(core.cursor,0);
});

test('Tal 31...Rxg5 shows the nearby queen loss instead of a temporary knight profit',()=>{
  const start='2r4k/5prp/2bQP3/5pN1/1PpR1P2/2q5/P4K1P/4R3 b - - 2 31';
  const move=new Chess(start).move('Rxg5');
  const game={startFen:start,moves:[move],positions:[start,move.after],headers:{}};
  const before=cp(160,['f7e6']);
  const after=cp(537,['d6e5','g5g7','d4d8','c8d8','e5c3','f7e6','e1e6',
    'c6e4','c3f6','d8g8','f2e3','e4b1','b4b5']);
  const context={game,index:1,move,before,after};
  const insight=unchanged(context,()=>explainMove(move,before,after,context));
  const core=unchanged(context,()=>createInsightLine({...context,insight},'response'));
  assert.deepEqual(core.steps.slice(0,5).map(step=>step.san),['Qe5+','Rg7','Rd8+','Rxd8','Qxc3']);
  assert.equal(core.steps[4].captured,'q');
  assert.equal(insight.response.consequence.ply,5);
  assert.equal(insight.response.consequence.distant,false,
    'a capture at ply five remains nearby even if an unrelated pawn exchange follows it');
  assert.equal(material(new Chess(core.steps.at(-1).after)),material(new Chess(start))+1,
    'the knight capture and rook-for-queen combination together cost Black one material point');
  assert.match(insight.response.focus.note,/흑 1점 손해/);
  assert.doesNotMatch(insight.response.focus.note,/3점 이득/);
  assert.equal(core.position().fen(),move.after);
  assert.equal(core.cursor,0);
});
