import { Chess, classifyMove, assessedMoveResult, reviewedSacrificeEvidence, sacrificeCandidates, isRecapture, GRADING_BASIS, formatScore, gameAt, scoreValue, uciMove } from './chess-core.js';
import { AnalysisLine, PIECE_NAMES, cloneChess, materialBalance, moveText } from './study.js';
import { positionalPawnPurpose } from './positional-purpose.js';
import { tacticalPatterns } from './tactical-patterns.js';

const side = color => color === 'w' ? '백' : '흑';
const object = type => PIECE_NAMES[type]+(type === 'n' ? '를' : '을');
export const moveTurn = move => `${side(move.color)}의 ${move.before.split(' ')[5]}번째 수`;
export const moveLabel = move => `${moveTurn(move)} · ${PIECE_NAMES[move.piece]} ${move.from}에서 ${move.to}로`;
const mateWinner = score => score?.type === 'mate' ? (scoreValue(score) > 0 ? 'w' : 'b') : null;
const assessedInsightResult=(before,after,move,context={})=>assessedMoveResult(before,after,move,
  context.game && Number.isInteger(context.index)?{moves:context.game.moves,moveIndex:context.index-1}:context);
const insightGradeContext=(context={})=>context.game && Number.isInteger(context.index)
  ?{...context,moves:context.game.moves,moveIndex:context.index-1}:context;

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
      primary:signature(assessedInsightResult(before,after,move,{game,index}))});
  } catch { return null; }
}

function refinedContinuation(context,kind,result) {
  const identity=insightIdentity(context,kind),{before,after}=context,move=context.game?.moves[context.index-1];
  if(!identity || result?.explanationIdentity!==identity || result.multipvComplete!==true || !Number.isInteger(result.depth)
    || !Array.isArray(result.lines) || result.lines.length!==1 || !['cp','mate'].includes(result.score?.type)
    || !Number.isFinite(result.score.value) || result.score.type==='mate' && !['w','b'].includes(result.score.winner))return null;
  try { result=structuredClone(result); } catch { return null; }
  const primary=assessedInsightResult(before,after,move,context),proof=kind==='sacrifice'?reviewedSacrificeEvidence(before,after,move):null;
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
    const source=sacrificeLine(move,before,after,{offer,branch:{...candidate,capture:result.bestmove}},result,line,null,context);
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
    const details=insight.kind==='mistake'?mistakeDetails(move,before,assessedInsightResult(before,after,move,context),insight.grade,insight.response,source):null;
    const alternativeFact=alternativeExplanation(move,source,details?.alternativeFact);
    return {...insight,alternative:source,alternativeFact,summary:details?details.summary
      :goodMoveSummary(move,insight.purposeFact,insight.response,insight.sacrificeFact,insight.riskFact,insight.grade,source)};
  }
  const consequence=source.consequence;
  const details=insight.kind==='mistake'?mistakeDetails(move,before,assessedInsightResult(before,after,move,context),insight.grade,source,insight.alternative):null;
  const mate=verifiedMate(source),mateFact=verifiedMateFact(source,move.color),opponentMate=mate&&mate.winner!==move.color;
  const openedRisk=insight.kind==='move'&&!insight.sacrificeFact?nearMaterialRisk(move,source):'';
  const responseFact=details?.responseFact||(opponentMate?mateFact:source.offer&&source.focus.payoff?sacrificeExplanation(move,source):mateFact||openedRisk||firstMoveFact(source));
  const purposeFact=insight.kind==='mistake'?insight.purposeFact:endingMovePurpose(move,insight.grade)||basicMoveComment(move,{...context,continuation:source});
  const summary=details?.summary||goodMoveSummary(move,purposeFact,source,insight.sacrificeFact,openedRisk,insight.grade,insight.alternative);
  return {...insight,response:source,responseFact,summary,purposeFact,riskFact:details?.riskFact||(opponentMate?mateFact:openedRisk||(source.score.type!=='mate' && consequence?.distant?distantRisk(consequence):'')),
    materialFact:source.score.type!=='mate'?nearMaterialNote(source):''};
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
  const result = source.binding || sacrifice ? source.result : response ? assessedInsightResult(before,after,move,context) : before;
  const count=scope==='core' ? source.focus.length : source.pv.length;
  const line = new AnalysisLine(gameAt(game,afterMove ? index : index-1),source.pv.slice(0,count),result);
  if (!line.steps.length) return null;
  for (const [stepIndex,step] of line.steps.entries()) step.explanation=exampleStepComment(step,{previousMove:line.steps[stepIndex-1]||line.prefixMoves.at(-1),
    continuation:{...source,moves:source.moves.slice(stepIndex+1)}});
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
  return sacrificeLine(move,before,after,evidence,null,null,insightPosition(move,true,context),context);
}

function sacrificeLine(move,before,after,evidence,refinedResult=null,preparedLine=null,basePosition=null,context={}) {
  const {offer,branch}=evidence;
  const primary=assessedInsightResult(before,after,move,context);
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
  if(move.promotion)text=text.replace('승격해 상대 왕을','승격하며 상대 왕을');
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
    const firstOwn=line.moves[1],quietPurpose=firstOwn?basicMoveComment(firstOwn):'';
    const quietSetup=firstOwn && firstOwn.color===move.color && !firstOwn.captured && !firstOwn.promotion && !/[+#]$/.test(firstOwn.san) && firstOwn!==finish
      && !/에서 .*로 옮깁니다\.$/.test(quietPurpose)?`${concreteStepFact(firstOwn)} `:'';
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

function neutralExchange(move,reply,context={}) {
  if(!move || !reply?.complete || reply.invalid || reply.score?.type==='mate' || !['r','q'].includes(move.piece)
    || move.promotion || /[+#]$/.test(move.san) || /[kq]/.test(move.flags) || isRecapture(move,context))return null;
  const capture=reply.moves[0];
  if(!capture?.captured || capture.color===move.color || capture.captured!==move.piece
    || capturedSquare(capture)!==move.to || capture.promotion || /[+#]$/.test(capture.san))return null;
  if(move.captured) {
    if(move.captured!==move.piece)return null;
  } else {
    const recapture=reply.moves[1];
    if(capture.piece!==move.piece || !recapture?.captured || recapture.color!==move.color
      || recapture.captured!==capture.piece || capturedSquare(recapture)!==capture.to
      || recapture.promotion || /[+#]$/.test(recapture.san)
      || !attackedBy(new Chess(move.after),move.to,move.color).some(target=>target.square===capture.from&&target.type===capture.piece))return null;
  }
  const line={...reply,moves:[move,...reply.moves]},exchange=exchangeEnd(line,move.captured?0:1);
  if(exchange.incomplete || exchange.end>(move.captured?2:3))return null;
  const initial=materialBalance(pieces(new Chess(move.before))).difference;
  const final=materialBalance(pieces(new Chess(line.moves[exchange.end-1].after))).difference;
  if(initial!==final)return null;
  return {end:exchange.end,text:move.captured
    ? `${move.to}의 ${object(move.captured)} 잡아 ${PIECE_NAMES[move.piece]} 교환을 제안합니다.`
    : `${move.to}에서 ${PIECE_NAMES[move.piece]} 교환을 제안합니다.`};
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

function laterCapturerRecovery(line,index,end) {
  const capturer=line.moves[index];
  let square=capturer.to,type=capturer.promotion||capturer.piece;
  // A quiet intermediate move does not settle a trade when this same piece
  // is actually recaptured soon afterwards in the recorded legal example.
  for(let next=index+1;next<Math.min(line.moves.length,MAX_INSIGHT_PLIES);next++) {
    const step=line.moves[next];
    if(step.color!==capturer.color && step.captured===type && capturedSquare(step)===square)return next>=end?next:null;
    if(step.color===capturer.color && step.from===square && step.piece===type) {
      square=step.to;type=step.promotion||step.piece;
    }
  }
  return null;
}

function nearMaterialLoss(move,line,context={}) {
  if(!line.complete || line.invalid || !line.moves.length)return {loss:null,recoveryEnd:0};
  const baseline=recaptureBaseline(move,context),before=new Chess(move.before),initial=pieces(new Chess(baseline)),sign=move.color==='w'?1:-1;
  const start=materialBalance(initial).difference*sign;
  const replyStart=materialBalance(pieces(new Chess(move.after))).difference*sign;
  const balance=(list,type)=>list.filter(piece=>VALUES[piece.type]===VALUES[type]&&piece.color===move.color).length
    -list.filter(piece=>VALUES[piece.type]===VALUES[type]&&piece.color!==move.color).length;
  const found=[];let recoveryEnd=0;
  for(let index=0;index<Math.min(line.moves.length,NEAR_CONSEQUENCE_PLIES);index++) {
    const step=line.moves[index];
    if(step.color===move.color || !step.captured&&!step.promotion)continue;
    const promotion=!!step.promotion;
    if(!promotion && VALUES[step.captured]<3)continue;
    // Trace the victim through the actual move and intervening moves. A queen
    // just promoted from a pawn is not an original nine-point queen loss.
    let origin=capturedSquare(step),type=step.captured,promoted=false;
    for(const previous of [move,...line.moves.slice(0,index)].reverse()) {
      if(previous.color!==move.color || previous.to!==origin || (previous.promotion||previous.piece)!==type)continue;
      if(previous.promotion)promoted=true;
      origin=previous.from;type=previous.piece;
    }
    if(!promotion && (promoted || before.get(origin)?.color!==move.color || before.get(origin)?.type!==type))continue;
    // Include an immediate capture of a newly promoted piece before judging
    // the gain, even when the promotion itself did not capture anything.
    const next=line.moves[index+1],takesPromotion=promotion&&next?.captured===step.promotion
      && capturedSquare(next)===step.to;
    let {end,incomplete}=exchangeEnd(line,takesPromotion?index+1:index);
    const recovery=laterCapturerRecovery(line,index,end);
    if(recovery!==null) {
      ({end,incomplete}=exchangeEnd(line,recovery));
      recoveryEnd=Math.max(recoveryEnd,end);
    }
    if(incomplete || end>MAX_INSIGHT_PLIES)continue;
    const final=pieces(new Chess(line.moves[end-1].after)),loss=start-materialBalance(final).difference*sign;
    if(loss<=0 || !promotion&&balance(initial,type)<=balance(final,type))continue;
    found.push({capture:step,ply:index+1,end,loss,replyLoss:replyStart-materialBalance(final).difference*sign,
      includesPriorCapture:baseline!==move.before,distant:false,kind:promotion?'promotion':'material'});
  }
  return {loss:found.sort((a,b)=>b.loss-a.loss || VALUES[b.capture.captured||'p']-VALUES[a.capture.captured||'p'] || a.ply-b.ply)[0]||null,recoveryEnd};
}

// A short scene can end before an offered piece is compensated on a different
// square. Verify both a nearby settled recovery and the end of the completed
// example before turning that scene's temporary deficit into a final loss.
function settledMaterialRecovery(move,line,loss,context={}) {
  if(!loss?.capture?.captured || loss.kind!=='material' || !line.complete || line.invalid
    || line.score?.type==='mate' || !line.moves.length)return null;
  const sign=move.color==='w'?1:-1;
  const initial=materialBalance(pieces(new Chess(recaptureBaseline(move,context)))).difference*sign;
  const tail=exchangeEnd(line,line.moves.length-1);
  if(tail.incomplete || materialBalance(pieces(line.final)).difference*sign<initial)return null;
  for(let index=loss.end;index<Math.min(line.moves.length,MAX_INSIGHT_PLIES);index++) {
    const capture=line.moves[index];
    if(capture.color!==move.color || !capture.captured&&!capture.promotion)continue;
    const exchange=exchangeEnd(line,index);
    if(exchange.incomplete || exchange.end>MAX_INSIGHT_PLIES)continue;
    const final=materialBalance(pieces(new Chess(line.moves[exchange.end-1].after))).difference*sign;
    if(final>=initial)return {loss,capture,end:exchange.end};
  }
  return null;
}

function materialRecoveryFact(line) {
  const recovery=line.materialRecovery;
  if(!recovery)return '';
  const lost=recovery.loss.capture;
  return `이 예상 수순에서는 ${capturedSquare(lost)}의 ${object(lost.captured)} 먼저 내주지만, ${concreteMoveText(recovery.capture,'possible')} 이어지는 교환을 반영하면 기물 점수 손해는 남지 않습니다.`;
}

function verifiedMate(line) {
  const score=line?.score,winner=score?.winner,finish=line?.moves.at(-1);
  if(!line?.complete || line.invalid || score?.type!=='mate' || !['w','b'].includes(winner)
    || !Number.isInteger(score.value) || Math.abs(score.value)<1 || !finish || finish.color!==winner
    || mateWinner(score)!==winner || !new Chess(finish.after).isCheckmate()
    || line.moves.filter(step=>step.color===winner).length!==Math.abs(score.value))return null;
  return {finish,winner,distance:Math.abs(score.value)};
}

const verifiedMateFact=(line,perspective=null)=>{
  const mate=verifiedMate(line);
  return mate?`${line.moves.length>NEAR_CONSEQUENCE_PLIES?'전체 예상 수순에서는':'이 예상 수순에서는'} ${mate.winner===perspective?mateFact(mate.finish):concreteMoveText(mate.finish,'possible')}`:'';
};

const missedMateTwo=(move,grade,alternative)=>grade.mateEvidence?.kind==='missed-verified-mate-in-two'
  && grade.mateEvidence.first===alternative.pv[0] && verifiedMate(alternative)?.winner===move.color
  && verifiedMate(alternative)?.distance===2;

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

function alternativeCombination(line) {
  const first=line.moves[0];
  if(!first || !line.complete || line.invalid)return null;
  for(let index=1;index<Math.min(line.moves.length-1,NEAR_CONSEQUENCE_PLIES);index++) {
    const capture=line.moves[index],setup=line.moves[index-1],reply=line.moves[index+1];
    if(capture.color===first.color || setup.color!==first.color || reply.color!==first.color
      || !capture.captured || !reply.captured || setup.to!==capturedSquare(capture)
      || (setup.promotion||setup.piece)!==capture.captured || capturedSquare(reply)!==capture.to
      || reply.captured!==(capture.promotion||capture.piece) || !['n','b','r','q'].includes(capture.captured))continue;
    const kind=reply.promotion?'promotion-recapture'
      :setup.captured==='p' && capture.piece==='p' && reply.captured==='p' && /[+#]$/.test(reply.san)?'checking-pawn-exchange'
      :index===1 && !setup.captured && !/[+#]$/.test(setup.san) && ['r','q'].includes(setup.piece)
        && capture.piece===setup.piece && !reply.promotion?'equal-major-exchange':null;
    if(!kind)continue;
    let finish=index+1;
    // A promotion with check can be followed by a capture of the other queen.
    // Follow only this newly promoted piece, never a second same-type piece.
    if(reply.promotion && line.moves[index+3]?.color===first.color
      && line.moves[index+3].from===reply.to && line.moves[index+3].piece===reply.promotion
      && line.moves[index+3].captured==='q' && line.moves[index+2]?.color!==first.color
      && !(line.moves[index+2].captured && capturedSquare(line.moves[index+2])===reply.to))finish=index+3;
    const exchange=exchangeEnd(line,finish);
    if(exchange.incomplete || exchange.end>MAX_INSIGHT_PLIES)continue;
    return {kind,setup:index-1,capture:index,reply:index+1,finish,end:exchange.end};
  }
  return null;
}

function alternativeCombinationFact(line) {
  const proof=line.focus?.combination;
  if(!proof)return '';
  const setup=line.moves[proof.setup],capture=line.moves[proof.capture],reply=line.moves[proof.reply],finish=line.moves[proof.finish];
  const preparation=proof.setup>0?`이어지는 예시에서 ${concreteMoveText(setup)} `:'';
  const acceptance=`${preparation}예상 수순에서 상대가 ${capture.to}의 ${object(capture.captured)} ${PIECE_NAMES[capture.piece]}${capture.piece==='n'?'로':'으로'} 잡으면, `;
  if(proof.kind==='promotion-recapture')return `${acceptance}${reply.from}의 폰으로 되잡으며 ${PIECE_NAMES[reply.promotion]}${reply.promotion==='n'?'로':'으로'} 승격합니다.${finish!==reply?` 이어지는 예시에서 승격한 ${PIECE_NAMES[reply.promotion]}${reply.promotion==='n'?'로':'으로'} ${capturedSquare(finish)}의 ${object(finish.captured)} 잡습니다.`:''}`;
  if(proof.kind==='checking-pawn-exchange')return `${acceptance}${PIECE_NAMES[reply.piece]}${reply.piece==='n'?'로':'으로'} 그 폰을 되잡아 체크합니다. ${object(setup.piece)} 내주는 대신 폰 두 개를 잡으며 체크를 이어가는 예시입니다.`;
  return `${acceptance}${PIECE_NAMES[reply.piece]}${reply.piece==='n'?'로':'으로'} 되잡아 ${PIECE_NAMES[setup.piece]}${setup.piece==='n'?'가':'이'} 하나씩 교환됩니다.`;
}

function minorExchange(move,line) {
  if(!line.complete || line.invalid || line.score?.type==='mate')return null;
  const prefix=[move],initial=materialBalance(pieces(new Chess(move.before))).difference;
  for(const step of line.moves.slice(0,NEAR_CONSEQUENCE_PLIES)) {
    prefix.push(step);
    const captures=prefix.filter(next=>next.captured);
    if(captures.some(next=>!['n','b'].includes(next.captured)) || prefix.some(next=>next.promotion))return null;
    if(captures.length<2)continue;
    if(captures.length!==2 || captures[0].color===captures[1].color)return null;
    if(materialBalance(pieces(new Chess(step.after))).difference!==initial)return null;
    const lost=captures.find(next=>next.color!==move.color),gained=captures.find(next=>next.color===move.color);
    const own=`${side(move.color)} ${PIECE_NAMES[lost.captured]}`,enemy=`${side(gained.color==='w'?'b':'w')} ${PIECE_NAMES[gained.captured]}`;
    const join=lost.captured==='n'?'와':'과',subject=gained.captured==='n'?'가':'이';
    const where=capturedSquare(lost)===capturedSquare(gained)?`${capturedSquare(lost)}에서 ${own}${join} ${enemy}`
      :`${capturedSquare(lost)}의 ${own}${join} ${capturedSquare(gained)}의 ${enemy}`;
    const next=line.moves[prefix.length-1],follow=next?.captured && next.color!==step.color
      && capturedSquare(next)===step.to && next.captured===(step.promotion||step.piece)
      ?` 이어지는 예시에서 ${concreteMoveText(next,'possible')}`:'';
    return {text:`예상 응수에서는 ${where}${subject} 교환됩니다.${follow}`,end:prefix.length-1};
  }
  return null;
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
  let consequence=alternative?null:materialConsequence(move,line);
  let {loss:nearLoss,recoveryEnd}=alternative?{loss:null,recoveryEnd:0}:nearMaterialLoss(move,line,context);
  const recovery=!alternative&&settledMaterialRecovery(move,line,nearLoss,context);
  if(recovery) {
    if(consequence?.capture===nearLoss.capture)consequence=null;
    nearLoss=null;recoveryEnd=Math.max(recoveryEnd,recovery.end);
    line.materialRecovery=recovery;
  }
  const offer=!alternative && line.moves[0]?.captured ? sacrificeCandidates(move).find(offer=>offer.captures.includes(line.pv[0])) : null;
  const payoff=offer?compensationPayoff(move,line):null;
  const purposePayoff=alternative?quietAlternativePayoff(line):null;
  const combination=alternative?alternativeCombination(line):null;
  const trade=alternative?neutralExchange(line.moves[0],{...line,moves:line.moves.slice(1)},context):null;
  const limit=payoff||combination?MAX_INSIGHT_PLIES:maxPlies;
  const mate=line.moves.findIndex((step,index)=>index<limit && new Chess(step.after).isCheckmate());
  const chosen=mate>=0?mate:payoff?payoff.index:purposePayoff?purposePayoff.index:combination?combination.finish:trade?trade.end-1:nearLoss?nearLoss.end-1:recoveryEnd?recoveryEnd-1:consequence && (!consequence.distant || maxPlies>NEAR_CONSEQUENCE_PLIES && consequence.end<=maxPlies) ? consequence.ply-1 : 0;
  const exchange=exchangeEnd(line,chosen);
  // Complete a nearby tactical exchange, including a checking intermezzo,
  // rather than reporting the temporary material balance at the six-ply cut.
  const exchangeLimit=nearLoss || recoveryEnd || consequence && !consequence.distant?MAX_INSIGHT_PLIES:limit;
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
  if(combination)line.focus.combination=combination;
  if(recoveryEnd)line.focus.recoveredExchange=true;
  if(offer)line.offer={...offer};
  line.consequence=consequence;
  line.nearLoss=nearLoss;
  return line;
}

function distantRisk(consequence) {
  const capture=consequence.capture;
  if(consequence.ply<=NEAR_CONSEQUENCE_PLIES) return `${concreteMoveText(capture,'possible')} 손익은 ${consequence.end}번 이동까지 이어지는 교환을 예상한 결과이며, 후속 수순에 따라 달라질 수 있습니다.`;
  return `긴 예상 수순이 이어질 경우, ${consequence.ply}번째 이동에서 ${concreteMoveText(capture,'possible')} 이후 선택에 따라 달라질 수 있습니다.`;
}

export function explainMistake(move, before, after, context = {}) {
  const grade = move && classifyMove(before,after,move,insightGradeContext(context));
  if (!grade || grade.severity < 1) return null;
  after=assessedInsightResult(before,after,move,context);
  const player = side(move.color), opponent = side(move.color === 'w' ? 'b' : 'w');
  const response = focusContinuation(move,continuation(insightPosition(move,true,context),after),false,NEAR_CONSEQUENCE_PLIES,context), alternative = focusContinuation(move,continuation(insightPosition(move,false,context),before),true,NEAR_CONSEQUENCE_PLIES,context);
  const sign = move.color === 'w' ? 1 : -1;
  const beforeValue = scoreValue(before.score)*sign, afterValue = scoreValue(after.score)*sign;
  const beforeMate = mateWinner(before.score), afterMate = mateWinner(after.score);
  const mateChanged = before.score.type === 'mate' || after.score.type === 'mate';
  const lossText = mateChanged ? '메이트 평가 변화' : `${player}의 평가 손실 ${(grade.loss/100).toFixed(2)}`;
  let reason;
  if(missedMateTwo(move,grade,alternative))reason='두 수로 끝낼 수 있는 체크메이트 기회를 놓쳤습니다.';
  else if (afterMate && afterMate !== move.color) {
    reason = verifiedMateFact(response,move.color)||'분석은 상대 메이트를 예상하지만, 전체 수순은 아직 확인되지 않았습니다.';
  } else if (beforeMate === move.color && afterMate !== move.color) {
    reason = new Chess(move.before).moves().some(san=>san.endsWith('#'))
      ?'한 수에 끝낼 수 있는 체크메이트 기회를 놓쳤습니다.'
      :'이 수 뒤에도 메이트가 이어지는지는 이번 수순에서 확인되지 않았습니다.';
  } else if (beforeValue >= 100 && afterValue <= -100) reason = `${player}이 유리하던 국면이 ${opponent}에게 유리한 국면으로 바뀌었습니다.`;
  else if (beforeValue >= 100 && afterValue < 100) reason = `${player}이 갖고 있던 우세를 살리지 못했습니다.`;
  else if (beforeValue > -100 && afterValue <= -100) reason = `버틸 수 있던 국면에서 ${player}이 불리해졌습니다.`;
  else if (afterValue <= -100) reason = `이미 불리한 국면에서 ${player}의 열세가 더 커졌습니다.`;
  else reason = '';

  const consequence=response.consequence;
  const details=mistakeDetails(move,before,after,grade,response,alternative);
  const responseFact=details.responseFact;
  const riskFact=details.riskFact||(!afterMate && consequence?.distant ? distantRisk(consequence) : '');
  const materialFact=!afterMate ? nearMaterialNote(response) : '';
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
  const grade=move && classifyMove(before,after,move,insightGradeContext(context));
  if (!grade) return null;
  if (grade.severity>=1) return {...explainMistake(move,before,after,context),kind:'mistake',moveFact:moveText(move),sacrifice:null,sacrificeFact:''};
  const assessed=assessedInsightResult(before,after,move,context);
  const response=focusContinuation(move,continuation(insightPosition(move,true,context),assessed),false,NEAR_CONSEQUENCE_PLIES,context);
  const alternative=focusContinuation(move,continuation(insightPosition(move,false,context),before),true,NEAR_CONSEQUENCE_PLIES,context);
  const sacrifice=sacrificeContinuation(move,before,after,context);
  const purpose=endingMovePurpose(move,grade)||basicMoveComment(move,{...context,continuation:response});
  const reason=grade.reason || (grade.key==='best' ? '분석한 후보 중 가장 높은 평가를 지키는 수입니다.'
    : grade.key==='excellent' ? '엔진이 예상한 승점을 거의 지키는 선택입니다.'
    : '최선수와 비교해 예상 승점의 감소를 작게 유지한 선택입니다.');
  const sacrificeFact=sacrifice ? sacrificeExplanation(move,sacrifice) : '';
  const primaryFact=response.offer && response.focus.payoff ? sacrificeExplanation(move,response) : '';
  const mate=verifiedMate(response),mateFact=verifiedMateFact(response,move.color),opponentMate=mate&&mate.winner!==move.color;
  const openedRisk=!sacrificeFact&&!primaryFact?nearMaterialRisk(move,response):'';
  const alternativeCoach=coachAlternative(alternative);
  const summary=goodMoveSummary(move,purpose,response,sacrificeFact,openedRisk,grade,alternative,alternativeCoach);
  return {kind:'move',grade,moveFact:moveText(move),purposeFact:purpose,reason,summary,
    response,responseFact:opponentMate?mateFact:primaryFact||mateFact||materialRecoveryFact(response)||openedRisk||firstMoveFact(response),alternative,
    alternativeFact:alternativeExplanation(move,alternative,alternativeCoach?.text),
    sacrifice,sacrificeFact,riskFact:opponentMate?mateFact:openedRisk,materialFact:openedRisk||response.focus.recoveredExchange?nearMaterialNote(response):'',lossText:'이 수의 의미',
    evaluation:`수 전 ${formatScore(before.score)} → 수 후 ${formatScore(assessed.score)} (백 기준)`,basis:GRADING_BASIS};
}

function endingOutcome(move,grade) {
  const evidence=grade?.endgameEvidence;
  if(evidence?.kind!=='preserved-king-rook-vs-king' || evidence.drawClaimsChecked!==true
    || !['w','b'].includes(evidence.winner) || evidence.maxHalfmove!==66)return '';
  const men=pieces(new Chess(move.after));
  if(men.length!==3 || men.filter(piece=>piece.type==='k').length!==2
    || men.filter(piece=>piece.type==='r' && piece.color===evidence.winner).length!==1)return '';
  return `룩을 가진 ${side(evidence.winner)}의 이론적 승리 국면은 유지됩니다.`;
}

function endingMovePurpose(move,grade) {
  if(!endingOutcome(move,grade) || grade.endgameEvidence.winner!==move.color || /[+#]$/.test(move.san))return '';
  const after=new Chess(move.after),men=pieces(after);
  const enemyKing=men.find(piece=>piece.type==='k' && piece.color!==move.color);
  const ownKing=men.find(piece=>piece.type==='k' && piece.color===move.color);
  if(move.piece==='k') {
    const distance=from=>Math.max(Math.abs(from.charCodeAt(0)-enemyKing.square.charCodeAt(0)),Math.abs(Number(from[1])-Number(enemyKing.square[1])));
    if(distance(move.to)<distance(move.from))return `왕을 ${move.to}로 가져가 상대 왕에게 접근합니다.`;
  }
  if(move.piece==='r') {
    // A bare enemy king cannot pass through a controlled rank/file on this
    // board. State the visible barrier, not a forced route or mating distance.
    if(move.to[1]!==move.from[1] && !['1','8'].includes(move.to[1]) && ownKing.square[1]!==move.to[1]
      && enemyKing.square[1]!==move.to[1])return `룩으로 ${move.to[1]}번째 가로줄을 제어해 상대 왕이 이동할 공간을 제한합니다.`;
    if(move.to[0]!==move.from[0] && !['a','h'].includes(move.to[0]) && ownKing.square[0]!==move.to[0]
      && enemyKing.square[0]!==move.to[0])return `룩으로 ${move.to[0]}파일을 제어해 상대 왕이 이동할 공간을 제한합니다.`;
  }
  return '';
}

function shortAlternativeMate(move,line) {
  const mate=line&&verifiedMate(line);
  if(!mate || mate.winner!==move.color || Math.abs(line.score.value)>4 || line.pv[0]===uciMove(move))return '';
  return `대신 ${concreteMoveText(line.moves[0],'possible')} ${verifiedMateFact(line,move.color)}`;
}

function shortAlternativePurpose(move,line,response,alternative=null) {
  if(!line?.complete || line.invalid || line.pv[0]===uciMove(move))return '';
  alternative=alternative||coachAlternative(line);
  const plan=alternative&&coachPlan(move,response);
  if(!alternative || !plan)return '';
  const combination=alternativeCombinationFact(line);
  if(combination)return `다른 후보로는 ${concreteMoveText(alternative.move,'possible')} ${combination}`;
  const escapingAttack=alternative.kind==='escape' && alternative.targets?.some(target=>VALUES[target.type]>=3
    && !plan.targets?.some(actual=>actual.square===target.square && actual.type===target.type));
  const relevant=['defend','develop','pawn-plan','discovered-defense','block','unpin','rook-connection'].includes(alternative.kind)
    || alternative.defendedPawns?.length || escapingAttack;
  if(!relevant || !alternative.benefit || alternative.kind===plan.kind && !alternative.defendedPawns?.length && !escapingAttack)return '';
  if(alternative.kind==='develop' && ['n','b'].includes(move.piece))return '';
  const after=new Chess(move.after),enemy=move.color==='w'?'b':'w';
  const protectedTargets=alternative.defendedPawns||alternative.kind==='defend'&&alternative.targets||[];
  if(protectedTargets.length && !protectedTargets.some(target=>after.get(target.square)?.color===move.color
    && legallyAttacked(after,target.square,enemy) && !legalGuard(after,target.square,move.to,move.color)))return '';
  const better=alternative.move;
  return `다른 후보로는 ${object(better.piece)} ${better.from}에서 ${better.to}로 옮겨 ${alternative.benefit} 수도 있었습니다.`;
}

function goodMoveSummary(move,purpose,response,sacrificeFact='',openedRisk='',grade=null,alternative=null,alternativeCoach=null) {
  const verified=verifiedMate(response);
  const ending=endingOutcome(move,grade);
  if(verified && verified.winner!==move.color)return [verifiedMateFact(response,move.color),ending].filter(Boolean).join(' ');
  if(sacrificeFact)return sacrificeFact;
  if(response.offer && response.focus.payoff)return sacrificeExplanation(move,response);
  if(grade?.mateEvidence?.kind==='retained-verified-mate-in-two' && verified?.winner===move.color) {
    const first=alternative?.moves[0],faster=verifiedMate(alternative);
    const option=first&&faster?.winner===move.color&&faster.distance===2
      ? `더 빠른 메이트로는 ${concreteMoveText(first,'possible')}`:'';
    return [purpose,'강제 체크메이트로 이어지는 수순을 유지합니다.',option].filter(Boolean).join(' ');
  }
  if(response.materialRecovery)return [purpose,materialRecoveryFact(response)].filter(Boolean).join(' ');
  const otherMate=shortAlternativeMate(move,alternative);
  if(verified)return [move.promotion?purpose:'',verifiedMateFact(response,move.color),otherMate,ending].filter(Boolean).join(' ');
  if(ending)return [purpose,ending].filter(Boolean).join(' ');
  const mate=response.moves.slice(0,NEAR_CONSEQUENCE_PLIES).find(step=>step.color===move.color && new Chess(step.after).isCheckmate());
  const trade=!openedRisk?minorExchange(move,response)?.text:'';
  return [mate?`이 예상 수순에서는 ${mateFact(mate)}`:openedRisk?`${purpose} ${openedRisk}`:purpose,trade,
    otherMate||shortAlternativePurpose(move,alternative,response,alternativeCoach)].filter(Boolean).join(' ');
}

function nearMaterialRisk(move,line) {
  const loss=line.nearLoss;
  if(!loss || line.score?.type==='mate' || line.focus?.incomplete || line.focus?.payoff)return '';
  if(!loss.includesPriorCapture && line.consequence?.capture===loss.capture && line.consequence.loss===loss.loss) {
    const opening=openedMajorRisk(move,line);
    if(opening)return opening;
  }
  const timing=loss.ply===1?'바로 다음 수에':'이어지는 예상 수순에서는';
  const promoted=line.moves.slice(0,loss.end).some(step=>step.promotion);
  // A newly selected later major loss is not proof that this move opened its
  // attack. Retain established causes for the original consequence only.
  const action=loss.kind!=='promotion' && line.consequence?.capture===loss.capture
    ?lossCause(move,line,loss.capture):`${timing} ${concreteMoveText(loss.capture,'possible')}`;
  const amount=loss.includesPriorCapture?loss.replyLoss:loss.loss;
  return amount>0?`${action} 이 예상 수순에서는 ${promoted?'교환과 승격을 반영하면':'교환 후'} ${side(move.color)}이 기물 점수 ${amount}점 손해를 봅니다.`:'';
}

const nearMaterialNote=line=>line.nearLoss?.includesPriorCapture && line.focus.note
  ?`앞선 포획부터 이어진 교환을 포함한 결과입니다. ${line.focus.note}`:line.focus.note;

function openedMajorRisk(move,line) {
  const consequence=line.consequence,capture=consequence?.capture;
  if(!line.complete || line.invalid || line.score?.type==='mate' || line.focus?.incomplete || line.focus?.payoff
    || !capture || capture.captured==='p' || consequence.distant || consequence.end>NEAR_CONSEQUENCE_PLIES)return '';
  const target=capturedSquare(capture),before=new Chess(move.before),after=new Chess(move.after),prefix=line.moves.slice(0,consequence.ply-1);
  if(target===move.to || before.get(target)?.color!==move.color || before.get(target)?.type!==capture.captured
    || after.get(target)?.color!==move.color || after.get(target)?.type!==capture.captured
    || !['b','r','q'].includes(capture.piece) || before.get(capture.from)?.color!==capture.color
    || before.get(capture.from)?.type!==capture.piece || after.get(capture.from)?.color!==capture.color
    || after.get(capture.from)?.type!==capture.piece
    || prefix.some(step=>[target,capture.from].includes(step.from)||[target,capture.from].includes(step.to)))return '';
  const matches=step=>step.from===capture.from&&capturedSquare(step)===target&&step.captured===capture.captured;
  if(legalCaptures(before,capture.color).some(matches) || !legalCaptures(after,capture.color).some(matches))return '';
  return `${lossCause(move,line,capture)} 이 예상 수순에서는 교환 후 ${side(move.color)}이 기물 점수 ${consequence.loss}점 손해를 봅니다.`;
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
  // A knight is a valid placeholder on every rank; a pawn on ranks 1 or 8
  // would make the probe's FEN invalid. Its type cannot change this capture's
  // legality: the placeholder is removed before checking the defender's king.
  probe.remove(target);probe.put({type:'n',color:enemy},target);
  return legalCaptures(probe,color).some(move=>move.from===from && move.to===target);
}

function pawnPurposePlan(move,before,after) {
  if(move.piece!=='p' || move.captured)return '';
  const attacked=attackedBy(after,move.to,move.color).filter(piece=>!['p','k'].includes(piece.type)
    && !before.attackers(piece.square,move.color).includes(move.from)).sort((a,b)=>VALUES[b.type]-VALUES[a.type]);
  if(attacked.length) {
    const action=`${targetName(attacked[0])}${attacked[0].type==='n'?'를':'을'} 공격`;
    const defended=pieces(after).filter(piece=>piece.color===move.color && piece.type==='p' && piece.square!==move.to
      && legallyAttacked(before,piece.square,move.color==='w'?'b':'w')
      && legalGuard(after,piece.square,move.to,move.color) && !legalGuard(before,piece.square,move.from,move.color));
    const support=defended.length?`공격받던 ${defended.map(piece=>piece.square).join('·')}의 폰을 지키면서 `:'';
    return {kind:'attack',text:support+action+'합니다.',benefit:support+action+'할',targets:[attacked[0]],defendedPawns:defended};
  }
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
  const benefit=opening?`${support?`${support}하고 `:''}${opening.square}의 비숍이 나올 길을 열`
    :support?`${support}할`:'';
  return text?{kind:'pawn-plan',text,benefit,cost:blocked&&opening?`${blocked.square}의 비숍이 갈 수 있는 대각선은 좁아집니다.`:''}:null;
}
const pawnPurpose=(move,before,after)=>pawnPurposePlan(move,before,after)?.text||'';

// A connection is useful board information, not a promise that doubling wins.
// Both rooks must be free to recapture on the other's square: an absolute pin
// or an intervening piece must not produce a fictitious mutual defence.
function rookConnection(move,before,after) {
  if(move.piece!=='r' || move.captured)return null;
  const partner=pieces(after).find(piece=>piece.color===move.color && piece.type==='r' && piece.square!==move.to
    && before.get(piece.square)?.type==='r' && before.get(piece.square)?.color===move.color
    && (piece.square[0]===move.to[0] || piece.square[1]===move.to[1])
    && canSupport(after,move.to,piece.square,move.color) && canSupport(after,piece.square,move.to,move.color)
    && !(canSupport(before,move.from,piece.square,move.color) && canSupport(before,piece.square,move.from,move.color)));
  if(!partner)return null;
  const line=partner.square[0]===move.to[0]?`${move.to[0]}파일`:`${move.to[1]}번째 가로줄`;
  return {kind:'rook-connection',text:`${line}에 두 룩을 연결해 서로 지키게 합니다.`,
    benefit:`${line}에 두 룩을 연결해 서로 지키게 할`,squares:[move.to,partner.square]};
}

function absolutePin(position,attackerSquare) {
  const attacker=position.get(attackerSquare);
  if(!attacker || !['b','r','q'].includes(attacker.type))return [];
  const [file,rank]=[attackerSquare.charCodeAt(0)-97,Number(attackerSquare[1])-1],pins=[];
  for(const [df,dr] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
    if(attacker.type==='b' && (!df||!dr) || attacker.type==='r' && df&&dr)continue;
    let target=null;
    for(let f=file+df,r=rank+dr;f>=0&&f<8&&r>=0&&r<8;f+=df,r+=dr) {
      const square=String.fromCharCode(97+f)+(r+1),piece=position.get(square);
      if(!piece)continue;
      if(piece.color===attacker.color)break;
      if(!target) {if(piece.type==='k')break;target={square,type:piece.type};continue;}
      if(piece.type==='k')pins.push({attackerSquare,attackerType:attacker.type,targetSquare:target.square,targetType:target.type,kingSquare:square});
      break;
    }
  }
  return pins;
}

function tracedVictim(line,setupIndex,target,capture) {
  let square=target.targetSquare;
  const color=capture.color==='w'?'b':'w',atSetup=new Chess(line.moves[setupIndex].after).get(square);
  if(atSetup?.color!==color || atSetup.type!==capture.captured || target.targetType!==capture.captured)return false;
  for(const step of line.moves.slice(setupIndex+1,line.moves.indexOf(capture))) {
    if(step.captured && capturedSquare(step)===square)return false;
    if(step.color===color && step.from===square)square=step.to;
  }
  return square===capturedSquare(capture);
}

function tracedAttacker(line,setupIndex,square,type,capture) {
  const attacker=new Chess(line.moves[setupIndex].after).get(square);
  if(attacker?.color!==capture.color || attacker.type!==type)return false;
  for(const step of line.moves.slice(setupIndex+1,line.moves.indexOf(capture))) {
    if(step.captured && capturedSquare(step)===square)return false;
    if(step.color===capture.color && step.from===square)square=step.to;
  }
  return square===capture.from && type===capture.piece;
}

// Explain the setup in the same legal PV as the capture, in chronological
// order. A motif elsewhere on the board cannot stand in for this victim, and
// the existence of a motif is never proof that every defence loses material.
function tacticalLossSetup(line,capture) {
  const end=line.moves.indexOf(capture);
  if(!line.complete || line.invalid || end<1 || end>=NEAR_CONSEQUENCE_PLIES)return '';
  for(const [index,step] of line.moves.slice(0,end).entries()) {
    if(step.color!==capture.color)continue;
    const tactics=tacticalPatterns(step),after=new Chess(step.after);
    const discovery=tactics?.discovered.find(target=>tracedVictim(line,index,target,capture)
      && tracedAttacker(line,index,target.attackerSquare,target.attackerType,capture));
    if(discovery) {
      const action=`${side(step.color)} ${object(step.piece)} ${step.from}에서 ${step.to}로 옮겨${after.isCheck()?' 체크하면서':''} ${discovery.attackerSquare}의 ${PIECE_NAMES[discovery.attackerType]}${discovery.attackerType==='n'?'가':'이'} ${discovery.targetSquare}의 ${object(discovery.targetType)} 공격할 길을 엽니다.`;
      return `이 예상 수순에서는 ${action} 이어서 ${concreteMoveText(capture,'possible')}`;
    }
    const skewer=tactics?.skewers.find(target=>tracedVictim(line,index,target,capture)
      && tracedAttacker(line,index,target.attackerSquare,target.attackerType,capture)
      && line.moves.slice(index+1,end).some(reply=>reply.color!==step.color && reply.piece==='k' && reply.from===target.kingSquare));
    if(skewer)return `이 예상 수순에서는 ${side(step.color)} ${PIECE_NAMES[skewer.attackerType]}${skewer.attackerType==='n'?'가':'이'} ${skewer.attackerSquare}에서 체크하면서 ${skewer.kingSquare}의 왕 뒤 ${skewer.targetSquare}의 ${PIECE_NAMES[skewer.targetType]}도 겨냥합니다. 왕이 피한 뒤 ${concreteMoveText(capture,'possible')}`;
    const pin=absolutePin(after,step.to).find(target=>tracedVictim(line,index,target,capture)
      && legalCaptures(after,step.color).some(attack=>attack.from===step.to && capturedSquare(attack)===target.targetSquare)
      && (tracedAttacker(line,index,target.attackerSquare,target.attackerType,capture)
        || line.moves[index+1]?.from===target.targetSquare && line.moves[index+1]?.to===target.attackerSquare
          && line.moves[index+1]?.captured===target.attackerType)
      && !absolutePin(new Chess(step.before),step.from).some(previous=>previous.targetSquare===target.targetSquare && previous.kingSquare===target.kingSquare));
    if(pin)return `이 예상 수순에서는 ${side(step.color)} ${PIECE_NAMES[pin.attackerType]}${pin.attackerType==='n'?'가':'이'} ${pin.attackerSquare}에서 ${pin.targetSquare}의 ${object(pin.targetType)} ${pin.kingSquare}의 왕 앞에 핀으로 묶습니다. 이어지는 교환에서 ${concreteMoveText(capture,'possible')}`;
  }
  return '';
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
  const setup=tacticalLossSetup(line,capture);
  if(setup)return setup;
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
  if (!guards.length) return `${stationary?'':'이 예상 수순에서 '}${square}의 ${victim}${capture.captured==='n'?'가':'이'} 수비 없이 남아, ${ending}`;
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

function defensivePurpose(move,tactics=tacticalPatterns(move)) {
  if(move.captured)return null;
  const block=tactics?.blocks.slice().sort((a,b)=>VALUES[b.protectedType]-VALUES[a.protectedType])[0];
  if(block) {
    const placement=`${block.blockSquare}에 ${object(move.piece)} 놓아 ${block.protectedSquare}의 ${PIECE_NAMES[block.protectedType]}에 걸린 핀을 `;
    const obstruction=`${block.blockSquare}에서 ${block.attackerSquare}의 ${PIECE_NAMES[block.attackerType]}${block.attackerType==='n'?'가':'이'} ${block.protectedSquare}의 ${object(block.protectedType)} 공격하던 길을 `;
    return block.kind==='unpin'?{kind:'unpin',text:placement+'풉니다.',benefit:placement+'풀'}
      :{kind:'block',text:obstruction+'막습니다.',benefit:obstruction+'막을'};
  }
  const defense=tactics?.discoveredDefenses.slice().sort((a,b)=>VALUES[b.protectedType]-VALUES[a.protectedType])[0];
  if(!defense)return null;
  const purpose=`${move.from} 칸을 비워 ${defense.defenderSquare}의 ${PIECE_NAMES[defense.defenderType]}${defense.defenderType==='n'?'가':'이'} 공격받던 ${defense.protectedSquare}의 ${object(defense.protectedType)} `;
  return {kind:'discovered-defense',protectedType:defense.protectedType,text:purpose+'지키게 합니다.',benefit:purpose+'지키게 할'};
}

function basicMoveComment(move,context={}) {
  const before=new Chess(move.before), after=insightPosition(move,true,context), enemy=move.color==='w'?'b':'w';
  if (after.isCheckmate()) return concreteMoveText(move);
  const draw=drawComment(after);
  if(draw)return draw;
  const evasion=checkEvasion(move,before,after);
  if(evasion)return evasion;
  if (move.promotion) return concreteMoveText(move);
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
  const pawnPlan=pawnPurpose(move,before,after);
  const defense=defensivePurpose(move,tactics);
  if(defense)return defense.kind==='discovered-defense'&&defense.protectedType==='p'&&pawnPlan
    ?`${pawnPlan} ${defense.text}`:defense.text;
  const trade=neutralExchange(move,context.continuation,context);
  if(trade)return trade.text;
  if (targets.length>=2 && targets[1].type!=='p') return `${targets.slice(0,2).map(targetName).join('·')}${targets[1].type==='n'?'를':'을'} 동시에 공격합니다.`;
  if (move.captured) return moveText(move);
  const promotionEscape=tactics?.promotionEscapes[0];
  if(promotionEscape)return `공격받던 ${object(move.piece)} ${move.to}로 피하면서 ${promotionEscape.promotionSquare} 승격칸도 계속 지킵니다.`;
  const discovered=tactics?.discovered.slice().sort((a,b)=>VALUES[b.targetType]-VALUES[a.targetType])[0];
  if(discovered && (!targets[0] || VALUES[discovered.targetType]>VALUES[targets[0].type]))return `${move.from} 칸을 비워 ${discovered.attackerSquare}의 ${PIECE_NAMES[discovered.attackerType]}${discovered.attackerType==='n'?'가':'이'} ${discovered.targetSquare}의 ${object(discovered.targetType)} 공격하게 합니다.`;
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
  const escaping=legallyAttacked(before,move.from,enemy) && !legallyAttacked(after,move.to,enemy);
  if (freshTarget) return `${escaping?`공격받던 ${object(move.piece)} ${move.to}로 피하면서 `:''}${targetName(freshTarget)}${freshTarget.type==='n'?'를':'을'} 공격합니다.`;
  const positionalPawn=positionalPawnPurpose(move);
  if (escaping) return `공격받던 ${object(move.piece)} ${move.to}로 피합니다.${positionalPawn.startsWith('통과 폰')?` ${positionalPawn}`:''}`;
  if(positionalPawn)return positionalPawn;
  const connection=rookConnection(move,before,after);
  if(connection)return connection.text;
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
function coachPlan(move,continuation=null) {
  const before=new Chess(move.before), after=new Chess(move.after), enemy=move.color==='w'?'b':'w';
  const targets=attackedBy(after,move.to,move.color).filter(piece=>piece.type!=='k').sort((a,b)=>VALUES[b.type]-VALUES[a.type]);
  const fresh=targets.filter(piece=>!before.attackers(piece.square,move.color).includes(move.from));
  const centers=['d4','e4','d5','e5'].filter(square=>after.attackers(square,move.color).includes(move.to) && canSupport(after,move.to,square,move.color));
  const developed=['n','b'].includes(move.piece) && move.from[1]===(move.color==='w'?'1':'8') && Number(move.before.split(' ')[5])<=10;
  const defended=pieces(after).filter(piece=>piece.color===move.color && piece.square!==move.to && piece.type!=='k'
    && legallyAttacked(before,piece.square,enemy) && legalGuard(after,piece.square,move.to,move.color)
    && !legalGuard(before,piece.square,move.from,move.color)).sort((a,b)=>VALUES[b.type]-VALUES[a.type]);
  if (move.san.endsWith('#')) return {kind:'mate',move};
  if(before.isCheck()) {
    const king=pieces(before).find(piece=>piece.color===move.color && piece.type==='k');
    const checker=king&&before.attackers(king.square,enemy).includes(capturedSquare(move))&&move.captured;
    return {kind:'check-evasion',move,benefit:checker?`체크하는 ${targetName({square:capturedSquare(move),type:move.captured})}${move.captured==='n'?'를':'을'} 잡아 체크를 해소할`
      :move.piece==='k'?'체크를 피할':'왕 앞을 막아 체크를 해소할'};
  }
  if (move.san.endsWith('+')) return {kind:'check',move};
  const defense=defensivePurpose(move);
  if(defense)return {...defense,move};
  const trade=neutralExchange(move,continuation);
  if(trade)return {kind:'exchange',move,trade,benefit:`${PIECE_NAMES[move.piece]} 교환을 제안할`};
  // A capture's immediate target is its main effect. A secondary attack after
  // that capture is not the opportunity the player necessarily missed.
  if(move.captured)return {kind:'capture',move};
  if (fresh.length>=2 && fresh[1].type!=='p') return {kind:'fork',move,targets:fresh.slice(0,2),benefit:`${fresh.slice(0,2).map(targetName).join('·')}${fresh[1].type==='n'?'를':'을'} 동시에 공격할`};
  const pawnPlan=pawnPurposePlan(move,before,after);
  if(pawnPlan)return {...pawnPlan,move};
  if (defended.length) return {kind:'defend',move,targets:[defended[0]],benefit:`공격받던 ${targetName(defended[0])}${defended[0].type==='n'?'를':'을'} 지킬`};
  if (developed) return {kind:'develop',move,centers,targets:fresh,benefit:fresh.length
    ? `${targetName(fresh[0])}${fresh[0].type==='n'?'를':'을'} 공격하며 전개할`
    : centers.length ? `중앙의 ${centers.join('·')} 칸을 제어하며 전개할` : `${object(move.piece)} 전개할`};
  if (legallyAttacked(before,move.from,enemy) && !legallyAttacked(after,move.to,enemy)) return {kind:'escape',move,targets:fresh,
    benefit:`상대의 공격을 피${fresh.length?`하면서 ${targetName(fresh[0])}${fresh[0].type==='n'?'를':'을'} 공격할`:'할'}`};
  if (fresh.length) return {kind:'attack',move,targets:[fresh[0]],benefit:`${targetName(fresh[0])}${fresh[0].type==='n'?'를':'을'} 공격할`};
  const connection=rookConnection(move,before,after);
  if(connection)return {...connection,move};
  const positionalPawn=positionalPawnPurpose(move);
  if(positionalPawn) {
    const benefit=positionalPawn.replace(/남겨둡니다\.$/,'남겨둘').replace(/만듭니다\.$/,'만들');
    return {kind:'pawn-plan',move,benefit};
  }
  if (move.piece==='r' && !pieces(after).some(piece=>piece.type==='p' && piece.square[0]===move.to[0])) return {kind:'file',move,benefit:`폰이 없는 ${move.to[0]}파일을 차지할`};
  if (centers.length) return {kind:'center',move,centers,benefit:`중앙의 ${centers.join('·')} 칸을 제어할`};
  return {kind:'move',move};
}

function coachAlternative(line) {
  const move=line.moves[0];
  if (!move) return null;
  const plan=coachPlan(move,{...line,moves:line.moves.slice(1)});
  // Captures, castling, promotions and checks retain every effect in moveText.
  const text=plan.kind==='exchange'?`대신 ${side(move.color)}은 ${plan.trade.text.replace(/제안합니다\.$/,'제안할 수 있었습니다.')}`
    :plan.kind==='check-evasion'?`대신 ${side(move.color)} ${object(move.piece)} ${move.from}에서 ${move.to}로 옮겨 ${plan.benefit} 수 있었습니다.${move.san.endsWith('+')?' 동시에 상대 왕도 체크합니다.':''}`
    :move.captured || move.promotion || /[+#]$/.test(move.san) || /[kq]/.test(move.flags) || !plan.benefit
    ? recommendedMove(line)
    : `대신 ${side(move.color)} ${object(move.piece)} ${move.from}에서 ${move.to}로 옮겨 ${plan.benefit} 수 있었습니다.`;
  const payoff=alternativeCombinationFact(line)||alternativePayoffFact(line);
  return {...plan,text:text+(plan.cost?` ${plan.cost}`:'')+(payoff?` ${payoff}`:'')};
}

function alternativeExplanation(move,line,existing=null) {
  if(line.pv[0]===uciMove(move))return '이 깊이에서는 실전 수와 같은 수가 추천됩니다. '
    +basicMoveComment(move,{continuation:{...line,moves:line.moves.slice(1)}});
  let text=existing||coachAlternative(line)?.text||recommendedMove(line);
  const mate=verifiedMate(line);
  // This is one complete legal example with a matching winner and distance.
  // It is not proof that every defensive move loses or that the played move
  // removed a mate. The two branches keep their own scores and board anchors.
  if(mate?.winner===move.color && line.moves.length>1 && !text.includes('체크메이트'))text+=` ${verifiedMateFact(line,move.color)}`;
  return text;
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

function missedFreeCapture(move,line) {
  const capture=line?.moves[0];
  if(!line?.complete || line.invalid || line.moves.length<3 || !capture?.captured || capture.color!==move.color
    || capture.promotion || line.score?.type==='mate' && mateWinner(line.score)!==move.color
    || move.captured===capture.captured && capturedSquare(move)===capturedSquare(capture))return '';
  const after=new Chess(capture.after);
  if(after.moves({verbose:true}).some(reply=>reply.captured===(capture.promotion||capture.piece)
    && capturedSquare(reply)===capture.to))return '';
  const exchange=exchangeEnd(line,0),tail=exchangeEnd(line,line.moves.length-1);
  if(exchange.incomplete || exchange.end>MAX_INSIGHT_PLIES || tail.incomplete)return '';
  const sign=move.color==='w'?1:-1,initial=materialBalance(pieces(new Chess(move.before))).difference*sign;
  const gain=position=>materialBalance(pieces(position)).difference*sign-initial;
  if(gain(new Chess(line.moves[exchange.end-1].after))<VALUES[capture.captured]
    ||gain(line.final)<VALUES[capture.captured])return '';
  return `${capturedSquare(capture)}의 ${object(capture.captured)} 잡아도 바로 되잡히지 않았는데, 그 기회를 놓쳤습니다.`;
}

function alternativePromotionFact(move,line) {
  if(!move.promotion || !line?.complete || line.invalid)return '';
  let square=move.from;
  for(const [index,step] of line.moves.slice(0,NEAR_CONSEQUENCE_PLIES).entries()) {
    if(step.color!==move.color || step.piece!=='p' || step.from!==square)continue;
    if(step.promotion)return index>0 && step.promotion!==move.promotion
      ?`이 대안의 예상 수순에서는 ${move.from}의 폰을 ${PIECE_NAMES[step.promotion]}${step.promotion==='n'?'로':'으로'} 승격합니다.`:'';
    square=step.to;
  }
  return '';
}

function coachReply(line) {
  const move=line.moves[0];
  if (!move) return '';
  const plan=coachPlan(move,{...line,moves:line.moves.slice(1)});
  if(['exchange','discovered-defense','block','unpin'].includes(plan.kind))return plan.kind==='exchange'
    ?`상대는 ${plan.trade.text.replace(/제안합니다\.$/,'제안할 수 있습니다.')}`
    :`상대는 ${object(move.piece)} ${move.from}에서 ${move.to}로 옮겨 ${plan.benefit} 수 있습니다.`;
  if (!move.captured && !move.promotion && !/[+#]$/.test(move.san)) {
    const targets=attackedBy(new Chess(move.after),move.to,move.color).filter(piece=>!['p','k'].includes(piece.type)).sort((a,b)=>VALUES[b.type]-VALUES[a.type]);
    if (targets.length) return `상대는 ${object(move.piece)} ${move.from}에서 ${move.to}로 옮겨 ${targetName(targets[0])}${targets[0].type==='n'?'를':'을'} 공격할 수 있습니다.`;
  }
  return firstMoveFact(line);
}

function exceptionalMoveComment(move,context={}) {
  return basicMoveComment(move,context);
}

// A victim captured in both examples is not evidence that the played move
// uniquely exposed it. Compare the original stationary piece on both boards,
// never a different same-type piece that later reaches that square.
function sharedCapture(move,reply,alternative) {
  const capture=reply.consequence?.capture;
  if(!capture || !reply.complete || reply.invalid || !alternative.complete || alternative.invalid
    || reply.consequence.distant || reply.nearLoss && reply.nearLoss.loss!==reply.consequence.loss)return '';
  const square=capturedSquare(capture),before=new Chess(move.before),after=new Chess(move.after);
  if(before.get(square)?.type!==capture.captured || before.get(square)?.color!==move.color
    || after.get(square)?.type!==capture.captured || after.get(square)?.color!==move.color || move.from===square)return '';
  const stationary=(moves,index)=>!moves.slice(0,index).some(step=>step.from===square || step.to===square || step.captured&&capturedSquare(step)===square);
  const actualIndex=reply.moves.indexOf(capture);
  if(!stationary(reply.moves,actualIndex) || reply.moves.slice(0,reply.consequence.end).filter(step=>step.captured && step.color!==move.color).length!==1)return '';
  const index=alternative.moves.findIndex((step,index)=>index<NEAR_CONSEQUENCE_PLIES && step.color!==move.color
    && step.captured===capture.captured && capturedSquare(step)===square && stationary(alternative.moves,index));
  if(index<0)return '';
  return `실전 수 뒤와 대안의 예상 수순 모두에서 ${square}의 ${side(move.color)} ${PIECE_NAMES[capture.captured]}${capture.captured==='n'?'가':'이'} 잡히는 예시입니다.`;
}

function mistakeDetails(move,before,after,grade,reply,alternativeLine) {
  const alternative=coachAlternative(alternativeLine),opponent=reply.moves[0],consequence=reply.consequence;
  let alternativeFact=alternativeExplanation(move,alternativeLine,alternative?.text);
  const promotionPlan=alternativePromotionFact(move,alternativeLine);
  if(promotionPlan)alternativeFact+=` ${promotionPlan}`;
  const shortMateMiss=missedMateTwo(move,grade,alternativeLine);
  if(opponent?.san.endsWith('#') && alternativeLine.moves.length) {
    let stillMated=false;
    try {stillMated=new Chess(alternativeLine.moves[0].after).move(reply.pv[0]).san.endsWith('#');} catch { /* A blocked mating move is no longer legal. */ }
    if(!stillMated)alternativeFact+=' 실전 수 뒤에 가능했던 즉시 체크메이트를 막습니다.';
  }
  let responseFact=coachReply(reply);
  const materialRisk=nearMaterialRisk(move,reply);
  const commonCapture=sharedCapture(move,reply,alternativeLine),trade=minorExchange(move,reply)?.text;
  if(commonCapture)responseFact=commonCapture;
  else if(materialRisk)responseFact=materialRisk;
  else if(consequence && !consequence.distant)responseFact=lossCause(move,reply,consequence.capture);
  else if(trade)responseFact=trade;
  else if(opponent?.captured && reply.focus.incomplete)responseFact=responseFact.replace(/있습니다\.$/,'있지만, 후속 응수가 부족해 교환의 최종 결과는 아직 확인되지 않았습니다.');
  const opportunity=coachOpportunity(move,alternative);
  const freeCapture=missedFreeCapture(move,alternativeLine);
  // Winning evaluations can remain mates on both branches. An immediately
  // available legal finish is still the concrete opportunity this move missed.
  const immediateMateMiss=grade.key==='miss' && !move.san.endsWith('#')
    && (alternativeLine.moves[0]?.san.endsWith('#') || new Chess(move.before).moves().some(san=>san.endsWith('#')));
  const draw=!reply.moves.length?drawComment(reply.final):'';
  const verified=verifiedMate(reply),mateExplanation=verifiedMateFact(reply,move.color);
  const ownMate=reply.moves.slice(0,NEAR_CONSEQUENCE_PLIES).find(step=>step.color===move.color && new Chess(step.after).isCheckmate());
  if(draw)responseFact=draw;
  if(verified)responseFact=mateExplanation;
  else if(ownMate)responseFact=`이 예상 수순에서는 ${mateFact(ownMate)}`;
  let reason;
  if(immediateMateMiss)reason='한 수에 끝낼 수 있는 체크메이트 기회를 놓쳤습니다.';
  else if(shortMateMiss)reason='두 수로 끝낼 수 있는 체크메이트 기회를 놓쳤습니다.';
  else if(draw)reason=draw;
  else if(verified)reason=mateExplanation;
  else if(ownMate)reason=responseFact;
  else if(reply.score?.type==='mate' && mateWinner(reply.score)!==move.color)reason=`분석은 상대 메이트를 예상하지만, 전체 수순은 아직 확인되지 않았습니다.${responseFact?` ${responseFact}`:''}`;
  else if(before.score.type==='mate' && mateWinner(before.score)===move.color && mateWinner(reply.score)!==move.color)reason='이 수 뒤에도 메이트가 이어지는지는 이번 수순에서 확인되지 않았습니다.';
  else if(commonCapture)reason=commonCapture;
  else if(reply.materialRecovery)reason=materialRecoveryFact(reply);
  else if(materialRisk)reason=materialRisk;
  else if(consequence && !consequence.distant)reason=responseFact;
  else if(freeCapture)reason=freeCapture;
  else if(promotionPlan)reason='';
  else if(opportunity)reason=opportunity+(opponent?.san.endsWith('+')&&responseFact?` ${responseFact}`:'');
  else if(trade)reason=trade;
  else if(consequence?.distant)reason=basicMoveComment(move);
  else if(consequence)reason=distantRisk(consequence);
  else reason=responseFact;
  const survivingMate=shortMateMiss && verified?.winner===move.color?`실전 수 뒤에도 ${mateExplanation}`:'';
  return {responseFact,alternativeFact,riskFact:verified&&verified.winner!==move.color?mateExplanation:materialRisk,
    summary:[move.promotion?concreteMoveText(move):'',reason,alternativeFact,survivingMate,endingOutcome(move,grade)].filter(Boolean).join(' ')||'구체적인 응수와 대안을 확인하려면 앞뒤 국면을 다시 분석해 주세요.'};
}

// Short, board-grounded explanations; no opening-book or proprietary review labels.
export function describeMove(move,before,after,context = {}) {
  if (!move) return {grade:null,text:'기보에서 수를 선택하면 그 수의 의미를 설명합니다.'};
  const grade=classifyMove(before,after,move,insightGradeContext(context));
  if (!grade)return {grade,text:basicMoveComment(move,context)};
  if(grade.severity<1)return {grade,text:explainMove(move,before,after,context)?.summary||exceptionalMoveComment(move,context)};
  after=assessedInsightResult(before,after,move,context);
  const reply=focusContinuation(move,continuation(insightPosition(move,true,context),after),false,NEAR_CONSEQUENCE_PLIES,context);
  const alternative=focusContinuation(move,continuation(insightPosition(move,false,context),before),true,NEAR_CONSEQUENCE_PLIES,context);
  return {grade,text:mistakeDetails(move,before,after,grade,reply,alternative).summary};
}
