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
    }
  }
}
const data=Object.fromEntries([...positions].sort().map(([fen,moves])=>[fen,[...moves].sort()]));
await writeFile(new URL('../src/opening-book.js',import.meta.url),`// Generated from lichess-org/chess-openings (CC0). See data/openings/SOURCES.json.\nconst book = ${JSON.stringify(data)};\nexport function isBookMove(move) {\n  if (!move?.before) return false;\n  return book[move.before.split(' ').slice(0,4).join(' ')]?.includes(move.from+move.to+(move.promotion||'')) || false;\n}\n`);
await writeFile(new URL('../data/openings/SOURCES.json',import.meta.url),JSON.stringify({source:'https://github.com/lichess-org/chess-openings',license:'CC0-1.0',downloaded:'2026-10-04',maxPlies,sources},null,2)+'\n');
console.log(`Opening book: ${positions.size} positions`);
