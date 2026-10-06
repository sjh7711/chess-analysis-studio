import test from 'node:test';
import assert from 'node:assert/strict';
import {InvitationInbox} from '../src/online-nav.js';

const invitation = {id:'request-one',host:'친구',status:'waiting',canJoin:true,timeControl:'10+5'};
const deferred = () => {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('arrival is announced by refresh without accepting or joining automatically', async()=>{
  const calls=[],changes=[];
  const inbox=new InvitationInbox({request:async path=>{calls.push(path);return {invitations:[invitation]};},onChange:state=>changes.push(state.invitations.length)});
  await inbox.refresh();assert.deepEqual(calls,['invitations']);assert.deepEqual(changes,[1]);
});
test('accept submits once and a delayed poll cannot restore the accepted card', async()=>{
  const poll=deferred(),join=deferred(),accepted=[];let polls=0,joins=0;
  const inbox=new InvitationInbox({request:async path=>{if(path==='invitations')return ++polls===1?{invitations:[invitation]}:poll.promise;joins++;return join.promise;},onAccepted:id=>accepted.push(id)});
  await inbox.refresh();const old=inbox.refresh();const accepting=inbox.respond(invitation.id,'join');
  await inbox.respond(invitation.id,'join');await inbox.refresh();assert.equal(joins,1);assert.equal(polls,2);
  join.resolve({game:{id:invitation.id,status:'active',color:'w'}});await accepting;
  poll.resolve({invitations:[invitation]});await old;
  assert.deepEqual(accepted,[invitation.id]);assert.deepEqual(inbox.invitations,[]);
});
test('decline removes only that request and never navigates',async()=>{
  let navigated=false;
  const inbox=new InvitationInbox({request:async path=>path==='invitations'?{invitations:[invitation,{...invitation,id:'second'}]}:{game:{}},onAccepted:()=>{navigated=true;}});
  await inbox.refresh();await inbox.respond(invitation.id,'decline');
  assert.deepEqual(inbox.invitations.map(item=>item.id),['second']);assert.equal(navigated,false);
});
test('cancelled request is removed on refresh and cannot be accepted',async()=>{
  let calls=0;
  const inbox=new InvitationInbox({request:async()=>({invitations:++calls===1?[invitation]:[]})});
  await inbox.refresh();await inbox.refresh();await inbox.respond(invitation.id,'join');assert.equal(calls,2);
});
test('server rejection removes an expired request, but a transport failure permits retry',async()=>{
  let failStatus=409;const navigated=[];
  const inbox=new InvitationInbox({request:async path=>{if(path==='invitations')return {invitations:[invitation]};throw Object.assign(new Error('요청 처리 실패'),{status:failStatus});},onAccepted:id=>navigated.push(id)});
  await inbox.refresh();await inbox.respond(invitation.id,'join');assert.equal(inbox.invitations.length,0);assert.equal(inbox.busy,null);
  failStatus=503;await inbox.refresh();await inbox.respond(invitation.id,'join');assert.equal(inbox.invitations.length,1);assert.equal(inbox.message,'요청 처리 실패');assert.deepEqual(navigated,[]);
});
test('lost join response recovers the game only if membership was confirmed',async()=>{
  const accepted=[];
  const inbox=new InvitationInbox({request:async path=>{if(path==='invitations')return {invitations:[invitation]};if(path.endsWith('/join'))throw new Error('network');return {game:{id:invitation.id,color:'b',status:'active'}};},onAccepted:id=>accepted.push(id)});
  await inbox.refresh();await inbox.respond(invitation.id,'join');assert.deepEqual(accepted,[invitation.id]);
});
test('page exit prevents a pending response from updating UI or navigating',async()=>{
  const join=deferred(),accepted=[];let changes=0;
  const inbox=new InvitationInbox({request:async path=>path==='invitations'?{invitations:[invitation]}:join.promise,onChange:()=>changes++,onAccepted:id=>accepted.push(id)});
  await inbox.refresh();const accepting=inbox.respond(invitation.id,'join');inbox.stop();const count=changes;
  join.resolve({game:{id:invitation.id}});await accepting;assert.equal(changes,count);assert.deepEqual(accepted,[]);
});
