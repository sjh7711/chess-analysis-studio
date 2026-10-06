import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackClock } from '../src/study.js';

function fixture() {
  let now=0,id=0,advances=0;
  const timers=new Map();
  const clock=new PlaybackClock(()=>advances++,{
    setTimer:(fn,delay)=>{timers.set(++id,{fn,at:now+delay});return id;},
    clearTimer:id=>timers.delete(id),
  });
  return {clock,timers,get advances(){return advances;},tick(ms){
    const end=now+ms;
    while (true) {
      const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if (!next) break;
      now=next[1].at;timers.delete(next[0]);next[1].fn();
    }
    now=end;
  }};
}

test('analysis time is excluded from every reading interval',()=>{
  for (const delay of [2000,4000,6000]) {
    const f=fixture();
    f.clock.hold();f.tick(30000);
    assert.equal(f.advances,0);
    assert.equal(f.timers.size,0);
    f.clock.ready(delay);f.tick(delay-1);
    assert.equal(f.advances,0);
    f.tick(1);assert.equal(f.advances,1);
    assert.equal(f.clock.phase,'idle');
  }
});

test('cached results get the full interval and repeated renders cannot extend it',()=>{
  const f=fixture();
  f.clock.ready(2000);f.tick(1200);
  f.clock.ready(2000);f.tick(800);
  assert.equal(f.advances,1);
  assert.equal(f.timers.size,0);
});

test('changing the interval while analyzing cannot skip the analysis wait',()=>{
  const f=fixture();
  f.clock.hold();f.tick(1000);f.clock.hold();f.tick(10000);
  assert.equal(f.advances,0);
  f.clock.ready(6000);f.tick(5999);
  assert.equal(f.advances,0);
  f.tick(1);assert.equal(f.advances,1);
});

test('reanalyzing and changing the reading interval discard the previous timer',()=>{
  const f=fixture();
  f.clock.ready(2000);f.tick(1500);
  const stale=[...f.timers.values()][0].fn;
  f.clock.hold();f.tick(4000);stale();
  assert.equal(f.advances,0);
  f.clock.ready(4000);f.tick(1000);
  f.clock.hold();f.clock.ready(6000);
  f.tick(5999);assert.equal(f.advances,0);
  f.tick(1);assert.equal(f.advances,1);
});

test('pausing or navigating away cancels pending advancement',()=>{
  const f=fixture();
  f.clock.ready(2000);
  const stale=[...f.timers.values()][0].fn;
  f.clock.stop();f.tick(5000);stale();
  assert.equal(f.advances,0);
  assert.equal(f.clock.phase,'idle');
});
