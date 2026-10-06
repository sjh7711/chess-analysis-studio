import {CompletionAlerts} from './completion-alerts.js';

const STORAGE = 'chessreview.notifications.v1';
export const invitationTime = value => ({'10':'10분','10+5':'10분 · 한 수마다 5초 추가','15+10':'15분 · 한 수마다 10초 추가','20':'20분','30':'30분','60':'60분'}[value] || value || '시간 제한 없음');

export class NotificationHistory {
  constructor(storage) {
    this.storage=storage; this.accountKey=null; this.invitations=[]; this.analyses=[]; this.readInvitations=[]; this.load();
  }
  load() {
    try {
      const saved=JSON.parse(this.storage?.getItem(STORAGE)||'null');
      if(!saved)return;
      this.analyses=(saved?.analyses||[]).filter(item=>typeof item.id==='string'&&typeof item.message==='string'&&Number.isFinite(item.createdAt)).slice(0,30);
      this.readInvitations=(saved?.readInvitations||[]).filter(key=>typeof key==='string').slice(-200);
    } catch { /* Keep this page's history when browser storage is unavailable. */ }
  }
  save() { try { this.storage?.setItem(STORAGE,JSON.stringify({analyses:this.analyses,readInvitations:this.readInvitations})); } catch {} }
  addAnalysis(message,createdAt=Date.now()) {
    this.load();
    this.analyses.unshift({id:`analysis:${createdAt}:${Math.random().toString(36).slice(2)}`,kind:'analysis',message,createdAt,read:false});
    this.analyses=this.analyses.slice(0,30); this.save();
  }
  syncInvitations(accountKey,items=[]) {
    this.accountKey=accountKey;
    // Names and game details stay on the server; only read markers are stored locally.
    this.invitations=accountKey?items.map(item=>({...item,id:'invitation:'+item.id,gameId:item.id,kind:'invitation'})):[];
  }
  entries() {
    const invitations=this.invitations.map(item=>({...item,read:this.readInvitations.includes(`${this.accountKey}:${item.gameId}`)}));
    return [...this.analyses,...invitations].sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id)).slice(0,30);
  }
  markRead() {
    this.load();
    const entries=this.entries(),ids=new Set(entries.map(item=>item.id));
    this.analyses=this.analyses.map(item=>ids.has(item.id)?{...item,read:true}:item);
    this.readInvitations=[...new Set([...this.readInvitations,...entries.filter(item=>item.kind==='invitation').map(item=>`${this.accountKey}:${item.gameId}`)])].slice(-200);
    this.save();
  }
}

export const completionAlerts=new CompletionAlerts({
  onNotice:(message,test)=>{
    if(typeof document==='undefined')return;
    if(test)notificationCenter?.testNotice();
    else notificationCenter?.addAnalysis(message);
    window.dispatchEvent(new CustomEvent('analysis-notice',{detail:{message,test}}));
  },
  onStatus:()=>notificationCenter?.renderSettings(),
});

function mountNotificationCenter() {
  const bell=document.querySelector('.notification-bell');if(!bell)return null;
  let storage;try{storage=localStorage;}catch{}
  const history=new NotificationHistory(storage);
  const dialog=document.createElement('dialog');dialog.id='completion-dialog';dialog.className='notification-dialog';dialog.setAttribute('aria-labelledby','completion-title');
  dialog.innerHTML=`
    <div class="notification-dialog-heading"><button id="notification-back" class="notification-icon" aria-label="최근 알림으로 돌아가기" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button><h2 id="completion-title" tabindex="-1">최근 알림</h2><button id="completion-close" class="notification-icon" aria-label="알림 닫기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
    <div id="notification-recent" class="notification-dialog-body"><div id="notification-list"></div></div>
    <div id="notification-settings" class="notification-dialog-body" hidden>
      <h3>분석 완료 알림</h3><p>전체 대국 분석이 끝나면 알려드립니다.</p>
      <label class="notification-sound"><input id="completion-sound" type="checkbox"> 완료 시 알림음</label>
      <button id="completion-desktop" class="notification-button">브라우저 알림 켜기</button>
      <p id="completion-status" class="notification-note" role="status"></p>
      <p class="notification-note">이 페이지를 열어 둔 상태에서 작동합니다.</p>
      <button id="completion-test" class="notification-button primary">알림 테스트</button>
      <p id="completion-test-status" class="notification-note" role="status" hidden></p>
    </div>
    <footer class="notification-dialog-footer"><button id="notification-settings-open" class="notification-button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6"/></svg>알림 설정</button></footer>`;
  document.body.append(dialog);
  const $=id=>dialog.querySelector('#'+id),badge=document.createElement('span');badge.className='invitation-count';badge.hidden=true;badge.setAttribute('aria-hidden','true');bell.append(badge);
  let pending=[];
  const statusLabels={waiting:'응답 대기',active:'수락됨 · 대국 진행 중',finished:'대국 종료',declined:'거절한 요청',cancelled:'취소된 요청'};
  const make=(tag,className,text)=>{const node=document.createElement(tag);node.className=className;if(text)node.textContent=text;return node;};
  function renderBell() {
    const unread=history.entries().filter(item=>!item.read),attention=new Set([...unread.map(item=>item.id),...pending.map(item=>'invitation:'+item.id)]);
    bell.classList.toggle('has-invitations',pending.length>0);
    bell.classList.toggle('has-completion',unread.length>0);
    badge.hidden=!attention.size;badge.textContent=attention.size>99?'99+':String(attention.size);
    bell.disabled=false;bell.title=attention.size?`알림 ${attention.size}개 · 최근 알림 보기`:'최근 알림 보기';bell.setAttribute('aria-label',bell.title);bell.setAttribute('aria-haspopup','dialog');
  }
  function renderRecent() {
    const list=$('notification-list'),entries=history.entries(),signature=JSON.stringify(entries);
    if(list.dataset.signature===signature)return;
    list.dataset.signature=signature;list.replaceChildren();
    if(!entries.length){const empty=make('div','notification-empty');empty.append(make('strong','','아직 알림이 없습니다.'),make('p','','대국 요청과 분석 완료 알림이 여기에 표시됩니다.'));list.append(empty);return;}
    for(const entry of entries){
      const row=make('article','notification-entry'+(!entry.read?' unread':''));row.dataset.notification=entry.id;
      const top=make('div','notification-entry-top'),title=make('strong','',entry.kind==='analysis'?'분석이 완료되었습니다':`${entry.host}님의 대국 요청`);
      const time=make('time','',new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(entry.createdAt));time.dateTime=new Date(entry.createdAt).toISOString();
      top.append(title,time);row.append(top);
      if(entry.kind==='analysis')row.append(make('p','notification-entry-detail',entry.message));
      else{
        row.append(make('p','notification-entry-detail',invitationTime(entry.timeControl)));
        const bottom=make('div','notification-entry-bottom');bottom.append(make('span','notification-entry-status '+entry.status,statusLabels[entry.status]||'대국 요청'));
        if(entry.status==='waiting'){
          const show=make('button','notification-entry-link','요청 보기');show.onclick=()=>{dialog.close();document.querySelector(`[data-invitation="${entry.gameId}"] .invitation-accept`)?.focus();};bottom.append(show);
        }else if(['active','finished'].includes(entry.status)){
          const link=make('a','notification-entry-link',entry.status==='active'?'대국 열기':'기록 보기');link.href='/play?room='+encodeURIComponent(entry.gameId);bottom.append(link);
        }
        row.append(bottom);
      }
      list.append(row);
    }
  }
  function renderSettings() {
    $('completion-sound').checked=completionAlerts.preferences.sound;
    const permission=completionAlerts.permission,enabled=completionAlerts.preferences.desktop;
    $('completion-desktop').textContent=enabled?'브라우저 알림 끄기':'브라우저 알림 켜기';
    $('completion-desktop').disabled=!enabled&&['denied','unsupported'].includes(permission);
    $('completion-status').textContent=completionAlerts.desktopFailed?'이 브라우저에서 시스템 알림을 표시하지 못했습니다. 소리와 화면 알림은 계속 사용할 수 있습니다.':permission==='unsupported'?'이 브라우저는 시스템 알림을 지원하지 않습니다. 소리와 화면으로 알려드립니다.':permission==='denied'?'브라우저에서 알림이 차단되어 있습니다. 사이트 권한에서 알림을 허용하면 사용할 수 있습니다.':enabled&&permission==='granted'?'다른 탭을 보고 있을 때도 분석 완료 알림을 보냅니다.':'브라우저 알림을 켜면 다른 탭을 보고 있을 때도 분석 완료 알림을 받을 수 있습니다.';
  }
  function showView(settings=false) {
    $('notification-recent').hidden=settings;$('notification-settings').hidden=!settings;$('notification-back').hidden=!settings;$('notification-settings-open').parentElement.hidden=settings;
    $('completion-title').textContent=settings?'알림 설정':'최근 알림';
    if(settings)renderSettings();else{history.markRead();renderRecent();renderBell();}
    $('completion-title').focus();
  }
  bell.onclick=()=>{showView();dialog.showModal();$('completion-title').focus();};
  $('completion-close').onclick=()=>dialog.close();$('notification-settings-open').onclick=()=>showView(true);$('notification-back').onclick=()=>showView();
  $('completion-sound').onchange=event=>{completionAlerts.setSound(event.target.checked);void completionAlerts.prepareSound();};
  $('completion-desktop').onclick=async()=>{await completionAlerts.toggleDesktop();renderSettings();};
  $('completion-test').onclick=()=>completionAlerts.test();
  for(const event of ['pointerdown','keydown'])document.addEventListener(event,()=>{void completionAlerts.prepareSound();},{passive:true});
  window.addEventListener('pagehide',()=>completionAlerts.dispose());
  window.addEventListener('storage',event=>{
    if(event.key===STORAGE){history.load();renderBell();if(dialog.open)renderRecent();}
    if(event.key==='chessreview.completion-alerts.v1'){completionAlerts.reloadPreferences();renderSettings();}
  });
  renderBell();
  return {
    renderSettings,
    testNotice(){const status=$('completion-test-status');status.textContent='테스트 알림을 보냈습니다.';status.hidden=false;},
    addAnalysis(message){history.addAnalysis(message);renderBell();if(dialog.open&&!$('notification-recent').hidden)renderRecent();},
    updateInvitations(accountKey,recent,waiting){pending=waiting;history.syncInvitations(accountKey,recent);renderBell();if(dialog.open&&!$('notification-recent').hidden)renderRecent();},
  };
}

export const notificationCenter=typeof document==='undefined'?null:mountNotificationCenter();
