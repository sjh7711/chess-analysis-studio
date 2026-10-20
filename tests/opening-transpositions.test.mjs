import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, classifyMove } from '../src/chess-core.js';
import { isBookMove } from '../src/opening-book.js';

function last(sans) {
  const chess=new Chess();
  return sans.split(' ').map(san=>chess.move(san)).at(-1);
}

test('English and Reti move orders reach the same registered queen-pawn theory',()=>{
  for(const sans of ['c4 Nf6 Nc3 e6 d4','Nf3 Nf6 c4 e6 Nc3 d5 d4']) {
    const move=last(sans),original=JSON.stringify(move);
    assert.equal(isBookMove(move),true);
    assert.equal(JSON.stringify(move),original);
  }
});

test('a Reti move order can transpose into registered Sicilian theory',()=>{
  assert.equal(isBookMove(last('Nf3 c5 e4')),true);
  assert.equal(isBookMove(last('e4 c5 Nf3')),true);
});

test('a transposition retains castling and en-passant identity while ignoring move counters',()=>{
  const move=last('Nf3 c5 e4');
  const lateFields=move.before.split(' ');lateFields[4]='72';lateFields[5]='18';
  const late=new Chess(lateFields.join(' ')).move('e4');
  assert.equal(isBookMove(late),true);
  const rights=move.before.split(' ');rights[2]='-';
  assert.equal(isBookMove(new Chess(rights.join(' ')).move('e4')),false);
  const ep=move.after.split(' ');ep[3]='e3';
  assert.equal(isBookMove({...move,after:ep.join(' ')}),false);
});

test('an unrelated arrival, illegal move or mutated metadata cannot claim a book transposition',()=>{
  const move=last('Nf3 c5 e4');
  assert.equal(isBookMove(move),true);
  for(const invalid of [{...move,from:'a1'},{...move,color:'b'},{...move,piece:'q'},
    {...move,after:move.before},{...move,before:'not a FEN'}])assert.equal(isBookMove(invalid),false);
  move.color='b';
  assert.equal(isBookMove(move),false,'cached recognition must not survive changed source metadata');
});

test('opening membership cannot hide a large evaluated error',()=>{
  const move=last('c4 Nf6 Nc3 e6 d4');
  assert.equal(isBookMove(move),true);
  const before={score:{type:'cp',value:0},lines:[]},after={score:{type:'cp',value:-300},lines:[]};
  assert.notEqual(classifyMove(before,after,move).key,'book');
});
