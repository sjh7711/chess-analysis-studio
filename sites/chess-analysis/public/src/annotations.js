export class BoardMarks {
  constructor(){this.items=new Map();this.position=null;}
  toggle(from,to){
    if(!/^[a-h][1-8]$/.test(from)||!/^[a-h][1-8]$/.test(to))return;
    const key=from+to;
    if(this.items.has(key))this.items.delete(key);else this.items.set(key,{from,to});
  }
  clear(){this.items.clear();}
  sync(position){if(this.position!==position){this.clear();this.position=position;}}
}

// Private, transient board markup. It never enters the PGN or server requests.
export class BoardAnnotations {
  constructor(board,{isFlipped,toggleButton,clearButton,enabled=()=>true}){
    this.board=board;this.isFlipped=isFlipped;this.enabled=enabled;this.toggleButton=toggleButton;this.clearButton=clearButton;
    this.marks=new BoardMarks();this.mode=false;this.drag=null;this.suppressClick=false;
    this.overlay=document.createElementNS('http://www.w3.org/2000/svg','svg');
    this.overlay.setAttribute('viewBox','0 0 800 800');this.overlay.setAttribute('aria-hidden','true');this.overlay.classList.add('board-annotations');board.parentElement.append(this.overlay);
    toggleButton.addEventListener('click',()=>this.setMode(!this.mode));clearButton.addEventListener('click',()=>this.clear());
    const stop=event=>{event.preventDefault();event.stopImmediatePropagation();};
    board.addEventListener('contextmenu',event=>{if(this.enabled())event.preventDefault();});
    board.addEventListener('pointerdown',event=>{
      if(!this.enabled()||!(event.button===2||(this.mode&&event.button===0)))return;
      const square=this.squareAt(event);if(!square)return;stop(event);
      this.drag={from:square,to:square,id:event.pointerId};board.setPointerCapture(event.pointerId);this.render();
    },true);
    board.addEventListener('pointermove',event=>{if(this.drag?.id!==event.pointerId)return;stop(event);this.drag.to=this.squareAt(event);this.render();},true);
    board.addEventListener('pointerup',event=>{
      if(this.drag?.id!==event.pointerId)return;stop(event);
      const {from}=this.drag,to=this.squareAt(event);this.cancelDrag();if(to)this.marks.toggle(from,to);
      this.suppressClick=true;setTimeout(()=>{this.suppressClick=false;},0);this.render();
    },true);
    board.addEventListener('pointercancel',event=>{if(this.drag?.id!==event.pointerId)return;stop(event);this.cancelDrag();this.render();},true);
    board.addEventListener('lostpointercapture',()=>{if(this.drag){this.drag=null;this.render();}});
    board.addEventListener('click',event=>{
      if(this.suppressClick){stop(event);return;}
      if(this.mode&&this.enabled()){stop(event);const square=event.target.closest('[data-square]')?.dataset.square;if(square)this.marks.toggle(square,square);this.render();}
    },true);
    board.addEventListener('dragstart',event=>{if(this.mode||this.drag)stop(event);},true);
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.querySelector('dialog[open]')){this.clear();this.setMode(false);}});
    this.render();
  }
  squareAt(event){const rect=this.board.getBoundingClientRect(),x=Math.floor((event.clientX-rect.left)/rect.width*8),y=Math.floor((event.clientY-rect.top)/rect.height*8);if(x<0||x>7||y<0||y>7)return null;return String.fromCharCode(97+(this.isFlipped()?7-x:x))+(this.isFlipped()?y+1:8-y);}
  cancelDrag(){const id=this.drag?.id;this.drag=null;if(id!==undefined&&this.board.hasPointerCapture(id))this.board.releasePointerCapture(id);}
  setMode(mode){this.cancelDrag();this.mode=mode;this.toggleButton.setAttribute('aria-pressed',String(mode));this.toggleButton.textContent=mode?'표기 모드 켜짐':'표기 모드';this.board.classList.toggle('marking-mode',mode);this.render();}
  clear(){this.cancelDrag();this.marks.clear();this.render();}
  sync(position){if(this.marks.position!==position)this.cancelDrag();this.marks.sync(position);if(!this.enabled()&&this.mode)this.setMode(false);this.render();}
  render(){
    const xy=square=>{const x=square.charCodeAt(0)-97,y=8-Number(square[1]);return this.isFlipped()?[(7-x)*100+50,(7-y)*100+50]:[x*100+50,y*100+50];};
    const items=[...this.marks.items.values(),...(this.drag?.to?[this.drag]:[])];
    this.overlay.innerHTML=items.map(({from,to})=>{
      const [x1,y1]=xy(from),[x2,y2]=xy(to);
      if(from===to)return `<rect x="${x1-48}" y="${y1-48}" width="96" height="96" rx="7" fill="#79aa37" fill-opacity=".36" stroke="#638f2c" stroke-width="5"/>`;
      const angle=Math.atan2(y2-y1,x2-x1),c=Math.cos(angle),s=Math.sin(angle),endX=x2-27*c,endY=y2-27*s;
      return `<path d="M${x1} ${y1}L${endX} ${endY}" stroke="#82b33d" stroke-width="18" stroke-linecap="round" opacity=".85"/><path d="M${x2} ${y2}L${x2-40*c+23*s} ${y2-40*s-23*c}L${x2-40*c-23*s} ${y2-40*s+23*c}Z" fill="#82b33d" opacity=".9"/>`;
    }).join('');this.clearButton.disabled=!this.marks.items.size;
  }
}
