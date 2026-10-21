import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisKey, AUTO_THREAD_FRACTION, AUTO_THREAD_LABEL, automaticThreads, availableReviewWorkers, availableThreads, DEFAULT_ENGINE_ID, DEFAULT_PERFORMANCE, ENGINES, engineChunks, engineId, gameReviewOptions, normalizePerformance, REVIEW_ENGINE_ID, reviewOptions, searchOptions, supportedThreads, workerUrl } from '../src/engine-options.js';
import { StockfishEngine } from '../src/engine.js';
import { restoreResults } from '../src/study.js';

test('new and unrecognized engine preferences default to Lite and game review uses Stockfish 19 Lite', () => {
  assert.equal(DEFAULT_ENGINE_ID, 'lite');
  assert.equal(REVIEW_ENGINE_ID, 'lite');
  assert.equal(ENGINES[REVIEW_ENGINE_ID].name, 'Stockfish 19 Lite');
  for (const value of [undefined, null, '', 'Stockfish 18', 'unknown']) {
    assert.equal(engineId(value), DEFAULT_ENGINE_ID);
  }
  assert.equal(engineId('full'), 'full');
  assert.equal(engineId('Stockfish 19'), 'full');
  assert.equal(engineId('lite'), 'lite');
  assert.equal(engineId('Stockfish 19 Lite'), 'lite');
});

test('performance controls select fixed depth while only result-affecting limits distinguish cached evaluations', () => {
  const settings = normalizePerformance({ movetime: 10000, multipv: 5, hash: 128, threadMode:'manual', threads: 4 }, 8,16);
  assert.deepEqual(searchOptions(24, settings), { depth:24, searchMode:'depth', multipv:5, hash:128, threads:4 });
  const key = analysisKey('lite',24,settings);
  for (const [name,value] of [['multipv',1],['hash',32]]) {
    assert.notEqual(analysisKey('lite',24,{...settings,[name]:value}),key);
  }
  for (const [name,value] of [['movetime',500],['threads',2],['threadMode','auto']]) {
    assert.equal(analysisKey('lite',24,{...settings,[name]:value}),key);
  }
  assert.notEqual(analysisKey('lite',20,settings),key);
  assert.notEqual(analysisKey('full',24,settings),key);
  assert.equal(normalizePerformance({threadMode:'manual',threads:8},2,8).threads,2);
  assert.equal(supportedThreads(false,16),1);
  assert.equal(supportedThreads(true,6),3);
  assert.equal(DEFAULT_PERFORMANCE.reviewMode,'precise');
  assert.equal(normalizePerformance().reviewMode,'precise');
  assert.equal(normalizePerformance({reviewMode:'fast'}).reviewMode,'fast');
  assert.match(key,/^review-v8:position:/);
});

test('available threads stop at half of logical cores and require browser shared memory',()=>{
  assert.deepEqual(availableThreads(false,16),[1]);
  assert.deepEqual(availableThreads(true,1),[1]);
  assert.deepEqual(availableThreads(true,3),[1]);
  assert.deepEqual(availableThreads(true,6),[1,2,3]);
  assert.deepEqual(availableThreads(true,32),[1,2,3,4,5,6,7,8]);
  for(const cores of [0,-1,NaN,Infinity,'8'])assert.equal(supportedThreads(true,cores),1);
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'SharedArrayBuffer');
  try {
    Object.defineProperty(globalThis,'SharedArrayBuffer',{value:undefined,configurable:true,writable:true});
    assert.deepEqual(availableThreads(true,16),[1]);assert.equal(supportedThreads(true,16),1);
  } finally {
    if(descriptor)Object.defineProperty(globalThis,'SharedArrayBuffer',descriptor);else delete globalThis.SharedArrayBuffer;
  }
});

test('independent review workers retain parallel task capacity without shared-memory or isolation support',()=>{
  assert.deepEqual(availableReviewWorkers(6),[1,2,3]);
  assert.deepEqual(availableReviewWorkers(16),[1,2,3,4,5,6,7,8]);
  for(const cores of [0,-1,NaN,Infinity,'8'])assert.deepEqual(availableReviewWorkers(cores),[1]);
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'SharedArrayBuffer');
  try {
    Object.defineProperty(globalThis,'SharedArrayBuffer',{value:undefined,configurable:true,writable:true});
    assert.equal(supportedThreads(false,16),1);
    assert.equal(supportedThreads(true,16),1);
    const maximum=availableReviewWorkers(16).at(-1);
    assert.equal(maximum,8);
    assert.equal(normalizePerformance({},maximum,16).threads,6);
    const defaultMaximum=availableReviewWorkers().at(-1);
    assert.equal(normalizePerformance({},undefined,16).threads,Math.min(defaultMaximum,6));
    assert.equal(automaticThreads(undefined,16),Math.min(defaultMaximum,6));
  } finally {
    if(descriptor)Object.defineProperty(globalThis,'SharedArrayBuffer',descriptor);else delete globalThis.SharedArrayBuffer;
  }
});

test('every offered worker and SMP count obeys the fifty-percent ceiling on even and odd core counts',()=>{
  for(let cores=2;cores<=64;cores++){
    const maximum=Math.min(8,Math.floor(cores/2)),expected=Array.from({length:maximum},(_,index)=>index+1);
    assert.deepEqual(availableReviewWorkers(cores),expected,`${cores} logical cores: review pool`);
    assert.deepEqual(availableThreads(true,cores),expected,`${cores} logical cores: SMP`);
    assert.ok(availableReviewWorkers(cores).every(count=>count/cores<=0.5));
    assert.equal(automaticThreads(64,cores),Math.max(1,Math.min(maximum,Math.floor(cores*0.4))));
    assert.equal(normalizePerformance({threadMode:'manual',threads:64},64,cores).threads,maximum);
  }
  // A device reporting one logical core needs one worker to do any analysis.
  assert.deepEqual(availableReviewWorkers(1),[1]);
  assert.deepEqual(availableThreads(true,1),[1]);
  assert.equal(normalizePerformance({threadMode:'manual',threads:8},8,1).threads,1);
});

test('automatic threads conservatively use forty percent of logical cores within the detected limit',()=>{
  assert.equal(AUTO_THREAD_FRACTION,0.4);assert.match(AUTO_THREAD_LABEL,/40%/);
  assert.equal(DEFAULT_PERFORMANCE.threadMode,'auto');assert.equal(DEFAULT_PERFORMANCE.threads,1);
  for(const [cores,expected] of [[1,1],[2,1],[3,1],[4,1],[5,2],[6,2],[7,2],[8,3],[10,4],[12,4],[16,6],[20,8],[32,8]]) {
    assert.equal(automaticThreads(supportedThreads(true,cores),cores),expected,`${cores} logical cores`);
  }
  assert.equal(automaticThreads(supportedThreads(false,32),32),1);
  assert.equal(automaticThreads(3,16),3);
  for(const cores of [0,-10,NaN,Infinity,'16'])assert.equal(automaticThreads(8,cores),1);
});

test('new and mode-less legacy preferences use automatic parallelism while explicit manual choices persist',()=>{
  for(const saved of [{},{threads:1},{threads:8},{threadMode:'unknown',threads:1}]) {
    const restored=normalizePerformance(saved,8,16);
    assert.equal(restored.threadMode,'auto');assert.equal(restored.threads,6);
  }
  for(const threads of [1,2,3,4,5,6,7,8]) {
    const restored=normalizePerformance({threadMode:'manual',threads},8,16);
    assert.equal(restored.threadMode,'manual');assert.equal(restored.threads,threads);
  }
  for(const threads of [1,2,3,4,5,6]) {
    const manual=normalizePerformance({threadMode:'manual',threads},6,16);
    assert.equal(manual.threadMode,'manual');assert.equal(manual.threads,threads);
    assert.deepEqual(normalizePerformance(JSON.parse(JSON.stringify(manual)),6,16),manual);
  }
  for(const threads of [0,-1,1.5,'4',NaN]) {
    const manual=normalizePerformance({threadMode:'manual',threads},6,16);
    assert.equal(manual.threadMode,'manual');assert.equal(manual.threads,1);
  }
  for(const threads of [7,8])assert.equal(normalizePerformance({threadMode:'manual',threads},6,16).threads,6);
  assert.equal(normalizePerformance({threadMode:'manual',threads:6},1,16).threads,1);
  assert.equal(normalizePerformance({threads:8},6,16).threads,6);
  assert.equal(normalizePerformance({threadMode:'auto',threads:8},1,16).threads,1);
  assert.equal(normalizePerformance({threadMode:'auto',threads:1},6,8).threads,3);
});

test('saved manual preferences are clamped after moving to a smaller or odd-core device',()=>{
  const saved=normalizePerformance({threadMode:'manual',threads:8,hash:128},8,16);
  for(const [cores,expected] of [[12,6],[9,4],[8,4],[7,3],[6,3],[4,2],[3,1],[2,1],[1,1]]){
    const restored=normalizePerformance(JSON.parse(JSON.stringify(saved)),8,cores);
    assert.equal(restored.threadMode,'manual');assert.equal(restored.threads,expected);
    assert.equal(restored.hash,128);
    assert.deepEqual(normalizePerformance(restored,8,cores),restored);
  }
  assert.equal(normalizePerformance(saved,2,16).threads,2);
  assert.equal(automaticThreads(8,8),3);
  assert.equal(automaticThreads(8,7),2);
});

test('thread mode and task count only affect scheduling and share the same fixed-depth cache policy',()=>{
  const auto=normalizePerformance({threadMode:'auto'},8,8),manual=normalizePerformance({threadMode:'manual',threads:3},8,8);
  assert.equal(auto.threads,3);
  assert.equal(analysisKey('full',16,auto),analysisKey('full',16,manual));
  assert.equal(analysisKey('full',16,auto,'game'),analysisKey('full',16,manual,'game'));
  const more=normalizePerformance({threadMode:'manual',threads:5},8,8);
  assert.equal(more.threads,4);
  assert.equal(analysisKey('full',16,auto),analysisKey('full',16,more));
  assert.equal(analysisKey('full',16,auto,'game'),analysisKey('full',16,more,'game'));
  assert.equal(searchOptions(16,auto).threads,3);assert.equal(gameReviewOptions(16,auto).threads,3);
  assert.equal('threadMode' in searchOptions(16,auto),false);
});

test('whole-game review limits candidates while preserving explicit position analysis and review speed settings',()=>{
  for(const multipv of [1,2,3,5]){
    const precise={...DEFAULT_PERFORMANCE,multipv};
    const requested=searchOptions(16,precise);
    assert.equal(requested.multipv,multipv);
    assert.deepEqual(reviewOptions(16,precise),requested);
    assert.deepEqual(gameReviewOptions(16,precise),{...requested,multipv:Math.min(2,multipv)});
    const fast={...precise,reviewMode:'fast'};
    assert.deepEqual(gameReviewOptions(16,fast),{...requested,depth:14,multipv:Math.min(2,multipv)});
  }
  assert.equal(gameReviewOptions(24,{...DEFAULT_PERFORMANCE,reviewMode:'fast',movetime:10000}).depth,22);
  assert.equal(gameReviewOptions(8,{...DEFAULT_PERFORMANCE,reviewMode:'fast'}).depth,8);
  assert.equal('movetime' in gameReviewOptions(24,{...DEFAULT_PERFORMANCE,reviewMode:'fast'}),false);
});

test('cache keys record the actual whole-game policy separately from manual candidate settings',()=>{
  const settings={...DEFAULT_PERFORMANCE,multipv:3};
  const position=analysisKey('full',16,settings),game=analysisKey('full',16,settings,'game');
  assert.match(game,/^review-v8:game:full:depth:16:2:32$/);
  assert.notEqual(position,game);
  assert.equal(analysisKey('full',16,{...settings,multipv:5},'game'),game);
  assert.notEqual(analysisKey('full',16,{...settings,multipv:5}),position);
  assert.notEqual(analysisKey('full',16,{...settings,reviewMode:'fast'},'game'),game);
  assert.notEqual(analysisKey('full',16,{...settings,multipv:1},'game'),game);
  for(const threads of [1,2,3,4,6,8])for(const movetime of [0,500,30000]){
    assert.equal(analysisKey('full',16,{...settings,threads,movetime},'game'),game);
    assert.equal(analysisKey('full',16,{...settings,threads,movetime}),position);
  }
});

test('full-engine parts cover each WASM file and stay below static asset limits', () => {
  for (const parallel of [false,true]) {
    const chunks = engineChunks(parallel);
    assert.equal(chunks.reduce((size,part) => size+part.size,0),parallel ? 99065439 : 99102793);
    for (const [i,part] of chunks.entries()) {
      assert.ok(part.size <= 20*1024*1024);
      if(i) assert.equal(part.start,chunks[i-1].start+chunks[i-1].size);
    }
  }
});

test('worker selection and UCI initialization use the selected thread and hash values', async () => {
  const messages = [];
  let url;
  class FakeWorker {
    constructor(value) { url=value; }
    postMessage(command) {
      messages.push(command);
      if(command==='uci')queueMicrotask(()=>this.onmessage({data:'uciok'}));
      if(command==='isready')queueMicrotask(()=>this.onmessage({data:'readyok'}));
    }
    terminate() {}
  }
  const engine = new StockfishEngine(FakeWorker,{threads:4,hash:128});
  try {
    await engine.ready;
    assert.equal(url,'/engine/stockfish-19-lite.js?v=19.0.0');
    assert.deepEqual(messages,['uci','setoption name Threads value 4','setoption name Hash value 128','isready']);
    assert.equal(await workerUrl('lite'),'/engine/stockfish-19-lite-single.js?v=19.0.0');
  } finally { engine.dispose(); }
});

test('saved full-engine evaluations only restore for the matching engine', () => {
  const saved={engine:'Stockfish 19',results:[[0,{score:{type:'cp',value:30},lines:[]}]]};
  assert.equal(restoreResults(saved,1).size,0);
  assert.equal(restoreResults(saved,1,'Stockfish 19').size,1);
});
