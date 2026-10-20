import { Chess } from './chess-core.js';

const CENTRAL = new Set(['d4','e4','d5','e5']);
const VALUABLE = new Set(['n','b','r','q']);
const opposite = color => color==='w'?'b':'w';

function reviewedPosition(move) {
  if(!move || typeof move.before!=='string' || typeof move.after!=='string'
    || !/^[a-h][1-8]$/.test(move.from) || !/^[a-h][1-8]$/.test(move.to))return null;
  try {
    const before=new Chess(move.before);
    if(before.isGameOver())return null;
    const actual=before.move({from:move.from,to:move.to,...(move.promotion?{promotion:move.promotion}:{})});
    for(const key of ['color','piece','captured','promotion'])if((actual[key]??null)!==(move[key]??null))return null;
    if(typeof move.flags==='string' && actual.flags!==move.flags)return null;
    if(before.fen()!==move.after || before.isGameOver())return null;
    return before;
  } catch { return null; }
}

// A teaching arrow shows control after the played move, not a second turn.
// Probe a legal capture to exclude pinned pieces and unsafe king destinations.
// Friendly kings are never removed or replaced to make a probe succeed.
function controls(position,from,to,color) {
  if(from===to || position.get(to)?.type==='k')return false;
  try {
    const fields=position.fen().split(' ');
    fields[1]=color;fields[3]='-';
    const probe=new Chess(fields.join(' ')),target=probe.get(to);
    if(!target || target.color===color) {
      if(target)probe.remove(to);
      if(!probe.put({type:'p',color:opposite(color)},to))return false;
    }
    return probe.moves({square:from,verbose:true}).some(capture=>capture.to===to && capture.captured && capture.captured!=='k');
  } catch { return false; }
}

/**
 * Two arrows for two board-verified targets actually named by this caption.
 * An ambiguous/single-target/conditional caption returns [] so its caller can
 * retain the ordinary one-move recommendation. No game/result is mutated.
 */
export function explanationArrows(move,caption) {
  if(typeof caption!=='string' || !caption.trim() || caption.length>2048
    || /잡으면|수락|예상\s*수순|다음\s*수|이어지|이후|대신|했어야|기회를?\s*놓|체크한\s*뒤/.test(caption))return [];
  const position=reviewedPosition(move);
  if(!position)return [];
  const named=[...new Set((caption.match(/(?<![a-z0-9])[a-h][1-8](?![a-z0-9])/gi)||[]).map(square=>square.toLowerCase()))];
  const from=move.to,color=move.color;
  const attackTargets=named.filter(square=>{
    const target=position.get(square);
    return target?.color===opposite(color) && VALUABLE.has(target.type) && controls(position,from,square,color);
  });

  // A discovered check must not draw a false check arrow from the moved piece.
  if(/체크(?:하면서|하며)/.test(caption) && /공격|겨냥/.test(caption)) {
    const king=position.board().flat().find(piece=>piece?.color===opposite(color) && piece.type==='k');
    if(king && position.isCheck() && position.attackers(king.square,color).includes(from) && attackTargets.length===1)
      return [{from,to:king.square,kind:'check'},{from,to:attackTargets[0],kind:'attack'}];
    return [];
  }

  if(/동시|두\s*(?:기물|대상)|함께\s*(?:공격|겨냥)/.test(caption) && /공격|겨냥/.test(caption)) {
    return attackTargets.length===2?attackTargets.map(to=>({from,to,kind:'attack'})):[];
  }

  if(/중앙|칸/.test(caption) && /제어|통제|겨냥/.test(caption)) {
    const targets=named.filter(to=>CENTRAL.has(to) && controls(position,from,to,color));
    return targets.length===2?targets.map(to=>({from,to,kind:position.get(to)?.color===color?'support':'control'})):[];
  }
  return [];
}
