import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { StockfishEngine } from '../src/engine.js';
import { Chess, parseGame, gameAt, formatScore, pvToSan } from '../src/chess-core.js';
import { SAMPLE_PGN } from '../src/sample.js';

class NodeWorker {
  constructor(url) {
    const filename=url.split('/').at(-1).split(/[?#]/)[0];
    this.child = spawn(process.execPath,[fileURLToPath(new URL(`../node_modules/stockfish/bin/${filename}`,import.meta.url))],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const data = buffer.slice(0,newline).trim(); buffer = buffer.slice(newline+1);
        this.onmessage?.({data});
      }
    });
    this.child.stderr.on('data',chunk => process.stderr.write(chunk));
    this.child.on('error',error => this.onerror?.(error));
  }
  postMessage(command) { this.child.stdin.write(command+'\n'); }
  terminate() { this.child.kill(); }
}

const engine = new StockfishEngine(NodeWorker);
try {
  const start = new Chess();
  const initial = await engine.analyze(start,{depth:12,movetime:600,multipv:3});
  assert.ok(initial.depth > 0);
  assert.equal(initial.lines.length,3);
  assert.ok(start.move(initial.bestmove));
  const game = parseGame(SAMPLE_PGN);
  const final = gameAt(game,59);
  const result = await engine.analyze(final,{depth:18,movetime:1800,multipv:3});
  assert.ok(result.depth > 0);
  for (const line of result.lines) {
    const position = new Chess(final.fen());
    for (const move of line.pv) assert.ok(position.move(move));
  }
  console.log(JSON.stringify({initial:{depth:initial.depth,score:formatScore(initial.score),bestmove:initial.bestmove},final:{depth:result.depth,score:formatScore(result.score),bestmove:result.bestmove,pv:pvToSan(final.fen(),result.lines[0].pv)}},null,2));
  const mate = await engine.analyze(new Chess('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1'));
  assert.equal(mate.score.winner,'w');
  const pending = engine.analyze(new Chess(),{depth:40,movetime:30000});
  await new Promise(resolve => setTimeout(resolve,20));
  engine.cancel();
  await assert.rejects(pending,{name:'AbortError'});
  const resumed = await engine.analyze(new Chess(),{depth:12,movetime:600,multipv:3});
  assert.ok(resumed.depth>0);
  assert.ok(new Chess().move(resumed.bestmove));
  assert.equal(engine.closed,false);
  console.log('PASS: live Stockfish initialization, MultiPV, sample position, mate, cancellation and worker reuse.');
} finally { engine.dispose(); }

const parallel = new StockfishEngine(NodeWorker,{threads:2,hash:64});
try {
  const result = await parallel.analyze(new Chess(),{depth:12,movetime:1000,multipv:5});
  assert.equal(result.lines.length,5);
  assert.ok(result.depth>0);
  for(const line of result.lines){const chess=new Chess();for(const move of line.pv)assert.ok(chess.move(move));}
  console.log('PASS: real parallel Stockfish with 2 threads, 64 MB hash and 5 legal candidate lines.');
} finally { parallel.dispose(); }
