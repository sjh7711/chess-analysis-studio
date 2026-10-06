import { Chess } from './chess-core.js';
import { PIECE_THEMES, renderThemedPiece } from './piece-themes.js';

// Older open tabs know only five themes and would overwrite an unknown choice.
export const PIECE_THEME_KEY='chessreview.piece-theme.v2';
let theme='classic';
try{const saved=globalThis.localStorage?.getItem(PIECE_THEME_KEY)??globalThis.localStorage?.getItem('chessreview.piece-theme');if(PIECE_THEMES.some(item=>item.id===saved))theme=saved;}catch{}
export const getPieceTheme=()=>theme;
export function setPieceTheme(value,{persist=true}={}){
  theme=PIECE_THEMES.some(item=>item.id===value)?value:'classic';
  if(persist)try{globalThis.localStorage?.setItem(PIECE_THEME_KEY,theme);}catch{}
  return theme;
}

// Keep only the latest step requested during a move. Complete the current
// animation before consuming it, without building a backlog of clicks.
export class StepNavigation {
  constructor(isMoving) { this.isMoving=isMoving; this.pending=null; }
  request(step) { this.pending=step; this.flush(); }
  cancel() { this.pending=null; }
  flush() {
    if (this.isMoving()) return;
    const step=this.pending;
    this.pending=null;
    step?.();
  }
}

export function pieceSvg(type, color) {
  return renderThemedPiece(type,color,theme);
}

// Count actual captures, not missing starting pieces: promotions and FEN starts
// otherwise make the displayed collection inaccurate.
export function capturedPieces(history) {
  const captured={w:[],b:[]},order='qrbnp';
  for(const move of history) if(move.captured&&order.includes(move.captured)) captured[move.color].push(move.captured);
  for(const list of Object.values(captured)) list.sort((a,b)=>order.indexOf(a)-order.indexOf(b));
  return captured;
}
export function capturedMarkup(pieces,color) {
  const names={p:'폰',n:'나이트',b:'비숍',r:'룩',q:'퀸'},opponent=color==='w'?'b':'w';
  const description=[...new Set(pieces)].map(type=>`${names[type]} ${pieces.filter(p=>p===type).length}개`).join(', ');
  return pieces.length?`<span class="captured-icons" role="img" aria-label="잡은 상대 기물: ${description}" title="잡은 상대 기물: ${description}">${pieces.map(type=>pieceSvg(type,opponent)).join('')}</span>`:'';
}

// Track identities through the history so jumps, captures and promotions use
// the same piece in either direction, including when two rooks look alike.
export function pieceSnapshot(chess, history=chess.history({verbose:true})) {
  const key=history[0]?.before || chess.fen();
  const start=history.length ? new Chess(key) : chess;
  const board=new Map(start.board().flat().filter(Boolean).map(piece=>[piece.square,{...piece,id:`${key}:${piece.square}`} ]));
  for (const move of history) {
    const piece=board.get(move.from);
    board.delete(move.from);
    if (move.flags.includes('e')) board.delete(move.to[0]+move.from[1]);
    board.set(move.to,{...piece,square:move.to,type:move.promotion || move.piece});
    if (move.flags.includes('k') || move.flags.includes('q')) {
      const from=(move.flags.includes('k')?'h':'a')+move.from[1], to=(move.flags.includes('k')?'f':'d')+move.from[1];
      const rook=board.get(from);board.delete(from);board.set(to,{...rook,square:to});
    }
  }
  return {key,pieces:[...board.values()]};
}

export function pieceTransitions(previous,next) {
  const old=new Map(previous.pieces.map(piece=>[piece.id,piece]));
  const pending=[], transitions=[];
  for (const to of next.pieces) {
    const from=old.get(to.id);
    if (from) { old.delete(to.id); transitions.push({from,to}); }
    else pending.push(to);
  }
  // A new PGN/FEN or edited board has a new identity space. Preserve stationary
  // pieces first, then connect matching pieces across the remaining squares.
  if (previous.key!==next.key) {
    const distance=(a,b)=>Math.abs(a.square.charCodeAt(0)-b.square.charCodeAt(0))+Math.abs(Number(a.square[1])-Number(b.square[1]));
    for (const stationary of [true,false]) for (let i=pending.length-1;i>=0;i--) {
      const to=pending[i];
      const from=[...old.values()].filter(p=>p.type===to.type && p.color===to.color && (!stationary || p.square===to.square))
        .sort((a,b)=>distance(a,to)-distance(b,to))[0];
      if (from) { old.delete(from.id);pending.splice(i,1);transitions.push({from,to}); }
    }
  }
  return [...transitions,...pending.map(to=>({to})),...[...old.values()].map(from=>({from}))];
}
