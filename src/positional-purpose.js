import { Chess } from './chess-core.js';

const square = (file,rank) => file>=0 && file<8 && rank>=1 && rank<=8 ? `${String.fromCharCode(97+file)}${rank}` : null;

function playedPawn(move) {
  if(!move || move.piece!=='p' || move.captured || move.promotion)return null;
  try {
    const position=new Chess(move.before),actual=position.move({from:move.from,to:move.to});
    if(actual.piece!=='p' || actual.color!==move.color || actual.captured || actual.promotion
      || position.fen()!==move.after || position.isGameOver())return null;
    return position;
  } catch { return null; }
}

function supportsPawn(position,from,to,color) {
  try {
    const fields=position.fen().split(' ');fields[1]=color;fields[3]='-';
    const probe=new Chess(fields.join(' '));
    probe.remove(to);
    if(!probe.put({type:'p',color:color==='w'?'b':'w'},to))return false;
    return probe.moves({square:from,verbose:true}).some(step=>step.to===to && step.captured==='p');
  } catch { return false; }
}

/** A quiet pawn's visible positional purpose, with no evaluation or win claim. */
export function positionalPawnPurpose(move) {
  const position=playedPawn(move);
  if(!position)return '';
  const file=move.to.charCodeAt(0)-97,rank=Number(move.to[1]),direction=move.color==='w'?1:-1;
  const distance=move.color==='w'?8-rank:rank-1;
  const enemy=move.color==='w'?'b':'w';
  const passed=!position.board().flat().some(piece=>piece?.color===enemy && piece.type==='p'
    && Math.abs(piece.square.charCodeAt(0)-97-file)<=1 && (Number(piece.square[1])-rank)*direction>0);
  const forward=Array.from({length:distance},(_,index)=>square(file,rank+direction*(index+1)));
  if(passed && distance>=1 && distance<=3 && forward.every(to=>!position.get(to))) {
    const remaining=['','한 칸','두 칸','세 칸'][distance];
    return `통과 폰을 ${move.to}로 전진시켜 승격까지 ${remaining}을 남겨둡니다.`;
  }
  const supported=[square(file-1,rank+direction),square(file+1,rank+direction)]
    .filter(to=>to && position.get(to)?.type==='p' && position.get(to)?.color===move.color
      && supportsPawn(position,move.to,to,move.color));
  if(supported.length)return `${supported.join('·')}의 폰을 뒷받침하는 폰 사슬을 만듭니다.`;
  return '';
}
