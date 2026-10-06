import { Chess, classifyMove, GRADING_BASIS, formatScore, gameAt, scoreValue, uciMove } from './chess-core.js';
import { AnalysisLine, PIECE_NAMES, materialBalance, moveText } from './study.js';

const side = color => color === 'w' ? '백' : '흑';
const object = type => PIECE_NAMES[type]+(type === 'n' ? '를' : '을');
export const moveTurn = move => `${side(move.color)}의 ${move.before.split(' ')[5]}번째 수`;
export const moveLabel = move => `${moveTurn(move)} · ${PIECE_NAMES[move.piece]} ${move.from}에서 ${move.to}로`;
const mateWinner = score => score?.type === 'mate' ? (scoreValue(score) > 0 ? 'w' : 'b') : null;

// Both branches stay anchored to the reviewed move, even when switching during playback.
export function createInsightLine({game,index,insight,before,after}, kind, scope='core') {
  if (!['response','alternative'].includes(kind) || !['core','full'].includes(scope)) return null;
  const response = kind === 'response';
  const source = response ? insight.response : insight.alternative;
  const result = response ? after : before;
  const count=scope==='core' ? source.focus.length : source.pv.length;
  const line = new AnalysisLine(gameAt(game,response ? index : index-1),source.pv.slice(0,count),result);
  if (!line.steps.length) return null;
  line.kind = 'pv';
  line.sourceScore = source.score;
  line.sourceDepth = result.depth;
  line.title = `${response ? '실전 수 이후 응수' : '실전 수 대신 대안'} · ${scope==='core'?'핵심 장면':'전체 예상 수순'}`;
  line.reviewIndex = index;
  line.reviewKind = kind;
  line.reviewScope = scope;
  line.fullLength = source.pv.length;
  line.focusNote = source.focus.note;
  line.startLabel = `${moveTurn(game.moves[index-1])} ${response ? '이후' : '직전'} · ${line.base.turn() === 'w' ? '백' : '흑'} 차례`;
  return line;
}

// Only describe a legal continuation belonging to the engine's chosen move.
// Partial/corrupt cached PVs must never produce invented moves or tactics.
function continuation(fen, result) {
  const chess = new Chess(fen), moves = [];
  const candidate = result?.lines?.find(line => line.pv?.[0] === result.bestmove);
  const pv = candidate?.pv || (result?.bestmove ? [result.bestmove] : []);
  for (const uci of pv) {
    try { moves.push(chess.move(uci)); } catch { break; }
    if (chess.isGameOver()) break;
  }
  return { moves, pv:moves.map(uciMove), final:chess, score:result?.score };
}

function firstMoveFact(line) {
  const move = line.moves[0];
  if (!move) return '';
  const action=`바로 다음 수에 ${moveText(move,'possible')}`;
  if(move.captured || move.promotion || /[+#]$/.test(move.san))return action;
  const after = new Chess(move.after);
  const targets = after.board().flat().filter(piece => piece && piece.color !== move.color && !['p','k'].includes(piece.type) && after.attackers(piece.square,move.color).includes(move.to));
  if (targets.length) return `${action} 이 수는 ${targets.map(piece => `${piece.square}의 ${side(piece.color)} ${PIECE_NAMES[piece.type]}`).join('·')}${targets.at(-1).type === 'n' ? '를' : '을'} 공격합니다.`;
  return action;
}

function recommendedMove(line) {
  const move = line.moves[0];
  if (!move) return '';
  return `대신 ${moveText(move,'alternative')}`;
}

// Six individual moves (three pairs) is a presentation boundary, never a
// mistake-grading rule or a claim that the continuation is forced.
export const NEAR_CONSEQUENCE_PLIES=6;

function exchangeEnd(line,index) {
  let end=index+1;
  // Show recaptures, intervening captures and check replies before stopping.
  while(end<line.moves.length && (line.moves[end-1].san.endsWith('+') || line.moves[end-1].captured && line.moves[end].captured)) end++;
  const last=line.moves[end-1];
  if(!last)return {end:0,incomplete:false};
  const position=new Chess(last.after);
  const incomplete=end===line.moves.length && !position.isGameOver() && (position.isCheck()
    || !!last.captured && position.moves({verbose:true}).some(reply=>reply.captured && reply.to===last.to));
  return {end,incomplete};
}

function materialConsequence(move,line) {
  const initial=pieces(new Chess(move.before)), sign=move.color==='w'?1:-1;
  const initialMaterial=materialBalance(initial).difference*sign;
  const balance=(list,type)=>list.filter(p=>p.type===type&&p.color===move.color).length-list.filter(p=>p.type===type&&p.color!==move.color).length;
  for(let index=0;index<line.moves.length;index++) {
    const capture=line.moves[index];
    if(capture.color===move.color || !capture.captured)continue;
    const {end,incomplete}=exchangeEnd(line,index);
    if(incomplete)continue;
    const final=pieces(new Chess(line.moves[end-1].after));
    const loss=initialMaterial-materialBalance(final).difference*sign;
    if(loss>0 && balance(initial,capture.captured)>balance(final,capture.captured)) {
      return {capture,ply:index+1,end,loss,distant:index+1>NEAR_CONSEQUENCE_PLIES || end>NEAR_CONSEQUENCE_PLIES};
    }
  }
  return null;
}

function focusContinuation(move,line,alternative=false) {
  const consequence=alternative?null:materialConsequence(move,line);
  const chosen=consequence && !consequence.distant ? consequence.ply-1 : 0;
  const {end,incomplete}=exchangeEnd(line,chosen);
  let note='';
  if(incomplete) note='후속 응수가 부족해 교환이나 체크 대응의 최종 결과는 아직 확인되지 않았습니다.';
  else if(end && (line.moves.slice(0,end).some(step=>step.captured) || !alternative && move.captured)) {
    const start=new Chess(move.before), final=new Chess(line.moves[end-1].after);
    const difference=(materialBalance(pieces(start)).difference-materialBalance(pieces(final)).difference)*(move.color==='w'?1:-1);
    note=difference>0 ? `이 구간의 기물 점수 차이: ${side(move.color)} ${difference}점 손해.`
      : difference<0 ? `이 구간의 기물 점수 차이: ${side(move.color)} ${-difference}점 이득.`
      : '교환을 반영하면 이 구간의 기물 점수 차이는 유지됩니다.';
  }
  line.focus={length:end,note,incomplete};
  line.consequence=consequence;
  return line;
}

function distantRisk(consequence) {
  const capture=consequence.capture;
  if(consequence.ply<=NEAR_CONSEQUENCE_PLIES) return `${moveText(capture,'possible')} 손익은 ${consequence.end}번 이동까지 이어지는 교환을 예상한 결과이며, 후속 수순에 따라 달라질 수 있습니다.`;
  return `긴 예상 수순이 이어질 경우, ${consequence.ply}번째 이동에서 ${moveText(capture,'possible')} 이후 선택에 따라 달라질 수 있습니다.`;
}

export function explainMistake(move, before, after, context = {}) {
  const grade = move && classifyMove(before,after,move,context);
  if (!grade || grade.severity < 1) return null;
  const player = side(move.color), opponent = side(move.color === 'w' ? 'b' : 'w');
  const response = focusContinuation(move,continuation(move.after,after)), alternative = focusContinuation(move,continuation(move.before,before),true);
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
  let responseFact = firstMoveFact(response);
  if(consequence && !consequence.distant && consequence.ply>1) responseFact+=` ${lossCause(move,response,consequence.capture)}`;
  const riskFact=!afterMate && consequence?.distant ? distantRisk(consequence) : '';
  const materialFact=!afterMate ? response.focus.note : '';
  // The compact explanation pairs the opponent's reply with the better move.
  // Evaluation loss is already displayed in the heading.
  let alternativeFact = recommendedMove(alternative);
  if (response.moves[0]?.san.endsWith('#') && alternative.moves.length) {
    const defence = new Chess(alternative.moves[0].after);
    let stillMated = false;
    try { defence.move(response.pv[0]); stillMated = defence.isCheckmate(); } catch { /* The mating move may no longer be legal. */ }
    if (!stillMated) alternativeFact += ` 실전 수 뒤에 가능했던 즉시 체크메이트를 막습니다.`;
  }
  const summary = [responseFact,alternativeFact].filter(Boolean).join(' ') || '상대 응수와 대안을 확인하려면 이 국면을 다시 분석해 주세요.';
  return { grade, reason, summary, responseFact, riskFact, materialFact, alternativeFact, lossText,
    evaluation:`수 전 ${formatScore(before.score)} → 수 후 ${formatScore(after.score)} (백 기준)`,
    response, alternative,
    basis:`예상 승점 ${(grade.pointsLoss*100).toFixed(1)}%p 감소. ${GRADING_BASIS} 평가 손실은 잃은 기물 점수나 손실까지의 이동 횟수가 아닙니다.`,
  };
}

const VALUES = {p:1,n:3,b:3,r:5,q:9,k:100};
const pieces = chess => chess.board().flat().filter(Boolean);
const targetName = piece => `${piece.square}의 ${PIECE_NAMES[piece.type]}`;
const attackedBy = (chess,square,color) => pieces(chess).filter(piece=>piece.color!==color && chess.attackers(piece.square,color).includes(square));
const capturedSquare = move => move.flags.includes('e') ? move.to[0]+move.from[1] : move.to;

function lossCause(move,line,capture) {
  const square=capturedSquare(capture), victim=PIECE_NAMES[capture.captured], attacker=PIECE_NAMES[capture.piece];
  const before=new Chess(move.before), current=new Chess(move.after), atCapture=new Chess(capture.before);
  const prefix=line.moves.slice(0,line.moves.indexOf(capture));
  const stationary=current.get(square)?.color===move.color && current.get(square)?.type===capture.captured
    && !prefix.some(step=>step.from===square || step.to===square);
  const timing=line.moves[0]===capture ? '바로 다음 수에' : '이어지는 응수에서';
  const ending=`${timing} ${moveText(capture,'possible')}`;
  if (capture.flags.includes('e')) return `이 수로 인해 상대에게 앙파상을 허용해, ${ending}`;
  if (stationary) {
    const guards=current.attackers(square,move.color);
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
    return `이 수로 인해 ${object(capture.captured)} 지키는 ${PIECE_NAMES[defender]}${defender==='n'?'가':'이'} 왕을 보호하느라 되잡을 수 없어, ${ending}`;
  }
  if (!guards.length) return `이 수로 인해 ${square}의 ${victim}${capture.captured==='n'?'가':'이'} 수비 없이 남아, ${ending}`;
  return `이 수로 인해 상대 ${attacker}의 공격을 허용해, ${ending}`;
}

function basicMoveComment(move) {
  const before=new Chess(move.before), after=new Chess(move.after), enemy=move.color==='w'?'b':'w';
  if (after.isCheckmate()) return moveText(move);
  if (after.isInsufficientMaterial()) return '체크메이트에 필요한 기물이 남지 않아 무승부입니다.';
  if (after.isStalemate()) return '상대가 둘 수 있는 합법적인 수가 없어 스테일메이트로 무승부입니다.';
  if (move.promotion || move.flags.includes('k') || move.flags.includes('q')) return moveText(move);
  const targets=attackedBy(after,move.to,move.color).sort((a,b)=>VALUES[b.type]-VALUES[a.type]);
  if (targets.length>=2 && targets[1].type!=='p') return `${targets.slice(0,2).map(targetName).join('·')}${targets[1].type==='n'?'를':'을'} 동시에 공격합니다.`;
  if (move.captured || move.san.endsWith('+')) return moveText(move);
  const defended=pieces(after).filter(piece=>piece.color===move.color && piece.square!==move.to && piece.type!=='k'
    && before.isAttacked(piece.square,enemy) && after.attackers(piece.square,move.color).includes(move.to)
    && !before.attackers(piece.square,move.color).includes(move.from)).sort((a,b)=>VALUES[b.type]-VALUES[a.type]);
  if (defended.length) return `공격받던 ${targetName(defended[0])}${defended[0].type==='n'?'를':'을'} 지킵니다.`;
  const centers=['d4','e4','d5','e5'].filter(square=>after.attackers(square,move.color).includes(move.to));
  const development=['n','b'].includes(move.piece) && move.from[1]===(move.color==='w'?'1':'8') && Number(move.before.split(' ')[5])<=10;
  const freshTarget=targets.find(piece=>!before.attackers(piece.square,move.color).includes(move.from));
  if (development) {
    if (freshTarget) return `${object(move.piece)} ${centers.length?'중앙 쪽으로 ':''}전개하며 ${targetName(freshTarget)}${freshTarget.type==='n'?'를':'을'} 공격합니다.${centers.filter(square=>square!==freshTarget.square).length ? ` ${centers.filter(square=>square!==freshTarget.square).join('·')} 칸도 제어합니다.` : ''}`;
    return `${object(move.piece)} 전개${centers.length?`해 중앙의 ${centers.join('·')} 칸을 제어합니다.`:'합니다.'}`;
  }
  if (freshTarget) return `${targetName(freshTarget)}${freshTarget.type==='n'?'를':'을'} 공격합니다.`;
  if (before.isAttacked(move.from,enemy) && !after.isAttacked(move.to,enemy)) return `공격받던 ${object(move.piece)} ${move.to}로 피합니다.`;
  if (move.piece==='p' && ['d','e'].includes(move.to[0]) && ['4','5'].includes(move.to[1])) return `중앙에 폰을 세워${centers.length?` ${centers.join('·')} 칸을 제어합니다.`:' 공간을 확보합니다.'}`;
  if (move.piece==='r' && !pieces(after).some(p=>p.type==='p' && p.square[0]===move.to[0])) return `폰이 없는 ${move.to[0]}파일에 룩을 배치합니다.`;
  if (centers.length) return `${object(move.piece)} ${move.to}에 두어 중앙의 ${centers.join('·')} 칸을 제어합니다.`;
  return `${object(move.piece)} ${move.from}에서 ${move.to}로 옮깁니다.`;
}

// Short, board-grounded explanations; no opening-book or proprietary review labels.
export function describeMove(move,before,after,context = {}) {
  if (!move) return {grade:null,text:'기보에서 수를 선택하면 그 수의 의미를 설명합니다.'};
  const grade=classifyMove(before,after,move,context);
  if (!grade || grade.severity<1) return {grade,text:grade?.reason && ['brilliant','great'].includes(grade.key) ? `${grade.reason} ${basicMoveComment(move)}` : basicMoveComment(move)};
  const reply=focusContinuation(move,continuation(move.after,after)), alternative=continuation(move.before,before);
  const opponent=reply.moves[0];
  if (after.score.type==='mate' && mateWinner(after.score)!==move.color) return {grade,text:after.score.value===0 ? '체크메이트당했습니다.' : `상대에게 ${Math.abs(after.score.value)}수 안의 체크메이트 수순을 허용했습니다.${opponent ? ` ${firstMoveFact(reply)}` : ''}`};
  if (before.score.type==='mate' && mateWinner(before.score)===move.color && mateWinner(after.score)!==move.color) return {grade,text:`체크메이트 기회를 놓쳤습니다.${alternative.moves[0] ? ` ${recommendedMove(alternative)}` : ''}`};
  const consequence=reply.consequence;
  if(consequence) return {grade,text:consequence.distant ? distantRisk(consequence) : lossCause(move,reply,consequence.capture)};
  if (opponent?.captured) return {grade,text:`${firstMoveFact(reply)}${reply.focus.note ? ` ${reply.focus.note}` : ''}`};
  const better=alternative.moves[0];
  if (better) {
    const targets=attackedBy(new Chess(better.after),better.to,better.color).sort((a,b)=>VALUES[b.type]-VALUES[a.type]);
    if (targets.length>=2 && targets[1].type!=='p') return {grade,text:`${recommendedMove(alternative)} 그러면 ${targets.slice(0,2).map(targetName).join('·')}${targets[1].type==='n'?'를':'을'} 동시에 공격할 수 있었습니다.`};
  }
  return {grade,text:[opponent?firstMoveFact(reply):'',better?recommendedMove(alternative):'이 수의 대안을 확인하려면 앞 국면을 분석해 주세요.'].filter(Boolean).join(' ')};
}
