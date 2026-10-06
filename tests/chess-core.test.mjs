import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, DEFAULT_POSITION, parseGame, parseInfo, gameAt, positionCommand, terminalResult, classifyMove, formatScore, scoreValue, pvToSan, exportPgn } from '../src/chess-core.js';
import { SAMPLE_PGN } from '../src/sample.js';

test('provided PGN replays all 59 plies and matches its final FEN exactly', () => {
  const game = parseGame(SAMPLE_PGN);
  assert.equal(game.moves.length,59);
  assert.equal(game.startFen,DEFAULT_POSITION);
  assert.equal(game.positions.at(-1),'3Q3k/p1p3pp/P7/1N6/2P1Pp2/7P/3r1qP1/7K b - - 4 30');
  assert.equal(gameAt(game,59).fen(),game.positions[59]);
  assert.equal(game.headers.Result,'1-0');
  assert.equal(gameAt(game,59).isCheckmate(),false);
});
test('PGN with custom starting FEN and black to move retains move numbers', () => {
  const game = parseGame('[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/4P3/4K3 b - - 0 17"]\n\n17... Kd7 18. e4 *');
  assert.equal(game.moves.length,2);
  assert.equal(game.moves[0].color,'b');
  assert.match(pvToSan(game.startFen,['e8d7','e2e4']),/^17\.\.\. Kd7 18\. e4$/);
});
test('bad PGN, invalid FEN, attacked idle king and impossible castling are rejected', () => {
  assert.throws(() => parseGame('1. e4 e5 2. Ke4 *'));
  assert.throws(() => parseGame('8/8/8/8/8/8/8/8 w - - 0 1','fen'));
  assert.throws(() => parseGame('4k3/8/8/8/8/8/4R3/4K3 w - - 0 1','fen'));
  assert.throws(() => parseGame('4k3/8/8/8/8/8/8/4K3 w K - 0 1','fen'));
  assert.throws(() => parseGame('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w','fen'));
});
test('UCI centipawns and mate scores normalize to white perspective', () => {
  const white = parseInfo('info depth 15 multipv 2 score cp 133 nodes 800 pv e2e4 e7e5','w');
  const black = parseInfo('info depth 15 score cp 133 nodes 800 pv e7e5','b');
  assert.equal(white.score.value,133); assert.equal(white.multipv,2);
  assert.equal(black.score.value,-133);
  assert.equal(formatScore(black.score),'-1.33');
  const mate = parseInfo('info depth 8 score mate -3 pv h8g8','b');
  assert.equal(mate.score.value,3); assert.equal(mate.score.winner,'w');
  assert.equal(parseInfo('info depth 9 score cp 55 lowerbound pv e2e4','w'),null);
  assert.equal(parseInfo('info string NNUE evaluation','w'),null);
});
test('checkmate and stalemate have correct terminal evaluation', () => {
  const mate = terminalResult(new Chess('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1'));
  assert.equal(mate.score.winner,'w'); assert.equal(mate.score.value,0);
  assert.ok(scoreValue(mate.score) > 0); assert.equal(formatScore(mate.score),'+M0');
  const stalemate = terminalResult(new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'));
  assert.equal(stalemate.score.value,0); assert.match(stalemate.terminal,/스테일메이트/);
});
test('repetition context is sent to engine and terminal detection retains history', () => {
  const game = parseGame('1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8 *');
  const chess = gameAt(game,8);
  assert.match(positionCommand(chess),/moves g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8$/);
  assert.match(terminalResult(chess).terminal,/동형 반복/);
});
test('grades distinguish white and black losses and preserve winning mates', () => {
  const result = value => ({score:{type:'cp',value},bestmove:'a2a3'});
  const move = {from:'e2',to:'e4',color:'w'};
  assert.equal(classifyMove(result(100),result(-150),move).key,'blunder');
  assert.equal(classifyMove(result(100),result(-150),{...move,color:'b'}).key,'best');
  assert.equal(classifyMove(result(-100),result(10),{...move,color:'b'}).key,'mistake');
  assert.equal(classifyMove({...result(100),bestmove:'e2e4'},result(100),move).key,'best');
  assert.equal(classifyMove({score:{type:'mate',value:3,winner:'w'}},{score:{type:'mate',value:5,winner:'w'}},move).key,'best');
});
test('promotion PV uses SAN, illegal continuation is truncated', () => {
  assert.match(pvToSan('7k/P7/7K/8/8/8/8/8 w - - 0 1',['a7a8q','a1a2']),/^1\. a8=Q/);
});
test('annotated PGN roundtrip preserves moves, result and evaluated positions', () => {
  const game = parseGame(SAMPLE_PGN);
  const results = new Map([[59,{score:{type:'cp',value:-243},depth:16}]]);
  const pgn = exportPgn(game,results);
  assert.match(pgn,/\[%eval -2.43\]/);
  const loaded = parseGame(pgn);
  assert.equal(loaded.positions.at(-1),game.positions.at(-1));
  assert.equal(loaded.headers.Result,'1-0');
});
