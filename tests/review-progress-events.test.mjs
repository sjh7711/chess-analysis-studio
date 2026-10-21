import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewGame } from '../src/game-review.js';
import { Chess, parseGame, uciMove } from '../src/chess-core.js';

const turn=()=>new Promise(setImmediate);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const game=parseGame('1. a3 h6 *');
const key='position:depth20';
const policy={depth:20,searchMode:'depth',multipv:2,hash:32,threads:1};
const cp=value=>({type:'cp',value});
const evaluated=(score,pv,depth=20)=>({score,depth,searchMode:'depth',multipvComplete:true,bestmove:pv[0],
  lines:[{score:{...score},depth,multipv:1,pv}]});
const cleanSettings=settings=>Object.fromEntries(Object.entries(settings).filter(([name])=>!['onInfo','onSearchInfo'].includes(name)));

function workers({gate,produce,rawTelemetry=false}={}) {
  const calls=[],instances=[],infos=[],searchInfos=[];
  const createEngine=()=>{
    const worker={resets:0,cancelled:0,disposed:0,
      reset(){assert.equal(this,worker);this.resets++;},
      cancel(){this.cancelled++;},dispose(){this.disposed++;},
      async analyze(chess,settings){
        assert.equal(this,worker);
        const call={fen:chess.fen(),history:chess.history(),settings:cleanSettings(settings)};
        calls.push(call);infos.push(settings.onInfo);searchInfos.push(settings.onSearchInfo);
        const info={depth:3,multipv:1,nodes:31,nps:700,score:cp(999),pv:['not-a-progress-field']};
        if(rawTelemetry)settings.onSearchInfo?.({depth:2,seldepth:7,multipv:1,nodes:30,nps:600,time:50,hashfull:8});
        settings.onInfo?.(info);
        if(calls.length===1&&gate)await gate.promise;
        if(rawTelemetry)settings.onSearchInfo?.({nodes:200,nps:800,time:250,hashfull:12});
        settings.onInfo?.({depth:settings.depth,multipv:1,nodes:201,nps:900});
        if(produce)return produce(chess,settings,calls.length);
        const restricted=settings.searchMoves,played=game.moves[chess.history().length];
        const candidates=restricted||chess.moves({verbose:true}).map(uciMove).sort().filter(move=>move!==(played&&uciMove(played)));
        const value=restricted?(chess.turn()==='w'?0:100):20;
        const score=cp(value),lines=candidates.slice(0,restricted?1:settings.multipv)
          .map((move,index)=>({score:cp(value-index),depth:settings.depth,multipv:index+1,pv:[move]}));
        return {score,depth:settings.depth,searchMode:'depth',multipvComplete:true,bestmove:lines[0].pv[0],lines};
      }};
    instances.push(worker);return worker;
  };
  return {calls,instances,infos,searchInfos,createEngine};
}

test('overlapping position and review progress respects each move dependency and completes only after publication',async()=>{
  const bus=workers(),events=[],trace=[],originalInfo=[];
  const options=Object.freeze({...policy,onInfo:info=>originalInfo.push(['root',info])});
  const comparisonOptions=Object.freeze({...policy,multipv:3,onInfo:info=>originalInfo.push(['review',info])});
  const original=JSON.stringify({options,comparisonOptions});
  const outcome=await reviewGame(game,{concurrency:2,createEngine:bus.createEngine,options,comparisonOptions,configKey:key,
    onResult:(_,index,phase)=>trace.push(`published:${phase}:${index}`),
    onProgress:event=>{events.push(event);trace.push(`${event.type}:${event.phase}:${event.index}`);}});
  assert.equal(outcome.analyzed,3);assert.equal(outcome.reviewed,2);
  assert.deepEqual(events.filter(event=>event.index===null),[
    {phase:'position',index:null,type:'start'},{phase:'review',index:null,type:'start'}]);
  for(let index=1;index<=2;index++)for(const parent of [index-1,index])
    assert.ok(trace.indexOf(`complete:position:${parent}`)<trace.indexOf(`start:review:${index}`));
  for(const [phase,indices]of [['position',[0,1,2]],['review',[1,2]]])for(const index of indices) {
    assert.ok(trace.indexOf(`published:${phase}:${index}`)<trace.indexOf(`complete:${phase}:${index}`));
    assert.equal(events.filter(event=>event.phase===phase&&event.index===index&&event.type==='start').length,1);
  }
  assert.equal(events.filter(event=>event.type==='search').length,5);
  assert.equal(originalInfo.filter(([phase])=>phase==='root').length,6);
  assert.equal(originalInfo.filter(([phase])=>phase==='review').length,4);
  const sample=events.find(event=>event.type==='info');
  assert.deepEqual(sample,{phase:'position',index:0,type:'info',requestedDepth:20,depth:3,multipv:1,nodes:31,nps:700});
  assert.equal(JSON.stringify({options,comparisonOptions}),original);
  assert.ok(bus.calls.every(call=>call.settings.depth===20&&call.settings.searchMode==='depth'&&!('movetime'in call.settings)));
});

test('progress does not alter searches, completed scores, or review evidence',async()=>{
  const plain=workers(),reported=workers(),events=[];
  const configuration={concurrency:2,options:policy,comparisonOptions:{...policy,multipv:3},configKey:key};
  const a=await reviewGame(game,{...configuration,createEngine:plain.createEngine});
  const b=await reviewGame(game,{...configuration,createEngine:reported.createEngine,onProgress:event=>events.push(event)});
  assert.deepEqual([...a.results],[...b.results]);
  assert.deepEqual(plain.calls,reported.calls);
  assert.deepEqual(plain.instances.map(worker=>worker.resets),reported.instances.map(worker=>worker.resets));
  assert.equal(events.filter(event=>event.type==='complete').length,5);
});

test('raw search telemetry includes bound and heartbeat metrics without duplicating scored-info progress',async()=>{
  const bus=workers({rawTelemetry:true}),events=[],scored=[],raw=[];
  const options={...policy,onInfo:info=>scored.push(info),onSearchInfo:info=>raw.push(info)};
  const outcome=await reviewGame(game,{concurrency:1,createEngine:bus.createEngine,options,
    configKey:key,onProgress:event=>events.push(event)});
  assert.equal(outcome.reviewed,2);assert.equal(bus.calls.length,5);
  assert.equal(scored.length,10);assert.equal(raw.length,10);
  const info=events.filter(event=>event.type==='info');
  assert.equal(info.length,10,'raw events replace the scored callback fallback, not duplicate it');
  assert.deepEqual(info[0],{phase:'position',index:0,type:'info',requestedDepth:20,
    depth:2,seldepth:7,multipv:1,nodes:30,nps:600,time:50,hashfull:8});
  assert.deepEqual(info[1],{phase:'position',index:0,type:'info',requestedDepth:20,
    nodes:200,nps:800,time:250,hashfull:12});
  assert.ok(info.every(event=>!('score'in event)&&!('pv'in event)));
});

test('raw telemetry observers cannot change evidence and are suppressed after cancellation or completion',async()=>{
  for(const observer of [()=>{throw new Error('raw view failed');},()=>Promise.reject(new Error('raw observer failed'))]) {
    const bus=workers({rawTelemetry:true}),events=[];
    const outcome=await reviewGame(game,{concurrency:1,createEngine:bus.createEngine,options:{...policy,onSearchInfo:observer},
      configKey:key,onProgress:event=>events.push(event)});
    assert.equal(outcome.reviewed,2);
    const count=events.length;for(const callback of bus.searchInfos)callback({depth:99,nodes:99999,time:1000});
    assert.equal(events.length,count);await turn();
  }
  const gate=deferred(),bus=workers({rawTelemetry:true,gate}),controller=new AbortController(),events=[],raw=[];
  const pending=reviewGame(game,{concurrency:1,createEngine:bus.createEngine,options:{...policy,onSearchInfo:info=>raw.push(info)},
    configKey:key,signal:controller.signal,onProgress:event=>events.push(event)});
  const rejected=assert.rejects(pending,{name:'AbortError'});
  while(!bus.calls.length)await turn();
  controller.abort();const count=events.length,rawCount=raw.length;
  bus.searchInfos[0]({depth:20,nodes:90000,time:1000});gate.resolve();await rejected;
  assert.equal(events.length,count);assert.equal(raw.length,rawCount);
});

test('each mate confirmation reports its actual deeper target without inheriting the earlier search callback or budget',async()=>{
  const start='7k/8/R4K2/8/8/8/8/8 w - - 0 1';
  const sample=parseGame(`[SetUp "1"]\n[FEN "${start}"]\n\n1. Ke6 *`),played='f6e6';
  const child=['h8g7','e6f5','g7h7','a6a7','h7g8','f5g6','g8h8','a7a8'];
  const before={...evaluated({type:'mate',value:2,winner:'w'},['f6g6','h8g8','a6a8']),configKey:key};
  const after={...evaluated({type:'mate',value:4,winner:'w'},child),configKey:key};
  const baseline=JSON.stringify({before,after}),events=[],forwarded=[];
  const bus=workers({produce:(_,settings)=>settings.depth===20
    ?evaluated(cp(500),[played,...child.slice(0,3)],20)
    :evaluated({type:'mate',value:5,winner:'w'},[played,...child],22)});
  const outcome=await reviewGame(sample,{concurrency:1,createEngine:bus.createEngine,options:policy,
    comparisonOptions:{...policy,onInfo:info=>forwarded.push(info)},configKey:key,results:new Map([[0,before],[1,after]]),
    isCached:()=>true,onProgress:event=>events.push(event)});
  assert.deepEqual(events.filter(event=>event.type==='search').map(event=>[event.phase,event.index,event.requestedDepth,event.multipv]),
    [['review',1,20,1],['review',1,22,1]]);
  assert.deepEqual(events.filter(event=>event.type==='info').map(event=>event.requestedDepth),[20,20,22,22]);
  assert.equal(forwarded.length,4);assert.equal(outcome.results.get(1).moveReview.mateReview.result.depth,22);
  assert.ok(bus.calls.every(call=>!('movetime'in call.settings)&&call.settings.searchMoves[0]===played));
  assert.equal(JSON.stringify({before,after}),baseline);
});

test('an unrestricted ranking confirmation is reported separately from the played-only search',async()=>{
  const start='q5k1/8/8/8/8/8/8/R3K3 w - - 0 30';
  const sample=parseGame(`[SetUp "1"]\n[FEN "${start}"]\n\n30. Rb1 *`),played='a1b1',response=['a8a5','e1f2'];
  const before={...evaluated(cp(100),['a1a2',...response]),configKey:key};
  before.lines.push({multipv:2,depth:20,score:cp(80),pv:['e1f1']});
  const after={...evaluated(cp(900),response),configKey:key},events=[];
  const bus=workers({produce:(_,settings)=>{
    if(settings.searchMoves)return evaluated(cp(120),[played,...response]);
    const value=evaluated(cp(110),[played,...response]);
    value.lines.push({multipv:2,depth:20,score:cp(100),pv:['a1a2',...response]});return value;
  }});
  const outcome=await reviewGame(sample,{concurrency:1,createEngine:bus.createEngine,options:policy,configKey:key,
    results:new Map([[0,before],[1,after]]),isCached:()=>true,onProgress:event=>events.push(event)});
  assert.deepEqual(events.filter(event=>event.type==='search').map(event=>[event.requestedDepth,event.multipv]),[[20,1],[20,2]]);
  assert.deepEqual(bus.calls[0].settings.searchMoves,[played]);assert.equal('searchMoves'in bus.calls[1].settings,false);
  assert.equal(outcome.results.get(1).moveReview.rankingReview.status,'complete');
});

test('late info from cancelled work neither reports progress nor invokes the original callback',async()=>{
  const gate=deferred(),bus=workers({gate}),controller=new AbortController(),events=[],forwarded=[];
  const pending=reviewGame(game,{concurrency:1,createEngine:bus.createEngine,options:{...policy,onInfo:info=>forwarded.push(info)},
    configKey:key,signal:controller.signal,onProgress:event=>events.push(event)});
  const rejected=assert.rejects(pending,{name:'AbortError'});
  while(!bus.calls.length)await turn();
  controller.abort();const count=events.length,forwardedCount=forwarded.length;
  bus.infos[0]({depth:20,multipv:1,nodes:9999,nps:1000});gate.resolve();await rejected;
  assert.equal(events.length,count);assert.equal(forwarded.length,forwardedCount);
  assert.equal(events.some(event=>event.type==='complete'),false);
});

test('throwing or rejecting progress observers cannot fail a valid analysis',async()=>{
  for(const observer of [()=>{throw new Error('view failed');},()=>Promise.reject(new Error('telemetry failed'))]) {
    const bus=workers(),outcome=await reviewGame(game,{concurrency:2,createEngine:bus.createEngine,
      options:policy,configKey:key,onProgress:observer});
    assert.equal(outcome.analyzed,3);assert.equal(outcome.reviewed,2);assert.equal(outcome.results.size,3);
    await turn();
  }
});

test('callbacks retained by a finished worker cannot emit stale info on later reuse',async()=>{
  const bus=workers(),events=[],forwarded=[];
  await reviewGame(game,{concurrency:1,createEngine:bus.createEngine,options:{...policy,onInfo:info=>forwarded.push(info)},
    configKey:key,onProgress:event=>events.push(event)});
  const count=events.length,originalCount=forwarded.length;
  for(const callback of bus.infos)callback({depth:99,multipv:1,nodes:99999});
  assert.equal(events.length,count);assert.equal(forwarded.length,originalCount);
});

test('completion waits for the result callback and suppresses completion if that publication is cancelled',async()=>{
  const gate=deferred(),controller=new AbortController(),bus=workers(),events=[];
  let publishing=false;
  const pending=reviewGame(game,{concurrency:1,createEngine:bus.createEngine,options:policy,configKey:key,signal:controller.signal,
    onResult:async()=>{publishing=true;await gate.promise;},onProgress:event=>events.push(event)});
  const rejected=assert.rejects(pending,{name:'AbortError'});
  while(!publishing)await turn();
  assert.equal(events.some(event=>event.type==='complete'),false);
  controller.abort();gate.resolve();await rejected;
  assert.equal(events.some(event=>event.type==='complete'),false);
});
