import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardMarks } from '../src/annotations.js';
import { capturedPieces } from '../src/pieces.js';
import { Chess } from '../src/chess-core.js';

test('private marks toggle independently and survive a same-position refresh',()=>{
  const marks=new BoardMarks();marks.sync('game:1');marks.toggle('b2','e5');marks.toggle('e4','e4');
  marks.sync('game:1');assert.equal(marks.items.size,2);
  marks.toggle('b2','e5');assert.deepEqual([...marks.items.values()],[{from:'e4',to:'e4'}]);
  marks.sync('game:2');assert.equal(marks.items.size,0);
});
test('capture collection uses actual history, including en passant and undo',()=>{
  const chess=new Chess();for(const move of ['e4','a6','e5','d5','exd6'])chess.move(move);
  assert.deepEqual(capturedPieces(chess.history({verbose:true})),{w:['p'],b:[]});
  chess.undo();assert.deepEqual(capturedPieces(chess.history({verbose:true})),{w:[],b:[]});
});
test('FEN omissions are not captures and a captured promoted piece keeps its actual type',()=>{
  const chess=new Chess('7k/P7/8/8/8/8/7K/1r6 w - - 0 1');
  assert.deepEqual(capturedPieces(chess.history({verbose:true})),{w:[],b:[]});
  chess.move('a8=Q+');chess.move('Kh7');chess.move('Qa1');chess.move('Rxa1');
  assert.deepEqual(capturedPieces(chess.history({verbose:true})),{w:[],b:['q']});
});
