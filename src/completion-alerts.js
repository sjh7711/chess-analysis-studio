const STORAGE = 'chessreview.completion-alerts.v1';

export class CompletionAlerts {
  constructor({host=globalThis,onNotice=()=>{},onStatus=()=>{}}={}) {
    this.host=host; this.onNotice=onNotice; this.onStatus=onStatus;
    this.preferences={sound:true,desktop:false};
    this.context=null; this.activeRun=null; this.desktopFailed=false;
    this.reloadPreferences();
  }
  reloadPreferences() {
    try {
      const saved=JSON.parse(this.host.localStorage?.getItem(STORAGE) || 'null');
      if (typeof saved?.sound === 'boolean') this.preferences.sound=saved.sound;
      if (typeof saved?.desktop === 'boolean') this.preferences.desktop=saved.desktop;
    } catch { /* Sound and in-page notices still work without storage. */ }
  }
  save() { try { this.host.localStorage?.setItem(STORAGE,JSON.stringify(this.preferences)); } catch {} }
  get permission() { return this.host.isSecureContext && this.host.Notification ? this.host.Notification.permission : 'unsupported'; }
  setSound(enabled) { this.preferences.sound=enabled; this.save(); }
  async toggleDesktop() {
    if (this.preferences.desktop) { this.preferences.desktop=false; this.save(); return; }
    if (['denied','unsupported'].includes(this.permission)) return;
    try {
      const permission=this.permission === 'granted' ? 'granted' : await this.host.Notification.requestPermission();
      this.preferences.desktop=permission === 'granted';
      this.desktopFailed=false; this.save();
    } catch { this.desktopFailed=true; }
  }
  // Called directly from a user gesture to allow sound after a long analysis finishes.
  async prepareSound() {
    if (!this.preferences.sound) return false;
    try {
      const Audio=this.host.AudioContext || this.host.webkitAudioContext;
      if (!Audio) return false;
      if (!this.context || this.context.state === 'closed') this.context=new Audio();
      if (this.context.state === 'suspended') await this.context.resume();
      return this.context.state === 'running';
    } catch { return false; }
  }
  async playSound() {
    if (!await this.prepareSound() || !this.preferences.sound) return false;
    try {
      const context=this.context, start=context.currentTime;
      [523.25,783.99].forEach((frequency,index)=>{
        const oscillator=context.createOscillator(), volume=context.createGain(), at=start+index*.24;
        oscillator.type='sine'; oscillator.frequency.setValueAtTime(frequency,at);
        volume.gain.setValueAtTime(0,at);
        volume.gain.linearRampToValueAtTime(.12,at+.025);
        volume.gain.exponentialRampToValueAtTime(.001,at+.3);
        oscillator.connect(volume); volume.connect(context.destination);
        oscillator.onended=()=>{oscillator.disconnect();volume.disconnect();};
        oscillator.start(at); oscillator.stop(at+.32);
      });
      return true;
    } catch { return false; }
  }
  begin(run) { this.activeRun=run; }
  cancel(run=this.activeRun) { if (run === this.activeRun) this.activeRun=null; }
  complete(run,message) {
    if (this.activeRun === null || run !== this.activeRun) return false;
    this.activeRun=null;
    this.deliver(message,false);
    return true;
  }
  test() { this.deliver('분석 완료 알림 테스트입니다.',true); }
  deliver(message,test) {
    this.onNotice(message,test);
    void this.playSound();
    if (!this.preferences.desktop || this.permission !== 'granted') return;
    try {
      const notification=new this.host.Notification(test ? '체스 분석 · 알림 테스트' : '체스 분석 완료',{
        body:message,tag:'chess-analysis-complete',silent:this.preferences.sound,
      });
      notification.onclick=()=>{this.host.focus?.();notification.close();};
      notification.onerror=()=>{this.desktopFailed=true;this.onStatus();};
    } catch { this.desktopFailed=true; this.onStatus(); }
  }
  dispose() { this.cancel(); if (this.context) void this.context.close().catch(()=>{}); }
}
