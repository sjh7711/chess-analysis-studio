import { Chess } from '../node_modules/chess.js/dist/esm/chess.js';
import { getAccountSession, handleAuthRequest, accountView, readBody } from './auth-service.mjs';

const json = (body,status=200) => Response.json(body,{status,headers:{'Cache-Control':'no-store','Vary':'Cookie'}});
const fail = (status,message) => { throw Object.assign(new Error(message),{status}); };
const id = () => crypto.randomUUID().replaceAll('-','');
const profileView = p => p && ({nickname:p.nickname,friendCode:p.friend_code});
const chessAt = state => {const c=new Chess();for(const move of state.moves)c.move(move);return c;};
const names={p:'폰',n:'나이트',b:'비숍',r:'룩',q:'퀸',k:'킹'};
export const TIME_CONTROLS={'10':{minutes:10,increment:0,label:'10분'},'10+5':{minutes:10,increment:5,label:'10+5'},'15+10':{minutes:15,increment:10,label:'15+10'},'20':{minutes:20,increment:0,label:'20분'},'30':{minutes:30,increment:0,label:'30분'},'60':{minutes:60,increment:0,label:'60분'}};
function clockAt(s,time){
  if(!s.clock)return null;
  const clock={...s.clock};
  if(clock.startedAt!==null&&s.result==='*'){
    const side=chessAt(s).turn(),key=side==='w'?'white':'black';clock[key]=Math.max(0,clock[key]-Math.max(0,time-clock.startedAt));
    clock.startedAt=time;
  }
  return clock;
}
async function expireGame(row,db,time){
  if(row.status!=='active')return row;
  const s=JSON.parse(row.state_json),clock=clockAt(s,time);if(!clock)return row;
  const c=chessAt(s),loser=c.turn(),key=loser==='w'?'white':'black';if(clock[key]>0)return row;
  const winner=loser==='w'?'b':'w',canMate=c.board().flat().some(p=>p&&p.color===winner&&p.type!=='k');
  s.clock={...clock,startedAt:null};s.result=canMate?(winner==='w'?'1-0':'0-1'):'1/2-1/2';s.reason=canMate?`${loser==='w'?'백':'흑'} 시간 초과`:'시간 초과 · 상대 체크메이트 기물 부족';
  if(s.request?.kind!=='undo')s.request=null;
  const changed=await db.prepare("UPDATE games SET state_json=?,status='finished',revision=revision+1,updated_at=? WHERE id=? AND revision=? RETURNING *").bind(JSON.stringify(s),time,row.id,row.revision).first();
  return changed||await db.prepare('SELECT * FROM games WHERE id=?').bind(row.id).first();
}
function moveLabel(move) {return `${move.color==='w'?'백':'흑'} ${names[move.piece]} ${move.from} → ${move.to}${move.captured?' · 잡기':''}${move.promotion?' · 승격':''}`;}
function resultOf(c) {
  if(c.isCheckmate())return {result:c.turn()==='w'?'0-1':'1-0',reason:'체크메이트'};
  if(c.isStalemate())return {result:'1/2-1/2',reason:'스테일메이트'};
  if(c.isInsufficientMaterial())return {result:'1/2-1/2',reason:'기물 부족'};
  if(c.isThreefoldRepetition())return {result:'1/2-1/2',reason:'같은 국면 3회 반복'};
  if(c.isDrawByFiftyMoves())return {result:'1/2-1/2',reason:'50수 규칙'};
  return null;
}
function restoreUndo(s,c,recipient,time) {
  const request=s.request,target=request.ply-1,history=c.history({verbose:true});
  if(!Number.isInteger(target)||target<0||target>=history.length)fail(409,'되돌릴 요청 국면을 찾을 수 없습니다.');
  if(s.clock){
    for(const [color,key] of [['w','white'],['b','black']]){
      const restoreTime=(color==='w'?s.whiteUser:s.blackUser)===recipient&&Number.isFinite(request.clock?.[key]);
      // The recipient recovers request-time thinking time; the requester keeps all elapsed time.
      const removed=restoreTime?[history[target]]:history.slice(target);
      const increment=removed.filter(move=>move.color===color).length*s.clock.increment;
      s.clock[key]=Math.max(0,(restoreTime?request.clock[key]:s.clock[key])-increment);
    }
    s.clock.startedAt=time;
  }
  s.moves=s.moves.slice(0,target);s.result='*';s.reason=null;s.lastOffer=null;
  // A requester who has exhausted their own time does not regain it by undoing.
  if(s.clock){
    const requesterColor=s.whiteUser===request.from?'w':'b';
    if(s.clock[requesterColor==='w'?'white':'black']===0){
      const winner=requesterColor==='w'?'b':'w';
      const canMate=chessAt(s).board().flat().some(p=>p&&p.color===winner&&p.type!=='k');
      s.result=canMate?(winner==='w'?'1-0':'0-1'):'1/2-1/2';
      s.reason=canMate?`${requesterColor==='w'?'백':'흑'} 시간 초과`:'시간 초과 · 상대 체크메이트 기물 부족';
    }
  }
  return s.result==='*'?'active':'finished';
}
function pgnFor(s,created) {
  const c=chessAt(s);
  for(const [key,value] of Object.entries({Event:'친구와 1대1 대국',Site:'Chess Review Studio',Date:new Date(created).toISOString().slice(0,10).replaceAll('-','.'),White:s.whiteName,Black:s.blackName,Result:s.result||'*',TimeControl:s.clock?`${s.clock.initial/1000}+${s.clock.increment/1000}`:'-'}))c.setHeader(key,value);
  if(s.reason)c.setHeader('Termination',s.reason);
  return c.pgn();
}
function view(row,user,{invited=false,now=Date.now()}={}) {
  const s=JSON.parse(row.state_json),member=row.owner_user===user||row.guest_user===user;
  const color=member?(s.whiteUser===user?'w':'b'):null;
  if(!member)return {id:row.id,status:row.status,host:s.hostName,timeControl:s.timeControl,invited,canJoin:row.status==='waiting'&&(invited||row.target_user===user),createdAt:row.created_at};
  const c=chessAt(s),history=c.history({verbose:true});
  return {id:row.id,status:row.status,revision:row.revision,mode:s.mode,color,host:s.hostName,white:s.whiteName,black:s.blackName,timeControl:s.timeControl,clock:clockAt(s,now),serverNow:now,fen:c.fen(),turn:c.turn(),check:c.isCheck(),moves:s.moves,history:history.map(m=>({san:m.san,label:moveLabel(m),from:m.from,to:m.to,color:m.color})),result:s.result,reason:s.reason,request:s.request?{...s.request,from:undefined,clock:undefined,mine:s.request.from===user}:null,createdAt:row.created_at,updatedAt:row.updated_at,inviteToken:row.status==='waiting'&&row.owner_user===user&&s.mode==='invite'?s.inviteToken:undefined,pgn:row.status==='finished'?pgnFor(s,row.created_at):undefined};
}
export async function handleGameRequest(request,db,{now=Date.now,undoRetries=2}={}) {
  try {
    const url=new URL(request.url),path=url.pathname.replace(/^\/api\/play\/?/,'').split('/').filter(Boolean),method=request.method;
    if(method!=='GET'){
      if(request.headers.get('origin')!==url.origin||request.headers.get('sec-fetch-site')==='cross-site')fail(403,'이 사이트에서 요청해 주세요.');
      if(!request.headers.get('content-type')?.startsWith('application/json'))fail(415,'JSON 요청이 필요합니다.');
    }
    const retryRequest=method==='POST'&&path[2]==='action'&&undoRetries>0?request.clone():null;
    const body=method==='GET'?{}:await readBody(request);
    if(path[0]==='auth'&&path.length===2)return await handleAuthRequest(request,db,path[1],body,now());
    const account=await getAccountSession(request,db,now()),user=account?.user_id;
    if(!user){if(method==='GET'&&path[0]==='me')return json({signedIn:false});if(method==='GET'&&path[0]==='invitations')return json({invitations:[],recentInvitations:[],accountKey:null});fail(401,'로그인한 뒤 이용해 주세요.');}
    const profile=await db.prepare('SELECT * FROM players WHERE user_id = ?').bind(user).first();
    if(path[0]==='me'){
      if(method==='GET')return json({signedIn:true,profile:profileView(profile),account:accountView(account,now()),chatgptAvailable:!!request.headers.get('oai-authenticated-user-id'),chatgptLabel:request.headers.get('oai-authenticated-user-email')||'현재 로그인한 ChatGPT 계정'});
      fail(405,'닉네임은 로그인 ID로 사용됩니다.');
    }
    if(path[0]==='invitations'&&path.length===1&&method==='GET'){
      if(!profile)return json({invitations:[],recentInvitations:[],accountKey:null});
      const rows=await db.prepare("SELECT * FROM games WHERE target_user=? AND status='waiting' ORDER BY created_at DESC,id DESC").bind(user).all();
      const recent=await db.prepare('SELECT * FROM games WHERE target_user=? ORDER BY created_at DESC,id DESC LIMIT 30').bind(user).all();
      const recentInvitations=recent.results.map(row=>{
        const state=JSON.parse(row.state_json);
        return {id:row.id,host:state.hostName,timeControl:state.timeControl,createdAt:row.created_at,status:row.status==='cancelled'?(state.reason==='대국 요청 거절'?'declined':'cancelled'):row.status};
      });
      return json({invitations:rows.results.map(row=>view(row,user)),recentInvitations,accountKey:profile.friend_code});
    }
    if(!profile)fail(428,'먼저 대국에 사용할 닉네임을 정해 주세요.');
    const friendsList=async()=>{
      const rows=await db.prepare('SELECT p.nickname,p.friend_code,f.created_at FROM friends f JOIN players p ON p.user_id=f.friend_user WHERE f.owner_user=? ORDER BY f.created_at DESC,p.friend_code').bind(user).all();
      return rows.results.map(p=>({nickname:p.nickname,friendCode:p.friend_code,addedAt:p.created_at}));
    };
    if(path[0]==='friends'){
      if(method==='GET'&&path.length===1)return json({friends:await friendsList()});
      if(method!=='POST'||(path.length>1&&path[1]!=='remove'))fail(405,'지원하지 않는 요청입니다.');
      const code=String(body.friendCode||'').replaceAll('-','').replaceAll(' ','').toUpperCase();
      if(path[1]==='remove'){
        await db.prepare('DELETE FROM friends WHERE owner_user=? AND friend_user=(SELECT user_id FROM players WHERE friend_code=?)').bind(user,code).run();
      }else{
        const target=await db.prepare('SELECT p.* FROM players p JOIN accounts a ON a.user_id=p.user_id WHERE p.friend_code=?').bind(code).first();
        if(!target)fail(404,'친구 코드를 찾을 수 없습니다. 상대의 코드를 확인해 주세요.');
        if(target.user_id===user)fail(400,'자신을 친구 목록에 추가할 수 없습니다.');
        await db.prepare('INSERT INTO friends (owner_user,friend_user,created_at) VALUES (?,?,?) ON CONFLICT(owner_user,friend_user) DO NOTHING').bind(user,target.user_id,now()).run();
      }
      return json({friends:await friendsList()});
    }
    const historyPage=async()=>{
      const cursor=url.searchParams.get('cursor')||'',match=/^(\d+):([a-f0-9]{32})$/.exec(cursor);if(cursor&&!match)fail(400,'기록 페이지를 확인해 주세요.');
      const before=match?Number(match[1]):Number.MAX_SAFE_INTEGER,beforeId=match?.[2]||'ffffffffffffffffffffffffffffffff';
      const rows=await db.prepare("SELECT * FROM games WHERE (owner_user=? OR guest_user=?) AND status='finished' AND (updated_at<? OR (updated_at=? AND id<?)) ORDER BY updated_at DESC,id DESC LIMIT 21").bind(user,user,before,before,beforeId).all();
      const page=rows.results.slice(0,20),last=page.at(-1);return {games:page.map(r=>view(r,user,{now:now()})),nextCursor:rows.results.length>20?`${last.updated_at}:${last.id}`:null};
    };
    if(path[0]==='history'&&method==='GET')return json(await historyPage());
    if(path[0]==='lobby'&&method==='GET'){
      const rows=await db.prepare("SELECT * FROM games WHERE (owner_user=? OR guest_user=? OR target_user=?) AND status IN ('waiting','active') ORDER BY updated_at DESC LIMIT 80").bind(user,user,user).all();
      const games=[];for(const r of rows.results){const current=await expireGame(r,db,now());if(current.status!=='finished')games.push(view(current,user,{now:now()}));}
      const history=await historyPage();return json({profile:profileView(profile),friends:await friendsList(),games:[...games,...history.games],nextCursor:history.nextCursor});
    }
    if(path[0]==='games'&&path.length===1&&method==='POST'){
      if(!['invite','friend'].includes(body.mode)||!['w','b','random'].includes(body.color))fail(400,'대국 설정을 확인해 주세요.');
      const control=TIME_CONTROLS[body.timeControl||'10'];if(!control)fail(400,'지원하는 대국 시간을 선택해 주세요.');
      const recent=await db.prepare('SELECT COUNT(*) AS count FROM games WHERE owner_user=? AND created_at>?').bind(user,now()-60000).first();
      if(recent.count>=5)fail(429,'잠시 후 다시 요청해 주세요.');
      const open=await db.prepare("SELECT COUNT(*) AS count FROM games WHERE owner_user=? AND status='waiting'").bind(user).first();
      if(open.count>=5)fail(409,'기다리는 초대가 5개 있습니다. 기존 초대를 취소하거나 이용해 주세요.');
      let target=null;
      if(body.mode==='friend'){
        const code=String(body.friendCode||'').replaceAll('-','').replaceAll(' ','').toUpperCase();
        target=await db.prepare('SELECT p.* FROM players p JOIN accounts a ON a.user_id=p.user_id WHERE p.friend_code=?').bind(code).first();
        if(!target)fail(404,'친구 코드를 찾을 수 없습니다. 상대가 닉네임을 등록했는지 확인해 주세요.');
        if(target.user_id===user)fail(400,'자신에게 대국을 요청할 수 없습니다.');
        const duplicate=await db.prepare("SELECT id FROM games WHERE status='waiting' AND ((owner_user=? AND target_user=?) OR (owner_user=? AND target_user=?))").bind(user,target.user_id,target.user_id,user).first();
        if(duplicate)fail(409,'이 친구와 기다리는 대국 요청이 이미 있습니다.');
      }
      const gameId=id(),white=body.color==='random'?(crypto.getRandomValues(new Uint8Array(1))[0]%2===0):body.color==='w',created=now();
      const s={mode:body.mode,hostName:profile.nickname,whiteUser:white?user:null,blackUser:white?null:user,whiteName:white?profile.nickname:(target?.nickname||'참가 대기'),blackName:white?(target?.nickname||'참가 대기'):profile.nickname,moves:[],result:'*',reason:null,request:null,inviteToken:id()+id(),timeControl:body.timeControl||'10',clock:{initial:control.minutes*60000,increment:control.increment*1000,white:control.minutes*60000,black:control.minutes*60000,startedAt:null}};
      await db.prepare('INSERT INTO games (id,owner_user,guest_user,target_user,status,revision,state_json,created_at,updated_at) VALUES (?,?,NULL,?,?,0,?,?,?)').bind(gameId,user,target?.user_id||null,'waiting',JSON.stringify(s),created,created).run();
      return json({game:view({id:gameId,owner_user:user,guest_user:null,status:'waiting',revision:0,state_json:JSON.stringify(s),created_at:created,updated_at:created},user)},201);
    }
    if(path[0]!=='games'||!/^[a-f0-9]{32}$/.test(path[1]||''))fail(404,'대국을 찾을 수 없습니다.');
    let row=await db.prepare('SELECT * FROM games WHERE id=?').bind(path[1]).first();
    if(!row)fail(404,'대국을 찾을 수 없습니다.');
    let s=JSON.parse(row.state_json);const member=row.owner_user===user||row.guest_user===user;
    const invited=s.mode==='invite'&&request.headers.get('x-invite-token')===s.inviteToken;
    if(!member&&row.target_user!==user&&!invited)fail(404,'참가 권한이 없거나 초대 링크가 올바르지 않습니다.');
    if(member){row=await expireGame(row,db,now());s=JSON.parse(row.state_json);}
    if(method==='GET')return json({game:view(row,user,{invited,now:now()})});
    if(method!=='POST')fail(405,'지원하지 않는 요청입니다.');
    let status=row.status,guest=row.guest_user,undoResponse=false;
    if(path[2]==='join'){
      if(row.status!=='waiting'||member)fail(409,'이미 참가했거나 시작된 대국입니다.');
      guest=user;
      if(!s.whiteUser){s.whiteUser=user;s.whiteName=profile.nickname;}else{s.blackUser=user;s.blackName=profile.nickname;}
      status='active';
      if(s.clock)s.clock.startedAt=now();
    }else if(path[2]==='decline'){
      if(row.status!=='waiting'||row.target_user!==user)fail(409,'거절할 수 없는 요청입니다.');
      status='cancelled';s.reason='대국 요청 거절';
    }else if(path[2]==='cancel'){
      if(row.status!=='waiting'||row.owner_user!==user)fail(409,'취소할 수 없는 초대입니다.');
      status='cancelled';s.reason='초대 취소';
    }else if(path[2]==='action'){
      if(!member)fail(403,'대국 참가자만 조작할 수 있습니다.');
      undoResponse=body.type==='respond'&&s.request?.kind==='undo'&&s.request.id===body.requestId;
      const undoWithdrawal=body.type==='withdraw'&&s.request?.kind==='undo'&&s.request.from===user;
      if(row.status!=='active'&&!(row.status==='finished'&&(undoResponse||undoWithdrawal)))fail(409,'진행 중인 대국이 아닙니다.');
      if(body.revision!==row.revision&&!undoResponse)fail(409,'대국이 변경되었습니다. 최신 상태를 확인한 뒤 다시 시도해 주세요.');
      const color=s.whiteUser===user?'w':'b',c=chessAt(s);
      s.clock=clockAt(s,now());
      if(body.type==='move'){
        if(c.turn()!==color)fail(409,'상대방의 차례입니다.');
        if(typeof body.uci!=='string'||!/^([a-h][1-8]){2}[qrbn]?$/.test(body.uci))fail(400,'올바르지 않은 이동입니다.');
        try{c.move(body.uci);}catch{fail(400,'그 위치로 이동할 수 없습니다.');}
        s.moves.push(body.uci);if(s.request?.kind!=='undo')s.request=null;
        if(s.clock)s.clock[color==='w'?'white':'black']+=s.clock.increment;
        const end=resultOf(c);if(end){Object.assign(s,end);status='finished';}
      }else if(body.type==='resign'){
        s.result=color==='w'?'0-1':'1-0';s.reason=`${color==='w'?'백':'흑'} 기권`;if(s.request?.kind!=='undo')s.request=null;status='finished';
      }else if(body.type==='offer'){
        if(!['draw','undo'].includes(body.kind))fail(400,'잘못된 요청입니다.');
        if(s.request)fail(409,'응답을 기다리는 요청이 있습니다.');
        if(body.kind==='undo'&&!s.moves.length)fail(409,'되돌릴 수가 없습니다.');
        if(s.lastOffer?.from===user&&s.lastOffer.ply===s.moves.length)fail(409,'이 국면에서는 이미 요청했습니다. 다음 이동 후 다시 요청해 주세요.');
        const last=c.history({verbose:true}).at(-1);
        s.request={id:id(),kind:body.kind,from:user,ply:s.moves.length,label:body.kind==='undo'?moveLabel(last):'무승부',createdAt:now(),...(body.kind==='undo'&&s.clock?{clock:{...s.clock}}:{})};
        s.lastOffer={from:user,ply:s.moves.length};
      }else if(body.type==='respond'){
        if(!s.request||s.request.id!==body.requestId||s.request.from===user)fail(409,'응답할 요청이 없습니다.');
        if(typeof body.accept!=='boolean')fail(400,'수락 여부가 필요합니다.');
        if(body.accept){
          if(s.request.kind==='draw'){s.result='1/2-1/2';s.reason='무승부 합의';status='finished';}
          else status=restoreUndo(s,c,user,now());
        }
        s.request=null;
      }else if(body.type==='withdraw'){
        if(!s.request||s.request.from!==user)fail(409,'취소할 요청이 없습니다.');s.request=null;
      }else fail(400,'지원하지 않는 대국 동작입니다.');
    }else fail(404,'요청을 찾을 수 없습니다.');
    const changed=now();
    if(status==='finished'&&s.clock)s.clock.startedAt=null;
    const updated=await db.prepare('UPDATE games SET guest_user=?,status=?,state_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? RETURNING *').bind(guest,status,JSON.stringify(s),changed,row.id,row.revision).first();
    if(!updated){
      // Re-read a still-pending undo if a move won the compare-and-swap race.
      if(undoResponse&&retryRequest)return handleGameRequest(retryRequest,db,{now,undoRetries:undoRetries-1});
      fail(409,'상대방의 요청이 먼저 반영되었습니다. 최신 상태에서 다시 시도해 주세요.');
    }
    return json({game:view(updated,user,{now:now()})});
  }catch(error){if(error.status)return json({error:error.message},error.status);console.error('Online chess request failed',error);return json({error:'대국 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'},500);}
}
