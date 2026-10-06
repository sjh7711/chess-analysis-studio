const $=id=>document.getElementById(id);
export function mountAccount({api,onSignedIn,onSignedOut}){
  let mode='login',data=null,linkState=null;
  const dialog=$('account-dialog'),message=$('account-message'),loginMessage=$('auth-message');
  const showMessage=(node,text,error=false)=>{node.textContent=text;node.hidden=!text;node.classList.toggle('error',error);};
  async function run(button,fn,target=message){
    if(button.disabled)return;button.disabled=true;showMessage(target,'');
    try{await fn();}catch(error){showMessage(target,error.message,true);}finally{button.disabled=false;}
  }
  function setMode(next){
    mode=next;for(const button of document.querySelectorAll('[data-auth-mode]'))button.setAttribute('aria-pressed',String(button.dataset.authMode===mode));
    $('auth-submit').textContent=mode==='signup'?'가입하고 시작':'로그인';
    $('auth-password').autocomplete=mode==='signup'?'new-password':'current-password';
    $('auth-password').minLength=mode==='signup'?8:1;
    $('auth-confirm-wrap').hidden=mode!=='signup';$('auth-confirm').required=mode==='signup';
    $('auth-help').textContent=mode==='signup'?'닉네임이 로그인 ID가 됩니다. 비밀번호는 8~128자로 입력하세요.':'가입한 닉네임과 비밀번호를 입력하세요.';
    showMessage(loginMessage,'');
  }
  for(const button of document.querySelectorAll('[data-auth-mode]'))button.onclick=()=>setMode(button.dataset.authMode);
  function update(next){
    data=next;$('account-open').hidden=!next?.signedIn;
    if(!next?.signedIn)return;
    $('account-name').textContent=next.profile.nickname;
    $('chatgpt-link-status').textContent=next.account.linkedChatGPT?'ChatGPT 계정이 연결되어 있습니다. 두 방식으로 같은 계정에 로그인할 수 있습니다.':'ChatGPT를 연동하면 비밀번호 없이도 같은 계정에 로그인할 수 있습니다.';
    $('chatgpt-link-start').hidden=next.account.linkedChatGPT;
    $('chatgpt-unlink-form').hidden=!next.account.linkedChatGPT;
    $('password-current-wrap').hidden=!!next.account.canResetPassword;
    $('password-current').required=!next.account.canResetPassword;
    $('password-help').textContent=next.account.canResetPassword?'방금 ChatGPT로 인증했습니다. 새 비밀번호를 설정할 수 있습니다.':'비밀번호를 변경하면 다른 기기에서 로그아웃됩니다.';
  }
  $('auth-form').onsubmit=event=>{event.preventDefault();void run($('auth-submit'),async()=>{
    if(mode==='signup'&&$('auth-password').value!==$('auth-confirm').value)throw new Error('비밀번호 확인이 일치하지 않습니다.');
    const next=await api('auth/'+mode,{nickname:$('auth-nickname').value,password:$('auth-password').value});
    $('auth-form').reset();await onSignedIn(next);
    window.dispatchEvent(new Event('account-changed'));try{localStorage.setItem('chessreview.auth-changed',String(Date.now()));}catch{}
  },loginMessage);};
  async function startChatGPT(link=false){
    const result=await api('auth/chatgpt-start',{mode:link?'link':'login',returnTo:location.pathname+location.search+location.hash});
    location.assign(result.redirect);
  }
  $('chatgpt-login').onclick=()=>void run($('chatgpt-login'),()=>startChatGPT(),loginMessage);
  $('chatgpt-link-start').onclick=()=>void run($('chatgpt-link-start'),()=>startChatGPT(true));
  $('account-open').onclick=async()=>{showMessage(message,'');dialog.showModal();try{update(await api('me'));}catch(error){showMessage(message,error.message,true);}};
  $('account-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{for(const input of dialog.querySelectorAll('input[type=password]'))input.value='';});
  $('account-logout').onclick=()=>void run($('account-logout'),async()=>{
    await api('auth/logout',{});dialog.close();update(null);onSignedOut();
    window.dispatchEvent(new Event('account-changed'));try{localStorage.setItem('chessreview.auth-changed',String(Date.now()));}catch{}
  });
  $('chatgpt-link-form').onsubmit=event=>{event.preventDefault();void run(event.submitter,async()=>{
    await api('auth/link',{state:linkState,password:$('link-password').value});
    $('chatgpt-link-form').reset();$('chatgpt-link-confirm').hidden=true;linkState=null;
    update(await api('me'));showMessage(message,'ChatGPT 연동이 완료되었습니다.');
  });};
  $('chatgpt-link-cancel').onclick=()=>{$('chatgpt-link-confirm').hidden=true;$('chatgpt-link-form').reset();linkState=null;};
  $('chatgpt-unlink-form').onsubmit=event=>{event.preventDefault();void run(event.submitter,async()=>{
    update(await api('auth/unlink',{password:$('unlink-password').value}));$('chatgpt-unlink-form').reset();
    showMessage(message,'연동을 해제했습니다. 닉네임과 비밀번호로 로그인할 수 있습니다.');
  });};
  $('password-form').onsubmit=event=>{event.preventDefault();void run(event.submitter,async()=>{
    if($('password-new').value!==$('password-confirm').value)throw new Error('새 비밀번호 확인이 일치하지 않습니다.');
    update(await api('auth/password',{password:$('password-current').value,newPassword:$('password-new').value}));
    $('password-form').reset();showMessage(message,'비밀번호를 변경했습니다.');
  });};
  $('forgot-password').onclick=()=>showMessage(loginMessage,'ChatGPT를 연동했다면 아래 버튼으로 로그인한 뒤 계정 설정에서 비밀번호를 변경하세요. 연동하지 않은 계정은 비밀번호를 재설정할 수 없습니다.');
  async function resume(){
    const url=new URL(location.href),action=url.searchParams.get('auth'),state=url.searchParams.get('authState');
    if(!action)return;
    url.searchParams.delete('auth');url.searchParams.delete('authState');history.replaceState(null,'',url.pathname+url.search+url.hash);
    try{
      if(action==='chatgpt'){
        const next=await api('auth/chatgpt-login',{state});await onSignedIn(next);window.dispatchEvent(new Event('account-changed'));
      }else if(action==='link'){
        const next=await api('me');if(!next.signedIn)throw new Error('닉네임으로 다시 로그인한 뒤 ChatGPT 연동을 시작해 주세요.');
        if(!next.chatgptAvailable)throw new Error('ChatGPT 인증이 완료되지 않았습니다. 다시 시도해 주세요.');
        update(next);linkState=state;$('chatgpt-link-confirm').hidden=false;
        $('chatgpt-link-label').textContent=next.profile.nickname+' 계정에 '+next.chatgptLabel+'을(를) 연결합니다.';
        dialog.showModal();$('link-password').focus();
      }
    }catch(error){showMessage(data?.signedIn?message:loginMessage,error.message,true);if(data?.signedIn&&!dialog.open)dialog.showModal();}
  }
  setMode('login');return {update,resume};
}
