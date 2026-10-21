import test from 'node:test';
import assert from 'node:assert/strict';
import { StableActionMarkup } from '../src/insight-actions.js';

function fixture() {
  const rendered=[],timers=new Map(),callbacks=[];
  let next=0;
  const view=new StableActionMarkup({render:markup=>rendered.push(markup),
    schedule:fn=>{const id=++next;timers.set(id,fn);callbacks.push(fn);return id;},
    cancel:id=>timers.delete(id)});
  const tick=()=>{const queued=[...timers];timers.clear();for(const [,fn]of queued)fn();};
  return {view,rendered,timers,callbacks,tick};
}

test('keyboard and ordinary updates render immediately and repeated markup preserves the DOM',()=>{
  const {view,rendered,timers}=fixture();
  view.update('original');view.update('original');view.update('keyboard selection');
  assert.deepEqual(rendered,['original','keyboard selection']);
  assert.equal(timers.size,0);
});

test('a held pointer coalesces engine updates until after the click dispatch task',()=>{
  const {view,rendered,timers,tick}=fixture();
  view.update('original');assert.equal(view.hold(3),true);
  view.update('depth 17');view.update('depth 18');
  assert.deepEqual(rendered,['original']);
  assert.equal(view.release(3),true);
  assert.deepEqual(rendered,['original']);assert.equal(timers.size,1);
  tick();assert.deepEqual(rendered,['original','depth 18']);
});

test('the click selection supersedes a deferred engine update without a later stale render',()=>{
  const {view,rendered,timers,tick}=fixture();
  view.update('original');view.hold(1);view.update('old engine result');view.release(1);
  view.update('clicked full response');
  assert.deepEqual(rendered,['original','clicked full response']);assert.equal(timers.size,0);
  tick();assert.deepEqual(rendered,['original','clicked full response']);
});

test('a click selecting the already displayed markup still discards the older pending result',()=>{
  const {view,rendered,tick}=fixture();
  view.update('original');view.hold(1);view.update('old result');view.release(1);
  view.update('original');tick();
  assert.deepEqual(rendered,['original']);
});

test('wrong pointer releases, cancellations, and additional pointers cannot end the active hold',()=>{
  const {view,rendered,timers,tick}=fixture();
  view.update('original');assert.equal(view.hold(0),true);assert.equal(view.hold(0),true);
  assert.equal(view.hold(2),false);view.update('pending');
  assert.equal(view.release(2),false);assert.equal(view.cancelHold(2),false);
  tick();assert.deepEqual(rendered,['original']);assert.equal(timers.size,0);
  view.release(0);tick();assert.deepEqual(rendered,['original','pending']);
});

test('a cancelled pointer flushes pending markup immediately and does not strand future keyboard updates',()=>{
  const {view,rendered,timers,tick}=fixture();
  view.update('original');view.hold(7);view.update('pending');
  assert.equal(view.cancelHold(7),true);
  assert.deepEqual(rendered,['original','pending']);assert.equal(timers.size,0);
  view.update('keyboard');tick();assert.deepEqual(rendered,['original','pending','keyboard']);
});

test('blur clears either a held pointer or an already scheduled flush',()=>{
  for(const released of [false,true]) {
    const {view,rendered,timers,tick}=fixture();
    view.update('original');view.hold(1);view.update('pending');
    if(released)view.release(1);
    assert.equal(view.cancelHold(),true);
    assert.deepEqual(rendered,['original','pending']);assert.equal(timers.size,0);
    tick();assert.deepEqual(rendered,['original','pending']);
  }
});

test('a new pointer hold before the timer fires protects the new gesture',()=>{
  const {view,rendered,timers,tick}=fixture();
  view.update('original');view.hold(1);view.update('depth 17');view.release(1);
  view.hold(2);assert.equal(timers.size,0);view.update('depth 18');
  tick();assert.deepEqual(rendered,['original']);
  view.release(2);tick();assert.deepEqual(rendered,['original','depth 18']);
});

test('cancelled timer callbacks cannot flush a newer selection or active gesture',()=>{
  const {view,rendered,callbacks}=fixture();
  view.update('original');view.hold(1);view.update('old result');view.release(1);
  const stale=callbacks[0];
  view.hold(2);view.update('new pending');stale();
  assert.deepEqual(rendered,['original']);
  view.cancelHold();stale();assert.deepEqual(rendered,['original','new pending']);
});

test('a held update returning to the displayed value needs no delayed DOM replacement',()=>{
  const {view,rendered,timers,tick}=fixture();
  view.update('original');view.hold(1);view.update('transient');view.update('original');view.release(1);
  assert.equal(timers.size,0);tick();assert.deepEqual(rendered,['original']);
});

test('release without an active matching hold does not flush queued work or create timers',()=>{
  const {view,rendered,timers,tick}=fixture();
  view.update('original');assert.equal(view.release(1),false);
  view.hold(1);view.update('pending');view.release(1);
  assert.equal(view.release(1),false);assert.equal(view.cancelHold(1),false);assert.equal(timers.size,1);
  tick();assert.deepEqual(rendered,['original','pending']);
});

test('dispose cancels timers, drops pending markup, and makes later calls inert',()=>{
  for(const released of [false,true]) {
    const {view,rendered,timers,callbacks,tick}=fixture();
    view.update('original');view.hold(1);view.update('pending');
    if(released)view.release(1);
    view.dispose();view.dispose();
    assert.equal(timers.size,0);view.update('late');assert.equal(view.hold(2),false);
    assert.equal(view.release(1),false);assert.equal(view.cancelHold(),false);
    tick();for(const callback of callbacks)callback();assert.deepEqual(rendered,['original']);
  }
});

test('invalid constructor callbacks are rejected and invalid pointer ids are ignored',()=>{
  assert.throws(()=>new StableActionMarkup(),TypeError);
  for(const key of ['render','schedule','cancel'])assert.throws(()=>new StableActionMarkup({render(){},[key]:null}),TypeError);
  const {view}=fixture();
  for(const value of [undefined,null,NaN,1.5,'1'])assert.equal(view.hold(value),false);
});
