import test from 'node:test';
import assert from 'node:assert/strict';
import {StockfishEngine} from '../src/engine.js';
import {Chess,positionCommand} from '../src/chess-core.js';

const turn=()=>new Promise(setImmediate);
const info=(depth,rank,score,pv,nodes=500)=>`info depth ${depth} multipv ${rank} score cp ${score} nodes ${nodes} pv ${pv}`;
const fixed=(changes={})=>({searchMode:'depth',depth:12,multipv:1,...changes});

// Only the UCI transport is simulated. The production adapter owns the queue,
// reset barrier, depth completion check, cancellation and result selection.
async function withProtocol(run,{onGo}={}) {
  const commands=[],workers=[];
  class FakeWorker {
    constructor(url){this.url=url;this.holdReady=false;this.tableWarm=false;this.newGames=0;this.terminated=0;workers.push(this);}
    emit(data){this.onmessage?.({data});}
    postMessage(command){
      commands.push(command);
      if(command==='uci')queueMicrotask(()=>this.emit('uciok'));
      if(command==='ucinewgame'){this.tableWarm=false;this.newGames++;}
      if(command==='isready'&&!this.holdReady)queueMicrotask(()=>this.emit('readyok'));
      if(command.startsWith('go '))onGo?.(this,command,commands);
    }
    terminate(){this.terminated++;}
  }
  const engine=new StockfishEngine(FakeWorker,{engineId:'lite',threads:1,hash:32});
  try{await engine.ready;await run({engine,worker:workers[0],commands,workers});}
  finally{engine.dispose();}
}

const queries=commands=>commands.filter(command=>command.startsWith('go '));

test('fixed-depth search waits for its own reset and never sends time or node early-stop limits',async()=>{
  await withProtocol(async({engine,worker,commands})=>{
    worker.holdReady=true;
    const query=engine.analyze(new Chess(),fixed({depth:16,multipv:3,movetime:1,nodes:1,searchMoves:['e2e4','d2d4','e2e4']}));
    await turn();
    assert.deepEqual(commands.slice(-2),['ucinewgame','isready']);
    assert.deepEqual(queries(commands),[],'a reset acknowledgement must precede any search');
    worker.emit('readyok');await turn();
    assert.deepEqual(queries(commands),['go depth 16 searchmoves e2e4 d2d4']);
    assert.ok(commands.includes('setoption name MultiPV value 2'));
    assert.ok(commands.includes(positionCommand(new Chess())));
    assert.equal(commands.some(command=>command.startsWith('setoption name Threads')),false);
    worker.emit([info(16,1,30,'e2e4 e7e5'),info(16,2,20,'d2d4 d7d5'),'bestmove e2e4'].join('\n'));
    const result=await query;
    assert.equal(result.depth,16);assert.equal(result.multipvComplete,true);
    assert.deepEqual(result.lines.map(line=>line.depth),[16,16]);
  });
});

test('reusing a fixed-depth engine starts every search with empty table and search history',async()=>{
  const observations=[];
  await withProtocol(async({engine,worker,commands,workers})=>{
    const first=await engine.analyze(new Chess(),fixed());
    const unrelated=new Chess();unrelated.move('d4');
    await engine.analyze(unrelated,fixed());
    const repeated=await engine.analyze(new Chess(),fixed());
    assert.deepEqual(repeated,first,'intervening positions must not seed a different score, PV or node count');
    assert.deepEqual(observations.map(item=>item.tableWarm),[false,false,false]);
    assert.deepEqual(observations.map(item=>item.newGames),[1,2,3]);
    assert.equal(worker.newGames,3);assert.equal(workers.length,1,'determinism does not require recreating WASM for each job');
    assert.equal(queries(commands).length,3);
  },{onGo:(worker,command,commands)=>{
    const position=commands.findLast(item=>item.startsWith('position '));
    const black=position.includes(' moves d2d4');
    const move=black?'d7d5':'e2e4',score=worker.tableWarm?999:25;
    observations.push({tableWarm:worker.tableWarm,newGames:worker.newGames,position});
    worker.tableWarm=true;
    queueMicrotask(()=>worker.emit(`${info(12,1,score,move)}\nbestmove ${move}`));
  }});
});

test('simultaneous fixed-depth requests execute in submission order without sharing a pending search',async()=>{
  await withProtocol(async({engine,worker,commands})=>{
    const white=new Chess(),black=new Chess();black.move('e4');
    const first=engine.analyze(white,fixed());
    const second=engine.analyze(black,fixed({depth:14}));
    await turn();
    assert.deepEqual(queries(commands),['go depth 12']);
    assert.equal(commands.filter(command=>command==='ucinewgame').length,1);
    assert.equal(commands.findLast(command=>command.startsWith('position ')),positionCommand(white));
    worker.emit(`${info(12,1,40,'e2e4 e7e5')}\nbestmove e2e4`);
    const a=await first;await turn();
    assert.deepEqual(queries(commands),['go depth 12','go depth 14']);
    assert.equal(commands.filter(command=>command==='ucinewgame').length,2);
    assert.equal(commands.findLast(command=>command.startsWith('position ')),positionCommand(black));
    worker.emit(`${info(14,1,35,'e7e5 g1f3')}\nbestmove e7e5`);
    const b=await second;
    assert.equal(a.score.value,40);assert.equal(b.score.value,-35,'each queued query retains its own side to move');
    assert.equal(a.bestmove,'e2e4');assert.equal(b.bestmove,'e7e5');
  });
});

test('fixed-depth searches reject a shallower complete result instead of publishing a partial grade input',async()=>{
  await withProtocol(async({engine,worker,commands})=>{
    const query=engine.analyze(new Chess(),fixed({depth:16,multipv:2}));
    const rejected=assert.rejects(query);await turn();
    worker.emit([info(15,1,30,'e2e4 e7e5'),info(15,2,20,'d2d4 d7d5'),'bestmove e2e4'].join('\n'));
    await rejected;
    assert.equal(queries(commands).length,1);
  });
});

test('fixed-depth searches reject unfinished target-depth MultiPV even when an older iteration is complete',async()=>{
  await withProtocol(async({engine,worker})=>{
    const query=engine.analyze(new Chess(),fixed({depth:16,multipv:2}));
    const rejected=assert.rejects(query);await turn();
    worker.emit([info(15,1,30,'e2e4 e7e5'),info(15,2,20,'d2d4 d7d5'),
      info(16,1,45,'d2d4 d7d5'),'bestmove d2d4'].join('\n'));
    await rejected;
  });
});

test('fixed-depth searches require all requested roots, rather than accepting a target-depth single-line fallback',async()=>{
  await withProtocol(async({engine,worker})=>{
    const query=engine.analyze(new Chess(),fixed({depth:16,multipv:2}));
    const rejected=assert.rejects(query);await turn();
    worker.emit(`${info(16,1,45,'e2e4 e7e5')}\nbestmove e2e4`);
    await rejected;
  });
});

test('cancelling a fixed-depth batch discards queued requests and drains the active result before a fresh request',async()=>{
  await withProtocol(async({engine,worker,commands})=>{
    const first=engine.analyze(new Chess(),fixed({searchMoves:['d2d4']}));
    const second=engine.analyze(new Chess(),fixed({searchMoves:['g1f3']}));
    const third=engine.analyze(new Chess(),fixed({searchMoves:['c2c4']}));
    const rejected=[first,second,third].map(query=>assert.rejects(query,{name:'AbortError'}));
    await turn();engine.cancel();
    assert.ok(commands.includes('stop'));
    const fresh=engine.analyze(new Chess(),fixed({searchMoves:['e2e4']}));
    await turn();assert.deepEqual(queries(commands),['go depth 12 searchmoves d2d4']);
    worker.emit(`${info(12,1,999,'d2d4 d7d5')}\nbestmove d2d4`);
    await Promise.all(rejected);await turn();
    assert.deepEqual(queries(commands),['go depth 12 searchmoves d2d4','go depth 12 searchmoves e2e4']);
    assert.equal(commands.filter(command=>command==='ucinewgame').length,2);
    worker.emit(`${info(12,1,25,'e2e4 e7e5')}\nbestmove e2e4`);
    const result=await fresh;
    assert.equal(result.score.value,25);assert.equal(result.bestmove,'e2e4');
  });
});

test('cancelling during the automatic reset drains its ready acknowledgement before resetting a later generation',async()=>{
  await withProtocol(async({engine,worker,commands})=>{
    worker.holdReady=true;
    const first=engine.analyze(new Chess(),fixed()),rejected=assert.rejects(first,{name:'AbortError'});
    await turn();assert.equal(commands.filter(command=>command==='ucinewgame').length,1);
    engine.cancel();
    const fresh=engine.analyze(new Chess(),fixed());
    await turn();assert.deepEqual(queries(commands),[]);
    assert.equal(commands.filter(command=>command==='ucinewgame').length,1);
    worker.emit('readyok');await rejected;await turn();
    assert.equal(commands.filter(command=>command==='ucinewgame').length,2);
    assert.deepEqual(queries(commands),[],'the stale readyok cannot satisfy the new generation reset');
    assert.equal(commands.includes('stop'),false,'a reset has no active search to stop');
    worker.emit('readyok');await turn();
    assert.deepEqual(queries(commands),['go depth 12']);
    worker.emit(`${info(12,1,25,'e2e4 e7e5')}\nbestmove e2e4`);
    assert.equal((await fresh).score.value,25);
  });
});

test('fixed-depth watchdog failure rejects partial results and later queued work rather than reporting completion',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  try{
    await withProtocol(async({engine,worker,commands})=>{
      const first=engine.analyze(new Chess(),fixed({depth:16,multipv:2}));
      const second=engine.analyze(new Chess(),fixed());
      const rejected=[first,second].map(query=>assert.rejects(query));
      await turn();
      worker.emit([info(12,1,30,'e2e4 e7e5'),info(12,2,20,'d2d4 d7d5')].join('\n'));
      t.mock.timers.tick(24*60*60*1000);
      await Promise.all(rejected);
      assert.equal(queries(commands).length,1,'failure cannot release a queued search onto the failed engine');
      assert.equal(engine.closed,true);assert.equal(worker.terminated,1);
    });
  }finally{t.mock.timers.reset();}
});
