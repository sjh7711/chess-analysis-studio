import test from 'node:test';
import assert from 'node:assert/strict';
import {StockfishEngine} from '../src/engine.js';
import {Chess,parseGame,uciMove,hasMoveReview} from '../src/chess-core.js';
import {reviewGame} from '../src/game-review.js';
import {normalizePerformance,searchOptions,gameReviewOptions,analysisKey} from '../src/engine-options.js';

const game=parseGame('1. a3 h6 *');
const turn=()=>new Promise(setImmediate);
function protocol({hold=false,completedDepth=13}={}) {
  const workers=[],engines=[];
  class Worker {
    constructor(url){this.url=url;this.commands=[];this.terminated=0;workers.push(this);}
    emit(data){this.onmessage?.({data});}
    postMessage(command){this.commands.push(command);
      if(command==='uci')queueMicrotask(()=>this.emit('uciok'));
      if(command==='isready')queueMicrotask(()=>this.emit('readyok'));
      if(!command.startsWith('go ')||hold)return;
      const position=this.commands.findLast(item=>item.startsWith('position fen '));
      const [fen,history]=position.slice('position fen '.length).split(' moves '),chess=new Chess(fen);
      for(const move of history?.split(' ')||[])chess.move(move);
      const restricted=command.split(' searchmoves ')[1]?.split(' '),requested=Number(command.match(/\bdepth (\d+)/)[1]);
      const multipv=Number(this.commands.findLast(item=>item.startsWith('setoption name MultiPV ')).split(' ').at(-1));
      const moves=restricted||chess.moves({verbose:true}).map(uciMove).sort();
      // Avoid the actual game move in overview candidates to exercise the real
      // reviewMove -> restricted-search protocol rather than only a cache hit.
      const played=game.moves[chess.history().length]&&uciMove(game.moves[chess.history().length]);
      const candidates=restricted?moves:moves.filter(move=>move!==played);
      const depth=Math.min(completedDepth,requested),lines=candidates.slice(0,multipv).map((move,index)=>`info depth ${depth} multipv ${index+1} score cp ${20-index} pv ${move}`);
      queueMicrotask(()=>this.emit([...lines,`bestmove ${candidates[0]}`].join('\n')));
    }
    terminate(){this.terminated++;}
  }
  const createEngine=(hash)=>{const engine=new StockfishEngine(Worker,{engineId:'lite',hash,threads:1});engines.push(engine);return engine;};
  return {workers,engines,createEngine};
}
const configured=(settings,depth)=>({performance:normalizePerformance(settings,8,16),depth});
async function runReview(bus,configuration,extra={}) {
  const {performance,depth}=configuration,key=analysisKey('lite',depth,performance,'game');
  const outcome=await reviewGame(game,{concurrency:performance.threads,createEngine:()=>bus.createEngine(performance.hash),
    options:gameReviewOptions(depth,performance),comparisonOptions:searchOptions(depth,performance),configKey:key,
    isCached:result=>result?.configKey===key,...extra});
  return {...outcome,key};
}

test('configured whole-game jobs reach actual UCI budgets while parallel tasks remain single-thread workers',async()=>{
  const bus=protocol(),configuration=configured({threadMode:'manual',threads:3,hash:128,movetime:3000,multipv:5,reviewMode:'precise'},20);
  const outcome=await runReview(bus,configuration);
  assert.equal(bus.workers.length,3);assert.equal(outcome.analyzed,3);assert.equal(outcome.reviewed,2);
  for(const worker of bus.workers){
    assert.match(worker.url,/stockfish-19-lite-single\.js/);
    assert.ok(worker.commands.includes('setoption name Hash value 128'));
    assert.equal(worker.commands.some(command=>command.startsWith('setoption name Threads')),false);
    assert.equal(worker.terminated,1);
  }
  const commands=bus.workers.flatMap(worker=>worker.commands),source=commands.filter(command=>command.startsWith('go ')&&!command.includes('searchmoves')),
    restricted=commands.filter(command=>command.includes('searchmoves'));
  assert.equal(source.length,3);assert.ok(source.every(command=>command==='go depth 20 movetime 3000'));
  assert.equal(restricted.length,2);assert.ok(restricted.every(command=>command.startsWith('go depth 13 movetime 3000 searchmoves ')));
  assert.ok(commands.includes('setoption name MultiPV value 2'));assert.ok(commands.includes('setoption name MultiPV value 1'));
  for(let index=1;index<=game.moves.length;index++){
    const before=outcome.results.get(index-1),after=outcome.results.get(index);
    assert.ok(hasMoveReview(before,after,game.moves[index-1]));assert.equal(after.moveReview.depth,before.depth);
    assert.equal(before.configKey,outcome.key);assert.equal(before.requestedDepth,20);
  }
});

test('changed applied settings miss prior game cache and preserve full candidates for explicit position analysis',async()=>{
  const oldBus=protocol(),oldConfiguration=configured({threadMode:'manual',threads:1,hash:32,movetime:500,multipv:3,reviewMode:'fast'},12);
  const old=await runReview(oldBus,oldConfiguration),saved=structuredClone([...old.results]);
  assert.ok(oldBus.workers[0].commands.includes('go depth 12 movetime 250'));
  const bus=protocol(),configuration=configured({threadMode:'manual',threads:3,hash:128,movetime:10000,multipv:5,reviewMode:'precise'},24);
  const next=await runReview(bus,configuration,{results:old.results});
  assert.notEqual(old.key,next.key);assert.equal(next.analyzed,3);assert.equal(next.reviewed,2);assert.deepEqual([...old.results],saved);
  for(const worker of bus.workers){assert.ok(worker.commands.includes('setoption name Hash value 128'));
    assert.ok(worker.commands.some(command=>command==='go depth 24 movetime 10000'));}
  const positionBus=protocol(),engine=positionBus.createEngine(configuration.performance.hash);
  try{await engine.ready;await engine.analyze(new Chess(),searchOptions(24,configuration.performance));
    const commands=positionBus.workers[0].commands;
    assert.ok(commands.includes('setoption name MultiPV value 5'));assert.ok(commands.includes('go depth 24 movetime 10000'));
    assert.equal(positionBus.workers.length,1);assert.equal(commands.some(command=>command.startsWith('setoption name Threads')),false);
  }finally{engine.dispose();}
});

test('aborting a configured review disposes real engine protocol workers and prevents late results from publication',async()=>{
  const bus=protocol({hold:true}),controller=new AbortController(),events=[];
  const configuration=configured({threadMode:'manual',threads:2,hash:64,movetime:1000,multipv:3},16);
  const pending=runReview(bus,configuration,{signal:controller.signal,onResult:(_,index)=>events.push(index)}),rejected=assert.rejects(pending,{name:'AbortError'});
  await turn();assert.equal(bus.workers.length,2);assert.ok(bus.workers.every(worker=>worker.commands.some(command=>command.startsWith('go '))));
  controller.abort();await rejected;
  for(const worker of bus.workers){assert.ok(worker.commands.includes('stop'));assert.equal(worker.terminated,1);
    worker.emit('info depth 24 multipv 1 score cp 999 pv e2e4\nbestmove e2e4');}
  await turn();assert.deepEqual(events,[]);assert.ok(bus.engines.every(engine=>engine.closed&&engine.pending===null));
});
