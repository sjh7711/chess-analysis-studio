import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Chess } from '../node_modules/chess.js/dist/esm/chess.js';

// CC0 factual opening data: https://github.com/lichess-org/chess-openings
const positions = new Map();
const sources = [];
let maxPlies = 0;
for (const volume of ['a','b','c','d','e']) {
  const input = await readFile(new URL(`../data/openings/${volume}.tsv`,import.meta.url),'utf8');
  sources.push({file:`${volume}.tsv`,sha256:createHash('sha256').update(input).digest('hex')});
  for (const row of input.trim().split(/\r?\n/).slice(1)) {
    const pgn = row.split('\t')[2];
    const chess = new Chess();
    chess.loadPgn(pgn);
    // Follow the source's named opening lines, including theory beyond move 10.
    const moves = chess.history({verbose:true});
    maxPlies = Math.max(maxPlies,moves.length);
    for (const move of moves) {
      const key = move.before.split(' ').slice(0,4).join(' ');
      if (!positions.has(key)) positions.set(key,new Set());
      positions.get(key).add(`${move.from}${move.to}${move.promotion||''}`);
      // Include named endpoints as well as outgoing edges. A different legal
      // move order can arrive at the same registered opening position.
      const arrival = move.after.split(' ').slice(0,4).join(' ');
      if (!positions.has(arrival)) positions.set(arrival,new Set());
    }
  }
}
const data=Object.fromEntries([...positions].sort().map(([fen,moves])=>[fen,[...moves].sort()]));
await writeFile(new URL('../src/opening-book.js',import.meta.url),`// Generated from lichess-org/chess-openings (CC0). See data/openings/SOURCES.json.
import { Chess } from '../node_modules/chess.js/dist/esm/chess.js';
const book = ${JSON.stringify(data)};
const transpositionCache = new WeakMap();
export function isBookMove(move) {
  if (!move?.before) return false;
  const uci=move.from+move.to+(move.promotion||'');
  if (book[move.before.split(' ').slice(0,4).join(' ')]?.includes(uci)) return true;
  if (!move.after || !Object.hasOwn(book,move.after.split(' ').slice(0,4).join(' '))) return false;
  const signature=[move.before,move.after,uci,move.color,move.piece,move.captured,move.promotion].join('|');
  const cached=transpositionCache.get(move);
  if (cached?.signature===signature) return cached.result;
  let result=false;
  try {
    const chess=new Chess(move.before),actual=chess.move({from:move.from,to:move.to,...(move.promotion?{promotion:move.promotion}:{})});
    result=actual.after===move.after && ['color','piece','captured','promotion'].every(key=>(actual[key]??null)===(move[key]??null));
  } catch { /* Unrelated or illegal records cannot establish a transposition. */ }
  transpositionCache.set(move,{signature,result});
  return result;
}
`);
await writeFile(new URL('../data/openings/SOURCES.json',import.meta.url),JSON.stringify({source:'https://github.com/lichess-org/chess-openings',license:'CC0-1.0',downloaded:'2026-10-04',maxPlies,recognition:'Named edges or legally verified arrivals at registered positions; board, turn, castling and en-passant rights are preserved.',sources},null,2)+'\n');
console.log(`Opening book: ${positions.size} positions`);
