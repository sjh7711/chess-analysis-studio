import {notificationCenter,invitationTime} from './notification-center.js';

async function request(path, body) {
  const response = await fetch('/api/play/' + path, {
    method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
    headers: body === undefined ? {} : {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || '요청을 처리하지 못했습니다.'), {status: response.status});
  return data;
}

// A response to an older poll must never restore an already handled invitation.
export class InvitationInbox {
  constructor({request: send = request, onChange = () => {}, onAccepted = () => {}} = {}) {
    this.send = send; this.onChange = onChange; this.onAccepted = onAccepted;
    this.invitations = []; this.recentInvitations=[]; this.accountKey=null; this.busy = null; this.message = ''; this.version = 0; this.stopped = false;
  }
  emit() { if (!this.stopped) this.onChange(this); }
  async refresh() {
    if (this.stopped || this.busy) return;
    const version = ++this.version;
    try {
      const data = await this.send('invitations');
      if (this.stopped || version !== this.version) return;
      this.invitations = data.invitations.filter(item => item.canJoin && item.status === 'waiting');
      this.recentInvitations=data.recentInvitations||[]; this.accountKey=data.accountKey||null;
      this.message = ''; this.emit();
    } catch (error) {
      if (this.stopped || version !== this.version) return;
      if ([401, 428].includes(error.status)) {this.invitations = [];this.recentInvitations=[];this.accountKey=null;}
      this.message = '연결을 확인하고 있습니다. 잠시 후 다시 시도합니다.'; this.emit();
    }
  }
  async respond(id, action) {
    if (this.stopped || this.busy || !['join', 'decline'].includes(action) || !this.invitations.some(item => item.id === id)) return;
    ++this.version; this.busy = id; this.message = ''; this.emit();
    try {
      let result;
      try { result = await this.send(`games/${id}/${action}`, {}); }
      catch (error) {
        // The server may have accepted a join before its response was interrupted.
        if (action !== 'join' || (error.status && error.status < 500)) throw error;
        const current = await this.send(`games/${id}`).catch(() => null);
        if (!current?.game?.color || current.game.status !== 'active') throw error;
        result = current;
      }
      if (this.stopped) return;
      this.invitations = this.invitations.filter(item => item.id !== id);
      this.recentInvitations=this.recentInvitations.map(item=>item.id===id?{...item,status:action==='join'?'active':'declined'}:item);
      if (action === 'join') this.onAccepted(result.game.id);
    } catch (error) {
      if (this.stopped) return;
      this.message = error.message || '요청을 처리하지 못했습니다. 다시 시도해 주세요.';
      if ([401, 403, 404, 409, 428].includes(error.status)) this.invitations = this.invitations.filter(item => item.id !== id);
    } finally {
      this.busy = null; this.emit();
    }
  }
  stop() { this.stopped = true; ++this.version; }
}

function mountInvitations() {
  const bell = document.querySelector('.notification-bell');
  if (!bell) return;
  const element = (tag, className, text) => {
    const node = document.createElement(tag); node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const tray = element('section', 'invitation-tray'); tray.id = 'invitation-tray'; tray.hidden = true;
  tray.setAttribute('aria-label', '받은 대국 요청');
  const heading = element('div', 'invitation-heading', '대국 요청이 왔습니다');
  const list = element('div', 'invitation-list');
  const message = element('p', 'invitation-message'); message.hidden = true; message.setAttribute('role', 'status');
  tray.append(heading, list, message);
  const announcement = element('span', 'notification-announcement');
  announcement.setAttribute('role', 'status'); announcement.setAttribute('aria-atomic', 'true');
  document.body.append(tray, announcement);
  const cards = new Map(); let previousIds = new Set();
  function render(inbox) {
    const count = inbox.invitations.length, ids = new Set(inbox.invitations.map(item => item.id));
    const fresh = inbox.invitations.filter(item => !previousIds.has(item.id));
    if (fresh.length) announcement.textContent = `${fresh.map(item => item.host).join(', ')}님이 대국을 요청했습니다. 우측 상단에서 수락할 수 있습니다.`;
    previousIds = ids;
    notificationCenter?.updateInvitations(inbox.accountKey,inbox.recentInvitations,inbox.invitations);
    for (const [id, card] of cards) if (!ids.has(id)) { card.node.remove(); cards.delete(id); }
    for (const invitation of inbox.invitations) {
      let card = cards.get(invitation.id);
      if (!card) {
        const node = element('article', 'invitation-card'); node.dataset.invitation = invitation.id;
        const name = element('strong', 'invitation-name');
        const description = element('p', 'invitation-description', '함께 1대1 대국을 시작할까요?');
        const time = element('p', 'invitation-time');
        const actions = element('div', 'invitation-actions');
        const accept = element('button', 'invitation-accept', '수락하고 대국');
        const decline = element('button', 'invitation-decline', '거절');
        for (const [button, action] of [[accept, 'join'], [decline, 'decline']]) {
          button.type = 'button';
          button.onclick = async () => { await inbox.respond(invitation.id, action); window.dispatchEvent(new Event('invitations-changed')); };
        }
        actions.append(accept, decline); node.append(name, description, time, actions); list.append(node);
        card = {node, name, time, accept, decline}; cards.set(invitation.id, card);
      }
      card.name.textContent = `${invitation.host}님의 대국 요청`;
      card.time.textContent = invitationTime(invitation.timeControl);
      card.accept.disabled = card.decline.disabled = !!inbox.busy;
      card.node.setAttribute('aria-busy', String(inbox.busy === invitation.id));
    }
    message.textContent = inbox.message; message.hidden = !inbox.message;
    // Connection failures with no pending requests should not obstruct the board.
    tray.hidden = !count;
    if (!count && inbox.message && !inbox.message.startsWith('연결')) announcement.textContent = inbox.message;
  }
  const inbox = new InvitationInbox({onChange: render, onAccepted: id => location.assign('/play?room=' + encodeURIComponent(id))});
  const header = document.querySelector('.topbar, .play-header');
  const positionTray = () => {
    const bottom = Math.max(0, header.getBoundingClientRect().bottom);
    tray.style.setProperty('--invitation-top', Math.min(bottom + 12, innerHeight * .4) + 'px');
  };
  new ResizeObserver(positionTray).observe(header);
  window.addEventListener('scroll', positionTray, {passive: true});
  window.addEventListener('resize', positionTray); positionTray();
  let timer, polling = false, stopped = false;
  async function poll() {
    clearTimeout(timer);
    if (stopped || polling) return;
    polling = true;
    try { await inbox.refresh(); }
    finally { polling = false; if (!stopped) timer = setTimeout(poll, document.hidden ? 30000 : 3000); }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
  window.addEventListener('focus', () => { void poll(); });
  window.addEventListener('account-changed', () => { ++inbox.version; void poll(); });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); inbox.stop(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { stopped = inbox.stopped = false; void poll(); } });
  void poll();
}

if (typeof document !== 'undefined') mountInvitations();
