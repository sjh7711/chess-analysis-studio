import { Chess } from '../src/chess-core.js';
import { pieceSvg, pieceSnapshot, pieceTransitions, capturedPieces, capturedMarkup } from '../src/pieces.js';
import { BoardAnnotations } from '../src/annotations.js';
import { materialBalance } from '../src/study.js';
import { MoveSounds, hasNewConfirmedMove } from '../src/move-sounds.js';
import { mountAccount } from './account.js';
import '../src/piece-settings.js';

const $=id=>document.getElementById(id), esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const noticeHome=document.createComment('notice lobby position');$('notice').before(noticeHome);
const roomDialogHomes=['action-dialog','promotion-dialog','game-result-dialog'].map(id=>{const node=$(id),home=document.createComment(id+' default position');node.before(home);node.addEventListener('close',syncActionLayers);return{node,home};});
const names={p:'폰',n:'나이트',b:'비숍',r:'룩',q:'퀸',k:'킹'};
const moveSounds=new MoveSounds({button:$('move-sound')});
let me,game,roomId=new URL(location.href).searchParams.get('room'),inviteToken=new URLSearchParams(location.hash.slice(1)).get('invite')||'',selected=null,pending=null,promoting=null,sending=false,flipped=false,pollTimer,refreshBusy=false,rendered=null,boardKey='',drag=null,suppressClick=0,dialogAction=null;
let mode='confirm';try{mode=localStorage.getItem('chessreview.move-mode')||'confirm';}catch{}
let clockReceived=performance.now();
let olderGames=[],historyCursor=null,latestGames=[],renderedFriends='';
let reviewPly=null;
const presentedResults=new Set();
const annotations=new BoardAnnotations($('online-board'),{isFlipped:()=>flipped,toggleButton:$('annotation-mode'),clearButton:$('annotation-clear')});
const timeLabel=value=>value?.includes('+')?value:(value?value+'분':'시간 제한 없음');
if(!['direct','confirm'].includes(mode))mode='confirm';
if(roomId&&inviteToken)try{sessionStorage.setItem('chessreview.invite.'+roomId,inviteToken);}catch{}
if(roomId&&!inviteToken)try{inviteToken=sessionStorage.getItem('chessreview.invite.'+roomId)||'';}catch{}
const chessFor=g=>{const c=new Chess();for(const uci of g?.moves||[])c.move(uci);return c;};
const displayedChess=()=>chessFor({...game,moves:game.moves.slice(0,reviewPly??game.moves.length)});
function syncNoticePlacement(){
  const element=$('notice'),inGame=!$('room').hidden&&!$('game-area').hidden;
  if(inGame){if(element.parentElement!==$('room-overlays'))$('room-overlays').prepend(element);}
  else{if(element.previousSibling!==noticeHome)noticeHome.after(element);element.inert=false;element.classList.remove('covered-alert');}
  for(const {node,home} of roomDialogHomes){if(inGame){if(node.parentElement!==$('room-overlays'))$('room-overlays').append(node);}else{if(node.previousSibling!==home){node.close();home.after(node);}node.inert=false;node.classList.remove('covered-alert');}}
  window.dispatchEvent(new Event('room-alert-placement'));
  syncActionLayers();
}
function syncActionLayers(){
  const tray=$('room-overlays'),isVisible=node=>node&&node.parentElement===tray&&(node.tagName==='DIALOG'?node.open:!node.hidden);
  const order=[$('promotion-dialog'),$('action-dialog'),$('notice').classList.contains('error')?$('notice'):null,$('request-panel'),$('invitation-tray'),$('game-result-dialog'),$('notice')];
  const front=order.find(isVisible);
  for(const node of tray.children){const covered=isVisible(node)&&node!==front;node.classList.toggle('covered-alert',covered);node.inert=covered;}
  $('pending-panel').inert=false;
}
window.addEventListener('invitation-tray-changed',syncActionLayers);
function showRoomDialog(id){syncNoticePlacement();const dialog=$(id);if(!dialog.open){if(dialog.parentElement===$('room-overlays'))dialog.show();else dialog.showModal();}syncActionLayers();}
function revealActionSlot(){
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    const content=document.querySelector('.room-sidebar-content'),slot=$('move-action-slot');
    if($('room').hidden||$('game-area').hidden||content.scrollHeight<=content.clientHeight)return;
    const bounds=content.getBoundingClientRect(),target=slot.getBoundingClientRect();
    if(target.top<bounds.top)content.scrollTop-=bounds.top-target.top;
    else if(target.bottom>bounds.bottom)content.scrollTop+=target.bottom-bounds.bottom;
  }));
}
function notice(text,error=false){$('notice-text').textContent=text;$('notice').classList.toggle('error',error);$('notice').hidden=!text;syncNoticePlacement();}
$('notice-dismiss').onclick=()=>notice('');
async function api(path,body){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch('/api/play/'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(inviteToken?{'X-Invite-Token':inviteToken}:{})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal:controller.signal});
    const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'요청에 실패했습니다.'),{status:response.status});return data;
  }catch(error){if(error.name==='AbortError')throw new Error('응답이 늦어지고 있습니다. 연결을 확인해 주세요.');throw error;}finally{clearTimeout(timer);}
}
const accountUI=mountAccount({api,onSignedIn:applyAccount,onSignedOut:resetAccount});
function resetAccount(){
  clearTimeout(pollTimer);cleanupDrag();me=null;game=null;pending=null;selected=null;rendered=null;boardKey='';olderGames=[];latestGames=[];renderedFriends='';
  $('room').hidden=true;$('lobby').hidden=true;$('login-panel').hidden=false;$('account-label').textContent='';$('online-board').replaceChildren();$('online-history').replaceChildren();
  scheduleGameLayout();
  for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();accountUI.update(null);
}
async function applyAccount(data){
  if(!data.signedIn){resetAccount();return;}
  me=data.profile;accountUI.update(data);$('login-panel').hidden=true;
  $('account-label').textContent=me.nickname;$('my-name').textContent=me.nickname;$('my-code').textContent=me.friendCode;await refresh();
}
async function initialize(){try{await applyAccount(await api('me'));}catch(error){notice(error.message,true);}}
async function refresh(){
  if(!me||refreshBusy)return;refreshBusy=true;clearTimeout(pollTimer);
  const target=roomId,accountCode=me.friendCode;
  try{
    if(target){const data=await api('games/'+target);if(roomId===target&&me?.friendCode===accountCode)acceptState(data.game);}
    else {const data=await api('lobby');if(!roomId&&me?.friendCode===accountCode){if(!olderGames.length)historyCursor=data.nextCursor;latestGames=data.games;renderFriends(data.friends);renderLobby(data.games);}}
    $('connection-status').textContent='연결됨 · 자동 저장';$('connection-status').classList.remove('offline');
  }catch(error){$('connection-status').textContent='연결 확인 중…';$('connection-status').classList.add('offline');if(error.status===401){resetAccount();notice('로그인이 만료되었습니다. 다시 로그인해 주세요.',true);}else if(error.status===404||error.status===428)notice(error.message,true);}
  finally{refreshBusy=false;pollTimer=setTimeout(refresh,document.hidden?12000:roomId?1500:5000);}
}
function acceptState(next){
  if(game?.id===next.id&&next.revision!==undefined&&game.revision>next.revision)return;
  const moved=hasNewConfirmedMove(game,next);
  const changed=game?.id!==next.id||game?.revision!==next.revision||game?.status!==next.status;
  clockReceived=performance.now();
  if(!changed){game.clock=next.clock;game.serverNow=next.serverNow;renderClocks();return;}
  if(game?.id===next.id&&(next.moves.length<game.moves.length||game.status==='finished'&&next.status==='active')){
    reviewPly=null;rendered=null;$('game-result-dialog').close();presentedResults.delete(next.id);
    olderGames=olderGames.filter(saved=>saved.id!==next.id);
    notice(next.status==='active'?'무르기를 수락해 요청 당시의 한 수 전으로 돌아갔습니다.':'요청한 수를 되돌렸습니다. 사용한 시간이 모두 소진되어 대국은 종료 상태입니다.');
  }
  if(game?.id!==next.id||(!game?.color&&next.color)){rendered=null;reviewPly=null;flipped=next.color==='b';}
  if(reviewPly!==null&&reviewPly>=next.moves.length)reviewPly=null;
  const positionChanged=game?.id!==next.id||game?.status!==next.status||JSON.stringify(game?.moves)!==JSON.stringify(next.moves);
  if(positionChanged){if(pending||promoting){pending=null;promoting=null;$('promotion-dialog').close();notice('대국 상태가 변경되어 이동 선택을 취소했습니다.');}cleanupDrag();selected=null;}
  else{if(pending)pending.revision=next.revision;if(promoting)promoting.revision=next.revision;}
  game=next;
  if(next.status==='finished'){
    dialogAction=null;$('action-dialog').close();
    if(!presentedResults.has(next.id))reviewPly=null;
  }
  renderRoom();
  if(moved)void moveSounds.play(chessFor(next).history({verbose:true}).at(-1));
  if(next.status==='finished'&&next.color&&!presentedResults.has(next.id))showGameResult();
}
function resultLabel(){return game.result==='1/2-1/2'?'무승부':game.result==='1-0'?'백 승리':'흑 승리';}
function showGameResult(){
  if(game?.status!=='finished'||!game.color)return;
  const draw=game.result==='1/2-1/2',winner=draw?null:game.result==='1-0'?'w':'b',won=winner===game.color;
  const dialog=$('game-result-dialog');
  dialog.dataset.outcome=draw?'draw':won?'win':'loss';
  $('game-result-title').textContent=draw?'무승부입니다':won?'승리했습니다!':'패배했습니다';
  $('game-result-reason').textContent=game.reason;
  $('game-result-emblem').innerHTML=draw?pieceSvg('k','w')+pieceSvg('k','b'):pieceSvg('k',winner);
  $('result-white-name').textContent=game.white+(game.color==='w'?' · 나':'');
  $('result-black-name').textContent=game.black+(game.color==='b'?' · 나':'');
  $('result-white-score').textContent=draw?'½':winner==='w'?'1':'0';
  $('result-black-score').textContent=draw?'½':winner==='b'?'1':'0';
  $('result-analyze-link').href='/?onlineGame='+game.id;
  presentedResults.add(game.id);
  showRoomDialog('game-result-dialog');
}
function closeGameResult(){
  $('game-result-dialog').close();
  if(game?.status==='finished'&&!$('room').hidden)$('show-result').focus({preventScroll:true});
}
function rowMarkup(g){
  const invited=g.canJoin,status=g.status==='active'?'진행 중':invited?'받은 대국 요청':g.status==='waiting'?'참가 대기':g.reason||'종료';
  const title=g.white?`${g.white} vs ${g.black}`:`${g.host}님의 대국 요청`;
  const ended=g.status==='finished';
  return `<article class="list-row"><div><strong>${esc(title)}</strong><small>${new Date(g.updatedAt||g.createdAt).toLocaleString('ko-KR')} · ${esc(timeLabel(g.timeControl))} · ${esc(status)}${ended?' · '+esc(g.result):''}${g.request?.kind==='undo'?' · 무르기 응답 대기':''}</small></div><div class="list-actions">${invited?`<button class="button primary" data-join="${g.id}">수락하고 대국</button><button class="button" data-decline="${g.id}">거절</button>`:ended?`<a class="button primary" href="/?onlineGame=${g.id}">분석하기</a><button class="button" data-open="${g.id}">${g.request?.kind==='undo'?'무르기 요청 확인':'기보 보기'}</button>`:`<button class="button" data-open="${g.id}">${g.status==='active'?'대국으로 돌아가기':'초대 확인'}</button>`}</div></article>`;
}
function renderFriends(friends=[]){
  const html=friends.length?friends.map(friend=>`<article class="friend-row"><span class="friend-avatar" aria-hidden="true">♟</span><strong>${esc(friend.nickname)}</strong><button class="button primary small" data-friend="${esc(friend.friendCode)}" aria-label="${esc(friend.nickname)}님에게 대국 신청">대국 신청</button><button class="friend-remove" data-remove-friend="${esc(friend.friendCode)}" data-name="${esc(friend.nickname)}" aria-label="${esc(friend.nickname)}님을 친구 목록에서 제거" title="목록에서 제거"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18"/></svg></button></article>`).join(''):'<p class="empty">친구를 추가하면 여기서 바로 대국을 신청할 수 있습니다.</p>';
  if(renderedFriends!==html){renderedFriends=html;$('friends-list').innerHTML=html;}
}
function renderLobby(games){
  $('lobby').hidden=false;$('room').hidden=true;
  olderGames=olderGames.filter(saved=>!games.some(current=>current.id===saved.id));
  const active=games.filter(g=>['waiting','active'].includes(g.status)),done=[...new Map([...games.filter(g=>g.status==='finished'),...olderGames].map(g=>[g.id,g])).values()];
  $('inbox').innerHTML=active.length?active.map(rowMarkup).join(''):'<p class="empty">아직 요청이 없습니다. 친구와 첫 대국을 시작해 보세요.</p>';
  $('history').innerHTML=done.length?done.map(rowMarkup).join(''):'<p class="empty">대국을 마치면 경기 기록이 여기에 남습니다.</p>';
  $('more-history').hidden=!historyCursor;scheduleGameLayout();
}
function playerMarkup(name,color,captured,material){
  const side=color==='w'?'백':'흑',advantage=material[color]-material[color==='w'?'b':'w'];
  return `<div class="player-info"><strong>${esc(name)}</strong><span>${side}${color===game.color?' · 나':''}</span><span class="material-score" data-material="${color}" aria-label="${side} 기물 점수 ${material[color]}점${advantage>0?`, ${advantage}점 우세`:''}" title="남은 기물의 합계 · 폰 1, 나이트·비숍 3, 룩 5, 퀸 9점 · 킹 제외">기물 ${material[color]}점${advantage>0?` (+${advantage})`:''}</span>${capturedMarkup(captured[color],color)}</div><time data-clock="${color}" aria-label="${side} 남은 시간"></time>`;
}
function renderClocks(){if(!game?.color)return;for(const element of document.querySelectorAll('[data-clock]')){const color=element.dataset.clock,key=color==='w'?'white':'black',active=game.status==='active'&&game.turn===color;const ms=game.clock?Math.max(0,game.clock[key]-(active?performance.now()-clockReceived:0)):null,seconds=ms===null?0:Math.ceil(ms/1000);element.textContent=ms===null?'—':`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;element.classList.toggle('running',active);element.classList.toggle('low',ms!==null&&ms<30000);}}
setInterval(renderClocks,200);
function renderRoom(){
  $('lobby').hidden=true;$('room').hidden=false;
  $('join-panel').hidden=!!game.color;$('game-area').hidden=!game.color;
  if(!game.color){$('join-title').textContent=game.status==='waiting'?`${game.host}님과 ${timeLabel(game.timeControl)} 대국할까요?`:'이미 시작되었거나 종료된 대국입니다.';$('join-game').disabled=!game.canJoin;scheduleGameLayout();return;}
  const active=game.status==='active',waiting=game.status==='waiting',ended=game.status==='finished';
  $('waiting-panel').hidden=!waiting;$('result-panel').hidden=!ended;$('game-actions').hidden=!active;
  $('waiting-text').textContent=game.mode==='friend'?'상대방이 대국함에서 요청을 수락하면 시작합니다.':'초대 링크로 참가한 첫 번째 친구와 대국합니다.';
  $('invite-link-wrap').hidden=!game.inviteToken;
  if(game.inviteToken)$('invite-link').value=location.origin+'/play?room='+game.id+'#invite='+game.inviteToken;
  const bottom=flipped?'b':'w',top=bottom==='w'?'b':'w';
  const position=displayedChess(),captured=capturedPieces(position.history({verbose:true})),material=materialBalance(position.board().flat());
  $('opponent-player').innerHTML=playerMarkup(top==='w'?game.white:game.black,top,captured,material);$('self-player').innerHTML=playerMarkup(bottom==='w'?game.white:game.black,bottom,captured,material);
  annotations.sync(game.id+':'+game.moves.slice(0,reviewPly??game.moves.length).join(','));
  renderClocks();
  $('turn-caption').textContent=waiting?'친구가 참가하면 시작됩니다.':ended?'대국 종료 · '+resultLabel():game.status==='cancelled'?'취소된 대국입니다.':(game.turn===game.color?'내 차례입니다':'상대방의 차례입니다')+(game.check?' · 체크':'');
  $('turn-caption').classList.toggle('my-turn',active&&game.turn===game.color);
  $('turn-caption').classList.toggle('finished',ended);
  if(ended){$('result-title').textContent=resultLabel();$('result-reason').textContent=game.reason;$('analyze-game-link').href='/?onlineGame='+game.id;for(const id of ['rematch-game','result-rematch']){$(id).textContent=`재대국 요청 · ${timeLabel(game.timeControl)}`;$(id).title='같은 상대·시간 규칙으로 백과 흑을 바꿔 요청합니다.';}}
  $('offer-undo').disabled=sending||!game.moves.length||!!game.request;$('offer-draw').disabled=sending||!!game.request;$('resign-game').disabled=sending;
  renderRequest();renderBoard();renderPending();
  const moves=game.history||[],viewed=reviewPly??moves.length;
  $('history-position').textContent=reviewPly===null?`현재 · ${moves.length} / ${moves.length}`:`기록 · ${viewed} / ${moves.length}`;
  $('history-position').classList.toggle('reviewing',reviewPly!==null);
  $('history-first').disabled=$('history-prev').disabled=viewed===0;$('history-last').disabled=$('history-next').disabled=viewed===moves.length;
  $('online-board').setAttribute('aria-label',reviewPly===null?'대국 체스보드':`이전 기록 체스보드 · ${viewed}번째 이동 이후`);
  $('online-history').innerHTML=moves.length?Array.from({length:Math.ceil(moves.length/2)},(_,i)=>`<div class="notation-row"><small>${i+1}.</small>${[i*2,i*2+1].map(n=>moves[n]?`<button data-ply="${n+1}" title="${esc(moves[n].label)}" aria-label="${esc(moves[n].label)} 이후 보기" aria-current="${n===viewed-1?'step':'false'}">${esc(moves[n].san)}</button>`:'<span></span>').join('')}</div>`).join(''):'<p class="empty">아직 둔 수가 없습니다.</p>';
  if(reviewPly===null)$('online-history').scrollTop=$('online-history').scrollHeight;
  scheduleGameLayout();
}
function showHistory(ply){
  if(!game?.color)return;
  const previous=reviewPly??game.moves.length;
  cleanupDrag();selected=null;pending=null;promoting=null;$('promotion-dialog').close();
  const target=Math.max(0,Math.min(game.moves.length,ply));reviewPly=target===game.moves.length?null:target;renderRoom();
  if(Math.abs(target-previous)===1)void moveSounds.play(target>previous?displayedChess().history({verbose:true}).at(-1):{});
}
function renderRequest(){
  const r=game.request;
  $('request-panel').dataset.requestId=r?.id||'';
  $('request-panel').hidden=!r;
  $('result-undo-panel').hidden=game.status!=='finished'||r?.kind!=='undo';
  if(!r){syncActionLayers();return;}
  const title=r.mine?'상대방의 응답을 기다립니다':r.kind==='undo'?'한 수 무르기 요청':'무승부 요청';
  const later=Math.max(0,game.moves.length-r.ply);
  const description=r.kind==='undo'?`${r.label} 직전으로 돌아갑니다.${later?` 요청 이후 둔 ${later}번의 이동도 취소됩니다.`:''} 요청받은 사람의 시간은 요청 시점으로 복구하고, 요청한 사람의 사용 시간은 유지합니다. 취소한 수의 추가 시간은 회수합니다.`:'수락하면 이 대국은 무승부로 끝납니다. 응답 중에도 시간은 흐릅니다.';
  $('request-title').textContent=title;$('request-description').textContent=description;
  $('request-response').hidden=r.mine;$('withdraw-request').hidden=!r.mine;
  $('result-undo-title').textContent=title;$('result-undo-description').textContent=description;
  $('result-undo-response').hidden=r.mine;$('result-withdraw-request').hidden=!r.mine;
  for(const id of ['accept-request','decline-request','withdraw-request','result-accept-undo','result-decline-undo','result-withdraw-request'])$(id).disabled=sending;
  syncActionLayers();
}
function renderPending(){
  const isNewMove=pending&&$('pending-panel').dataset.move!==pending.uci;$('pending-panel').dataset.move=pending?.uci||'';
  $('pending-panel').hidden=mode!=='confirm';$('action-slot-empty').hidden=mode==='confirm';
  $('move-action-slot').hidden=game?.status!=='active';
  $('pending-title').textContent=pending?'이 위치에 둘까요?':'이동 확인';
  $('pending-description').textContent=pending?`${names[pending.piece]} ${pending.from} → ${pending.to}${pending.promotion?' · '+names[pending.promotion]+' 승격':''}`:'둘 위치를 선택하세요.';
  $('confirm-move').disabled=$('cancel-move').disabled=!pending||sending;
  syncActionLayers();scheduleGameLayout();
  if(isNewMove)revealActionSlot();
}
function renderBoard(){
  if(!game?.color)return;
  const key=JSON.stringify([game.id,game.moves,flipped,selected,pending?.uci,reviewPly]);if(boardKey===key)return;boardKey=key;
  const c=displayedChess(),snapshot=pieceSnapshot(c),board=$('online-board'),last=c.history({verbose:true}).at(-1);
  let preview=c;if(pending){preview=new Chess(c.fen());preview.move(pending.uci);}
  const squares=[];for(let row=0;row<8;row++)for(let col=0;col<8;col++){
    const file=flipped?7-col:col,rank=flipped?row+1:8-row,square=String.fromCharCode(97+file)+rank,piece=preview.get(square),dark=(file+rank)%2===1;
    squares.push(`<button class="online-square${dark?' dark':''}${last&&(last.from===square||last.to===square)?' last':''}${piece?.type==='k'&&piece.color===c.turn()&&c.isCheck()?' check':''}${pending?.to===square?' pending':''}" data-square="${square}" role="gridcell" aria-label="${square} ${piece?(piece.color==='w'?'백':'흑')+' '+names[piece.type]:'빈 칸'}">${piece?pieceSvg(piece.type,piece.color):''}${row===7?`<span class="file">${String.fromCharCode(97+file)}</span>`:''}${col===0?`<span class="rank">${rank}</span>`:''}</button>`);
  }
  board.innerHTML=squares.join('');
  paintMoveHints(drag?.from||selected);
  if(rendered&&rendered.flipped===flipped&&rendered.fen!==c.fen()&&!pending&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
    const size=board.clientWidth/8,xy=sq=>{let x=sq.charCodeAt(0)-97,y=8-Number(sq[1]);return flipped?[7-x,7-y]:[x,y];};
    for(const {from,to} of pieceTransitions(rendered.snapshot,snapshot))if(from&&to&&from.square!==to.square){
      const [fx,fy]=xy(from.square),[tx,ty]=xy(to.square),target=board.querySelector(`[data-square="${to.square}"] .piece`);if(!target)continue;
      target.animate([{transform:`translate(${(fx-tx)*size}px,${(fy-ty)*size}px)`},{transform:'translate(0,0)'}],{duration:210,easing:'ease-out'});
    }
  }
  if(!pending)rendered={snapshot,fen:c.fen(),flipped};
}
const canInteract=()=>reviewPly===null&&game?.status==='active'&&game.turn===game.color&&!sending&&!promoting&&!$('connection-status').classList.contains('offline');
const canMove=()=>canInteract()&&!pending;
function pickedPiece(square){const from=pending?.to===square?pending.from:square,piece=chessFor(game).get(from);return piece?.color===game.color?{from,piece}:null;}
function cancelPendingForSelection(){if(!pending)return false;pending=null;selected=null;renderPending();renderBoard();return true;}
function paintMoveHints(from){
  const moves=from&&canMove()?chessFor(game).moves({square:from,verbose:true}):[];
  const destinations=new Set(moves.map(move=>move.to)),captures=new Set(moves.filter(move=>move.captured).map(move=>move.to));
  for(const square of $('online-board').querySelectorAll('[data-square]')){
    square.classList.toggle('selected',square.dataset.square===from);
    square.classList.toggle('legal',destinations.has(square.dataset.square));
    square.classList.toggle('legal-capture',captures.has(square.dataset.square));
  }
}
function choose(square){if(!canInteract())return;if(pending){const picked=pickedPiece(square);if(!picked)return;cancelPendingForSelection();selected=picked.from;renderBoard();return;}const c=chessFor(game),piece=c.get(square);if(selected&&selected!==square){if(c.moves({square:selected,verbose:true}).some(m=>m.to===square)){stageMove(selected,square);return;}}selected=piece?.color===game.color?(selected===square?null:square):null;renderBoard();}
function stageMove(from,to,promotion){
  if(!canMove())return;const c=chessFor(game),choices=c.moves({square:from,verbose:true}).filter(m=>m.to===to);if(!choices.length){selected=null;renderBoard();return;}
  if(choices.some(m=>m.promotion)&&!promotion){promoting={from,to,revision:game.revision};for(const b of $('promotion-options').children)b.innerHTML=pieceSvg(b.dataset.promotion,game.color)+`<span>${names[b.dataset.promotion]}</span>`;showRoomDialog('promotion-dialog');return;}
  const uci=from+to+(promotion||''),move=c.move(uci);selected=null;
  if(mode==='confirm'){pending={...move,uci,revision:game.revision};renderBoard();renderPending();}else void action({type:'move',uci});
}
async function action(body){if(sending)return;sending=true;renderPending();renderRequest();$('confirm-move').disabled=true;try{const {game:next}=await api('games/'+roomId+'/action',{revision:game.revision,...body});pending=null;notice('');acceptState(next);}catch(error){pending=null;notice(error.message,true);await refresh();renderBoard();renderPending();}finally{sending=false;$('confirm-move').disabled=false;if(game?.color)renderRoom();}}
async function openRoom(id){$('game-result-dialog').close();cleanupDrag();pending=null;promoting=null;selected=null;game=null;rendered=null;roomId=id;inviteToken='';history.pushState(null,'','/play?room='+id);notice('');await refresh();}
function ask(title,description,fn){$('action-title').textContent=title;$('action-description').textContent=description;dialogAction=fn;showRoomDialog('action-dialog');}
async function runButton(button,fn){if(button.disabled)return;button.disabled=true;try{await fn();}catch(error){notice(error.message,true);}finally{button.disabled=false;}}
async function copy(text){try{await navigator.clipboard.writeText(text);notice('복사했습니다. 친구에게 보내 주세요.');}catch{notice('복사하지 못했습니다. 표시된 코드를 직접 선택해 복사해 주세요.',true);}}
function savePgn(){if(!game?.pgn)return;const url=URL.createObjectURL(new Blob([game.pgn],{type:'application/x-chess-pgn'})),a=document.createElement('a');a.href=url;a.download='friendly-chess-'+game.id.slice(0,8)+'.pgn';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('invite-form').onsubmit=event=>{event.preventDefault();void runButton(event.submitter,async()=>{const data=await api('games',{mode:'invite',color:$('invite-color').value,timeControl:$('invite-time').value});await openRoom(data.game.id);});};
$('add-friend-form').onsubmit=event=>{event.preventDefault();void runButton(event.submitter,async()=>{const data=await api('friends',{friendCode:$('friend-code').value});renderFriends(data.friends);$('friend-code').value='';notice('친구 목록에 저장했습니다. 이제 이름 옆에서 대국을 신청하세요.');});};
$('friends-list').onclick=event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.dataset.friend)void runButton(button,async()=>{const data=await api('games',{mode:'friend',color:$('friend-color').value,timeControl:$('friend-time').value,friendCode:button.dataset.friend});await openRoom(data.game.id);});
  if(button.dataset.removeFriend)ask(`${button.dataset.name}님을 목록에서 제거할까요?`,'경기 기록은 유지되며, 친구 코드로 다시 추가할 수 있습니다.',async()=>{const data=await api('friends/remove',{friendCode:button.dataset.removeFriend});renderFriends(data.friends);notice('친구 목록에서 제거했습니다.');});
};
$('copy-code').onclick=()=>copy(me.friendCode);$('copy-link').onclick=()=>copy($('invite-link').value);$('refresh-lobby').onclick=()=>refresh();
$('more-history').onclick=event=>runButton(event.currentTarget,async()=>{const data=await api('history?cursor='+encodeURIComponent(historyCursor));olderGames.push(...data.games);historyCursor=data.nextCursor;renderLobby(latestGames);});
$('lobby').onclick=event=>{const button=event.target.closest('button');if(!button)return;if(button.dataset.open)void openRoom(button.dataset.open);else if(button.dataset.join)void runButton(button,async()=>{await api('games/'+button.dataset.join+'/join',{});await openRoom(button.dataset.join);});else if(button.dataset.decline)void runButton(button,async()=>{await api('games/'+button.dataset.decline+'/decline',{});await refresh();});};
$('join-game').onclick=event=>runButton(event.currentTarget,async()=>{const data=await api('games/'+roomId+'/join',{});acceptState(data.game);});
$('cancel-invite').onclick=()=>ask('초대를 취소할까요?','상대는 이 초대로 참가할 수 없게 됩니다.',async()=>{await api('games/'+roomId+'/cancel',{});await backLobby();});
async function backLobby(){$('game-result-dialog').close();cleanupDrag();roomId=null;game=null;pending=null;rendered=null;inviteToken='';history.pushState(null,'','/play');notice('');await refresh();}
$('back-lobby').onclick=backLobby;$('flip-board').onclick=()=>{flipped=!flipped;rendered=null;renderRoom();};
$('confirm-move').onclick=()=>{if(pending&&pending.revision===game.revision)void action({type:'move',uci:pending.uci});};
$('cancel-move').onclick=()=>{pending=null;renderBoard();renderPending();};
$('promotion-options').onclick=event=>{const button=event.target.closest('[data-promotion]');if(!button||!promoting)return;const {from,to,revision}=promoting;promoting=null;$('promotion-dialog').close();if(game.revision===revision)stageMove(from,to,button.dataset.promotion);};
$('promotion-cancel').onclick=()=>{promoting=null;$('promotion-dialog').close();};$('promotion-dialog').addEventListener('cancel',()=>{promoting=null;});
$('offer-undo').onclick=()=>{
  const revision=game.revision,targetRoom=roomId;
  ask('한 수 무르기를 요청할까요?',`${game.history.at(-1).label} 직전으로 돌아갑니다. 요청 후 수가 진행되거나 대국이 끝나도 상대방이 수락하면 함께 되돌립니다. 상대의 시간은 요청 시점으로 복구하고, 내가 사용한 시간은 유지합니다.`,()=>{if(roomId===targetRoom)return action({type:'offer',kind:'undo',revision});});
};
$('offer-draw').onclick=()=>ask('무승부를 요청할까요?','상대방이 수락하면 대국이 무승부로 끝납니다.',()=>action({type:'offer',kind:'draw'}));
$('resign-game').onclick=()=>ask('기권할까요?','기권하면 상대방의 승리로 대국이 종료됩니다.',()=>action({type:'resign'}));
function respondToRequest(accept){if(game?.request)void action({type:'respond',requestId:game.request.id,accept});}
for(const id of ['accept-request','result-accept-undo'])$(id).onclick=()=>respondToRequest(true);
for(const id of ['decline-request','result-decline-undo'])$(id).onclick=()=>respondToRequest(false);
for(const id of ['withdraw-request','result-withdraw-request'])$(id).onclick=()=>{if(game?.request)void action({type:'withdraw'});};
$('action-confirm').onclick=async()=>{const fn=dialogAction;dialogAction=null;$('action-dialog').close();try{await fn?.();}catch(error){notice(error.message,true);}};$('action-cancel').onclick=()=>{$('action-dialog').close();dialogAction=null;};
$('action-dialog').addEventListener('cancel',()=>{dialogAction=null;});
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape'||document.querySelector('dialog:modal'))return;
  const dialog=$('room-overlays').querySelector('dialog[open]:not(.covered-alert)');
  if(dialog){event.preventDefault();if(dialog.dispatchEvent(new Event('cancel',{cancelable:true})))dialog.close();}
});
$('download-pgn').onclick=savePgn;
for(const id of ['rematch-game','result-rematch'])$(id).onclick=event=>runButton(event.currentTarget,async()=>{
  if(game?.status!=='finished')return;
  $('rematch-game').disabled=$('result-rematch').disabled=true;
  try{const data=await api('games',{rematchOf:game.id});await openRoom(data.game.id);}catch(error){$('game-result-dialog').close();throw error;}finally{$('rematch-game').disabled=$('result-rematch').disabled=false;}
});
for(const prefix of ['friend','invite'])$(`${prefix}-time-options`).addEventListener('click',event=>{
  const button=event.target.closest('[data-time-control]');if(!button)return;
  $(`${prefix}-time`).value=button.dataset.timeControl;
  for(const option of $(`${prefix}-time-options`).querySelectorAll('[data-time-control]'))option.setAttribute('aria-pressed',String(option===button));
});
$('show-result').onclick=showGameResult;
$('close-result').onclick=closeGameResult;
$('review-finished-game').onclick=()=>{closeGameResult();if(!$('history-prev').disabled)$('history-prev').focus({preventScroll:true});};
$('game-result-dialog').addEventListener('cancel',event=>{event.preventDefault();closeGameResult();});
$('history-first').onclick=()=>showHistory(0);
$('history-prev').onclick=()=>showHistory((reviewPly??game.moves.length)-1);
$('history-next').onclick=()=>showHistory((reviewPly??game.moves.length)+1);
$('history-last').onclick=()=>showHistory(game.moves.length);
$('online-history').onclick=event=>{const button=event.target.closest('[data-ply]');if(button)showHistory(Number(button.dataset.ply));};
document.addEventListener('keydown',event=>{if(!game?.color||$('room').hidden||document.querySelector('dialog[open]')||event.target.closest('input,select,textarea,[contenteditable="true"]')||event.altKey||event.ctrlKey||event.metaKey)return;if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();showHistory((reviewPly??game.moves.length)+(event.key==='ArrowLeft'?-1:1));}});
function updateMode(){for(const button of $('move-mode').querySelectorAll('[data-move-mode]'))button.setAttribute('aria-pressed',String(button.dataset.moveMode===mode));}
$('move-mode').onclick=event=>{const button=event.target.closest('[data-move-mode]');if(!button||button.dataset.moveMode===mode)return;mode=button.dataset.moveMode;try{localStorage.setItem('chessreview.move-mode',mode);}catch{}pending=null;renderPending();renderBoard();updateMode();};
$('online-board').onclick=event=>{if(suppressClick){suppressClick=false;return;}const square=event.target.closest('[data-square]');if(square)choose(square.dataset.square);};
$('online-board').onpointerdown=event=>{if(event.button!==0||!event.isPrimary||!canInteract())return;cleanupDrag();const square=event.target.closest('[data-square]');if(!square)return;const picked=pickedPiece(square.dataset.square);if(!picked)return;const size=square.getBoundingClientRect().width,reselected=cancelPendingForSelection();drag={...picked,reselected,startX:event.clientX,startY:event.clientY,pointerId:event.pointerId,node:null,size};paintMoveHints(drag.from);};
$('online-board').onpointermove=event=>{if(!drag||drag.pointerId!==event.pointerId)return;if(!drag.node&&Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>6){$('online-board').setPointerCapture(event.pointerId);drag.node=document.createElement('div');drag.node.className='drag-piece';drag.node.style.width=drag.node.style.height=drag.size+'px';drag.node.innerHTML=pieceSvg(drag.piece.type,drag.piece.color);document.body.append(drag.node);document.querySelector(`[data-square="${drag.from}"]`)?.classList.add('drag-source');}if(drag.node){event.preventDefault();drag.node.style.left=event.clientX-drag.size/2+'px';drag.node.style.top=event.clientY-drag.size/2+'px';}};
document.addEventListener('pointerup',event=>{if(!drag||drag.pointerId!==event.pointerId)return;const {from,reselected}=drag,didDrag=!!drag.node,target=document.elementFromPoint(event.clientX,event.clientY)?.closest('#online-board [data-square]');cleanupDrag();if(didDrag||reselected){suppressClick=true;setTimeout(()=>{suppressClick=false;},0);if(didDrag){if(target)stageMove(from,target.dataset.square);else{selected=null;renderBoard();}}else choose(from);}});
function cancelDrag(){if(!drag)return;cleanupDrag();selected=null;renderBoard();}
document.addEventListener('pointercancel',event=>{if(drag?.pointerId===event.pointerId)cancelDrag();});
$('online-board').addEventListener('lostpointercapture',event=>{if(drag?.pointerId===event.pointerId)cancelDrag();});
$('online-board').addEventListener('dragstart',event=>event.preventDefault());
window.addEventListener('blur',cancelDrag);
document.addEventListener('keydown',event=>{if(event.key==='Escape')cancelDrag();});
function cleanupDrag(){const previous=drag;drag=null;previous?.node?.remove();for(const node of document.querySelectorAll('.drag-piece'))node.remove();for(const square of $('online-board').querySelectorAll('.drag-source'))square.classList.remove('drag-source');if(previous){try{$('online-board').releasePointerCapture(previous.pointerId);}catch{}}paintMoveHints(selected);}
window.addEventListener('popstate',()=>{$('game-result-dialog').close();roomId=new URL(location.href).searchParams.get('room');game=null;pending=null;rendered=null;inviteToken=new URLSearchParams(location.hash.slice(1)).get('invite')||'';void refresh();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelDrag();else void refresh();});window.addEventListener('pagehide',()=>{clearTimeout(pollTimer);cleanupDrag();});
window.addEventListener('invitations-changed',()=>{void refresh();});
let layoutFrame,mobileControls=false;
const mobileControlHomes=[['turn-caption','mobile-turn-slot'],['move-sound','mobile-tool-extras'],['account-open','mobile-tool-extras']].map(([id,target])=>{
  const node=$(id),anchor=document.createComment(id+' desktop position');node.before(anchor);return{node,anchor,target:$(target)};
});
function setBoardTools(open,focus=false){
  $('board-tools').classList.toggle('is-open',open);
  $('board-tools-toggle').setAttribute('aria-expanded',String(open));
  $('board-tools-toggle').setAttribute('aria-label',open?'체스판 도구 닫기':'체스판 도구 열기');
  if(focus)$('board-tools-toggle').focus({preventScroll:true});
}
$('board-tools-toggle').onclick=()=>setBoardTools($('board-tools-toggle').getAttribute('aria-expanded')!=='true');
document.addEventListener('pointerdown',event=>{if(mobileControls&&!event.target.closest('#board-tools,#board-tools-toggle'))setBoardTools(false);});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&mobileControls&&$('board-tools').classList.contains('is-open')){setBoardTools(false,true);event.preventDefault();}});
function syncMobileControls(){
  syncNoticePlacement();
  const mobile=matchMedia('(max-width:700px)').matches&&!$('game-area').hidden&&!$('room').hidden;
  if(mobile===mobileControls)return;
  mobileControls=mobile;document.body.classList.toggle('mobile-game',mobile);setBoardTools(false);
  for(const {node,anchor,target}of mobileControlHomes){if(mobile)target.append(node);else anchor.after(node);}
}
function syncHistoryScroll(){
  const list=$('online-history');
  if(!mobileControls){if(reviewPly===null)list.scrollTop=list.scrollHeight;return;}
  if(reviewPly===null){list.scrollLeft=list.scrollWidth;return;}
  const current=list.querySelector('[aria-current="step"]');if(!current){list.scrollLeft=0;return;}
  const item=current.getBoundingClientRect(),bounds=list.getBoundingClientRect();
  if(item.left<bounds.left)list.scrollLeft-=bounds.left-item.left+6;else if(item.right>bounds.right)list.scrollLeft+=item.right-bounds.right+6;
}
function scheduleGameLayout(){cancelAnimationFrame(layoutFrame);layoutFrame=requestAnimationFrame(fitGameLayout);}
function fitGameLayout(){
  syncMobileControls();
  const area=$('game-area');if(area.hidden||$('room').hidden)return;
  const main=document.querySelector('.play-main'),style=getComputedStyle(main);
  const availableWidth=main.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
  const availableHeight=Math.max(0,Math.floor((window.visualViewport?.height||innerHeight)-(area.getBoundingClientRect().top+scrollY)-parseFloat(style.paddingBottom)));
  const stacked=mobileControls,gap=stacked?8:20;
  const sidebarWidth=stacked?availableWidth:Math.min(360,Math.max(280,availableWidth*.3));
  const playerHeight=$('opponent-player').offsetHeight+$('self-player').offsetHeight;
  const content=document.querySelector('.room-sidebar-content'),sidebar=document.querySelector('.room-sidebar');
  const visible=stacked?[...content.children].filter(node=>!node.hidden&&getComputedStyle(node).display!=='none'):[];
  const contentHeight=visible.reduce((sum,node)=>sum+node.offsetHeight,0)+Math.max(0,visible.length-1)*parseFloat(getComputedStyle(content).gap);
  const actionsHeight=$('game-actions').hidden?0:$('game-actions').offsetHeight+parseFloat(getComputedStyle(sidebar).gap);
  const controlsHeight=stacked?contentHeight+actionsHeight:0;
  const naturalBoardSize=Math.max(0,Math.floor(Math.min(stacked?availableWidth:availableWidth-sidebarWidth-gap,availableHeight-playerHeight-(stacked?controlsHeight+gap:0))));
  // On short phones, scroll the controls instead of shrinking the board to a thumbnail.
  const minimumBoardSize=stacked?Math.max(0,Math.min(200,availableWidth,availableHeight-playerHeight-gap-128)):0;
  document.body.classList.toggle('compact-game-controls',stacked&&naturalBoardSize<minimumBoardSize);
  const boardSize=Math.max(naturalBoardSize,minimumBoardSize);
  area.style.setProperty('--game-height',availableHeight+'px');
  area.style.setProperty('--board-size',boardSize+'px');
  area.style.setProperty('--sidebar-width',sidebarWidth+'px');
  area.style.setProperty('--room-width',(stacked?availableWidth:boardSize+sidebarWidth+gap)+'px');
  syncHistoryScroll();
}
const layoutObserver=new ResizeObserver(scheduleGameLayout);
for(const element of [document.querySelector('.play-main'),document.querySelector('.play-header'),document.querySelector('.room-heading'),$('notice'),$('opponent-player'),$('self-player')])layoutObserver.observe(element);
window.addEventListener('resize',scheduleGameLayout);window.visualViewport?.addEventListener('resize',scheduleGameLayout);
document.fonts.ready.then(scheduleGameLayout);
window.addEventListener('storage',event=>{if(event.key==='chessreview.auth-changed')location.reload();});
updateMode();void initialize().then(()=>accountUI.resume());
