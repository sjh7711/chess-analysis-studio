import { scrypt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

const DAY=86400000, WINDOW=600000;
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const token=()=>randomBytes(32).toString('hex');
export const tokenHash=value=>createHash('sha256').update(value).digest('hex');
const secure=request=>new URL(request.url).protocol==='https:';
const cookieName=(request,kind='session')=>(secure(request)?'__Host-':'')+'chess-'+kind;
function cookie(request,kind,value,age){return `${cookieName(request,kind)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure(request)?'; Secure':''}`;}
function cookieValue(request,kind='session'){
  const key=cookieName(request,kind)+'=';
  return (request.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(key))?.slice(key.length)||'';
}
const json=(body,status=200,cookies=[])=>{
  const headers=new Headers({'Cache-Control':'no-store','Vary':'Cookie','Content-Type':'application/json','X-Content-Type-Options':'nosniff'});
  for(const value of cookies)headers.append('Set-Cookie',value);
  return new Response(JSON.stringify(body),{status,headers});
};
export function normalizedNickname(value){
  if(typeof value!=='string')fail(400,'닉네임을 입력해 주세요.');
  const nickname=value.normalize('NFKC').trim();
  if(!/^[\p{L}\p{N}_-]{2,20}$/u.test(nickname))fail(400,'닉네임은 한글·영문·숫자·밑줄·하이픈으로 2~20자 입력해 주세요.');
  return {nickname,key:nickname.toLowerCase()};
}
function validPassword(value){
  if(typeof value!=='string'||[...value].length<8||[...value].length>128)fail(400,'비밀번호는 8~128자로 입력해 주세요.');
  return value;
}
// OWASP's 16 MiB scrypt configuration keeps each hash inside the Worker budget.
function derive(password,salt){return new Promise((resolve,reject)=>scrypt(password,salt,32,{N:16384,r:8,p:5,maxmem:32*1024*1024},(error,key)=>error?reject(error):resolve(key)));}
export async function passwordHash(password){
  validPassword(password);const salt=randomBytes(16).toString('hex');
  return `scrypt:16384:8:5:${salt}:${(await derive(password,salt)).toString('hex')}`;
}
async function verifyPassword(password,encoded){
  const match=/^scrypt:16384:8:5:([a-f0-9]{32}):([a-f0-9]{64})$/.exec(encoded||'');
  if(typeof password!=='string'||password.length>256)return false;
  const actual=await derive(password,match?.[1]||'00000000000000000000000000000000');
  const expected=Buffer.from(match?.[2]||'0'.repeat(64),'hex');
  return timingSafeEqual(actual,expected)&&!!match;
}
export async function readBody(request){
  const reader=request.body?.getReader();if(!reader)fail(400,'요청 내용을 확인해 주세요.');
  const chunks=[];let length=0;
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>4096){await reader.cancel();fail(413,'요청이 너무 큽니다.');}chunks.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{fail(400,'요청 형식을 확인해 주세요.');}
  if(!body||Array.isArray(body)||typeof body!=='object')fail(400,'요청 형식을 확인해 주세요.');return body;
}
async function quota(db,key,limit,now){
  const row=await db.prepare('INSERT INTO auth_limits (key,started_at,count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN started_at<=? THEN 1 ELSE count+1 END,started_at=CASE WHEN started_at<=? THEN excluded.started_at ELSE started_at END RETURNING count').bind(tokenHash(key),now,now-WINDOW,now-WINDOW).first();
  if(row.count>limit)fail(429,'시도가 너무 많습니다. 10분 뒤 다시 시도해 주세요.');
}
async function limitRequest(request,db,action,key,now){
  // CF-Connecting-IP is supplied by the hosting proxy, never X-Forwarded-For.
  const address=request.headers.get('cf-connecting-ip')||'unknown';
  await quota(db,`ip:${address}`,100,now);
  if(action==='signup')await quota(db,`signup:${address}`,10,now);
  if(key)await quota(db,`account:${key}`,12,now);
}
export async function getAccountSession(request,db,now=Date.now()){
  const value=cookieValue(request);if(!/^[a-f0-9]{64}$/.test(value))return null;
  return db.prepare('SELECT a.*,s.token_hash,s.created_at AS session_created,s.method AS session_method FROM account_sessions s JOIN accounts a ON a.user_id=s.user_id AND a.version=s.version WHERE s.token_hash=? AND s.expires_at>?').bind(tokenHash(value),now).first();
}
export const accountView=(account,now=Date.now())=>({linkedChatGPT:!!account?.chatgpt_id,canResetPassword:account?.session_method==='chatgpt'&&now-account.session_created<WINDOW});
async function profileFor(db,user){const p=await db.prepare('SELECT * FROM players WHERE user_id=?').bind(user).first();return p&&{nickname:p.nickname,friendCode:p.friend_code};}
async function newSession(request,db,account,method,now){
  const value=token();
  const made=await db.prepare('INSERT INTO account_sessions (token_hash,user_id,version,method,created_at,expires_at) SELECT ?,user_id,version,?,?,? FROM accounts WHERE user_id=? AND version=? RETURNING token_hash').bind(tokenHash(value),method,now,now+30*DAY,account.user_id,account.version).first();
  if(!made)fail(409,'계정이 변경되었습니다. 다시 로그인해 주세요.');
  const old=cookieValue(request);if(old)await db.prepare('DELETE FROM account_sessions WHERE token_hash=?').bind(tokenHash(old)).run();
  await db.batch([
    db.prepare('DELETE FROM account_sessions WHERE expires_at<?').bind(now),
    db.prepare('DELETE FROM auth_intents WHERE expires_at<?').bind(now),
    db.prepare('DELETE FROM auth_limits WHERE started_at<?').bind(now-DAY),
  ]);
  return cookie(request,'session',value,30*86400);
}
async function signInResponse(request,db,account,method,now,status=200){
  const session=await newSession(request,db,account,method,now);
  return json({signedIn:true,profile:await profileFor(db,account.user_id),account:{linkedChatGPT:!!account.chatgpt_id,canResetPassword:method==='chatgpt'}},status,[session,cookie(request,'intent','',0)]);
}
function safeReturn(value){
  if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||value.includes('\\'))return '/play';
  const url=new URL(value,'https://chess.invalid');
  if(!['/','/play'].includes(url.pathname))return '/play';
  return url.pathname+url.search+url.hash;
}
async function consumeIntent(request,db,body,mode,user,now){
  const value=cookieValue(request,'intent');
  if(!/^[a-f0-9]{64}$/.test(value)||body.state!==value)fail(403,'인증 요청이 만료되었습니다. ChatGPT 인증을 다시 시작해 주세요.');
  const intent=await db.prepare('DELETE FROM auth_intents WHERE token_hash=? AND mode=? AND expires_at>? RETURNING *').bind(tokenHash(value),mode,now).first();
  if(!intent||intent.user_id!==(user||null))fail(403,'인증 요청이 일치하지 않습니다. 다시 시작해 주세요.');
}
export async function handleAuthRequest(request,db,action,body,now){
  if(request.method!=='POST')fail(405,'지원하지 않는 요청입니다.');
  const account=await getAccountSession(request,db,now);
  const chatgpt=request.headers.get('oai-authenticated-user-id');
  if(action==='logout'){
    if(account)await db.prepare('DELETE FROM account_sessions WHERE token_hash=?').bind(account.token_hash).run();
    return json({signedIn:false},200,[cookie(request,'session','',0),cookie(request,'intent','',0)]);
  }
  if(action==='signup'||action==='login'){
    const {nickname,key}=normalizedNickname(body.nickname);
    await limitRequest(request,db,action,key,now);
    if(action==='signup'){
      const hash=await passwordHash(body.password),user='local_'+crypto.randomUUID().replaceAll('-','');
      try{await db.batch([
        db.prepare('INSERT INTO accounts (user_id,nickname_key,password_hash,created_at) VALUES (?,?,?,?)').bind(user,key,hash,now),
        db.prepare('INSERT INTO players (user_id,nickname,friend_code,created_at) VALUES (?,?,?,?)').bind(user,nickname,randomBytes(6).toString('hex').toUpperCase(),now),
      ]);}catch(error){if(String(error.message).includes('UNIQUE'))fail(409,'이미 사용 중인 닉네임입니다. 다른 닉네임을 골라 주세요.');throw error;}
      return signInResponse(request,db,{user_id:user,version:1},'password',now,201);
    }
    const found=await db.prepare('SELECT * FROM accounts WHERE nickname_key=?').bind(key).first();
    if(!await verifyPassword(body.password,found?.password_hash))fail(401,'닉네임 또는 비밀번호가 올바르지 않습니다.');
    return signInResponse(request,db,found,'password',now);
  }
  if(action==='chatgpt-start'){
    await limitRequest(request,db,action,null,now);
    const mode=body.mode==='link'?'link':'login';
    if(mode==='link'&&!account)fail(401,'닉네임으로 먼저 로그인해 주세요.');
    const value=token();
    await db.prepare('INSERT INTO auth_intents (token_hash,mode,user_id,expires_at) VALUES (?,?,?,?)').bind(tokenHash(value),mode,mode==='link'?account.user_id:null,now+WINDOW).run();
    const target=new URL(safeReturn(body.returnTo),new URL(request.url).origin);
    target.searchParams.set('auth',mode==='link'?'link':'chatgpt');target.searchParams.set('authState',value);
    const returnTo=target.pathname+target.search+target.hash;
    return json({redirect:'/signin-with-chatgpt?return_to='+encodeURIComponent(returnTo)},200,[cookie(request,'intent',value,600)]);
  }
  if(action==='chatgpt-login'){
    await limitRequest(request,db,action,null,now);
    if(!chatgpt)fail(401,'ChatGPT 인증을 완료해 주세요.');
    await consumeIntent(request,db,body,'login',null,now);
    const found=await db.prepare('SELECT * FROM accounts WHERE chatgpt_id=?').bind(chatgpt).first();
    if(!found)fail(404,'연동된 계정이 없습니다. 닉네임으로 가입·로그인한 뒤 계정 설정에서 ChatGPT를 연동해 주세요.');
    return signInResponse(request,db,found,'chatgpt',now);
  }
  if(!account)fail(401,'로그인한 뒤 이용해 주세요.');
  await limitRequest(request,db,action,account.nickname_key,now);
  if(action==='link'){
    if(!chatgpt)fail(401,'ChatGPT 인증을 먼저 완료해 주세요.');
    if(!await verifyPassword(body.password,account.password_hash))fail(401,'현재 비밀번호가 올바르지 않습니다.');
    await consumeIntent(request,db,body,'link',account.user_id,now);
    if(account.chatgpt_id&&account.chatgpt_id!==chatgpt)fail(409,'다른 ChatGPT 계정이 연결되어 있습니다. 먼저 연동을 해제해 주세요.');
    try{
      const linked=await db.prepare('UPDATE accounts SET chatgpt_id=? WHERE user_id=? AND version=? AND (chatgpt_id IS NULL OR chatgpt_id=?) RETURNING user_id').bind(chatgpt,account.user_id,account.version,chatgpt).first();
      if(!linked)fail(409,'계정 상태가 변경되었습니다. 다시 시도해 주세요.');
    }catch(error){if(String(error.message).includes('UNIQUE'))fail(409,'이 ChatGPT 계정은 이미 다른 닉네임과 연동되어 있습니다.');throw error;}
    return json({linkedChatGPT:true},200,[cookie(request,'intent','',0)]);
  }
  if(action==='unlink'||action==='password'){
    const recentChatGPT=action==='password'&&account.session_method==='chatgpt'&&now-account.session_created<WINDOW;
    if(!recentChatGPT&&!await verifyPassword(body.password,account.password_hash))fail(401,'현재 비밀번호가 올바르지 않습니다.');
    let updated;
    if(action==='password'){
      const hash=await passwordHash(body.newPassword);
      updated=await db.prepare('UPDATE accounts SET password_hash=?,version=version+1 WHERE user_id=? AND version=? RETURNING *').bind(hash,account.user_id,account.version).first();
    }else updated=await db.prepare('UPDATE accounts SET chatgpt_id=NULL,version=version+1 WHERE user_id=? AND version=? RETURNING *').bind(account.user_id,account.version).first();
    if(!updated)fail(409,'계정이 변경되었습니다. 다시 로그인해 주세요.');
    await db.prepare('DELETE FROM account_sessions WHERE user_id=?').bind(account.user_id).run();
    return signInResponse(request,db,updated,'password',now);
  }
  fail(404,'요청을 찾을 수 없습니다.');
}
