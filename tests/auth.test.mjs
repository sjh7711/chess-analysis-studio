import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { handleGameRequest } from '../online/game-service.mjs';
const PASSWORD='Chess test password 2026!';
function fixture(){
  let time=Date.now();const sqlite=new DatabaseSync(':memory:');
  const dir=new URL('../sites/chess-analysis/drizzle/',import.meta.url);
  for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(file,dir),'utf8'));
  const db={prepare(sql){let params=[];return {bind(...args){params=args;return this;},async first(){return sqlite.prepare(sql).get(...params)||null;},async all(){return {results:sqlite.prepare(sql).all(...params)};},async run(){return sqlite.prepare(sql).run(...params);}};},async batch(statements){sqlite.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  function client(){const cookies=new Map();let ip=crypto.randomUUID();return {cookies,async call(path,body,headers={}){
    const response=await handleGameRequest(new Request('https://chess.test/api/play/'+path,{method:body===undefined?'GET':'POST',headers:{Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),'CF-Connecting-IP':ip,...(body===undefined?{}:{Origin:'https://chess.test','Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)}),db,{now:()=>time});
    const setCookies=response.headers.getSetCookie();for(const c of setCookies){const pair=c.split(';')[0],i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}
    return {status:response.status,cookies:setCookies,...await response.json()};
  },signup(nickname){return this.call('auth/signup',{nickname,password:PASSWORD});},async intent(mode='login'){
    const start=await this.call('auth/chatgpt-start',{mode,returnTo:'/play?room=abc#invite=secret'});assert.equal(start.status,200);
    return new URL(new URL(start.redirect,'https://chess.test').searchParams.get('return_to'),'https://chess.test').searchParams.get('authState');
  }};}
  return {sqlite,client,tick:ms=>time+=ms};
}
test('nickname signup stores a salted hash and a hashed HttpOnly session; survives another request',async()=>{
  const f=fixture(),a=f.client(),b=f.client();const result=await a.signup('체스친구');assert.equal(result.status,201);assert.equal(result.profile.nickname,'체스친구');
  assert.match(result.cookies[0],/__Host-chess-session=.*HttpOnly.*SameSite=Lax.*Secure/);
  const row=f.sqlite.prepare('SELECT * FROM accounts').get();assert.match(row.password_hash,/^scrypt:16384:8:5:/);assert.ok(!row.password_hash.includes(PASSWORD));
  assert.notEqual(f.sqlite.prepare('SELECT token_hash FROM account_sessions').get().token_hash,a.cookies.get('__Host-chess-session'));
  assert.equal((await a.call('me')).profile.friendCode,result.profile.friendCode);assert.equal((await b.call('me')).signedIn,false);
  assert.equal((await b.call('me',undefined,{'oai-authenticated-user-id':row.user_id})).signedIn,false);
});
test('nickname normalization enforces uniqueness, validates characters, rejects short and oversize passwords',async()=>{
  const f=fixture(),a=f.client();assert.equal((await a.signup('Player')).status,201);
  assert.equal((await f.client().signup('ｐｌａｙｅｒ')).status,409);
  assert.equal((await f.client().signup('<script>')).status,400);
  assert.equal((await f.client().call('auth/signup',{nickname:'짧은암호',password:'1234567'})).status,400);
  assert.equal((await f.client().call('auth/signup',{nickname:'긴암호',password:'a'.repeat(129)})).status,400);
});
test('eight-character passwords are accepted for signup and password changes',async()=>{
  const f=fixture(),a=f.client();
  assert.equal((await a.call('auth/signup',{nickname:'여덟글자',password:'Chess123'})).status,201);
  await a.call('auth/logout',{});
  assert.equal((await a.call('auth/login',{nickname:'여덟글자',password:'Chess123'})).status,200);
  assert.equal((await a.call('auth/password',{password:'Chess123',newPassword:'1234567'})).status,400);
  assert.equal((await a.call('auth/password',{password:'Chess123',newPassword:'NewPass8'})).status,200);
  await a.call('auth/logout',{});
  assert.equal((await a.call('auth/login',{nickname:'여덟글자',password:'NewPass8'})).status,200);
});
test('password login rejects wrong credentials and sessions are revoked on logout/expiry',async()=>{
  const f=fixture(),a=f.client(),b=f.client();await a.signup('TestPlayer');
  assert.equal((await b.call('auth/login',{nickname:'testplayer',password:'bad password'})).status,401);
  assert.equal((await b.call('auth/login',{nickname:'TESTPLAYER',password:PASSWORD})).status,200);
  const stolen=b.cookies.get('__Host-chess-session');await b.call('auth/logout',{});b.cookies.set('__Host-chess-session',stolen);
  assert.equal((await b.call('me')).signedIn,false);f.tick(31*86400000);assert.equal((await a.call('me')).signedIn,false);
});
test('auth mutations reject cross-origin requests and excessive login attempts',async()=>{
  const f=fixture(),a=f.client();assert.equal((await a.call('auth/signup',{nickname:'test',password:PASSWORD},{Origin:'https://evil.test'})).status,403);
  await a.signup('ratecheck');for(let i=0;i<11;i++)assert.equal((await a.call('auth/login',{nickname:'ratecheck',password:'wrong'})).status,401);
  assert.equal((await a.call('auth/login',{nickname:'ratecheck',password:PASSWORD})).status,429);
  f.tick(600001);assert.equal((await a.call('auth/login',{nickname:'ratecheck',password:PASSWORD})).status,200);
});
test('link requires password plus browser-bound intent; ChatGPT login accesses the same player',async()=>{
  const f=fixture(),a=f.client(),b=f.client();const profile=(await a.signup('연동계정')).profile;
  const headers={'oai-authenticated-user-id':'chatgpt-alice'};
  assert.equal((await a.call('auth/link',{password:PASSWORD,state:'bad'},headers)).status,403);
  const state=await a.intent('link');assert.equal((await a.call('auth/link',{password:'wrong',state},headers)).status,401);
  assert.equal((await a.call('auth/link',{password:PASSWORD,state},headers)).status,200);
  const loginState=await b.intent();assert.equal((await b.call('auth/chatgpt-login',{state:loginState},headers)).status,200);
  assert.deepEqual((await b.call('me')).profile,profile);
  assert.equal((await b.call('auth/chatgpt-login',{state:loginState},headers)).status,403);
  assert.equal((await b.call('me')).account.linkedChatGPT,true);
});
test('ChatGPT cannot be linked to two accounts and a link intent cannot switch accounts',async()=>{
  const f=fixture(),a=f.client(),b=f.client();await a.signup('연동첫째');await b.signup('연동둘째');const headers={'oai-authenticated-user-id':'chatgpt-shared'};
  const state=await a.intent('link');assert.equal((await a.call('auth/link',{password:PASSWORD,state},headers)).status,200);
  const second=await b.intent('link');assert.equal((await b.call('auth/link',{password:PASSWORD,state:second},headers)).status,409);
  const stranger=f.client();const third=await b.intent('link');stranger.cookies.set('__Host-chess-intent',b.cookies.get('__Host-chess-intent'));
  assert.equal((await stranger.call('auth/link',{password:PASSWORD,state:third},headers)).status,401);
});
test('password changes invalidate old sessions; a recent linked ChatGPT login can recover password',async()=>{
  const f=fixture(),a=f.client(),b=f.client();await a.signup('비번변경');const headers={'oai-authenticated-user-id':'chatgpt-recover'};
  await a.call('auth/link',{password:PASSWORD,state:await a.intent('link')},headers);
  await b.call('auth/chatgpt-login',{state:await b.intent()},headers);
  assert.equal((await a.call('auth/password',{password:'wrong',newPassword:'Replacement password!'})).status,401);
  assert.equal((await b.call('auth/password',{newPassword:'Replacement password!'})).status,200);
  assert.equal((await a.call('me')).signedIn,false);
  assert.equal((await a.call('auth/login',{nickname:'비번변경',password:PASSWORD})).status,401);
  assert.equal((await a.call('auth/login',{nickname:'비번변경',password:'Replacement password!'})).status,200);
});
test('unlink requires password and revokes existing ChatGPT sessions and future ChatGPT login',async()=>{
  const f=fixture(),a=f.client(),b=f.client();await a.signup('해제계정');const headers={'oai-authenticated-user-id':'chatgpt-unlink'};
  await a.call('auth/link',{password:PASSWORD,state:await a.intent('link')},headers);
  await b.call('auth/chatgpt-login',{state:await b.intent()},headers);
  assert.equal((await a.call('auth/unlink',{password:'wrong'})).status,401);
  assert.equal((await a.call('auth/unlink',{password:PASSWORD})).status,200);
  assert.equal((await b.call('me')).signedIn,false);assert.equal((await a.call('me')).account.linkedChatGPT,false);
  assert.equal((await b.call('auth/chatgpt-login',{state:await b.intent()},headers)).status,404);
});
test('a new nickname account can invite another, finish a game, and read the saved PGN',async()=>{
  const f=fixture(),a=f.client(),b=f.client();await a.signup('새로운백');await b.signup('새로운흑');
  const made=await a.call('games',{mode:'invite',color:'w',timeControl:'10'});assert.equal(made.status,201);
  const joined=await b.call(`games/${made.game.id}/join`,{},{'x-invite-token':made.game.inviteToken});assert.equal(joined.status,200);
  const end=await a.call(`games/${made.game.id}/action`,{type:'resign',revision:joined.game.revision});assert.equal(end.status,200);
  assert.match(end.game.pgn,/새로운백/);assert.equal((await b.call('history')).games.length,1);
});
