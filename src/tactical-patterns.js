import { Chess, validateFen } from '../node_modules/chess.js/dist/esm/chess.js';

const cache=new WeakMap();
const moveCache=new WeakMap();
const major=type=>['n','b','r','q'].includes(type);
const slider=type=>['b','r','q'].includes(type);
const men=position=>position.board().flat().filter(Boolean);
const at=square=>[square.charCodeAt(0)-97,Number(square[1])-1];
const square=(file,rank)=>file>=0&&file<8&&rank>=0&&rank<8?`${String.fromCharCode(97+file)}${rank+1}`:null;

function direction(from,to) {
  const [fromFile,fromRank]=at(from),[toFile,toRank]=at(to),file=toFile-fromFile,rank=toRank-fromRank;
  return file===0&&rank!==0 || rank===0&&file!==0 || Math.abs(file)===Math.abs(rank)&&file!==0
    ? [Math.sign(file),Math.sign(rank)]:null;
}

function between(from,to,blocked) {
  const step=direction(from,to);
  if(!step)return false;
  let [file,rank]=at(from);
  for(let next=square(file+=step[0],rank+=step[1]);next&&next!==to;next=square(file+=step[0],rank+=step[1])) {
    if(next===blocked)return true;
  }
  return false;
}

function validatedMove(move) {
  if(!move || typeof move.before!=='string' || typeof move.after!=='string'
    || move.before.trim().split(/\s+/).length!==6 || !validateFen(move.before).ok || !validateFen(move.after).ok)return null;
  try {
    const before=new Chess(move.before),enemy=before.turn()==='w'?'b':'w';
    const king=men(before).find(piece=>piece.color===enemy&&piece.type==='k');
    if(!king || before.isAttacked(king.square,before.turn()) || before.isInsufficientMaterial() || before.isDrawByFiftyMoves())return null;
    for(const color of ['w','b']) {
      const pieces=men(before).filter(piece=>piece.color===color);
      if(pieces.length>16 || pieces.filter(piece=>piece.type==='p').length>8)return null;
    }
    const rights=move.before.trim().split(/\s+/)[2];
    for(const [right,kingSquare,rookSquare,color] of [['K','e1','h1','w'],['Q','e1','a1','w'],['k','e8','h8','b'],['q','e8','a8','b']]) {
      if(rights.includes(right) && (before.get(kingSquare)?.type!=='k' || before.get(kingSquare)?.color!==color
        || before.get(rookSquare)?.type!=='r' || before.get(rookSquare)?.color!==color))return null;
    }
    const after=new Chess(move.before),actual=after.move({from:move.from,to:move.to,promotion:move.promotion});
    if(after.fen()!==move.after || actual.color!==move.color || actual.piece!==move.piece
      || actual.san!==move.san || actual.flags!==move.flags
      || (actual.captured||null)!==(move.captured||null) || (actual.promotion||null)!==(move.promotion||null))return null;
    return {before,after,actual};
  } catch { return null; }
}

function legalMoves(position,color) {
  let colors=moveCache.get(position);
  if(!colors){colors=new Map();moveCache.set(position,colors);}
  if(colors.has(color))return colors.get(color);
  const fields=position.fen().split(' ');
  if(fields[1]!==color){fields[1]=color;fields[3]='-';}
  const result=new Chess(fields.join(' ')).moves({verbose:true});
  colors.set(color,result);return result;
}
const captures=(position,color)=>legalMoves(position,color).filter(move=>move.captured&&move.captured!=='k');

function discoveredAttacks(move,before,after) {
  const attackers=men(after).filter(piece=>piece.color===move.color&&slider(piece.type)&&piece.square!==move.to
    && before.get(piece.square)?.color===move.color&&before.get(piece.square)?.type===piece.type);
  const targets=men(after).filter(piece=>piece.color!==move.color&&major(piece.type)
    && before.get(piece.square)?.color===piece.color&&before.get(piece.square)?.type===piece.type);
  const candidates=attackers.flatMap(attacker=>targets.filter(target=>between(attacker.square,target.square,move.from))
    .map(target=>({attacker,target})));
  if(!candidates.length)return [];
  const beforeCaptures=captures(before,move.color),afterCaptures=captures(after,move.color),found=[];
  for(const {attacker,target} of candidates) {
    if(!afterCaptures.some(capture=>capture.from===attacker.square&&capture.to===target.square)
      || beforeCaptures.some(previous=>previous.from===attacker.square&&previous.to===target.square))continue;
    found.push({color:move.color,attackerSquare:attacker.square,attackerType:attacker.type,
      targetSquare:target.square,targetType:target.type});
  }
  return found;
}

function checkingSkewers(move,after) {
  if(!after.isCheck())return [];
  const king=men(after).find(piece=>piece.color!==move.color&&piece.type==='k'),found=[];
  const replies=after.moves({verbose:true}).filter(reply=>reply.piece==='k');
  for(const attackerSquare of after.attackers(king.square,move.color)) {
    const attacker=after.get(attackerSquare),step=direction(attackerSquare,king.square);
    if(!slider(attacker.type) || !step)continue;
    let [file,rank]=at(king.square),target=null;
    for(let next=square(file+=step[0],rank+=step[1]);next;next=square(file+=step[0],rank+=step[1])) {
      const piece=after.get(next);
      if(piece){target={square:next,...piece};break;}
    }
    if(!target || target.color===move.color || !major(target.type))continue;
    // Geometry alone is insufficient for a pinned checking piece. Verify a
    // legal king escape after which this same slider can actually take the rear
    // piece. This proves a possible attack, never that the king must choose it.
    const exposed=replies.some(reply=>{
      const position=new Chess(reply.after),still=position.get(attackerSquare);
      return still?.color===move.color && still.type===attacker.type && captures(position,move.color)
        .some(capture=>capture.from===attackerSquare&&capture.to===target.square&&capture.captured===target.type);
    });
    if(exposed)found.push({color:move.color,attackerSquare,attackerType:attacker.type,kingSquare:king.square,
      targetSquare:target.square,targetType:target.type});
  }
  return found;
}

function defensiveBlocks(move,before,after) {
  if(move.captured || move.piece==='k')return [];
  const enemy=move.color==='w'?'b':'w',king=men(before).find(piece=>piece.color===move.color&&piece.type==='k');
  const attackers=men(before).filter(piece=>piece.color===enemy&&slider(piece.type));
  const targets=men(before).filter(piece=>piece.color===move.color&&major(piece.type)&&piece.square!==move.from);
  if(!attackers.some(attacker=>targets.some(target=>between(attacker.square,target.square,move.to)
    || between(attacker.square,king.square,target.square)&&between(attacker.square,king.square,move.to))))return [];
  const beforeCaptures=captures(before,enemy),afterCaptures=captures(after,enemy),found=[];
  for(const capture of beforeCaptures) {
    if(!slider(capture.piece) || !major(capture.captured) || capture.to===move.from)continue;
    const attacker=after.get(capture.from),target=after.get(capture.to);
    if(attacker?.color!==enemy || attacker.type!==capture.piece || target?.color!==move.color
      || target.type!==capture.captured || !between(capture.from,capture.to,move.to)
      || afterCaptures.some(next=>next.from===capture.from&&next.to===capture.to))continue;
    found.push({kind:'block',color:move.color,blockSquare:move.to,attackerSquare:capture.from,attackerType:capture.piece,
      protectedSquare:capture.to,protectedType:capture.captured});
  }
  const pins=beforeCaptures.filter(capture=>slider(capture.piece)&&major(capture.captured)&&capture.to!==move.from
    && between(capture.from,king.square,capture.to)&&between(capture.from,king.square,move.to));
  if(!pins.length)return found;
  const ownBefore=legalMoves(before,move.color),ownAfter=legalMoves(after,move.color);
  for(const capture of pins) {
    const target=after.get(capture.to),attacker=after.get(capture.from);
    if(target?.color!==move.color || target.type!==capture.captured || attacker?.color!==enemy || attacker.type!==capture.piece)continue;
    const removed=new Chess(move.before);removed.remove(capture.to);
    if(!removed.attackers(king.square,enemy).includes(capture.from))continue;
    const newlyFree=ownAfter.some(step=>step.from===capture.to && step.to!==capture.from
      && !between(capture.from,king.square,step.to)
      && !ownBefore.some(previous=>previous.from===step.from&&previous.to===step.to&&(previous.promotion||null)===(step.promotion||null)));
    if(newlyFree && !found.some(item=>item.protectedSquare===capture.to))found.push({kind:'unpin',color:move.color,
      blockSquare:move.to,attackerSquare:capture.from,attackerType:capture.piece,protectedSquare:capture.to,protectedType:capture.captured});
  }
  return found;
}

function promotionEscapes(move,before,after) {
  if(move.piece==='p')return [];
  const enemy=move.color==='w'?'b':'w',pawns=men(before).filter(piece=>piece.color===enemy&&piece.type==='p'&&piece.square[1]===(enemy==='w'?'7':'2'));
  if(!pawns.length)return [];
  const attacks=captures(before,enemy).filter(capture=>capture.to===move.from);
  if(!attacks.length || captures(after,enemy).some(capture=>capture.to===move.to))return [];
  const found=[];
  for(const pawn of pawns) {
    const promotionSquare=pawn.square[0]+(enemy==='w'?'8':'1');
    const guards=(position,from)=>{
      const promoted=legalMoves(position,enemy).find(step=>step.from===pawn.square&&step.to===promotionSquare&&step.promotion==='q'&&!step.captured);
      return promoted && new Chess(promoted.after).moves({verbose:true})
        .some(reply=>reply.from===from&&reply.to===promotionSquare&&reply.captured==='q'&&reply.piece===move.piece);
    };
    if(after.get(pawn.square)?.color!==enemy || after.get(pawn.square)?.type!=='p'
      || !guards(before,move.from) || !guards(after,move.to))continue;
    found.push({color:move.color,from:move.from,to:move.to,piece:move.piece,pawnSquare:pawn.square,promotionSquare,
      attackerSquare:attacks[0].from,attackerType:attacks[0].piece});
  }
  return found;
}

/** Verified board patterns only. Grades, scores and prose belong to callers. */
export function tacticalPatterns(move) {
  if(!move || typeof move!=='object')return null;
  const signature=[move.before,move.after,move.from,move.to,move.piece,move.color,move.captured,move.promotion,move.san,move.flags].join('|');
  const cached=cache.get(move);
  if(cached?.signature===signature)return cached.result;
  const board=validatedMove(move);
  const freeze=items=>Object.freeze(items.map(item=>Object.freeze(item)));
  const result=board?Object.freeze({discovered:freeze(discoveredAttacks(board.actual,board.before,board.after)),
    skewers:freeze(checkingSkewers(board.actual,board.after)),blocks:freeze(defensiveBlocks(board.actual,board.before,board.after)),
    promotionEscapes:freeze(promotionEscapes(board.actual,board.before,board.after))}):null;
  cache.set(move,{signature,result});
  return result;
}
