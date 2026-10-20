import { Chess, classifyMove, assessedMoveResult, reviewedSacrificeEvidence, sacrificeCandidates, isRecapture, GRADING_BASIS, formatScore, gameAt, scoreValue, uciMove } from './chess-core.js';
import { AnalysisLine, PIECE_NAMES, cloneChess, materialBalance, moveText } from './study.js';
import { positionalPawnPurpose } from './positional-purpose.js';
import { tacticalPatterns } from './tactical-patterns.js';

const side = color => color === 'w' ? '백' : '흑';
const object = type => PIECE_NAMES[type]+(type === 'n' ? '를' : '을');
export const moveTurn = move => `${side(move.color)}의 ${move.before.split(' ')[5]}번째 수`;
export const moveLabel = move => `${moveTurn(move)} · ${PIECE_NAMES[move.piece]} ${move.from}에서 ${move.to}로`;
const mateWinner = score => score?.type === 'mate' ? (scoreValue(score) > 0 ? 'w' : 'b') : null;

// Explanation searches are separate from game grading. Bind their cache to
// the original position, history and completed review, never a refined insight.
export function insightIdentity({game,index,before,after},kind) {
  if (!['response','alternative','sacrifice'].includes(kind) || !Number.isInteger(index) || index<1 || !before || !after) return null;
  const move=game?.moves[index-1];
  if (!move) return null;
  try {
    const afterMove=kind!=='alternative',count=afterMove?index:index-1,fen=afterMove?move.after:move.before;
    if(gameAt(game,count).fen()!==fen)return null;
    const signature=result=>({score:result.score,depth:result.depth,bestmove:result.bestmove,configKey:result.configKey,
      pv:result.lines?.find(line=>line.pv?.[0]===result.bestmove)?.pv||[],moveReview:result.moveReview});
    return JSON.stringify({version:1,kind,index,fen,startFen:game.startFen,history:game.moves.slice(0,count).map(uciMove),
      move:{before:move.before,after:move.after,uci:uciMove(move)},before:signature(before),after:signature(after),
      primary:signature(assessedMoveResult(before,after,move))});
  } catch { return null; }
}

function refinedContinuation(context,kind,result) {
  const identity=insightIdentity(context,kind),{before,after}=context,move=context.game?.moves[context.index-1];
  if(!identity || result?.explanationIdentity!==identity || result.multipvComplete!==true || !Number.isInteger(result.depth)
    || !Array.isArray(result.lines) || result.lines.length!==1 || !['cp','mate'].includes(result.score?.type)
    || !Number.isFinite(result.score.value) || result.score.type==='mate' && !['w','b'].includes(result.score.winner))return null;
  try { result=structuredClone(result); } catch { return null; }
  const primary=assessedMoveResult(before,after,move),proof=kind==='sacrifice'?reviewedSacrificeEvidence(before,after,move):null;
  const originalDepth=kind==='sacrifice'?proof?.branch.depth:kind==='alternative'?before.depth:Math.max(0,primary.depth-1);
  if(!Number.isInteger(originalDepth) || result.depth<=originalDepth)return null;
  const candidate=result.lines[0],sameScore=(a,b)=>a?.type===b?.type && a.value===b.value && (a.winner||null)===(b.winner||null);
  if(candidate.multipv!==1 || candidate.depth!==result.depth || !sameScore(candidate.score,result.score)
    || !Array.isArray(candidate.pv) || !candidate.pv.length || candidate.pv[0]!==result.bestmove)return null;
  const line=continuation(gameAt(context.game,kind==='alternative'?context.index-1:context.index),result);
  if(line.pv.length!==candidate.pv.length)return null;
  if(kind==='sacrifice') {
    if(!proof)return null;
    const offers=sacrificeCandidates(move),captures=[...new Set(offers.flatMap(offer=>offer.captures))].sort();
    const restricted=[...new Set(result.searchGoal?.restrictedMoves||[])].sort();
    if(captures.length!==restricted.length || captures.some((capture,index)=>capture!==restricted[index]))return null;
    const offer=offers.find(offer=>offer.captures.includes(result.bestmove));
    if(!offer)return null;
    const source=sacrificeLine(move,before,after,{offer,branch:{...candidate,capture:result.bestmove}},result,line);
    return source?{...source,binding:identity,result:{...result,conditional:true,bestResponse:false}}:null;
  }
  if(result.searchGoal?.restrictedMoves?.length)return null;
  const source=focusContinuation(move,line,kind==='alternative',MAX_INSIGHT_PLIES,context);
  return {...source,binding:identity,result:{...result}};
}

export function refineInsight(context,kind,result) {
  if(!context.insight)return null;
  const source=refinedContinuation(context,kind,result);
  if(!source)return null;
  const {insight,before,after}=context,move=context.game.moves[context.index-1];
  if(kind==='sacrifice') {
    const sacrificeFact=sacrificeExplanation(move,source);
    return {...insight,sacrifice:source,sacrificeFact,summary:sacrificeFact||insight.purposeFact||insight.summary};
  }
  if(kind==='alternative') {
    const details=insight.kind==='mistake'?mistakeDetails(move,before,assessedMoveResult(before,after,move),insight.grade,insight.response,source):null;
    const alternativeFact=source.pv[0]===uciMove(move)?'이 깊이에서는 실전 수와 같은 수가 추천됩니다.'
      : details?.alternativeFact||coachAlternative(source)?.text||recommendedMove(source);
    return {...insight,alternative:source,alternativeFact,summary:details?details.summary:insight.summary};
  }
  const consequence=source.consequence;
  const details=insight.kind==='mistake'?mistakeDetails(move,before,assessedMoveResult(before,after,move),insight.grade,source,insight.alternative):null;
  const responseFact=details?.responseFact||(source.offer&&source.focus.payoff?sacrificeExplanation(move,source):firstMoveFact(source));
  const summary=details?.summary||goodMoveSummary(move,insight.purposeFact,source,insight.sacrificeFact);
  return {...insight,response:source,responseFact,summary,riskFact:source.score.type!=='mate' && consequence?.distant?distantRisk(consequence):'',
    materialFact:source.score.type!=='mate'?source.focus.note:''};
}

// Both branches stay anchored to the reviewed move, even when switching during playback.
export function createInsightLine(context, kind, scope='core') {
  const {game,index,insight,before,after}=context;
  if (!insight || !['response','alternative','sacrifice'].includes(kind) || !['core','full'].includes(scope)) return null;
  const move=game.moves[index-1];
  if (!move) return null;
  const response = kind === 'response', sacrifice=kind==='sacrifice', afterMove=response||sacrifice;
  // Revalidate the current identity instead of trusting an old explanation
  // object after a new analysis or game has replaced its source result.
  const selected=sacrifice?insight.sacrifice:response?insight.response:insight.alternative;
  const source = selected?.binding ? refinedContinuation(context,kind,selected.result)
    : sacrifice ? sacrificeContinuation(move,before,after,context) : selected;
  if (!source?.focus || !source.pv?.length) return null;
  const result = source.binding || sacrifice ? source.result : response ? assessedMoveResult(before,after,move) : before;
  const count=scope==='core' ? source.focus.length : source.pv.length;
  const line = new AnalysisLine(gameAt(game,afterMove ? index : index-1),source.pv.slice(0,count),result);
  if (!line.steps.length) return null;
  for (const [stepIndex,step] of line.steps.entries()) step.explanation=exampleStepComment(step,{previousMove:line.steps[stepIndex-1]||line.prefixMoves.at(-1)});
  line.kind = 'pv';
  line.sourceScore = source.score;
  line.sourceDepth = result.depth;
  line.title = sacrifice ? `상대가 희생을 받아들이면 · ${scope==='core'?'핵심 예시':'전체 예시 수순'}`
    : `${response ? '실전 수 이후 응수' : '실전 수 대신 대안'} · ${scope==='core'?'핵심 장면':'전체 예상 수순'}`;
  line.reviewIndex = index;
  line.reviewKind = kind;
  line.reviewScope = scope;
  line.fullLength = source.pv.length;
  line.focusNote = source.focus.note;
  line.startLabel = `${moveTurn(move)} ${afterMove ? '이후' : '직전'} · ${line.base.turn() === 'w' ? '백' : '흑'} 차례${sacrifice?' · 희생 수락을 가정한 예시':''}`;
  if (sacrifice) { line.conditional=true;line.bestResponse=false; }
  return line;
}

// Only describe a legal continuation belonging to the engine's chosen move.
// Partial/corrupt cached PVs must never produce invented moves or tactics.
function continuation(position, result) {
  const chess = typeof position==='string'?new Chess(position):cloneChess(position), moves = [];
  const candidate = result?.lines?.find(line => line.pv?.[0] === result.bestmove);
  const pv = candidate?.pv || (result?.bestmove ? [result.bestmove] : []);
  let invalid=false;
  for (const uci of chess.isGameOver()?[]:pv) {
    try { moves.push(chess.move(uci)); } catch { invalid=true;break; }
    if (chess.isGameOver()) break;
  }
  return { moves, pv:moves.map(uciMove), final:chess, score:result?.score, invalid, complete:!invalid && moves.length===pv.length };
}

function insightPosition(move,afterMove,context={}) {
  const expected=afterMove?move.after:move.before;
  try {
    if(context.game && Number.isInteger(context.index)) {
      const chess=gameAt(context.game,context.index-(afterMove?0:1));
      if(chess.fen()===expected)return chess;
    }
    if(Array.isArray(context.moves) && Number.isInteger(context.moveIndex) && context.moveIndex>=0) {
      const chess=new Chess(context.moves[0]?.before||move.before),count=context.moveIndex+(afterMove?1:0);
      for(const step of context.moves.slice(0,count))chess.move(uciMove(step));
      if(chess.fen()===expected)return chess;
    }
  } catch { /* A missing or unrelated history cannot replace the move's board. */ }
  return new Chess(expected);
}

function sacrificeContinuation(move,before,after,context={}) {
  const evidence=reviewedSacrificeEvidence(before,after,move);
  if (!evidence) return null;
  return sacrificeLine(move,before,after,evidence,null,null,insightPosition(move,true,context));
}

function sacrificeLine(move,before,after,evidence,refinedResult=null,preparedLine=null,basePosition=null) {
  const {offer,branch}=evidence;
  const primary=assessedMoveResult(before,after,move);
  if(branch.capture===primary.bestmove)return null;
  const result=refinedResult||{...primary,score:branch.score,depth:branch.depth,
    bestmove:branch.capture,lines:[{...branch,multipv:1}],conditional:true,bestResponse:false};
  const line=preparedLine||continuation(basePosition||move.after,result),capture=line.moves[0];
  if (line.moves.length!==branch.pv.length || line.moves.length<2 || !capture?.captured
    || capture.color===move.color || capturedSquare(capture)!==offer.square || capture.captured!==offer.piece) return null;
  // A small pawn capture is not the payoff for offering a rook. Stop early
  // only at mate or a settled exchange recovering the pre-sacrifice balance.
  const payoff=compensationPayoff(move,line);
  let length=payoff ? payoff.end : Math.min(line.moves.length,NEAR_CONSEQUENCE_PLIES);
  if(!payoff && length) {
    const tail=exchangeEnd(line,length-1);
    if(!tail.incomplete && tail.end<=MAX_INSIGHT_PLIES)length=tail.end;
  }
  const last=line.moves[length-1],position=new Chess(last.after);
  const incomplete=position.isCheck() || !!last.captured && position.moves({verbose:true}).some(reply=>reply.captured && capturedSquare(reply)===last.to);
  line.focus={length,incomplete,payoff,note:'상대가 이 포획을 선택한 경우의 예시이며, 다른 응수를 선택할 수도 있습니다.'};
  line.result=result;line.offer={...offer};line.conditional=true;line.bestResponse=false;
  return line;
}

function exampleStepComment(move,context={}) {
  const action=concreteMoveText(move),purpose=basicMoveComment(move,context);
  // The route is shown by the moving piece and the move label already. Keep
  // one useful purpose instead of repeating the same capture/check twice.
  return purpose!==moveText(move) && !/에서 .*로 옮깁니다\.$/.test(purpose) ? purpose : action;
}

function captureHasMultipleOrigins(move) {
  if(!move.captured || move.flags.includes('e'))return false;
  try {
    const candidates=new Chess(move.before).moves({verbose:true}).filter(candidate=>candidate.piece===move.piece
      && candidate.to===move.to && candidate.captured===move.captured && (candidate.promotion||null)===(move.promotion||null));
    return candidates.length>1;
  } catch { /* Do not infer origins from a malformed move record. */ }
  return false;
}

function concreteMoveText(move,form='statement') {
  const checkers=move.san.endsWith('#')?mateCheckers(move):[];
  const separateMate=move.san.endsWith('#') && !(checkers.length===1 && checkers[0].square===move.to && checkers[0].type===move.piece);
  let text=moveText(separateMate?{...move,san:move.san.slice(0,-1)}:move,form);
  if(captureHasMultipleOrigins(move)) {
    const subject=`${side(move.color)} ${PIECE_NAMES[move.piece]}${move.piece==='n'?'가':'이'} `;
    text=text.replace(subject,`${subject}${move.from}에서 `);
  }
  if(separateMate)text+=` ${mateFact(move).replace('체크메이트합니다.',form==='possible'?'체크메이트할 수 있습니다.':form==='alternative'?'체크메이트했어야 합니다.':'체크메이트합니다.')}`;
  return text;
}

function checkSetup(step) {
  const position=new Chess(step.after),king=pieces(position).find(piece=>piece.type==='k' && piece.color!==step.color);
  const checker=king && position.attackers(king.square,step.color).map(square=>({square,...position.get(square)}))[0];
  return checker ? `${checker.square}의 ${PIECE_NAMES[checker.type]}${checker.type==='n'?'로':'으로'} 체크한 뒤, ` : '체크한 뒤, ';
}

function mateCheckers(step) {
  const position=new Chess(step.after);
  if(!position.isCheckmate())return [];
  const king=pieces(position).find(piece=>piece.type==='k' && piece.color!==step.color);
  return king?position.attackers(king.square,step.color).map(square=>({square,...position.get(square)})):[];
}

function mateFact(step) {
  const checkers=mateCheckers(step);
  if(checkers.length===1) {
    const checker=checkers[0];
    return `${PIECE_NAMES[checker.type]}${checker.type==='n'?'가':'이'} ${checker.square}에서 체크메이트합니다.`;
  }
  return '상대 왕을 체크메이트합니다.';
}

function concreteStepFact(step) {
  const purpose=exampleStepComment(step);
  if(!step.captured && !step.promotion && !/[+#]$/.test(step.san) && !purpose.includes(step.to)) {
    return `${side(step.color)} ${PIECE_NAMES[step.piece]}${step.piece==='n'?'를':'을'} ${step.to}에 놓습니다. ${purpose}`;
  }
  return purpose;
}

function sacrificeExplanation(move,line) {
  const capture=line.moves[0],offer=line.offer;
  if(!capture?.captured || !offer)return '';
  const value=scoreValue(line.score,move.color),mate=mateWinner(line.score),payoff=line.focus.payoff;
  const acceptance=`상대가 ${offer.square}의 ${PIECE_NAMES[offer.piece]}${offer.piece==='n'?'를':'을'} ${captureHasMultipleOrigins(capture)?`${capture.from}의 `:''}${PIECE_NAMES[capture.piece]}${capture.piece==='n'?'로':'으로'} 잡으면, `;
  const checking=line.moves.slice(1,Math.min(line.focus.length,NEAR_CONSEQUENCE_PLIES)).filter(step=>step.color===move.color && /[+#]$/.test(step.san));
  let scene;
  if(payoff) {
    const finish=line.moves[payoff.index],distant=payoff.index+1>NEAR_CONSEQUENCE_PLIES;
    const beforeCapture=new Chess(capture.before),afterCapture=new Chess(capture.after);
    const deflection=finish.captured && finish.to!==capture.to && legalGuard(beforeCapture,capturedSquare(finish),capture.from,capture.color)
      && !legalGuard(afterCapture,capturedSquare(finish),capture.to,capture.color);
    const route=checking.find(step=>line.moves.indexOf(step)<payoff.index);
    const firstOwn=line.moves[1],quietSetup=firstOwn && firstOwn.color===move.color && !firstOwn.captured && !firstOwn.promotion && !/[+#]$/.test(firstOwn.san) && firstOwn!==finish
      ? `${object(firstOwn.piece)} ${firstOwn.to}에 놓아 ${basicMoveComment(firstOwn)} ` : '';
    const setup=deflection ? `${capturedSquare(finish)}의 ${PIECE_NAMES[finish.captured]}${finish.captured==='n'?'를':'을'} 지키던 ${PIECE_NAMES[capture.piece]}${capture.piece==='n'?'가':'이'} 자리를 떠납니다. ` : quietSetup;
    const timing=distant?`${route?checkSetup(route):''}이어지는 긴 예상 수순에서는 `:setup?'그 틈에 ':route?checkSetup(route):'';
    const result=payoff.kind==='mate' ? mateFact(finish)
      : concreteMoveText(finish);
    scene=acceptance+setup+timing+result;
  } else {
    const first=line.moves.find((step,index)=>index>0 && index<NEAR_CONSEQUENCE_PLIES && step.color===move.color);
    const fact=first ? concreteStepFact(first) : '뒤의 응수가 부족해 내준 기물에 대한 보상은 아직 확인되지 않았습니다.';
    scene=acceptance+fact;
  }
  // The board proves a played example, not that the opponent must accept or
  // that an engine score is material compensation. Keep those claims apart.
  if(value<0 && line.conditional===true)return `${scene} 다만 이 응수 뒤의 평가는 ${formatScore(line.score,move.color)} (${side(move.color)} 기준)로 ${value<=-100?'불리하며':'조금 불리하며'}, 이 교환만으로 좋은 수라고 볼 수는 없습니다.`;
  if(!payoff && mate)return `${scene} 이 응수에는 ${side(mate)}이 ${Math.abs(line.score.value)}수 안에 체크메이트할 것으로 분석됩니다. 핵심 장면 뒤에도 이어지는 예상 수순입니다.`;
  if(!payoff)return `${scene} 내준 기물을 모두 되찾는 결과는 이 장면에서 아직 확인되지 않습니다.`;
  return scene;
}

function firstMoveFact(line) {
  const move = line.moves[0];
  if (!move) return '';
  const action=`바로 다음 수에 ${concreteMoveText(move,'possible')}`;
  if(move.captured || move.promotion || /[+#]$/.test(move.san))return action;
  const after = new Chess(move.after);
  const targets = attackedBy(after,move.to,move.color).filter(piece=>!['p','k'].includes(piece.type));
  if (targets.length) return `${action} 이 수는 ${targets.map(piece => `${piece.square}의 ${side(piece.color)} ${PIECE_NAMES[piece.type]}`).join('·')}${targets.at(-1).type === 'n' ? '를' : '을'} 공격합니다.`;
  return action;
}

function recommendedMove(line) {
  const move = line.moves[0];
  if (!move) return '';
  return `대신 ${concreteMoveText(move,'alternative')}`;
}

// Six individual moves (three pairs) is a presentation boundary, never a
// mistake-grading rule or a claim that the continuation is forced.
export const NEAR_CONSEQUENCE_PLIES=6;
export const MAX_INSIGHT_PLIES=12;

function exchangeEnd(line,index) {
  let end=index+1;
  // Show recaptures, intervening captures and check replies before stopping.
  while(end<line.moves.length && (line.moves[end-1].san.endsWith('+')
    || line.moves[end-1].captured && (line.moves[end].captured || line.moves[end].san.endsWith('+'))
    || line.moves[end].captured && earlierCapturer(line,end,line.moves[end]))) end++;
  const last=line.moves[end-1];
  if(!last)return {end:0,incomplete:false};
  const position=new Chess(last.after);
  const incomplete=end===line.moves.length && !position.isGameOver() && (line.invalid || position.isCheck()
    || position.moves({verbose:true}).some(reply=>reply.captured
      && (last.captured && capturedSquare(reply)===last.to || earlierCapturer(line,end,reply))));
  return {end,incomplete};
}

function earlierCapturer(line,end,capture) {
  // Follow the victim backwards through its moves. A check and a quiet king
  // reply do not settle an exchange if that same capturing piece is then taken.
  let square=capturedSquare(capture),type=capture.captured;
  for(let index=end-1;index>=0;index--) {
    const step=line.moves[index];
    if(step.color===capture.color || step.to!==square || (step.promotion||step.piece)!==type)continue;
    if(step.captured)return true;
    square=step.from;type=step.piece;
  }
  return false;
}

function compensationPayoff(move,line) {
  const first=line.moves[0];
  if(!first?.captured || first.color===move.color)return null;
  const sign=move.color==='w'?1:-1,initial=materialBalance(pieces(new Chess(move.before))).difference*sign;
  for(let index=1;index<Math.min(line.moves.length,MAX_INSIGHT_PLIES);index++) {
    const step=line.moves[index];
    if(step.color!==move.color)continue;
    if(new Chess(step.after).isCheckmate())return {index,end:index+1,kind:'mate'};
    if(line.invalid || !step.captured && !step.promotion)continue;
    const {end,incomplete}=exchangeEnd(line,index);
    if(incomplete || end>MAX_INSIGHT_PLIES)continue;
    const final=materialBalance(pieces(new Chess(line.moves[end-1].after))).difference*sign;
    if(final>=initial)return {index,end,kind:'material',gain:final-initial};
  }
  return null;
}

function materialConsequence(move,line) {
  const initial=pieces(new Chess(move.before)), sign=move.color==='w'?1:-1;
  const initialMaterial=materialBalance(initial).difference*sign;
  // A knight exchanged for a bishop is not a lost minor piece. Match equal
  // material values before naming the victim that remains uncompensated.
  const balance=(list,type)=>list.filter(p=>VALUES[p.type]===VALUES[type]&&p.color===move.color).length
    -list.filter(p=>VALUES[p.type]===VALUES[type]&&p.color!==move.color).length;
  for(let index=0;index<line.moves.length;index++) {
    const capture=line.moves[index];
    if(capture.color===move.color || !capture.captured)continue;
    const {end,incomplete}=exchangeEnd(line,index);
    if(incomplete)continue;
    // A checking intermezzo can recover the offered piece after a quiet king
    // reply. Do not freeze that temporary capture into a final material loss.
    if(index===0 && sacrificeCandidates(move).some(offer=>offer.captures.includes(line.pv[0])) && compensationPayoff(move,line))continue;
    const final=pieces(new Chess(line.moves[end-1].after));
    const loss=initialMaterial-materialBalance(final).difference*sign;
    const local=pieces(new Chess(capture.before));
    if(loss>0 && balance(initial,capture.captured)>balance(final,capture.captured)
      && balance(local,capture.captured)>balance(final,capture.captured)) {
      return {capture,ply:index+1,end,loss,distant:index+1>NEAR_CONSEQUENCE_PLIES};
    }
  }
  return null;
}

function quietAlternativePayoff(line) {
  const first=line.moves[0];
  if(!line.complete || first?.captured || first?.promotion || !first || /[+#]$/.test(first.san) || /[kq]/.test(first.flags))return null;
  const targets=attackedBy(new Chess(first.after),first.to,first.color).filter(piece=>!['p','k'].includes(piece.type));
  if(!targets.length)return null;
  const sign=first.color==='w'?1:-1,initial=materialBalance(pieces(new Chess(first.before))).difference*sign;
  for(let index=1;index<Math.min(line.moves.length,NEAR_CONSEQUENCE_PLIES);index++) {
    const capture=line.moves[index];
    if(capture.color!==first.color || !capture.captured)continue;
    // Follow the attacked piece if it moves (including capturing our offered
    // pawn). Do not confuse another same-type piece with the original target.
    let square=capturedSquare(capture),type=capture.captured;
    for(let previous=index-1;previous>=1;previous--) {
      const step=line.moves[previous];
      if(step.color===capture.color || step.to!==square || (step.promotion||step.piece)!==type)continue;
      square=step.from;type=step.piece;
    }
    if(!targets.some(target=>target.square===square && target.type===type))continue;
    const {end,incomplete}=exchangeEnd(line,index);
    if(incomplete || end>NEAR_CONSEQUENCE_PLIES)continue;
    const gain=materialBalance(pieces(new Chess(line.moves[end-1].after))).difference*sign-initial;
    if(gain>0)return {index,end,gain};
  }
  return null;
}

function alternativePayoffFact(line) {
  const payoff=line.focus?.purposePayoff;
  if(!payoff)return '';
  const first=line.moves[0],finish=line.moves[payoff.index],acceptance=line.moves[payoff.index-1];
  const recapture=acceptance?.captured && acceptance.color!==first.color && acceptance.captured===first.piece
    && capturedSquare(acceptance)===first.to && finish.to===acceptance.to && finish.captured===acceptance.piece;
  const result=`교환 후 ${side(first.color)}이 기물 점수 ${payoff.gain}점의 이득을 남기는 예시입니다.`;
  return recapture ? `예상 응수에서는 상대가 ${first.to}의 ${object(first.piece)} ${PIECE_NAMES[acceptance.piece]}${acceptance.piece==='n'?'로':'으로'} 잡으면, ${PIECE_NAMES[finish.piece]}${finish.piece==='n'?'로':'으로'} 그 ${object(finish.captured)} 되잡아 ${result}`
    : `이어지는 예상 응수에서 ${concreteMoveText(finish)} ${result}`;
}

function recaptureBaseline(move,context={}) {
  const moves=context.game?.moves||context.moves,index=context.game&&Number.isInteger(context.index)?context.index-1:context.moveIndex;
  const actualContext=Array.isArray(moves)&&Number.isInteger(index)
    ? {...context,moves,moveIndex:index,previousMove:moves[index-1]}:context;
  const valid=step=>{
    try {const played=new Chess(step.before).move(uciMove(step));return played.after===step.after && played.captured===step.captured;} catch {return false;}
  };
  const takesPromotion=(capture,previous)=>!!capture?.captured && !!previous?.promotion
    && previous.color!==capture.color && previous.after===capture.before
    && capturedSquare(capture)===previous.to && capture.captured===previous.promotion;
  const promotion=takesPromotion(move,actualContext.previousMove);
  if(!isRecapture(move,actualContext) && !promotion)return move.before;
  if(Array.isArray(moves) && Number.isInteger(index) && moves[index]?.before===move.before && moves[index]?.after===move.after) {
    const target=capturedSquare(move);
    let anchor=index-1;
    while(!promotion && anchor>=0) {
      const previous=moves[anchor];
      if(previous.color!==move.color && previous.captured && previous.to===target && (previous.promotion||previous.piece)===move.captured)break;
      anchor--;
    }
    if(anchor>=0 && valid(moves[anchor])) {
      // Consecutive captures can exchange on several squares. Include those
      // already played captures rather than treating a recapture as free gain.
      while(anchor>0 && (moves[anchor-1]?.captured || takesPromotion(moves[anchor],moves[anchor-1]))
        && moves[anchor-1].after===moves[anchor].before && valid(moves[anchor-1]))anchor--;
      return moves[anchor].before;
    }
  }
  return actualContext.previousMove && valid(actualContext.previousMove)?actualContext.previousMove.before:move.before;
}

function focusContinuation(move,line,alternative=false,maxPlies=NEAR_CONSEQUENCE_PLIES,context={}) {
  const consequence=alternative?null:materialConsequence(move,line);
  const offer=!alternative && line.moves[0]?.captured ? sacrificeCandidates(move).find(offer=>offer.captures.includes(line.pv[0])) : null;
  const payoff=offer?compensationPayoff(move,line):null;
  const purposePayoff=alternative?quietAlternativePayoff(line):null;
  const limit=payoff?MAX_INSIGHT_PLIES:maxPlies;
  const mate=line.moves.findIndex((step,index)=>index<limit && new Chess(step.after).isCheckmate());
  const chosen=mate>=0?mate:payoff?payoff.index:purposePayoff?purposePayoff.index:consequence && (!consequence.distant || maxPlies>NEAR_CONSEQUENCE_PLIES && consequence.end<=maxPlies) ? consequence.ply-1 : 0;
  const exchange=exchangeEnd(line,chosen);
  // Complete a nearby tactical exchange, including a checking intermezzo,
  // rather than reporting the temporary material balance at the six-ply cut.
  const exchangeLimit=consequence && !consequence.distant?MAX_INSIGHT_PLIES:limit;
  const end=Math.min(exchange.end,exchangeLimit),incomplete=exchange.incomplete||exchange.end>exchangeLimit;
  let note='';
  if(mate>=0)note=`이 예상 수순에서는 ${mateFact(line.moves[mate])}`;
  else if(exchange.end>exchangeLimit) note='핵심 장면은 체크나 교환이 이어지는 도중에 끝납니다. 뒤의 응수는 전체 수순에서 확인할 수 있습니다.';
  else if(incomplete) note='후속 응수가 부족해 교환이나 체크 대응의 최종 결과는 아직 확인되지 않았습니다.';
  else if(end && (line.moves.slice(0,end).some(step=>step.captured) || !alternative && move.captured)) {
    const start=new Chess(alternative?move.before:recaptureBaseline(move,context)), final=new Chess(line.moves[end-1].after);
    const difference=(materialBalance(pieces(start)).difference-materialBalance(pieces(final)).difference)*(move.color==='w'?1:-1);
    note=difference>0 ? `이 구간의 기물 점수 차이: ${side(move.color)} ${difference}점 손해.`
      : difference<0 ? `이 구간의 기물 점수 차이: ${side(move.color)} ${-difference}점 이득.`
      : '교환을 반영하면 이 구간의 기물 점수 차이는 유지됩니다.';
  }
  line.focus={length:end,note,incomplete,payoff};
  if(purposePayoff)line.focus.purposePayoff=purposePayoff;
  if(offer)line.offer={...offer};
  line.consequence=consequence;
  return line;
}

function distantRisk(consequence) {
  const capture=consequence.capture;
  if(consequence.ply<=NEAR_CONSEQUENCE_PLIES) return `${concreteMoveText(capture,'possible')} 손익은 ${consequence.end}번 이동까지 이어지는 교환을 예상한 결과이며, 후속 수순에 따라 달라질 수 있습니다.`;
  return `긴 예상 수순이 이어질 경우, ${consequence.ply}번째 이동에서 ${concreteMoveText(capture,'possible')} 이후 선택에 따라 달라질 수 있습니다.`;
}

export function explainMistake(move, before, after, context = {}) {
  const grade = move && classifyMove(before,after,move,context);
  if (!grade || grade.severity < 1) return null;
  after=assessedMoveResult(before,after,move);
  const player = side(move.color), opponent = side(move.color === 'w' ? 'b' : 'w');
  const response = focusContinuation(move,continuation(insightPosition(move,true,context),after),false,NEAR_CONSEQUENCE_PLIES,context), alternative = focusContinuation(move,continuation(insightPosition(move,false,context),before),true,NEAR_CONSEQUENCE_PLIES,context);
  const sign = move.color === 'w' ? 1 : -1;
  const beforeValue = scoreValue(before.score)*sign, afterValue = scoreValue(after.score)*sign;
  const beforeMate = mateWinner(before.score), afterMate = mateWinner(after.score);
  const mateChanged = before.score.type === 'mate' || after.score.type === 'mate';
  const lossText = mateChanged ? '메이트 평가 변화' : `${player}의 평가 손실 ${(grade.loss/100).toFixed(2)}`;
  let reason;
  if (afterMate && afterMate !== move.color) {
    reason = Math.abs(after.score.value) === 0 ? `${player}이 체크메이트당했습니다.` : `${opponent}에게 ${Math.abs(after.score.value)}수 안의 강제 체크메이트를 허용했습니다.`;
    if (beforeMate === move.color) reason = `체크메이트 기회를 놓치고, 오히려 ${opponent}에게 강제 체크메이트를 허용했습니다.`;
  } else if (beforeMate === move.color && afterMate !== move.color) {
    reason = '이전에 가능했던 강제 체크메이트 수순을 놓쳤습니다.';
  } else if (beforeValue >= 100 && afterValue <= -100) reason = `${player}이 유리하던 국면이 ${opponent}에게 유리한 국면으로 바뀌었습니다.`;
  else if (beforeValue >= 100 && afterValue < 100) reason = `${player}이 갖고 있던 우세를 살리지 못했습니다.`;
  else if (beforeValue > -100 && afterValue <= -100) reason = `버틸 수 있던 국면에서 ${player}이 불리해졌습니다.`;
  else if (afterValue <= -100) reason = `이미 불리한 국면에서 ${player}의 열세가 더 커졌습니다.`;
  else reason = '';

  const consequence=response.consequence;
  const details=mistakeDetails(move,before,after,grade,response,alternative);
  const responseFact=details.responseFact;
  const riskFact=!afterMate && consequence?.distant ? distantRisk(consequence) : '';
  const materialFact=!afterMate ? response.focus.note : '';
  // The compact explanation pairs the opponent's reply with the better move.
  // Evaluation loss is already displayed in the heading.
  const alternativeFact=details.alternativeFact,summary=details.summary;
  return { grade, reason, summary, responseFact, riskFact, materialFact, alternativeFact, lossText,
    evaluation:`수 전 ${formatScore(before.score)} → 수 후 ${formatScore(after.score)} (백 기준)`,
    response, alternative,
    basis:`예상 승점 ${(grade.pointsLoss*100).toFixed(1)}%p 감소. ${GRADING_BASIS} 평가 손실은 잃은 기물 점수나 손실까지의 이동 횟수가 아닙니다.`,
  };
}

// The lightbulb explains every completed move. The main defensive PV and an
// acceptance example are separate lines with separate scores and identities.
export function explainMove(move,before,after,context={}) {
  const grade=move && classifyMove(before,after,move,context);
  if (!grade) return null;
  if (grade.severity>=1) return {...explainMistake(move,before,after,context),kind:'mistake',moveFact:moveText(move),sacrifice:null,sacrificeFact:''};
  const assessed=assessedMoveResult(before,after,move);
  const response=focusContinuation(move,continuation(insightPosition(move,true,context),assessed),false,NEAR_CONSEQUENCE_PLIES,context);
  const alternative=focusContinuation(move,continuation(insightPosition(move,false,context),before),true,NEAR_CONSEQUENCE_PLIES,context);
  const sacrifice=sacrificeContinuation(move,before,after,context);
  const purpose=basicMoveComment(move,context);
  const reason=grade.reason || (grade.key==='best' ? '분석한 후보 중 가장 높은 평가를 지키는 수입니다.'
    : grade.key==='excellent' ? '엔진이 예상한 승점을 거의 지키는 선택입니다.'
    : '최선수와 비교해 예상 승점의 감소를 작게 유지한 선택입니다.');
  const sacrificeFact=sacrifice ? sacrificeExplanation(move,sacrifice) : '';
  const primaryFact=response.offer && response.focus.payoff ? sacrificeExplanation(move,response) : '';
  const summary=goodMoveSummary(move,purpose,response,sacrificeFact);
  return {kind:'move',grade,moveFact:moveText(move),purposeFact:purpose,reason,summary,
    response,responseFact:primaryFact||firstMoveFact(response),alternative,
    alternativeFact:alternative.focus.purposePayoff?coachAlternative(alternative).text:recommendedMove(alternative),
    sacrifice,sacrificeFact,riskFact:'',materialFact:'',lossText:'이 수의 의미',
    evaluation:`수 전 ${formatScore(before.score)} → 수 후 ${formatScore(assessed.score)} (백 기준)`,basis:GRADING_BASIS};
}

function goodMoveSummary(move,purpose,response,sacrificeFact='') {
  if(sacrificeFact)return sacrificeFact;
  if(response.offer && response.focus.payoff)return sacrificeExplanation(move,response);
  const mate=response.moves.slice(0,NEAR_CONSEQUENCE_PLIES).find(step=>step.color===move.color && new Chess(step.after).isCheckmate());
  return mate?`이 예상 수순에서는 ${mateFact(mate)}`:purpose;
}

const VALUES = {p:1,n:3,b:3,r:5,q:9,k:100};
const pieces = chess => chess.board().flat().filter(Boolean);
const targetName = piece => `${piece.square}의 ${PIECE_NAMES[piece.type]}`;
const capturedSquare = move => move.flags.includes('e') ? move.to[0]+move.from[1] : move.to;
const legalMoveCache=new WeakMap();

// attackers() includes pinned pieces. A threat in a teaching sentence needs a
// legal capture, not just an unobstructed geometric ray. Changing the turn is
// only a local probe; never alter the real game or retain a stale en-passant.
function legalMoves(chess,color) {
  let cached=legalMoveCache.get(chess);
  if(!cached){cached=new Map();legalMoveCache.set(chess,cached);}
  if(cached.has(color))return cached.get(color);
  const fen=chess.fen().split(' ');
  if(fen[1]!==color){fen[1]=color;fen[3]='-';}
  const moves=new Chess(fen.join(' ')).moves({verbose:true});
  cached.set(color,moves);
  return moves;
}
const legalCaptures=(chess,color)=>legalMoves(chess,color).filter(move=>move.captured && move.captured!=='k');
const legallyAttacked = (chess,square,color) => legalCaptures(chess,color).some(move=>capturedSquare(move)===square);
const legalGuard = (chess,square,guard,color) => legalCaptures(chess,color==='w'?'b':'w')
  .filter(move=>capturedSquare(move)===square)
  .some(capture=>new Chess(capture.after).moves({verbose:true}).some(reply=>reply.from===guard && reply.to===capture.to && reply.captured));
const attackedBy = (chess,square,color) => {
  const targets=legalCaptures(chess,color).filter(move=>move.from===square).map(move=>({square:capturedSquare(move),...chess.get(capturedSquare(move))}));
  const unique=[...new Map(targets.map(piece=>[piece.square,piece])).values()];
  // Kings cannot be captured, but a verified check can form the first half of
  // a check-and-attack. Other pinned pseudo-attacks remain excluded above.
  const king=pieces(chess).find(piece=>piece.color!==color && piece.type==='k');
  if(king && chess.turn()!==color && chess.isCheck() && chess.attackers(king.square,color).includes(square))unique.push(king);
  return unique;
};

function canSupport(chess,from,target,color) {
  if(chess.get(target)?.type==='k')return false;
  const probe=new Chess(chess.fen()),enemy=color==='w'?'b':'w';
  // Treat the occupied friendly square as the destination of a possible
  // exchange, then verify that the new defender would be free to recapture.
  probe.remove(target);probe.put({type:'p',color:enemy},target);
  return legalCaptures(probe,color).some(move=>move.from===from && move.to===target);
}

function pawnPurpose(move,before,after) {
  if(move.piece!=='p' || move.captured)return '';
  const attacked=attackedBy(after,move.to,move.color).filter(piece=>!['p','k'].includes(piece.type)
    && !before.attackers(piece.square,move.color).includes(move.from)).sort((a,b)=>VALUES[b.type]-VALUES[a.type]);
  if(attacked.length)return `${targetName(attacked[0])}${attacked[0].type==='n'?'를':'을'} 공격합니다.`;
  const home=move.color==='w'?'1':'8', bishops=pieces(after).filter(piece=>piece.color===move.color && piece.type==='b' && piece.square[1]===home);
  const supported=pieces(after).filter(piece=>piece.color===move.color && piece.type==='p' && piece.square!==move.to
    && after.attackers(piece.square,move.color).includes(move.to) && canSupport(after,move.to,piece.square,move.color));
  const opening=bishops.find(bishop=>legalMoves(after,move.color).some(step=>step.from===bishop.square && step.to===move.from)
    && !legalMoves(before,move.color).some(step=>step.from===bishop.square && step.to===move.from));
  const blocked=bishops.find(bishop=>legalMoves(before,move.color).some(step=>step.from===bishop.square && step.to===move.to)
    && !legalMoves(after,move.color).some(step=>step.from===bishop.square && step.to===move.to));
  if(!opening && !blocked)return '';
  const support=supported.length ? `${supported.map(piece=>piece.square).join('·')}의 폰을 뒷받침` : '';
  let text=opening ? `${support?`${support}하고 `:''}${opening.square}의 비숍이 나올 길을 엽니다.`
    : support ? `${support}합니다.` : '';
  if(blocked && text)text+=` ${blocked.square}의 비숍이 갈 수 있는 대각선은 좁아집니다.`;
  return text;
}

function lossCause(move,line,capture) {
  const square=capturedSquare(capture), victim=PIECE_NAMES[capture.captured], attacker=PIECE_NAMES[capture.piece];
  const before=new Chess(move.before), current=new Chess(move.after), atCapture=new Chess(capture.before);
  const prefix=line.moves.slice(0,line.moves.indexOf(capture));
  const stationary=current.get(square)?.color===move.color && current.get(square)?.type===capture.captured
    && !prefix.some(step=>step.from===square || step.to===square);
  const timing=line.moves[0]===capture ? '바로 다음 수에' : '이어지는 응수에서';
  const ending=`${timing} ${concreteMoveText(capture,'possible')}`;
  if (capture.flags.includes('e')) return `이 수로 인해 상대에게 앙파상을 허용해, ${ending}`;
  if (stationary) {
    const guards=current.attackers(square,move.color);
    if(before.get(square)?.color===move.color && !before.attackers(square,move.color).length
      && before.get(capture.from)?.type===capture.piece && before.get(capture.from)?.color===capture.color) {
      try {
        const fen=move.before.split(' ');fen[1]=capture.color;fen[3]='-';
        const earlier=new Chess(fen.join(' ')).move(uciMove(capture));
        if(earlier.captured===capture.captured)return `이미 공격받던 ${square}의 ${object(capture.captured)} 지키지 않아, ${ending}`;
      } catch { /* A pseudo-attack or pinned attacker does not establish an earlier threat. */ }
    }
    if (before.get(square)?.color===move.color && before.attackers(square,move.color).includes(move.from) && !guards.length) {
      return `이 수로 인해 ${object(capture.captured)} 지키던 ${PIECE_NAMES[move.piece]}${move.piece==='n'?'가':'이'} 자리를 떠나, ${ending}`;
    }
    if (before.get(square)?.color===move.color && ['b','r','q'].includes(capture.piece)
      && current.get(capture.from)?.type===capture.piece && current.get(capture.from)?.color===capture.color
      && !before.attackers(square,capture.color).includes(capture.from) && current.attackers(square,capture.color).includes(capture.from)) {
      return `이 수로 인해 상대 ${attacker}의 공격길이 열려, ${ending}`;
    }
    if (move.to===square && !before.isAttacked(move.from,capture.color)
      && current.get(capture.from)?.type===capture.piece && current.attackers(square,capture.color).includes(capture.from)) {
      return `이 수로 인해 ${victim}${capture.captured==='n'?'가':'이'} 상대 ${attacker}의 공격 범위에 놓여, ${ending}`;
    }
  }
  const fork=prefix.find((step,index)=>{
    if (step.color!==capture.color || step.to!==capture.from || step.piece!==capture.piece
      || prefix.slice(index+1).some(next=>[square,step.to].includes(next.from) || [square,step.to].includes(next.to))) return false;
    const targets=attackedBy(new Chess(step.after),step.to,step.color);
    return targets.some(p=>p.square===square && p.type===capture.captured) && targets.some(p=>p.square!==square && p.type!=='p');
  });
  if (fork) return `이 수로 인해 상대 ${PIECE_NAMES[fork.piece]}의 동시 공격을 허용해, ${ending}`;
  if (prefix.at(-2)?.color===capture.color && prefix.at(-2).san.endsWith('+')) {
    return `이 수로 인해 상대의 체크에 대응하는 사이, ${ending}`;
  }
  const king=pieces(atCapture).find(p=>p.color===move.color && p.type==='k');
  const guards=atCapture.attackers(square,move.color);
  const pinned=guards.find(guard=>{
    if (!king || guard===king.square) return false;
    const probe=new Chess(capture.before); probe.remove(guard);
    return !atCapture.isAttacked(king.square,capture.color) && probe.isAttacked(king.square,capture.color);
  });
  const recaptures=new Chess(capture.after).moves({verbose:true}).some(step=>step.to===capture.to && step.captured && guards.includes(step.from));
  if (pinned && !recaptures) {
    const defender=atCapture.get(pinned).type;
    if(before.get(square)?.color===move.color && legallyAttacked(before,square,capture.color)
      && !legalGuard(before,square,pinned,move.color)) return `이미 ${square}의 ${victim}${capture.captured==='n'?'가':'이'} 공격받고 있었지만 ${PIECE_NAMES[defender]}${defender==='n'?'가':'이'} 왕을 보호하느라 되잡을 수 없어, ${ending}`;
    return `이 수로 인해 ${object(capture.captured)} 지키는 ${PIECE_NAMES[defender]}${defender==='n'?'가':'이'} 왕을 보호하느라 되잡을 수 없어, ${ending}`;
  }
  if (!guards.length) return `${square}의 ${victim}${capture.captured==='n'?'가':'이'} 수비 없이 남아, ${ending}`;
  return line.moves[0]===capture?`이 예상 수순에서는 ${ending}`:`이어지는 예상 수순에서는 ${concreteMoveText(capture,'possible')}`;
}

function drawComment(position) {
  if(position.isStalemate())return '상대가 둘 수 있는 합법적인 수가 없어 스테일메이트로 무승부입니다.';
  if(position.isInsufficientMaterial())return '체크메이트에 필요한 기물이 남지 않아 무승부입니다.';
  if(position.isThreefoldRepetition())return '같은 배치가 세 번 반복되어 무승부입니다.';
  if(position.isDrawByFiftyMoves())return '50수 동안 폰 이동이나 포획이 없어 무승부입니다.';
  return '';
}

function checkEvasion(move,before,after) {
  if(!before.isCheck())return '';
  const king=pieces(before).find(piece=>piece.color===move.color && piece.type==='k'),enemy=move.color==='w'?'b':'w';
  const checkers=king?before.attackers(king.square,enemy).map(square=>({square,...before.get(square)})):[];
  const captured=checkers.find(piece=>piece.square===capturedSquare(move) && piece.type===move.captured);
  let purpose;
  if(captured)purpose=`${captured.square}의 ${object(captured.type)} 잡아 체크를 해소합니다.`;
  else if(move.piece==='k')purpose=`왕을 ${move.to}로 옮겨 체크를 피합니다.`;
  else {
    const checker=checkers.find(piece=>['b','r','q'].includes(piece.type));
    if(!checker)return '';
    purpose=`${move.to}에서 ${checker.square}의 ${PIECE_NAMES[checker.type]}${checker.type==='n'?'와':'과'} 왕 사이를 막아 체크를 해소합니다.`;
  }
  if(move.promotion)purpose=`폰을 ${PIECE_NAMES[move.promotion]}${move.promotion==='n'?'로':'으로'} 승격하면서 ${purpose}`;
  if(after.isCheck())purpose+=' 동시에 상대 왕도 체크합니다.';
  return purpose;
}

function basicMoveComment(move,context={}) {
  const before=new Chess(move.before), after=insightPosition(move,true,context), enemy=move.color==='w'?'b':'w';
  if (after.isCheckmate()) return concreteMoveText(move);
  const draw=drawComment(after);
  if(draw)return draw;
  const evasion=checkEvasion(move,before,after);
  if(evasion)return evasion;
  if (move.promotion) return moveText(move);
  if (move.flags.includes('k') || move.flags.includes('q')) {
    const rank=move.color==='w'?'1':'8',rook=move.flags.includes('k')?'f':'d';
    return `캐슬링해 왕을 ${move.to}로 옮기고 룩을 ${rook}${rank}로 꺼냅니다.`;
  }
  const targets=attackedBy(after,move.to,move.color).filter(piece=>piece.type!=='k').sort((a,b)=>VALUES[b.type]-VALUES[a.type]);
  const tactics=tacticalPatterns(move);
  if (move.san.endsWith('+')) {
    const skewer=tactics?.skewers[0];
    if(skewer)return `${skewer.attackerSquare}의 ${PIECE_NAMES[skewer.attackerType]}${skewer.attackerType==='n'?'로':'으로'} 체크하면서 ${skewer.kingSquare}의 왕 뒤 ${skewer.targetSquare}의 ${PIECE_NAMES[skewer.targetType]}도 같은 공격선에 놓습니다.`;
    const valuable=targets.filter(piece=>piece.type!=='p');
    return valuable.length ? `체크하면서 ${valuable.slice(0,2).map(targetName).join('·')}도 겨냥합니다.` : moveText(move);
  }
  if (move.captured && isRecapture(move,context)) return `${targetName({square:capturedSquare(move),type:move.captured})}${move.captured==='n'?'를':'을'} 되잡습니다.`;
  if (targets.length>=2 && targets[1].type!=='p') return `${targets.slice(0,2).map(targetName).join('·')}${targets[1].type==='n'?'를':'을'} 동시에 공격합니다.`;
  if (move.captured) return moveText(move);
  const block=tactics?.blocks.slice().sort((a,b)=>VALUES[b.protectedType]-VALUES[a.protectedType])[0];
  if(block)return block.kind==='unpin'
    ? `${block.blockSquare}에 ${object(move.piece)} 놓아 ${block.protectedSquare}의 ${PIECE_NAMES[block.protectedType]}에 걸린 핀을 풉니다.`
    : `${block.blockSquare}에서 ${block.attackerSquare}의 ${PIECE_NAMES[block.attackerType]}${block.attackerType==='n'?'가':'이'} ${block.protectedSquare}의 ${object(block.protectedType)} 공격하던 길을 막습니다.`;
  const promotionEscape=tactics?.promotionEscapes[0];
  if(promotionEscape)return `공격받던 ${object(move.piece)} ${move.to}로 피하면서 ${promotionEscape.promotionSquare} 승격칸도 계속 지킵니다.`;
  const discovered=tactics?.discovered.slice().sort((a,b)=>VALUES[b.targetType]-VALUES[a.targetType])[0];
  if(discovered && (!targets[0] || VALUES[discovered.targetType]>VALUES[targets[0].type]))return `${move.from} 칸을 비워 ${discovered.attackerSquare}의 ${PIECE_NAMES[discovered.attackerType]}${discovered.attackerType==='n'?'가':'이'} ${discovered.targetSquare}의 ${object(discovered.targetType)} 공격하게 합니다.`;
  const pawnPlan=pawnPurpose(move,before,after);
  if(pawnPlan)return pawnPlan;
  const defended=pieces(after).filter(piece=>piece.color===move.color && piece.square!==move.to && piece.type!=='k'
    && legallyAttacked(before,piece.square,enemy) && legalGuard(after,piece.square,move.to,move.color)
    && !legalGuard(before,piece.square,move.from,move.color)).sort((a,b)=>VALUES[b.type]-VALUES[a.type]);
  if (defended.length) return `공격받던 ${targetName(defended[0])}${defended[0].type==='n'?'를':'을'} 지킵니다.`;
  const centers=['d4','e4','d5','e5'].filter(square=>after.attackers(square,move.color).includes(move.to) && canSupport(after,move.to,square,move.color));
  const development=['n','b'].includes(move.piece) && move.from[1]===(move.color==='w'?'1':'8') && Number(move.before.split(' ')[5])<=10;
  const freshTarget=targets.find(piece=>!before.attackers(piece.square,move.color).includes(move.from));
  if (development) {
    if (freshTarget) {
      const otherCenters=centers.filter(square=>square!==freshTarget.square);
      return `${targetName(freshTarget)}${freshTarget.type==='n'?'를':'을'} 공격${otherCenters.length?`하고 ${otherCenters.join('·')} 칸도 제어하며`:'하며'} ${object(move.piece)} 전개합니다.`;
    }
    return centers.length ? `중앙의 ${centers.join('·')} 칸을 겨냥하며 ${object(move.piece)} 전개합니다.` : `${object(move.piece)} 전개합니다.`;
  }
  if (freshTarget) return `${targetName(freshTarget)}${freshTarget.type==='n'?'를':'을'} 공격합니다.`;
  const positionalPawn=positionalPawnPurpose(move);
  if (legallyAttacked(before,move.from,enemy) && !legallyAttacked(after,move.to,enemy)) return `공격받던 ${object(move.piece)} ${move.to}로 피합니다.${positionalPawn.startsWith('통과 폰')?` ${positionalPawn}`:''}`;
  if(positionalPawn)return positionalPawn;
  if (move.piece==='p' && ['d','e'].includes(move.to[0]) && ['4','5'].includes(move.to[1])) return `중앙에 폰을 세워${centers.length?` ${centers.join('·')} 칸을 제어합니다.`:' 공간을 확보합니다.'}`;
  if (move.piece==='r' && !pieces(after).some(p=>p.type==='p' && p.square[0]===move.to[0])) return `폰이 없는 ${move.to[0]}파일에 룩을 배치합니다.`;
  if (centers.length) return `${object(move.piece)} ${move.to}에 두어 중앙의 ${centers.join('·')} 칸을 제어합니다.`;
  return `${object(move.piece)} ${move.from}에서 ${move.to}로 옮깁니다.`;
}

// Candidate cards and reviewed moves use the same factual, board-specific
// language. This describes a purpose, never a promise of a win or a new grade.
export function describeHumanMove(move,context={}) {
  return move ? basicMoveComment(move,context) : '';
}

// A positional recommendation needs a reason visible on the board. Do not turn
// a balanced recapture into the explanation for an engine's positional verdict.
function coachPlan(move) {
  const before=new Chess(move.before), after=new Chess(move.after), enemy=move.color==='w'?'b':'w';
  const targets=attackedBy(after,move.to,move.color).filter(piece=>piece.type!=='k').sort((a,b)=>VALUES[b.type]-VALUES[a.type]);
  const fresh=targets.filter(piece=>!before.attackers(piece.square,move.color).includes(move.from));
  const centers=['d4','e4','d5','e5'].filter(square=>after.attackers(square,move.color).includes(move.to) && canSupport(after,move.to,square,move.color));
  const developed=['n','b'].includes(move.piece) && move.from[1]===(move.color==='w'?'1':'8') && Number(move.before.split(' ')[5])<=10;
  const defended=pieces(after).filter(piece=>piece.color===move.color && piece.square!==move.to && piece.type!=='k'
    && legallyAttacked(before,piece.square,enemy) && legalGuard(after,piece.square,move.to,move.color)
    && !legalGuard(before,piece.square,move.from,move.color)).sort((a,b)=>VALUES[b.type]-VALUES[a.type]);
  if (move.san.endsWith('#')) return {kind:'mate',move};
  if (move.san.endsWith('+')) return {kind:'check',move};
  if (fresh.length>=2 && fresh[1].type!=='p') return {kind:'fork',move,targets:fresh.slice(0,2),benefit:`${fresh.slice(0,2).map(targetName).join('·')}${fresh[1].type==='n'?'를':'을'} 동시에 공격할`};
  if (defended.length) return {kind:'defend',move,targets:[defended[0]],benefit:`공격받던 ${targetName(defended[0])}${defended[0].type==='n'?'를':'을'} 지킬`};
  if (developed) return {kind:'develop',move,centers,targets:fresh,benefit:fresh.length
    ? `${targetName(fresh[0])}${fresh[0].type==='n'?'를':'을'} 공격하며 전개할`
    : centers.length ? `중앙의 ${centers.join('·')} 칸을 제어하며 전개할` : `${object(move.piece)} 전개할`};
  if (legallyAttacked(before,move.from,enemy) && !legallyAttacked(after,move.to,enemy)) return {kind:'escape',move,benefit:'상대의 공격을 피할'};
  if (fresh.length) return {kind:'attack',move,targets:[fresh[0]],benefit:`${targetName(fresh[0])}${fresh[0].type==='n'?'를':'을'} 공격할`};
  if (move.piece==='r' && !pieces(after).some(piece=>piece.type==='p' && piece.square[0]===move.to[0])) return {kind:'file',move,benefit:`폰이 없는 ${move.to[0]}파일을 차지할`};
  if (centers.length) return {kind:'center',move,centers,benefit:`중앙의 ${centers.join('·')} 칸을 제어할`};
  return {kind:'move',move};
}

function coachAlternative(line) {
  const move=line.moves[0];
  if (!move) return null;
  const plan=coachPlan(move);
  // Captures, castling, promotions and checks retain every effect in moveText.
  const text=move.captured || move.promotion || /[+#]$/.test(move.san) || /[kq]/.test(move.flags) || !plan.benefit
    ? recommendedMove(line)
    : `대신 ${side(move.color)} ${object(move.piece)} ${move.from}에서 ${move.to}로 옮겨 ${plan.benefit} 수 있었습니다.`;
  const payoff=alternativePayoffFact(line);
  return {...plan,text:text+(payoff?` ${payoff}`:'')};
}

function coachOpportunity(move,alternative) {
  if (!alternative) return '';
  const actual=coachPlan(move), after=new Chess(move.after), better=alternative.move;
  if (alternative.kind==='develop' && actual.kind!=='develop' && !['n','b'].includes(move.piece)) {
    return `${move.captured?`${object(move.captured)} 잡기보다 `:''}${object(better.piece)} 먼저 전개할 기회를 놓쳤습니다.`;
  }
  if (alternative.kind==='defend') {
    const target=alternative.targets[0];
    if (after.get(target.square)?.color===move.color && legallyAttacked(after,target.square,move.color==='w'?'b':'w')
      && !legalGuard(after,target.square,move.to,move.color)) return `공격받던 ${targetName(target)}${target.type==='n'?'를':'을'} 지키는 수를 먼저 찾을 수 있었습니다.`;
  }
  if (['fork','attack'].includes(alternative.kind)) {
    const targets=alternative.targets.filter(target=>!(move.captured===target.type && capturedSquare(move)===target.square));
    const actualTargets=attackedBy(after,move.to,move.color);
    if (targets.some(target=>!actualTargets.some(actual=>actual.square===target.square))) return alternative.kind==='fork' && targets.length>=2
      ? `${PIECE_NAMES[better.piece]}${better.piece==='n'?'로':'으로'} 두 기물을 동시에 공격할 기회를 놓쳤습니다.`
      : `${targets.map(targetName).join('·')}${targets.at(-1).type==='n'?'를':'을'} 공격할 기회를 놓쳤습니다.`;
  }
  return '';
}

function coachReply(line) {
  const move=line.moves[0];
  if (!move) return '';
  if (!move.captured && !move.promotion && !/[+#]$/.test(move.san)) {
    const targets=attackedBy(new Chess(move.after),move.to,move.color).filter(piece=>!['p','k'].includes(piece.type)).sort((a,b)=>VALUES[b.type]-VALUES[a.type]);
    if (targets.length) return `상대는 ${object(move.piece)} ${move.from}에서 ${move.to}로 옮겨 ${targetName(targets[0])}${targets[0].type==='n'?'를':'을'} 공격할 수 있습니다.`;
  }
  return firstMoveFact(line);
}

function exceptionalMoveComment(move,context={}) {
  return basicMoveComment(move,context);
}

function mistakeDetails(move,before,after,grade,reply,alternativeLine) {
  const alternative=coachAlternative(alternativeLine),opponent=reply.moves[0],consequence=reply.consequence;
  let alternativeFact=alternative?.text||'';
  if(opponent?.san.endsWith('#') && alternativeLine.moves.length) {
    let stillMated=false;
    try {stillMated=new Chess(alternativeLine.moves[0].after).move(reply.pv[0]).san.endsWith('#');} catch { /* A blocked mating move is no longer legal. */ }
    if(!stillMated)alternativeFact+=' 실전 수 뒤에 가능했던 즉시 체크메이트를 막습니다.';
  }
  let responseFact=coachReply(reply);
  if(consequence && !consequence.distant)responseFact=lossCause(move,reply,consequence.capture);
  else if(opponent?.captured && reply.focus.incomplete)responseFact=responseFact.replace(/있습니다\.$/,'있지만, 후속 응수가 부족해 교환의 최종 결과는 아직 확인되지 않았습니다.');
  const opportunity=coachOpportunity(move,alternative);
  // Winning evaluations can remain mates on both branches. An immediately
  // available legal finish is still the concrete opportunity this move missed.
  const immediateMateMiss=grade.key==='miss' && !move.san.endsWith('#')
    && (alternativeLine.moves[0]?.san.endsWith('#') || new Chess(move.before).moves().some(san=>san.endsWith('#')));
  const draw=!reply.moves.length?drawComment(reply.final):'';
  const ownMate=reply.moves.slice(0,NEAR_CONSEQUENCE_PLIES).find(step=>step.color===move.color && new Chess(step.after).isCheckmate());
  if(draw)responseFact=draw;
  if(ownMate)responseFact=`이 예상 수순에서는 ${mateFact(ownMate)}`;
  let reason;
  if(immediateMateMiss)reason='한 수에 끝낼 수 있는 체크메이트 기회를 놓쳤습니다.';
  else if(draw)reason=draw;
  else if(ownMate)reason=responseFact;
  else if(reply.moves.some(step=>step.color!==move.color && new Chess(step.after).isCheckmate()))reason=responseFact;
  else if(reply.score?.type==='mate' && mateWinner(reply.score)!==move.color)reason=`엔진은 상대의 ${Math.abs(reply.score.value)}수 안의 체크메이트를 예상합니다.${responseFact?` ${responseFact}`:''}`;
  else if(before.score.type==='mate' && mateWinner(before.score)===move.color && mateWinner(reply.score)!==move.color)reason='체크메이트 기회를 놓쳤습니다.';
  else if(consequence && !consequence.distant)reason=responseFact;
  else if(opportunity)reason=opportunity+(opponent?.san.endsWith('+')&&responseFact?` ${responseFact}`:'');
  else if(consequence)reason=distantRisk(consequence);
  else reason=responseFact;
  return {responseFact,alternativeFact,summary:[reason,alternativeFact].filter(Boolean).join(' ')||'구체적인 응수와 대안을 확인하려면 앞뒤 국면을 다시 분석해 주세요.'};
}

// Short, board-grounded explanations; no opening-book or proprietary review labels.
export function describeMove(move,before,after,context = {}) {
  if (!move) return {grade:null,text:'기보에서 수를 선택하면 그 수의 의미를 설명합니다.'};
  const grade=classifyMove(before,after,move,context);
  if (!grade)return {grade,text:basicMoveComment(move,context)};
  if(grade.severity<1)return {grade,text:explainMove(move,before,after,context)?.summary||exceptionalMoveComment(move,context)};
  after=assessedMoveResult(before,after,move);
  const reply=focusContinuation(move,continuation(insightPosition(move,true,context),after),false,NEAR_CONSEQUENCE_PLIES,context);
  const alternative=focusContinuation(move,continuation(insightPosition(move,false,context),before),true,NEAR_CONSEQUENCE_PLIES,context);
  return {grade,text:mistakeDetails(move,before,after,grade,reply,alternative).summary};
}
