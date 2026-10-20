import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisKey, DEFAULT_ENGINE_ID, DEFAULT_PERFORMANCE, ENGINES, engineChunks, engineId, gameReviewOptions, normalizePerformance, REVIEW_ENGINE_ID, reviewOptions, searchOptions, supportedThreads, workerUrl } from '../src/engine-options.js';
import { StockfishEngine } from '../src/engine.js';
import { restoreResults } from '../src/study.js';

test('new and unrecognized engine preferences default to full while manual Lite remains selectable', () => {
  assert.equal(DEFAULT_ENGINE_ID, 'full');
  assert.equal(REVIEW_ENGINE_ID, 'full');
  assert.equal(ENGINES[REVIEW_ENGINE_ID].name, 'Stockfish 19');
  for (const value of [undefined, null, '', 'Stockfish 18', 'unknown']) {
    assert.equal(engineId(value), DEFAULT_ENGINE_ID);
  }
  assert.equal(engineId('full'), 'full');
  assert.equal(engineId('Stockfish 19'), 'full');
  assert.equal(engineId('lite'), 'lite');
  assert.equal(engineId('Stockfish 19 Lite'), 'lite');
});

test('performance controls map to search limits and distinguish cached evaluations', () => {
  const settings = normalizePerformance({ movetime: 10000, multipv: 5, hash: 128, threads: 4 }, 8);
  assert.deepEqual(searchOptions(24, settings), { depth:24, movetime:10000, multipv:5, hash:128, threads:4 });
  const key = analysisKey('lite',24,settings);
  for (const [name,value] of [['movetime',500],['multipv',1],['hash',32],['threads',2]]) {
    assert.notEqual(analysisKey('lite',24,{...settings,[name]:value}),key);
  }
  assert.notEqual(analysisKey('full',24,settings),key);
  assert.equal(normalizePerformance({threads:8},2).threads,1);
  assert.equal(supportedThreads(false,16),1);
  assert.equal(supportedThreads(true,6),4);
  assert.equal(DEFAULT_PERFORMANCE.reviewMode,'precise');
  assert.equal(normalizePerformance().reviewMode,'precise');
  assert.equal(normalizePerformance({reviewMode:'fast'}).reviewMode,'fast');
  assert.match(key,/^review-v4:position:/);
});

test('whole-game review limits candidates while preserving explicit position analysis and review speed settings',()=>{
  for(const multipv of [1,2,3,5]){
    const precise={...DEFAULT_PERFORMANCE,multipv};
    const requested=searchOptions(16,precise);
    assert.equal(requested.multipv,multipv);
    assert.deepEqual(reviewOptions(16,precise),requested);
    assert.deepEqual(gameReviewOptions(16,precise),{...requested,multipv:Math.min(2,multipv)});
    const fast={...precise,reviewMode:'fast'};
    assert.deepEqual(gameReviewOptions(16,fast),{...requested,multipv:Math.min(2,multipv),movetime:600});
  }
  assert.equal(gameReviewOptions(24,{...DEFAULT_PERFORMANCE,reviewMode:'fast',movetime:10000}).movetime,1500);
});

test('cache keys record the actual whole-game policy separately from manual candidate settings',()=>{
  const settings={...DEFAULT_PERFORMANCE,multipv:3};
  const position=analysisKey('full',16,settings),game=analysisKey('full',16,settings,'game');
  assert.match(game,/^review-v4:game:full:16:1200:2:32:1$/);
  assert.notEqual(position,game);
  assert.equal(analysisKey('full',16,{...settings,multipv:5},'game'),game);
  assert.notEqual(analysisKey('full',16,{...settings,multipv:5}),position);
  assert.notEqual(analysisKey('full',16,{...settings,reviewMode:'fast'},'game'),game);
  assert.notEqual(analysisKey('full',16,{...settings,multipv:1},'game'),game);
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
