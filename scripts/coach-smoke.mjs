import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { StockfishEngine } from '../src/engine.js';
import { parseGame, gameAt, formatScore } from '../src/chess-core.js';
import { describeMove, moveLabel } from '../src/insight.js';

class NodeWorker {
  constructor(url) {
    const filename=url.split('/').at(-1).split(/[?#]/)[0];
    this.child=spawn(process.execPath,[fileURLToPath(new URL(`../node_modules/stockfish/bin/${filename}`,import.meta.url))],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let buffer='';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',chunk=>{
      buffer+=chunk;
      let newline;
      while ((newline=buffer.indexOf('\n'))>=0) { const data=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);this.onmessage?.({data}); }
    });
    this.child.stderr.on('data',chunk=>process.stderr.write(chunk));
    this.child.on('error',error=>this.onerror?.(error));
  }
  postMessage(command) { this.child.stdin.write(command+'\n'); }
  terminate() { this.child.kill(); }
}
const game=parseGame(await readFile(new URL('../tests/fixtures/review-example.pgn',import.meta.url),'utf8'));
const engine=new StockfishEngine(NodeWorker);
try {
  for (const index of [2,3,31,33,69,73,80]) {
    const before=await engine.analyze(gameAt(game,index),{depth:16,movetime:1500,multipv:3});
    const after=await engine.analyze(gameAt(game,index+1),{depth:16,movetime:1500,multipv:3});
    const comment=describeMove(game.moves[index],before,after);
    assert.ok(comment.text && comment.grade);
    assert.doesNotMatch(comment.text,/undefined|NaN/);
    console.log(JSON.stringify({move:moveLabel(game.moves[index]),before:formatScore(before.score),after:formatScore(after.score),comment},null,2));
  }
} finally { engine.dispose(); }
