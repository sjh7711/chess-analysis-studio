import test from 'node:test';
import assert from 'node:assert/strict';
import { StepNavigation } from '../src/pieces.js';

function board() {
  let index=0, moving=false;
  const visited=[];
  const navigation=new StepNavigation(()=>moving);
  return {
    visited, navigation,
    step(direction) { navigation.request(()=>{ index+=direction;visited.push(index);moving=true; }); },
    finish() { moving=false;navigation.flush(); },
  };
}

test('rapid clicks finish the current move and retain only one pending step',()=>{
  const b=board();
  for(let i=0;i<30;i++)b.step(1);
  assert.deepEqual(b.visited,[1]);
  b.finish();
  assert.deepEqual(b.visited,[1,2]);
  b.finish();b.finish();
  assert.deepEqual(b.visited,[1,2]);
});

test('the last requested direction replaces a pending forward step',()=>{
  const b=board();
  b.step(1);b.step(1);b.step(-1);
  assert.deepEqual(b.visited,[1]);
  b.finish();
  assert.deepEqual(b.visited,[1,0]);
});

test('ordinary clicks each advance and a new animation cannot drain another step early',()=>{
  const b=board();
  b.step(1);b.finish();b.step(1);b.step(1);
  b.navigation.flush();
  assert.deepEqual(b.visited,[1,2]);
  b.finish();b.step(1);b.navigation.flush();
  assert.deepEqual(b.visited,[1,2,3]);
  b.finish();
  assert.deepEqual(b.visited,[1,2,3,4]);
});

test('changing mode or directly choosing a position cancels a pending step',()=>{
  const b=board();
  b.step(1);b.step(1);b.navigation.cancel();b.finish();
  assert.deepEqual(b.visited,[1]);
  b.step(-1);b.finish();
  assert.deepEqual(b.visited,[1,0]);
});

test('castling and captures wait for every piece animation to finish',()=>{
  let moving=2, advances=0;
  const navigation=new StepNavigation(()=>moving>0);
  navigation.request(()=>advances++);
  moving--;navigation.flush();
  assert.equal(advances,0);
  moving--;navigation.flush();navigation.flush();
  assert.equal(advances,1);
});
