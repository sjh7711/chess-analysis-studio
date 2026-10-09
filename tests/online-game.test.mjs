import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { handleGameRequest } from '../online/game-service.mjs';
import { Chess } from '../node_modules/chess.js/dist/esm/chess.js';
import {tokenHash} from '../online/auth-service.mjs';

function fixture(){
  let time=1_800_000_000_000;
  const sqlite=new DatabaseSync(':memory:');const migrationDir=new URL('../sites/chess-analysis/drizzle/',import.meta.url);
  for(const file of readdirSync(migrationDir).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(file,migrationDir),'utf8'));
  const db={prepare(sql){return {bind(...args){return {
    async first(){return sqlite.prepare(sql).get(...args)||null;},
    async all(){return {results:sqlite.prepare(sql).all(...args)};},
    async run(){return sqlite.prepare(sql).run(...args);}
  };}};}};
  for(const user of ['alice','bob','eve','new-user']){
    sqlite.prepare('INSERT INTO accounts (user_id,nickname_key,password_hash,created_at) VALUES (?,?,?,?)').run(user,user,'fixture',time);
    sqlite.prepare('INSERT INTO account_sessions VALUES (?,?,1,?,?,?)').run(tokenHash(tokenHash(user)),user,'password',time,time+86400000);
  }
  const call=async(user,path,body,extra={})=>{const request=new Request('https://chess.test/api/play/'+path,{method:body===undefined?'GET':'POST',headers:{...(user?{Cookie:'__Host-chess-session='+tokenHash(user)}:{}),...(body===undefined?{}:{Origin:'https://chess.test','Content-Type':'application/json'}),...extra},body:body===undefined?undefined:JSON.stringify(body)}),response=await handleGameRequest(request,db,{now:()=>time});return {status:response.status,...await response.json()};};
  const players=async()=>{for(const [user,nickname] of [['alice','알리스'],['bob','보브'],['eve','관전자']])sqlite.prepare('INSERT OR IGNORE INTO players VALUES (?,?,?,?)').run(user,nickname,tokenHash(user).slice(0,12).toUpperCase(),time);};
  const start=async(mode='invite',timeControl='10')=>{await players();const bob=await call('bob','me');const made=await call('alice','games',{mode,color:'w',timeControl,friendCode:bob.profile.friendCode});assert.equal(made.status,201);const joined=await call('bob','games/'+made.game.id+'/join',{},mode==='invite'?{'x-invite-token':made.game.inviteToken}:{});assert.equal(joined.status,200);return made.game.id;};
  const action=async(user,id,body)=>{const current=await call(user,'games/'+id);return call(user,'games/'+id+'/action',{revision:current.game.revision,...body});};
  return {sqlite,db,call,players,start,action,tick:ms=>{time+=ms;}};
}
test('login and nickname required; game records exclude private account identifiers',async()=>{const f=fixture();assert.equal((await f.call(null,'me')).signedIn,false);assert.equal((await f.call(null,'lobby')).status,401);assert.equal((await f.call('alice','lobby')).status,428);const id=await f.start();const state=await f.call('alice','games/'+id);assert.equal(state.game.color,'w');assert.ok(!JSON.stringify(state).includes('alice'));assert.equal((await f.call('eve','games/'+id)).status,404);});
test('notification inbox is private, pending only, and removes joined, declined and cancelled requests',async()=>{
  const f=fixture();assert.deepEqual((await f.call(null,'invitations')).invitations,[]);assert.deepEqual((await f.call('new-user','invitations')).invitations,[]);
  await f.players();const bob=(await f.call('bob','me')).profile;
  for(const action of ['join','decline','cancel']){
    const {game}=await f.call('alice','games',{mode:'friend',color:'w',friendCode:bob.friendCode,timeControl:'15+10'});
    const list=(await f.call('bob','invitations')).invitations;assert.equal(list.length,1);assert.equal(list[0].id,game.id);assert.equal(list[0].host,'알리스');assert.equal(list[0].timeControl,'15+10');
    assert.deepEqual((await f.call('alice','invitations')).invitations,[]);assert.deepEqual((await f.call('eve','invitations')).invitations,[]);
    assert.equal(list[0].inviteToken,undefined);assert.equal(list[0].pgn,undefined);
    assert.equal((await f.call(action==='cancel'?'alice':'bob',`games/${game.id}/${action}`,{})).status,200);
    assert.deepEqual((await f.call('bob','invitations')).invitations,[]);
    const recent=await f.call('bob','invitations');assert.equal(recent.accountKey,bob.friendCode);
    const notification=recent.recentInvitations.find(item=>item.id===game.id);assert.equal(notification.status,{join:'active',decline:'declined',cancel:'cancelled'}[action]);
    assert.deepEqual(Object.keys(notification).sort(),['createdAt','host','id','status','timeControl']);
    assert.deepEqual((await f.call('eve','invitations')).recentInvitations,[]);
  }
  await f.call('alice','games',{mode:'invite',color:'w'});assert.deepEqual((await f.call('bob','invitations')).invitations,[]);
});
test('invite token admits exactly one opponent; expired or missing invitation cannot join',async()=>{const f=fixture();await f.players();const {game}=await f.call('alice','games',{mode:'invite',color:'w'});assert.equal((await f.call('bob','games/'+game.id+'/join',{})).status,404);const results=await Promise.all(['bob','eve'].map(u=>f.call(u,'games/'+game.id+'/join',{}, {'x-invite-token':game.inviteToken})));assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);});
test('friend request appears only in recipient inbox and can be accepted without invite token',async()=>{const f=fixture();await f.players();const bob=await f.call('bob','me');const made=await f.call('alice','games',{mode:'friend',color:'b',friendCode:bob.profile.friendCode});assert.equal(made.game.inviteToken,undefined);assert.equal((await f.call('bob','lobby')).games[0].canJoin,true);assert.equal((await f.call('eve','lobby')).games.length,0);assert.equal((await f.call('eve','games/'+made.game.id+'/join',{})).status,404);const joined=await f.call('bob','games/'+made.game.id+'/join',{});assert.equal(joined.game.color,'w');});
test('friend decline and owner cancellation prevent joining',async()=>{const f=fixture();await f.players();const bob=await f.call('bob','me'),made=await f.call('alice','games',{mode:'friend',color:'w',friendCode:bob.profile.friendCode});assert.equal((await f.call('alice','games/'+made.game.id+'/decline',{})).status,409);assert.equal((await f.call('bob','games/'+made.game.id+'/decline',{})).status,200);assert.equal((await f.call('bob','games/'+made.game.id+'/join',{})).status,409);const invite=await f.call('alice','games',{mode:'invite',color:'w'});await f.call('alice','games/'+invite.game.id+'/cancel',{});assert.equal((await f.call('bob','games/'+invite.game.id+'/join',{}, {'x-invite-token':invite.game.inviteToken})).status,409);});
test('server rejects illegal moves, wrong turn and stale revisions',async()=>{const f=fixture(),id=await f.start();assert.equal((await f.action('bob',id,{type:'move',uci:'e7e5'})).status,409);assert.equal((await f.action('alice',id,{type:'move',uci:'e2e5'})).status,400);const a=await f.action('alice',id,{type:'move',uci:'e2e4'});assert.equal(a.game.moves.length,1);const old=await f.call('bob','games/'+id+'/action',{type:'move',uci:'e7e5',revision:1});assert.equal(old.status,409);assert.equal((await f.action('bob',id,{type:'move',uci:'e7e5'})).game.moves.length,2);});
test('concurrent move submissions apply at most once',async()=>{const f=fixture(),id=await f.start();const results=await Promise.all(['e2e4','d2d4'].map(uci=>f.call('alice','games/'+id+'/action',{type:'move',uci,revision:1})));assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await f.call('alice','games/'+id)).game.moves.length,1);});
test('undo needs the opponent acceptance and restores exactly one ply and side to move',async()=>{const f=fixture(),id=await f.start();await f.action('alice',id,{type:'move',uci:'e2e4'});await f.action('bob',id,{type:'move',uci:'e7e5'});const offered=await f.action('alice',id,{type:'offer',kind:'undo'});assert.equal(offered.game.moves.length,2);assert.match(offered.game.request.label,/흑 폰 e7/);assert.equal((await f.action('alice',id,{type:'respond',requestId:offered.game.request.id,accept:true})).status,409);const accepted=await f.action('bob',id,{type:'respond',requestId:offered.game.request.id,accept:true});assert.deepEqual(accepted.game.moves,['e2e4']);assert.equal(accepted.game.turn,'b');const c=new Chess();c.move('e4');assert.equal(accepted.game.fen,c.fen());});
test('declining or withdrawing undo leaves the board unchanged and rejects stale acceptance',async()=>{
  const f=fixture(),id=await f.start();await f.action('alice',id,{type:'move',uci:'e2e4'});
  let offer=await f.action('alice',id,{type:'offer',kind:'undo'});
  const denied=await f.action('bob',id,{type:'respond',requestId:offer.game.request.id,accept:false});
  assert.deepEqual(denied.game.moves,['e2e4']);assert.equal(denied.game.request,null);
  assert.equal((await f.action('alice',id,{type:'offer',kind:'undo'})).status,409);
  await f.action('bob',id,{type:'move',uci:'e7e5'});
  offer=await f.action('alice',id,{type:'offer',kind:'undo'});
  await f.action('alice',id,{type:'withdraw'});
  assert.equal((await f.action('bob',id,{type:'respond',requestId:offer.game.request.id,accept:true})).status,409);
  assert.deepEqual((await f.call('bob','games/'+id)).game.moves,['e2e4','e7e5']);
});
test('agreed draw is saved with complete PGN and is available only to participants',async()=>{const f=fixture(),id=await f.start();await f.action('alice',id,{type:'move',uci:'e2e4'});const offer=await f.action('alice',id,{type:'offer',kind:'draw'});assert.equal(offer.game.status,'active');const end=await f.action('bob',id,{type:'respond',requestId:offer.game.request.id,accept:true});assert.equal(end.game.result,'1/2-1/2');assert.equal(end.game.status,'finished');const c=new Chess();c.loadPgn(end.game.pgn);assert.equal(c.getHeaders().White,'알리스');assert.equal(c.getHeaders().Black,'보브');assert.equal(c.getHeaders().Result,'1/2-1/2');assert.equal(c.history().length,1);assert.equal((await f.call('bob','lobby')).games[0].status,'finished');assert.equal((await f.call('eve','games/'+id)).status,404);});
test('resignation declares opponent winner and prevents further changes',async()=>{const f=fixture(),id=await f.start();const end=await f.action('alice',id,{type:'resign'});assert.equal(end.game.result,'0-1');assert.equal(end.game.reason,'백 기권');assert.equal((await f.action('bob',id,{type:'move',uci:'e7e5'})).status,409);});
test('checkmate ends and persists the game automatically',async()=>{const f=fixture(),id=await f.start();for(const [u,uci]of [['alice','f2f3'],['bob','e7e5'],['alice','g2g4'],['bob','d8h4']])assert.equal((await f.action(u,id,{type:'move',uci})).status,200);const end=(await f.call('alice','games/'+id)).game;assert.equal(end.result,'0-1');assert.equal(end.reason,'체크메이트');assert.equal(end.history.at(-1).san,'Qh4#');assert.ok(end.pgn.includes('[Result "0-1"]'));});
test('threefold repetition includes full move history',async()=>{const f=fixture(),id=await f.start();for(let i=0;i<2;i++)for(const [u,uci]of [['alice','g1f3'],['bob','g8f6'],['alice','f3g1'],['bob','f6g8']])await f.action(u,id,{type:'move',uci});const end=(await f.call('alice','games/'+id)).game;assert.equal(end.result,'1/2-1/2');assert.equal(end.reason,'같은 국면 3회 반복');});

test('undo keeps its request-time target after later moves and accepts an older revision only once',async()=>{
  const f=fixture(),id=await f.start();
  await f.action('alice',id,{type:'move',uci:'e2e4'});await f.action('bob',id,{type:'move',uci:'e7e5'});
  const offer=await f.action('alice',id,{type:'offer',kind:'undo'}),requestId=offer.game.request.id;
  for(const [user,uci] of [['alice','g1f3'],['bob','b8c6']]){
    const next=await f.action(user,id,{type:'move',uci});assert.equal(next.game.request.id,requestId);assert.equal(next.game.request.ply,2);
  }
  const response={type:'respond',requestId,accept:true,revision:offer.game.revision};
  const accepted=await f.call('bob','games/'+id+'/action',response);
  assert.equal(accepted.status,200);assert.deepEqual(accepted.game.moves,['e2e4']);assert.equal(accepted.game.turn,'b');
  assert.equal(accepted.game.request,null);assert.equal(accepted.game.result,'*');
  assert.equal((await f.call('bob','games/'+id+'/action',response)).status,409);
});

test('pending undo survives threefold termination, restores its target and replaces the saved result',async()=>{
  const f=fixture(),id=await f.start();
  const sequence=[['alice','g1f3'],['bob','g8f6'],['alice','f3g1'],['bob','f6g8'],['alice','g1f3'],['bob','g8f6'],['alice','f3g1']];
  for(const [user,uci] of sequence)await f.action(user,id,{type:'move',uci});
  const offer=await f.action('alice',id,{type:'offer',kind:'undo'}),requestId=offer.game.request.id;
  const ended=await f.action('bob',id,{type:'move',uci:'f6g8'});
  assert.equal(ended.game.status,'finished');assert.equal(ended.game.reason,'같은 국면 3회 반복');assert.equal(ended.game.request.id,requestId);
  const resumed=await f.call('bob','games/'+id+'/action',{type:'respond',requestId,accept:true,revision:offer.game.revision});
  assert.equal(resumed.status,200);assert.equal(resumed.game.status,'active');assert.equal(resumed.game.result,'*');assert.equal(resumed.game.reason,null);
  assert.deepEqual(resumed.game.moves,sequence.slice(0,6).map(([,uci])=>uci));assert.equal(resumed.game.pgn,undefined);
  assert.equal((await f.call('alice','history')).games.length,0);
  assert.equal((await f.action('alice',id,{type:'move',uci:'e2e4'})).status,200);
  const final=await f.action('bob',id,{type:'resign'}),pgn=new Chess();pgn.loadPgn(final.game.pgn);
  assert.equal(pgn.getHeaders().Result,'1-0');assert.equal(pgn.history().length,7);
  assert.equal((await f.call('alice','history')).games.length,1);
});

test('pending undo survives checkmate and resignation; finished requests can also be declined or withdrawn',async()=>{
  for(const finish of ['mate','resign'])for(const reply of ['accept','decline','withdraw']){
    const f=fixture(),id=await f.start();
    for(const [user,uci] of [['alice','f2f3'],['bob','e7e5'],['alice','g2g4']])await f.action(user,id,{type:'move',uci});
    const offer=await f.action('alice',id,{type:'offer',kind:'undo'}),requestId=offer.game.request.id;
    const ended=await f.action('bob',id,finish==='mate'?{type:'move',uci:'d8h4'}:{type:'resign'});
    assert.equal(ended.game.status,'finished');assert.equal(ended.game.request.id,requestId);
    assert.equal((await f.action('alice',id,{type:'respond',requestId,accept:true})).status,409);
    assert.equal((await f.action('alice',id,{type:'offer',kind:'undo'})).status,409);
    assert.equal((await f.call('eve','games/'+id+'/action',{type:'respond',requestId,accept:true,revision:ended.game.revision})).status,404);
    const result=await f.action(reply==='withdraw'?'alice':'bob',id,reply==='withdraw'?{type:'withdraw'}:{type:'respond',requestId,accept:reply==='accept'});
    assert.equal(result.status,200);assert.equal(result.game.request,null);
    if(reply==='accept'){
      assert.equal(result.game.status,'active');assert.equal(result.game.reason,null);assert.deepEqual(result.game.moves,['f2f3','e7e5']);
    }else{assert.equal(result.game.status,'finished');assert.deepEqual(result.game.moves,ended.game.moves);assert.equal(result.game.result,ended.game.result);}
  }
});

test('undo restores only the recipient clock and removes increments for every discarded move',async()=>{
  for(const requester of ['alice','bob']){
    const f=fixture(),id=await f.start('invite','10+5');
    f.tick(3000);await f.action('alice',id,{type:'move',uci:'e2e4'});
    f.tick(2000);await f.action('bob',id,{type:'move',uci:'e7e5'});
    f.tick(1000);const offer=await f.action(requester,id,{type:'offer',kind:'undo'});
    f.tick(4000);await f.action('alice',id,{type:'move',uci:'g1f3'});
    f.tick(6000);await f.action('bob',id,{type:'move',uci:'b8c6'});
    f.tick(3000);const recipient=requester==='alice'?'bob':'alice';
    const {game}=await f.action(recipient,id,{type:'respond',requestId:offer.game.request.id,accept:true});
    assert.deepEqual(game.moves,['e2e4']);assert.equal(game.turn,'b');
    assert.equal(game.clock.white,requester==='alice'?594000:601000);
    assert.equal(game.clock.black,requester==='alice'?598000:592000);
    f.tick(2000);const later=(await f.call(recipient,'games/'+id)).game;
    assert.equal(later.clock.white,game.clock.white);assert.equal(later.clock.black,game.clock.black-2000);
  }
});

test('recipient timeout can be undone with the pending request and the recipient clock is restored',async()=>{
  const f=fixture(),id=await f.start();f.tick(2000);await f.action('alice',id,{type:'move',uci:'e2e4'});
  const offer=await f.action('alice',id,{type:'offer',kind:'undo'});f.tick(600001);
  const ended=(await f.call('bob','games/'+id)).game;assert.equal(ended.reason,'흑 시간 초과');assert.equal(ended.request.id,offer.game.request.id);
  const {game}=await f.call('bob','games/'+id+'/action',{type:'respond',requestId:offer.game.request.id,accept:true,revision:offer.game.revision});
  assert.equal(game.status,'active');assert.equal(game.clock.white,598000);assert.equal(game.clock.black,600000);assert.deepEqual(game.moves,[]);
  f.tick(1000);assert.equal((await f.call('alice','games/'+id)).game.clock.white,597000);
  assert.equal((await f.action('alice',id,{type:'move',uci:'d2d4'})).status,200);
});

test('requester time is not recovered after their own timeout',async()=>{
  const f=fixture(),id=await f.start();await f.action('alice',id,{type:'move',uci:'e2e4'});await f.action('bob',id,{type:'move',uci:'e7e5'});
  const offer=await f.action('alice',id,{type:'offer',kind:'undo'});f.tick(600001);
  const {game}=await f.call('bob','games/'+id+'/action',{type:'respond',requestId:offer.game.request.id,accept:true,revision:offer.game.revision});
  assert.deepEqual(game.moves,['e2e4']);assert.equal(game.clock.white,0);assert.equal(game.status,'finished');assert.equal(game.reason,'백 시간 초과');assert.equal(game.request,null);
});

test('undo acceptance racing a subsequent move still reaches the request-time board',async()=>{
  for(const acceptFirst of [false,true]){
    const f=fixture(),id=await f.start();await f.action('alice',id,{type:'move',uci:'e2e4'});await f.action('bob',id,{type:'move',uci:'e7e5'});
    const offer=await f.action('alice',id,{type:'offer',kind:'undo'}),revision=offer.game.revision;
    const accept=()=>f.call('bob','games/'+id+'/action',{type:'respond',requestId:offer.game.request.id,accept:true,revision});
    const move=()=>f.call('alice','games/'+id+'/action',{type:'move',uci:'g1f3',revision});
    const outcomes=await Promise.all(acceptFirst?[accept(),move()]:[move(),accept()]);
    assert.equal(outcomes[acceptFirst?0:1].status,200);
    assert.deepEqual((await f.call('alice','games/'+id)).game.moves,['e2e4']);
  }
});
test('server rejects cross-origin changes and accidental self invitations',async()=>{const f=fixture();await f.players();assert.equal((await f.call('alice','me',{nickname:'변경'},{Origin:'https://evil.test'})).status,403);const p=await f.call('alice','me');assert.equal((await f.call('alice','games',{mode:'friend',color:'w',friendCode:p.profile.friendCode})).status,400);});
test('exactly the six requested time controls are accepted',async()=>{for(const [preset,minutes,increment]of [['10',10,0],['10+5',10,5],['15+10',15,10],['20',20,0],['30',30,0],['60',60,0]]){const f=fixture(),id=await f.start('invite',preset),g=(await f.call('alice','games/'+id)).game;assert.equal(g.clock.white,minutes*60000);assert.equal(g.clock.black,minutes*60000);assert.equal(g.clock.increment,increment*1000);assert.equal((await f.call('alice','games',{mode:'invite',color:'w',timeControl:'3+2'})).status,400);}});
test('either player can request a rematch with the same clock rules, swapped colors and untouched history',async()=>{
  for(const preset of ['10','10+5','15+10','20','30','60'])for(const requester of ['alice','bob']){
    const f=fixture(),id=await f.start('invite',preset);f.tick(2500);await f.action('alice',id,{type:'move',uci:'e2e4'});await f.action('bob',id,{type:'resign'});
    const original=f.sqlite.prepare('SELECT * FROM games WHERE id=?').get(id),oldState=JSON.parse(original.state_json),opponent=requester==='alice'?'bob':'alice';
    const eve=(await f.call('eve','me')).profile;
    const created=await f.call(requester,'games',{rematchOf:id,mode:'invite',timeControl:'60',color:'random',friendCode:eve.friendCode});
    assert.equal(created.status,201);assert.notEqual(created.game.id,id);assert.equal(created.game.mode,'friend');assert.equal(created.game.status,'waiting');assert.equal(created.game.timeControl,preset);
    assert.equal(created.game.color,requester==='alice'?'b':'w');assert.deepEqual(created.game.moves,[]);assert.equal(created.game.clock.startedAt,null);
    assert.equal(created.game.clock.white,oldState.clock.initial);assert.equal(created.game.clock.black,oldState.clock.initial);assert.equal(created.game.clock.increment,oldState.clock.increment);
    assert.deepEqual(f.sqlite.prepare('SELECT * FROM games WHERE id=?').get(id),original);
    assert.equal((await f.call(opponent,'invitations')).invitations[0].id,created.game.id);assert.equal((await f.call('eve','games/'+created.game.id)).status,404);
    assert.equal((await f.call(requester,'games',{rematchOf:id})).status,409);
    const joined=await f.call(opponent,'games/'+created.game.id+'/join',{});assert.equal(joined.status,200);assert.equal(joined.game.status,'active');assert.equal(joined.game.color,requester==='alice'?'w':'b');
    assert.equal(joined.game.clock.white,oldState.clock.initial);assert.equal(joined.game.clock.black,oldState.clock.initial);
  }
});
test('rematch creation rejects unfinished games, outsiders, missing games and malformed IDs',async()=>{
  const f=fixture(),id=await f.start();
  assert.equal((await f.call('alice','games',{rematchOf:id})).status,409);
  await f.action('bob',id,{type:'resign'});
  assert.equal((await f.call('eve','games',{rematchOf:id})).status,404);
  assert.equal((await f.call(null,'games',{rematchOf:id})).status,401);
  assert.equal((await f.call('alice','games',{rematchOf:'0'.repeat(32)})).status,404);
  for(const invalid of [null,{},'bad-id'])assert.equal((await f.call('alice','games',{rematchOf:invalid})).status,400);
});
test('only side to move loses time; increment applies once and PGN retains time control',async()=>{const f=fixture(),id=await f.start('invite','10+5');f.tick(3000);const g=(await f.action('alice',id,{type:'move',uci:'e2e4'})).game;assert.equal(g.clock.white,602000);assert.equal(g.clock.black,600000);f.tick(2000);const after=(await f.call('alice','games/'+id)).game;assert.equal(after.clock.white,602000);assert.equal(after.clock.black,598000);const end=(await f.action('bob',id,{type:'resign'})).game;assert.ok(end.pgn.includes('[TimeControl "600+5"]'));f.tick(20000);assert.deepEqual((await f.call('alice','games/'+id)).game.clock,end.clock);});
test('undo keeps requester elapsed time and removes the restored move increment',async()=>{const f=fixture(),id=await f.start('invite','10+5');f.tick(3000);await f.action('alice',id,{type:'move',uci:'e2e4'});f.tick(2000);await f.action('bob',id,{type:'move',uci:'e7e5'});f.tick(1000);const offered=await f.action('alice',id,{type:'offer',kind:'undo'});f.tick(1000);const undone=(await f.action('bob',id,{type:'respond',requestId:offered.game.request.id,accept:true})).game;assert.equal(undone.clock.white,600000);assert.equal(undone.clock.black,598000);assert.equal(undone.turn,'b');f.tick(2000);assert.equal((await f.call('alice','games/'+id)).game.clock.black,596000);});
test('server declares time loss even without a client timeout message and refuses a late move',async()=>{const f=fixture(),id=await f.start();f.tick(600001);const late=await f.call('alice','games/'+id+'/action',{type:'move',uci:'e2e4',revision:1});assert.equal(late.status,409);const end=(await f.call('bob','games/'+id)).game;assert.equal(end.status,'finished');assert.equal(end.result,'0-1');assert.equal(end.reason,'백 시간 초과');assert.equal(end.moves.length,0);assert.equal(end.clock.white,0);});
test('waiting room clock does not run before opponent joins',async()=>{const f=fixture();await f.players();const {game}=await f.call('alice','games',{mode:'invite',color:'w',timeControl:'10'});f.tick(3600000);assert.equal((await f.call('alice','games/'+game.id)).game.clock.white,600000);const joined=await f.call('bob','games/'+game.id+'/join',{}, {'x-invite-token':game.inviteToken});assert.equal(joined.game.clock.white,600000);});

test('saved game pagination is complete, stable with tied dates and private',async()=>{
  const f=fixture(),id=await f.start();await f.action('bob',id,{type:'resign'});
  const original=f.sqlite.prepare('SELECT * FROM games WHERE id=?').get(id);
  for(let i=1;i<=25;i++)f.sqlite.prepare('INSERT INTO games (id,owner_user,guest_user,target_user,status,revision,state_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(i.toString(16).padStart(32,'0'),original.owner_user,original.guest_user,null,'finished',original.revision,original.state_json,original.created_at,original.updated_at);
  const first=await f.call('alice','lobby');assert.equal(first.games.length,20);assert.ok(first.nextCursor);
  const second=await f.call('alice','history?cursor='+first.nextCursor);assert.equal(second.games.length,6);assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.games,...second.games].map(g=>g.id)).size,26);
  assert.equal((await f.call('eve','history')).games.length,0);
  assert.equal((await f.call('alice','history?cursor=invalid')).status,400);
});

test('nickname login IDs cannot be renamed through the old profile endpoint; friend codes remain fixed',async()=>{
  const f=fixture();await f.players();const before=(await f.call('bob','me')).profile;
  assert.equal((await f.call('bob','me',{nickname:'새 보브'})).status,405);
  assert.equal((await f.call('bob','me')).profile.friendCode,before.friendCode);
});
test('saved friends persist, are private, deduplicate and follow nickname changes',async()=>{
  const f=fixture();await f.players();const bob=(await f.call('bob','me')).profile;
  assert.equal((await f.call('alice','friends',{friendCode:bob.friendCode.toLowerCase()})).friends.length,1);
  assert.equal((await f.call('alice','friends',{friendCode:bob.friendCode})).friends.length,1);
  assert.deepEqual((await f.call('eve','friends')).friends,[]);assert.deepEqual((await f.call('bob','friends')).friends,[]);
  f.sqlite.prepare('UPDATE players SET nickname=? WHERE user_id=?').run('이름 변경','bob');
  const list=(await f.call('alice','lobby')).friends;assert.equal(list[0].nickname,'이름 변경');assert.equal(list[0].friendCode,bob.friendCode);
  assert.deepEqual(Object.keys(list[0]).sort(),['addedAt','friendCode','nickname']);
});
test('friend validation and owner-only removal preserve completed games',async()=>{
  const f=fixture(),id=await f.start();const bob=(await f.call('bob','me')).profile,alice=(await f.call('alice','me')).profile;
  assert.equal((await f.call('alice','friends',{friendCode:alice.friendCode})).status,400);
  assert.equal((await f.call('alice','friends',{friendCode:'no-such-code'})).status,404);
  await f.call('alice','friends',{friendCode:bob.friendCode});await f.call('eve','friends/remove',{friendCode:bob.friendCode});
  assert.equal((await f.call('alice','friends')).friends.length,1);
  await f.action('bob',id,{type:'resign'});await f.call('alice','friends/remove',{friendCode:bob.friendCode});
  assert.equal((await f.call('alice','friends')).friends.length,0);assert.equal((await f.call('alice','history')).games[0].id,id);
});
test('a saved friend starts a recipient-only match with chosen time and color',async()=>{
  const f=fixture();await f.players();const bob=(await f.call('bob','me')).profile;
  await f.call('alice','friends',{friendCode:bob.friendCode});const friend=(await f.call('alice','friends')).friends[0];
  const made=await f.call('alice','games',{mode:'friend',friendCode:friend.friendCode,color:'b',timeControl:'15+10'});
  assert.equal(made.game.color,'b');assert.equal(made.game.timeControl,'15+10');
  const inbox=(await f.call('bob','lobby')).games;assert.equal(inbox[0].id,made.game.id);assert.equal(inbox[0].canJoin,true);
});
