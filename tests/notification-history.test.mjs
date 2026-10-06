import test from 'node:test';
import assert from 'node:assert/strict';
import {NotificationHistory} from '../src/notification-center.js';
const memory=()=>{let value=null;return {getItem:()=>value,setItem:(_,next)=>{value=next;}};};
const invitation={id:'a'.repeat(32),host:'친구',status:'waiting',createdAt:20,timeControl:'10'};

test('recent analysis notifications persist, sort with invitations and are marked read',()=>{
  const storage=memory(),history=new NotificationHistory(storage);
  history.addAnalysis('백 vs 흑 · 3개 국면 분석 완료',10);history.syncInvitations('account-a',[invitation]);
  assert.deepEqual(history.entries().map(item=>item.kind),['invitation','analysis']);assert.ok(history.entries().every(item=>!item.read));
  history.markRead();const restored=new NotificationHistory(storage);restored.syncInvitations('account-a',[invitation]);
  assert.ok(restored.entries().every(item=>item.read));assert.match(restored.entries()[1].message,/분석 완료/);
});
test('read markers are account scoped, and invitation names are not persisted',()=>{
  const storage=memory(),history=new NotificationHistory(storage);history.syncInvitations('account-a',[invitation]);history.markRead();
  assert.ok(!storage.getItem().includes('친구'));history.syncInvitations('account-b',[invitation]);assert.equal(history.entries()[0].read,false);
  history.syncInvitations(null,[invitation]);assert.deepEqual(history.entries(),[]);
});
test('invitation status updates replace a record rather than duplicating it',()=>{
  const history=new NotificationHistory(memory());history.syncInvitations('account-a',[invitation]);history.markRead();
  history.syncInvitations('account-a',[{...invitation,status:'declined'}]);assert.equal(history.entries().length,1);assert.equal(history.entries()[0].status,'declined');assert.equal(history.entries()[0].read,true);
});
test('bounded history and blocked or invalid browser storage do not break notifications',()=>{
  const storage=memory(),history=new NotificationHistory(storage);for(let i=0;i<40;i++)history.addAnalysis('완료 '+i,i);
  assert.equal(new NotificationHistory(storage).entries().length,30);assert.equal(history.entries()[0].message,'완료 39');
  const blocked=new NotificationHistory({getItem(){throw Error();},setItem(){throw Error();}});blocked.addAnalysis('완료',1);blocked.addAnalysis('다음 완료',2);assert.equal(blocked.entries().length,2);
  const invalid=new NotificationHistory({getItem:()=>'{',setItem(){}});assert.deepEqual(invalid.entries(),[]);
});
test('a second page reads newly saved completion records before marking them read',()=>{
  const storage=memory(),first=new NotificationHistory(storage),second=new NotificationHistory(storage);first.addAnalysis('방금 완료',1);second.markRead();assert.equal(second.entries()[0].message,'방금 완료');assert.equal(second.entries()[0].read,true);
});
