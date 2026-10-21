import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundReview } from '../src/background-review.js';

const turn=()=>new Promise(setImmediate);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const spec=()=>({game:{name:'game'},results:new Map(),options:{depth:20,multipv:2},configKey:'game20'});

test('live searches retain both position and move-review work while their phases overlap',async()=>{
  const gate=deferred(),events=[];let publish;
  const review=new BackgroundReview({run:async(_,options)=>{publish=options.onProgress;await gate.promise;return 'done';},
    onProgress:(job,event)=>events.push({phase:event.phase,active:job.activeSearches.size})});
  const pending=review.start(spec()),job=review.active;await turn();
  publish({phase:'position',index:38,type:'search',requestedDepth:20,multipv:2});
  const startedAt=job.activeSearches.get('position:38').startedAt;
  assert.ok(Number.isFinite(startedAt));
  publish({phase:'position',index:38,type:'info',requestedDepth:20,depth:19,nodes:100});
  publish({phase:'review',index:4,type:'search',requestedDepth:22,multipv:1});
  assert.equal(job.activeSearches.size,2);
  assert.equal(job.activeSearches.get('position:38').depth,19);
  assert.equal(job.activeSearches.get('position:38').startedAt,startedAt);
  publish({phase:'review',index:4,type:'complete'});
  assert.equal(job.activeSearches.size,1);
  assert.equal(job.activeSearches.get('position:38').nodes,100);
  gate.resolve();assert.equal(await pending,'done');assert.equal(events.length,4);
});

test('a new confidence search resets the previous search depth and calculation amount',async()=>{
  const gate=deferred();let publish;
  const review=new BackgroundReview({run:async(_,options)=>{publish=options.onProgress;await gate.promise;}});
  const pending=review.start(spec()),job=review.active;await turn();
  publish({phase:'review',index:7,type:'search',requestedDepth:20});
  publish({phase:'review',index:7,type:'info',requestedDepth:20,depth:20,nodes:30000});
  publish({phase:'review',index:7,type:'search',requestedDepth:22});
  assert.equal(job.activeSearches.get('review:7').requestedDepth,22);
  assert.equal(job.activeSearches.get('review:7').depth,undefined);
  assert.equal(job.activeSearches.get('review:7').nodes,undefined);
  gate.resolve();await pending;
});

test('detached jobs ignore late telemetry and cannot overwrite a new review search',async()=>{
  const gate=deferred(),events=[];let publish;
  const review=new BackgroundReview({run:async(_,options)=>{publish=options.onProgress;await gate.promise;},
    onProgress:(_,event)=>events.push(event)});
  const pending=review.start(spec()),job=review.active;await turn();review.stop();
  publish({phase:'review',index:2,type:'info',depth:20});
  assert.equal(job.activeSearches.size,0);assert.equal(events.length,0);
  gate.resolve();assert.equal(await pending,null);
});
