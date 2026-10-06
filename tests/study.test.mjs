import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, parseGame, gameAt, positionCommand } from '../src/chess-core.js';
import { AnalysisLine, describeMove, editedPosition, movementGuide, materialBalance, exportLine, restoreResults } from '../src/study.js';
import { SAMPLE_PGN } from '../src/sample.js';

test('PV playback advances, rewinds and replays without changing original game',()=>{
  const chess=gameAt(parseGame(SAMPLE_PGN),59);
  const original=chess.fen();
  const line=new AnalysisLine(chess,['d2d8','b5c3','d8d2']);
  assert.equal(line.cursor,0);
  line.seek(1);
  assert.deepEqual(line.position().get('d8'),{type:'r',color:'b'});
  assert.match(line.steps[0].explanation,/백 퀸/);
  assert.equal(line.position().turn(),'w');
  line.seek(0); assert.equal(line.position().fen(),original);
  line.seek(99); assert.equal(line.cursor,3);
  assert.equal(chess.fen(),original);
});
test('a move at an earlier branch point replaces future moves and evaluations only',()=>{
  const line=new AnalysisLine(new Chess(),['e2e4','e7e5','g1f3']);
  const result={score:{type:'cp',value:20}};
  line.results.set(0,result); line.results.set(2,result); line.results.set(3,result);
  line.seek(1); line.play('c7c5');
  assert.deepEqual(line.steps.map(m=>m.uci),['e2e4','c7c5']);
  assert.equal(line.cursor,2);
  assert.equal(line.results.size,1);
  assert.equal(line.results.get(0),result);
});
test('illegal branch move leaves cursor, future and original history intact',()=>{
  const line=new AnalysisLine(new Chess(),['e2e4','e7e5']);
  line.seek(1); const fen=line.position().fen();
  assert.throws(()=>line.play('e1e4'));
  assert.equal(line.cursor,1); assert.equal(line.steps.length,2); assert.equal(line.position().fen(),fen);
});
test('branch snapshots retain repetition history for the engine',()=>{
  const game=parseGame('1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 *');
  const line=new AnalysisLine(gameAt(game,8));
  assert.equal(line.position().isThreefoldRepetition(),true);
  assert.match(positionCommand(line.position()),/moves g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8/);
});
test('PV with illegal tail retains only its legal prefix',()=>{
  const line=new AnalysisLine(new Chess(),['e2e4','e7e5','e1e7','b8c6']);
  assert.equal(line.steps.length,2);
});
test('move explanations correctly describe castling, en passant, promotion and mate',()=>{
  const castle=new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  assert.match(describeMove(castle.move('O-O')),/h1 → f1/);
  const ep=new Chess(); for(const move of ['e4','a6','e5','d5'])ep.move(move);
  assert.match(describeMove(ep.move('exd6')),/앙파상으로 d5의 흑 폰/);
  const promotion=new Chess('7k/P7/7K/8/8/8/8/8 w - - 0 1');
  assert.match(describeMove(promotion.move('a8=N')),/나이트로 승격/);
  const game=gameAt(parseGame(SAMPLE_PGN),58);
  assert.match(describeMove(game.move('Qe8#')),/체크메이트입니다/);
});
test('editor applies new placements and turn with rights reset; rejects invalid kings',()=>{
  const chess=new Chess();
  const board=new Map(chess.board().flat().filter(Boolean).map(p=>[p.square,{type:p.type,color:p.color}]));
  board.set('e4',board.get('e2'));board.delete('e2');
  const edited=editedPosition(board,'b');
  assert.equal(edited.turn(),'b');assert.equal(edited.fen().split(' ')[2],'-');
  assert.equal(chess.get('e4'),undefined);
  board.delete('e1');assert.throws(()=>editedPosition(board,'w'));
  board.set('e3',{type:'k',color:'w'});board.set('e4',{type:'k',color:'b'});board.delete('e8');
  assert.throws(()=>editedPosition(board,'w'));
});
test('movement guide covers six pieces and both pawn directions',()=>{
  assert.equal(movementGuide('n').targets.length,8);
  assert.equal(movementGuide('b').targets.length,13);
  assert.equal(movementGuide('r').targets.length,14);
  assert.equal(movementGuide('q').targets.length,27);
  assert.equal(movementGuide('k').targets.length,8);
  assert.deepEqual(movementGuide('p','w').targets.map(t=>t.square),['d3','d4','c3','e3']);
  assert.deepEqual(movementGuide('p','b').targets.map(t=>t.square),['d6','d5','c6','e6']);
  assert.equal(movementGuide('p').targets.filter(t=>t.capture).length,2);
});

test('branch PGN retains original prefix, comments, result * and full proposed continuation',()=>{
  const chess=gameAt(parseGame(SAMPLE_PGN),58);
  const line=new AnalysisLine(chess,['e7e8']);
  line.results.set(1,{score:{type:'mate',value:0,winner:'w'},depth:0});
  const pgn=exportLine(line,{White:'shinjjong',Black:'imgubi',Result:'1-0',Termination:'resignation'});
  const game=parseGame(pgn);
  assert.equal(game.moves.length,59);
  assert.equal(game.moves.at(-1).san,'Qe8#');
  assert.equal(game.headers.Result,'*');
  assert.equal(game.headers.Termination,undefined);
  assert.match(pgn,/체크메이트입니다/);
  assert.equal(chess.fen(),line.base.fen());
});
test('edited-FEN branch export retains the starting FEN',()=>{
  const chess=new Chess('7k/P7/7K/8/8/8/8/8 w - - 0 1');
  const line=new AnalysisLine(chess,['a7a8n']);
  const game=parseGame(exportLine(line));
  assert.equal(game.startFen,chess.fen());
  assert.equal(game.moves[0].san,'a8=N');
});
test('material count works from an arbitrary FEN and excludes kings',()=>{
  assert.deepEqual(materialBalance(new Chess().board().flat()),{w:39,b:39,difference:0});
  const chess=new Chess('7k/P7/7K/8/8/8/8/8 w - - 0 1');
  assert.deepEqual(materialBalance(chess.board().flat()),{w:1,b:0,difference:1});
  chess.move('a8=N');assert.equal(materialBalance(chess.board().flat()).w,3);
});
test('saved analysis restores only in-range results for the matching engine',()=>{
  const good={score:{type:'cp',value:10},lines:[],depth:12};
  const data={engine:'Stockfish 19 Lite',results:[[0,good],[1,good],[9,good],[-1,good],[2,{score:{type:'cp',value:null},lines:[]}],null]};
  assert.deepEqual([...restoreResults(data,3).keys()],[0,1]);
  assert.equal(restoreResults({...data,engine:'old'},3).size,0);
});
