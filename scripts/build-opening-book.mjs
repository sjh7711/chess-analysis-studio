import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Chess } from '../node_modules/chess.js/dist/esm/chess.js';

// CC0 factual opening data: https://github.com/lichess-org/chess-openings
const positions = new Map();
const sources = [];
for (const volume of ['a','b','c','d','e']) {
  const input = await readFile(new URL(`../data/openings/${volume}.tsv`,import.meta.url),'utf8');
  sources.push({file:`${volume}.tsv`,sha256:createHash('sha256').update(input).digest('hex')});
  for (const row of input.trim().split(/\r?\n/).slice(1)) {
    const pgn = row.split('\t')[2];
    const chess = new Chess();
    chess.loadPgn(pgn);
    // Recognize named opening prefixes, limited to the first ten full moves.
    for (const move of chess.history({verbose:true}).slice(0,20)) {
      const key = move.before.split(' ').slice(0,4).join(' ');
      if (!positions.has(key)) positions.set(key,new Set());
      positions.get(key).add(`${move.from}${move.to}${move.promotion||''}`);
    }
  }
}
const data=Object.fromEntries([...positions].sort().map(([fen,moves])=>[fen,[...moves].sort()]));
await writeFile(new URL('../src/opening-book.js',import.meta.url),`// Generated from lichess-org/chess-openings (CC0). See data/openings/SOURCES.json.\nconst book = ${JSON.stringify(data)};\nexport function isBookMove(move) {\n  if (!move?.before || Number(move.before.split(' ')[5]) > 10) return false;\n  return book[move.before.split(' ').slice(0,4).join(' ')]?.includes(move.from+move.to+(move.promotion||'')) || false;\n}\n`);
await writeFile(new URL('../data/openings/SOURCES.json',import.meta.url),JSON.stringify({source:'https://github.com/lichess-org/chess-openings',license:'CC0-1.0',downloaded:'2026-10-04',maxPlies:20,sources},null,2)+'\n');
console.log(`Opening book: ${positions.size} positions`);
