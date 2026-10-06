import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { StockfishEngine } from '../src/engine.js';
import { Chess, parseGame } from '../src/chess-core.js';
import { DEFAULT_PERFORMANCE, searchOptions, reviewOptions } from '../src/engine-options.js';
import { SAMPLE_PGN } from '../src/sample.js';
import { NodeEngineWorker } from './node-engine-worker.mjs';

const full=process.argv.includes('--full');
class BenchmarkWorker extends NodeEngineWorker {
  constructor(url){super(full ? '/engine/stockfish-19-single.js' : url);}
}
const game=parseGame(SAMPLE_PGN), results={engine:full?'Stockfish 19':'Stockfish 19 Lite',threads:1,positions:game.positions.length};
for(const [name,options] of [['previous',searchOptions(16,DEFAULT_PERFORMANCE)],['fast',reviewOptions(16,DEFAULT_PERFORMANCE)]]){
  const start=performance.now(), engine=new StockfishEngine(BenchmarkWorker), chess=new Chess(game.startFen);
  const depths=[],scores=[];
  try{
    for(let i=0;i<game.positions.length;i++){
      const result=await engine.analyze(chess,options);
      assert.ok(result.terminal || result.depth>0);
      for(const line of result.lines){const check=new Chess(chess.fen());for(const uci of line.pv)assert.ok(check.move(uci));}
      depths.push(result.depth);scores.push(result.score);
      if(game.moves[i])chess.move(game.moves[i]);
      if((i+1)%15===0)console.log(`${name}: ${i+1}/${game.positions.length}`);
    }
    results[name]={milliseconds:Math.round(performance.now()-start),options,averageDepth:depths.reduce((a,b)=>a+b,0)/depths.length,depths,scores};
  }finally{engine.dispose();}
}
results.speedup=Number((results.previous.milliseconds/results.fast.milliseconds).toFixed(2));
await writeFile(new URL('../performance-benchmark.json',import.meta.url),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify({engine:results.engine,positions:results.positions,previousMs:results.previous.milliseconds,fastMs:results.fast.milliseconds,speedup:results.speedup,depthBefore:results.previous.averageDepth,depthAfter:results.fast.averageDepth}));
