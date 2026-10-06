import test from 'node:test';
import assert from 'node:assert/strict';
import { CompletionAlerts } from '../src/completion-alerts.js';

function fixture({permission='default',saved=null,audio=true}={}) {
  const notices=[], notifications=[], tones=[];
  let requests=0, statuses=0, storage=saved;
  class Notification {
    static permission=permission;
    static async requestPermission() { requests++; return this.permission='granted'; }
    constructor(title,options) { notifications.push({title,options}); }
  }
  class AudioContext {
    state='suspended'; currentTime=10; destination={};
    async resume() { this.state='running'; }
    async close() { this.state='closed'; }
    createOscillator() { return {frequency:{setValueAtTime(frequency){tones.push(frequency);}},connect(){},disconnect(){},start(){},stop(){}}; }
    createGain() { return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}}; }
  }
  const host={isSecureContext:true,Notification,AudioContext:audio ? AudioContext : undefined,localStorage:{getItem:()=>storage,setItem:(_,value)=>{storage=value;}}};
  const alerts=new CompletionAlerts({host,onNotice:(...notice)=>notices.push(notice),onStatus:()=>statuses++});
  return {alerts,host,notices,notifications,tones,get requests(){return requests;},get statuses(){return statuses;},get storage(){return storage;}};
}

test('a completed run notifies once; canceled or replaced runs do not notify',()=>{
  const f=fixture();
  assert.equal(f.alerts.complete(1,'premature'),false);
  f.alerts.begin(1); f.alerts.cancel();
  assert.equal(f.alerts.complete(1,'stopped'),false);
  f.alerts.begin(2); f.alerts.begin(3); f.alerts.cancel(2);
  assert.equal(f.alerts.complete(2,'stale'),false);
  assert.equal(f.alerts.complete(3,'finished'),true);
  assert.equal(f.alerts.complete(3,'duplicate'),false);
  assert.deepEqual(f.notices,[['finished',false]]);
});

test('permission is requested only by explicit browser alert activation',async()=>{
  const f=fixture();
  f.alerts.test();
  assert.equal(f.requests,0); assert.equal(f.notifications.length,0);
  await f.alerts.toggleDesktop();
  assert.equal(f.requests,1);
  f.alerts.begin(1); f.alerts.complete(1,'5개 국면 분석 완료');
  assert.deepEqual(f.notifications[0],{title:'체스 분석 완료',options:{body:'5개 국면 분석 완료',tag:'chess-analysis-complete',silent:true}});
  await f.alerts.toggleDesktop(); f.alerts.test();
  assert.equal(f.notifications.length,1);
  assert.equal(JSON.parse(f.storage).desktop,false);
});

test('denied and unsupported permissions preserve in-page notices without prompting',async()=>{
  for (const unsupported of [false,true]) {
    const f=fixture({permission:'denied'});
    if (unsupported) f.host.isSecureContext=false;
    await f.alerts.toggleDesktop(); f.alerts.test();
    assert.equal(f.requests,0); assert.equal(f.notifications.length,0);
    assert.equal(f.notices.length,1);
  }
});

test('chime plays two tones and respects saved mute setting',async()=>{
  const f=fixture();
  assert.equal(await f.alerts.playSound(),true);
  assert.deepEqual(f.tones,[523.25,783.99]);
  f.alerts.setSound(false);
  assert.equal(await f.alerts.playSound(),false);
  assert.equal(f.tones.length,2);
  const restored=fixture({saved:f.storage});
  assert.equal(await restored.alerts.playSound(),false);
  assert.equal(restored.tones.length,0);
});

test('unavailable browser notifications and audio do not prevent completion notice',async()=>{
  const f=fixture({audio:false,permission:'granted',saved:JSON.stringify({sound:true,desktop:true})});
  f.host.Notification=class {static permission='granted';constructor(){throw new Error('Unavailable');}};
  f.alerts.begin(4);
  assert.equal(f.alerts.complete(4,'finished'),true);
  assert.deepEqual(f.notices,[['finished',false]]);
  assert.equal(f.alerts.desktopFailed,true); assert.equal(f.statuses,1);
  assert.equal(await f.alerts.playSound(),false);
});

test('test notification does not consume a running analysis completion',()=>{
  const f=fixture();
  f.alerts.begin(5); f.alerts.test(); f.alerts.complete(5,'finished');
  assert.deepEqual(f.notices,[['분석 완료 알림 테스트입니다.',true],['finished',false]]);
});
