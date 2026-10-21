// Keep action buttons alive from pointerdown through click. Engine results may
// update the explanation in that interval, but replacing its DOM loses clicks.
export class StableActionMarkup {
  constructor({render,schedule=fn=>setTimeout(fn,0),cancel=clearTimeout}={}) {
    if(typeof render!=='function'||typeof schedule!=='function'||typeof cancel!=='function')
      throw new TypeError('Stable action markup requires render and timer functions.');
    this.render=render;
    this.schedule=schedule;
    this.cancel=cancel;
    this.pointer=null;
    this.latest=undefined;
    this.shown=undefined;
    this.pending=false;
    this.timer=null;
    this.revision=0;
    this.disposed=false;
  }

  update(markup) {
    if(this.disposed)return;
    this.latest=markup;
    this.pending=markup!==this.shown;
    if(this.pointer!==null)return;
    // A click can render a new selection before the deferred engine update is
    // flushed. Its newer markup replaces that pending value, including a
    // selection whose markup equals the last displayed value.
    this.cancelFlush();
    this.flush();
  }

  hold(pointerId) {
    if(this.disposed||!Number.isInteger(pointerId))return false;
    if(this.pointer!==null)return this.pointer===pointerId;
    this.cancelFlush();
    this.pointer=pointerId;
    return true;
  }

  release(pointerId) {
    if(this.disposed||this.pointer===null||this.pointer!==pointerId)return false;
    this.pointer=null;
    if(this.pending) {
      const revision=++this.revision;
      this.timer=this.schedule(()=>{
        if(this.disposed||revision!==this.revision)return;
        this.timer=null;
        this.flush();
      });
    }
    return true;
  }

  cancelHold(pointerId) {
    if(this.disposed||pointerId!==undefined&&(this.pointer===null||this.pointer!==pointerId))return false;
    this.pointer=null;
    this.cancelFlush();
    this.flush();
    return true;
  }

  cancelFlush() {
    this.revision++;
    if(this.timer!==null)this.cancel(this.timer);
    this.timer=null;
  }

  flush() {
    if(this.disposed||this.pointer!==null||!this.pending)return;
    this.pending=false;
    this.shown=this.latest;
    this.render(this.shown);
  }

  dispose() {
    if(this.disposed)return;
    this.cancelFlush();
    this.pointer=null;
    this.pending=false;
    this.disposed=true;
  }
}
