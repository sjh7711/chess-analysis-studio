import {Chess} from '../node_modules/chess.js/dist/esm/chess.js';

const values={p:1,n:3,b:3,r:5,q:9,k:0};
const uci=move=>move.from+move.to+(move.promotion||'');
const square=move=>move.flags.includes('e')?move.to[0]+move.from[1]:move.to;
const promotion=move=>move.promotion?values[move.promotion]-1:0;
const material=(chess,color)=>chess.board().flat().filter(Boolean)
  .reduce((sum,piece)=>sum+values[piece.type]*(piece.color===color?1:-1),0);
const validUci=value=>typeof value==='string'&&/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value);
const DEFAULT_BUDGET=4096,MAX_PV_PLIES=64,MAX_HISTORY_PLIES=512;

function workFor(options={}){
  const budget=options.nodeBudget??DEFAULT_BUDGET;
  if(!Number.isInteger(budget)||budget<1||budget>65536)throw Error('Invalid proof budget.');
  return {budget,nodes:0,exhausted:false,histories:new WeakMap(),depths:new WeakMap()};
}
function spend(work,count=1){
  if(work.nodes+count>work.budget){work.exhausted=true;throw Error('Capture proof budget exhausted.');}
  work.nodes+=count;
}
function play(chess,move,work){
  spend(work);if(!validUci(move)||chess.isGameOver())throw Error('Invalid or terminal continuation.');
  const step=chess.move(move);work.depths.set(chess,(work.depths.get(chess)||0)+1);
  if(uci(step)!==move)throw Error('Noncanonical move.');return step;
}
function undo(chess,work){chess.undo();work.depths.set(chess,work.depths.get(chess)-1);}
function checkpoint(chess,work,callback){
  const start=work.depths.get(chess)||0;
  try{return callback();}finally{while((work.depths.get(chess)||0)>start)undo(chess,work);}
}
function legal(chess,work){spend(work);const moves=chess.moves({verbose:true});spend(work,moves.length);return moves;}
function copyHistory(position,work){
  if(!position||typeof position.history!=='function')throw Error('Actual position history required.');
  let history=work.histories.get(position);
  if(!history){history=position.history({verbose:true});if(history.length>MAX_HISTORY_PLIES)throw Error('History proof limit.');work.histories.set(position,history);}
  const chess=new Chess(history[0]?.before||position.fen());
  for(const source of history){if(chess.fen()!==source.before)throw Error('History position mismatch.');if(play(chess,uci(source),work).after!==source.after)throw Error('History move mismatch.');}
  if(chess.fen()!==position.fen())throw Error('History final position mismatch.');
  return chess;
}
function replay(root,pv,work){
  if(!Array.isArray(pv)||!pv.length||pv.length>MAX_PV_PLIES)throw Error('Missing or excessive PV.');
  return checkpoint(root,work,()=>{const moves=pv.map(move=>play(root,move,work));return {terminal:root.isGameOver(),moves};});
}

// Legal same-square exchange accounting. The defender may stop exchanging;
// this is a local material certificate, not proof of the game's final result.
function exchangeGain(chess,target,memo,work){
  const victim=chess.get(target);
  if(chess.isGameOver()||!victim||victim.color===chess.turn()||victim.type==='k')return 0;
  const key=chess.fen()+'|'+target;if(memo.has(key))return memo.get(key);
  let best=0;
  for(const capture of legal(chess,work)){
    if(!capture.captured||square(capture)!==target)continue;
    play(chess,uci(capture),work);
    const gain=chess.isGameOver()&&!chess.isCheckmate()?0
      :values[capture.captured]+promotion(capture)-exchangeGain(chess,capture.to,memo,work);
    undo(chess,work);best=Math.max(best,gain);
  }
  memo.set(key,best);return best;
}
function captureGain(chess,capture,work){
  if(!capture.captured)return 0;
  return checkpoint(chess,work,()=>{
    play(chess,uci(capture),work);
    return chess.isGameOver()&&!chess.isCheckmate()?0
      :values[capture.captured]+promotion(capture)-exchangeGain(chess,capture.to,new Map(),work);
  });
}
function captures(chess,minimum,work){
  if(chess.isGameOver())return [];
  const out=[];
  for(const move of legal(chess,work)){
    if(!move.captured||!['n','b','r','q'].includes(move.captured))continue;
    const gain=captureGain(chess,move,work);
    if(gain>=minimum)out.push({uci:uci(move),san:move.san,captured:move.captured,gain});
  }
  return out;
}
function certifyAttack(position,first,minimum,work){
  const chess=position;return checkpoint(chess,work,()=>{if(chess.isGameOver()||!validUci(first))return null;
  const attacker=chess.turn(),initial=material(chess,attacker),start=legal(chess,work).find(move=>uci(move)===first);
  if(!start)return null;
  const immediate=start.captured&&['n','b','r','q'].includes(start.captured)?captureGain(chess,start,work):0;
  play(chess,first,work);
  if(immediate>=minimum)return {kind:'immediate-capture',first,firstSan:start.san,gain:immediate,captured:start.captured,certificates:[]};
  if(chess.isGameOver())return null;
  const replies=legal(chess,work),certificates=[];if(!replies.length)return null;
  for(const reply of replies){
    play(chess,uci(reply),work);if(chess.isGameOver())return null;
    const delta=material(chess,attacker)-initial;
    const finish=captures(chess,Math.max(0,minimum-delta),work).find(move=>delta+move.gain>=minimum);
    undo(chess,work);if(!finish)return null;
    certificates.push({reply:uci(reply),replySan:reply.san,finish:finish.uci,finishSan:finish.san,gain:delta+finish.gain,captured:finish.captured});
  }
  return {kind:start.san.endsWith('+')?'checking-capture':'attacking-capture',first,firstSan:start.san,
    minimumGain:Math.min(...certificates.map(item=>item.gain)),certificates};
  });
}
function validMinimum(minimum){return Number.isInteger(minimum)&&minimum>=1&&minimum<=9;}

export function certifyMaterialAttack(position,first,minimum=3,options={}){
  try{if(!validMinimum(minimum))return null;const work=workFor(options),proof=certifyAttack(copyHistory(position,work),first,minimum,work);
    return proof?{...proof,work:{nodes:work.nodes,budget:work.budget}}:null;
  }catch{return null;}
}
export function immediateMaterialCaptures(position,minimum=3,options={}){
  try{if(!validMinimum(minimum))return [];const work=workFor(options);return captures(copyHistory(position,work),minimum,work);}
  catch{return [];}
}

function snapshotLoss(root,line,snapshot,color){
  if(!snapshot||!Number.isInteger(snapshot.start)||!Number.isInteger(snapshot.end)||!Number.isFinite(snapshot.loss))return null;
  if(snapshot.start===0)return snapshot.end===0&&snapshot.loss===0?0:null;
  if(snapshot.start<1||snapshot.start>6||snapshot.end<snapshot.start||snapshot.end>12||snapshot.end>line.moves.length)return null;
  if(!line.moves[snapshot.start-1].captured&&!line.moves[snapshot.start-1].promotion)return null;
  const last=line.moves[snapshot.end-1],position=new Chess(last.after),loss=material(root,color)-material(position,color);
  return loss===snapshot.loss?loss:null;
}

// The caller supplies completed, configuration-bound root searches and keeps
// all original scores and expected-point bands. This additional certificate
// rechecks the actual history/PVs and provides only the smaller guaranteed
// material deficit, never a remote PV's larger sampled loss.
export function inspectCertifiedTacticalLoss({root,move,bestUci,playedPv,bestPv,playedSnapshot,bestSnapshot,minimum=3,nodeBudget,allowLosingMates=false}={}){
  let work;
  try{
    work=workFor({nodeBudget});if(!validMinimum(minimum)||!move||!validUci(bestUci)||root.fen()!==move.before)return {evidence:null,work:{nodes:work.nodes,budget:work.budget}};
    if(!Array.isArray(playedPv)||playedPv[0]!==uci(move)||!playedPv[1]||!Array.isArray(bestPv)||bestPv[0]!==bestUci||bestUci===uci(move))throw Error('Unbound material PV.');
    const position=copyHistory(root,work),played=replay(position,playedPv,work),best=replay(position,bestPv,work);
    if(played.moves[0].after!==move.after||played.moves[0].color!==move.color||played.moves[0].piece!==move.piece)throw Error('Actual move mismatch.');
    // The caller may separately certify that both completed engine branches
    // end in the mover's forced loss. A draw or the mover's mate remains an
    // invalid material-loss example, and ordinary CP reviews keep the stricter
    // terminal guard.
    const excludedTerminal=line=>{
      if(!line.terminal)return false;
      if(allowLosingMates!==true)return true;
      const end=new Chess(line.moves.at(-1).after);
      return !end.isCheckmate() || end.turn()!==move.color;
    };
    if(excludedTerminal(played)||excludedTerminal(best)||[...played.moves,...best.moves].some(step=>step.color===move.color&&step.promotion))throw Error('Terminal or promotion compensation.');
    const playedLoss=snapshotLoss(position,played,playedSnapshot,move.color),bestLoss=snapshotLoss(position,best,bestSnapshot,move.color);
    if(playedLoss===null||bestLoss===null||playedLoss-Math.max(0,bestLoss)<minimum)throw Error('Unproved relative material deficit.');
    const {proof,actualMove}=checkpoint(position,work,()=>{
      const actualMove=play(position,uci(move),work);return {actualMove,proof:certifyAttack(position,playedPv[1],minimum,work)};
    });
    if(!proof)throw Error('Missing attack proof.');
    const bestAlsoLoses=checkpoint(position,work,()=>{
      play(position,bestUci,work);return captures(position,minimum,work).length>0||certifyAttack(position,playedPv[1],minimum,work);
    });
    if(bestAlsoLoses)throw Error('Comparable best loss.');
    const actorFirstGain=(actualMove.captured?values[actualMove.captured]:0)+promotion(actualMove);
    const certifiedLoss=(proof.minimumGain??proof.gain)-actorFirstGain,additional=certifiedLoss-Math.max(0,bestLoss);
    if(additional<minimum)throw Error('Capture compensation removes the deficit.');
    const evidence={version:1,kind:'certified-material-loss',additional,sampledAdditional:playedLoss-Math.max(0,bestLoss),actorFirstGain,certifiedLoss,proof,
      played:{start:playedSnapshot.start,end:playedSnapshot.end,loss:playedLoss},best:{start:bestSnapshot.start,end:bestSnapshot.end,loss:Math.max(0,bestLoss)},nearPlies:6,maxPlies:12,
      work:{nodes:work.nodes,budget:work.budget}};
    return {evidence,work:{nodes:work.nodes,budget:work.budget,exhausted:false}};
  }catch{return {evidence:null,work:{nodes:work?.nodes??0,budget:work?.budget??null,exhausted:work?.exhausted??false}};}
}
export function certifiedTacticalLoss(options){return inspectCertifiedTacticalLoss(options).evidence;}
