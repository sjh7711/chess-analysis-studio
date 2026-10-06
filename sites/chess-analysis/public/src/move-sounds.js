const STORAGE='chessreview.move-sounds.v1';
const RECORDINGS={
  move:new URL('../sounds/chess-move.wav',import.meta.url).href,
  capture:new URL('../sounds/chess-capture.wav',import.meta.url).href,
};

// Polling, request responses, undo, and opening an existing game are silent.
export function hasNewConfirmedMove(previous,next) {
  return !!previous && previous.id===next.id && previous.status==='active'
    && next.moves.length>previous.moves.length
    && previous.moves.every((move,index)=>move===next.moves[index]);
}

export class MoveSounds {
  constructor({host=globalThis,button=null}={}) {
    this.host=host; this.button=button; this.enabled=true; this.context=null;
    this.files=new Map(); this.buffers=new Map(); this.active=null; this.revision=0;
    try { this.enabled=host.localStorage?.getItem(STORAGE)!=='off'; } catch {}
    this.Audio=host.AudioContext||host.webkitAudioContext;
    // Download early, then decode during the first user gesture to avoid move latency.
    if(this.Audio)for(const capture of [false,true])void this.file(capture).catch(()=>{});
    this.unlock=()=>{void this.prepare().then(ready=>{
      if(ready)for(const capture of [false,true])void this.buffer(capture).catch(()=>{});
    });};
    for(const type of ['pointerdown','keydown'])host.document?.addEventListener(type,this.unlock,{capture:true,passive:true});
    host.addEventListener?.('storage',event=>{
      if(event.key===STORAGE)this.setEnabled(event.newValue!=='off',false);
    });
    if(button)button.addEventListener('click',()=>{
      this.setEnabled(!this.enabled);
      if(this.enabled)void this.play();
    });
    this.render();
  }
  render() {
    if(!this.button)return;
    this.button.disabled=!this.Audio;
    this.button.setAttribute('aria-pressed',String(this.enabled&&!!this.Audio));
    this.button.setAttribute('aria-label',this.Audio?`기물 이동 소리 ${this.enabled?'끄기':'켜기'}`:'이 브라우저는 기물 이동 소리를 지원하지 않습니다');
    this.button.title=this.Audio?'기물 이동 소리 켜기·끄기':'';
    this.button.querySelector('.sound-label').textContent=this.Audio?`소리 ${this.enabled?'켜짐':'꺼짐'}`:'소리 미지원';
  }
  setEnabled(enabled,persist=true) {
    this.enabled=enabled; this.revision++;
    if(!enabled)this.stop();
    if(persist)try{this.host.localStorage?.setItem(STORAGE,enabled?'on':'off');}catch{}
    this.render();
  }
  async prepare() {
    if(!this.enabled||!this.Audio)return false;
    try {
      if(!this.context||this.context.state==='closed'){
        this.context=new this.Audio(); this.buffers.clear();
      }
      if(this.context.state==='suspended')await this.context.resume();
      return this.context.state==='running';
    }catch{return false;}
  }
  file(capture) {
    if(this.files.has(capture))return this.files.get(capture);
    const pending=Promise.resolve().then(async()=>{
      const response=await this.host.fetch(RECORDINGS[capture?'capture':'move']);
      if(!response.ok)throw new Error('Move sound could not be loaded');
      return response.arrayBuffer();
    }).catch(error=>{this.files.delete(capture);throw error;});
    this.files.set(capture,pending);return pending;
  }
  buffer(capture) {
    if(this.buffers.has(capture))return this.buffers.get(capture);
    const context=this.context;
    const pending=this.file(capture).then(bytes=>context.decodeAudioData(bytes.slice(0))).catch(error=>{
      if(this.buffers.get(capture)===pending)this.buffers.delete(capture);
      throw error;
    });
    this.buffers.set(capture,pending);return pending;
  }
  stop() {
    if(!this.active)return;
    try{this.active.source.stop();}catch{}
    this.active.source.disconnect();this.active.gain.disconnect();this.active=null;
  }
  async play(move={}) {
    const revision=++this.revision;
    if(!await this.prepare()||!this.enabled||revision!==this.revision)return false;
    try {
      const buffer=await this.buffer(!!move.captured);
      if(!this.enabled||revision!==this.revision)return false;
      this.stop();
      const source=this.context.createBufferSource(),gain=this.context.createGain();
      source.buffer=buffer;
      gain.gain.setValueAtTime(.6,this.context.currentTime);
      source.connect(gain);gain.connect(this.context.destination);
      this.active={source,gain};
      source.onended=()=>{source.disconnect();gain.disconnect();if(this.active?.source===source)this.active=null;};
      source.start();return true;
    }catch{return false;}
  }
}
