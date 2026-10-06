import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisKey, engineChunks, normalizePerformance, searchOptions, supportedThreads, workerUrl } from '../src/engine-options.js';
import { StockfishEngine } from '../src/engine.js';
import { restoreResults } from '../src/study.js';

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
