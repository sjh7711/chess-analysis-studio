import { Chess, uciMove, validatePosition } from './chess-core.js';

export const PIECE_NAMES = { p:'폰', n:'나이트', b:'비숍', r:'룩', q:'퀸', k:'킹' };

// Use the legal move's piece/capture data, not SAN spelling, in explanations.
export function moveText(move, form='statement') {
  const side=move.color==='w'?'백':'흑', enemy=move.color==='w'?'흑':'백';
  const subject=`${side} ${PIECE_NAMES[move.piece]}${move.piece==='n'?'가':'이'}`;
  const endings={
    move:['이동합니다.','이동할 수 있습니다.','이동했어야 합니다.','이동하는 수','이동해'],
    capture:['잡습니다.','잡을 수 있습니다.','잡았어야 합니다.','잡는 수','잡고'],
    castle:['캐슬링합니다.','캐슬링할 수 있습니다.','캐슬링했어야 합니다.','캐슬링하는 수','캐슬링해'],
    promote:['승격합니다.','승격할 수 있습니다.','승격했어야 합니다.','승격하는 수','승격해'],
    check:['체크합니다.','체크할 수 있습니다.','체크했어야 합니다.','체크하는 수','체크해'],
    mate:['체크메이트합니다.','체크메이트할 수 있습니다.','체크메이트했어야 합니다.','체크메이트하는 수','체크메이트해'],
  };
  const actions=[];
  if(move.flags.includes('k') || move.flags.includes('q')) {
    const rank=move.color==='w'?'1':'8', kingSide=move.flags.includes('k');
    actions.push([`${move.from}에서 ${move.to}로 이동하고 룩도 ${kingSide?'h':'a'}${rank}에서 ${kingSide?'f':'d'}${rank}로 옮겨 `,'castle']);
  } else if(move.captured) {
    const ep=move.flags.includes('e'), square=ep?move.to[0]+move.from[1]:move.to;
    actions.push([`${ep?`${move.from}에서 ${move.to}로 이동해 앙파상으로 `:''}${square}의 ${enemy} ${PIECE_NAMES[move.captured]}${move.captured==='n'?'를':'을'} `,'capture']);
  } else actions.push([`${move.from}에서 ${move.to}로 `,'move']);
  if(move.promotion)actions.push([`${PIECE_NAMES[move.promotion]}${move.promotion==='n'?'로':'으로'} `,'promote']);
  if(move.san.endsWith('#'))actions.push(['상대 왕을 ','mate']);
  else if(move.san.endsWith('+'))actions.push(['상대 왕을 ','check']);
  const column={statement:0,possible:1,alternative:2,phrase:3}[form] ?? 0;
  return `${subject} ${actions.map(([prefix,verb],index)=>prefix+endings[verb][index===actions.length-1?column:4]).join(' ')}`;
}
export const MOVE_RULES = {
  p:'앞으로 한 칸 이동합니다. 시작 칸에서는 앞의 두 칸이 모두 비어 있으면 두 칸 갈 수 있습니다. 상대 기물은 앞 대각선 한 칸에서만 잡으며, 뒤로 가지 못합니다.',
  n:'한 방향으로 두 칸, 직각으로 한 칸인 L자 모양으로 이동합니다. 다른 기물을 뛰어넘을 수 있습니다.',
  b:'대각선 네 방향으로 원하는 만큼 이동합니다. 다른 기물을 뛰어넘을 수 없습니다.',
  r:'가로·세로 네 방향으로 원하는 만큼 이동합니다. 다른 기물을 뛰어넘을 수 없습니다.',
  q:'가로·세로·대각선 여덟 방향으로 원하는 만큼 이동합니다. 다른 기물을 뛰어넘을 수 없습니다.',
  k:'모든 방향으로 한 칸 이동합니다. 상대가 공격하는 칸으로 갈 수 없습니다.',
};

export function cloneChess(chess) {
  const history = chess.history({ verbose:true });
  const clone = new Chess(history[0]?.before || chess.fen());
  for (const move of history) clone.move(uciMove(move));
  return clone;
}

// Start the reading interval only after a completed analysis is available.
export class PlaybackClock {
  constructor(advance, {setTimer=(fn,delay)=>setTimeout(fn,delay),clearTimer=id=>clearTimeout(id)}={}) {
    this.advance=advance; this.setTimer=setTimer; this.clearTimer=clearTimer;
    this.phase='idle'; this.timer=null; this.revision=0;
  }
  stop() {
    this.clearTimer(this.timer); this.timer=null;
    this.revision++; this.phase='idle';
  }
  hold() { this.stop(); this.phase='analysis'; }
  ready(delay) {
    if (this.phase==='reading') return;
    this.stop(); this.phase='reading';
    const revision=this.revision;
    this.timer=this.setTimer(()=>{
      if (revision!==this.revision) return;
      this.timer=null; this.phase='idle'; this.advance();
    },delay);
  }
}

export function describeMove(move) {
  const color = move.color === 'w' ? '백' : '흑';
  const opponent = move.color === 'w' ? '흑' : '백';
  const after = new Chess(move.after);
  let text = `${color} ${PIECE_NAMES[move.piece]}: ${move.from} → ${move.to}. `;
  if (move.flags.includes('k') || move.flags.includes('q')) {
    const rank = move.color === 'w' ? '1' : '8';
    text += `${move.flags.includes('k') ? '킹사이드' : '퀸사이드'} 캐슬링입니다. 룩도 ${move.flags.includes('k') ? 'h'+rank+' → f'+rank : 'a'+rank+' → d'+rank}로 이동합니다. `;
  } else {
    const dx = Math.abs(move.from.charCodeAt(0)-move.to.charCodeAt(0));
    const dy = Math.abs(Number(move.from[1])-Number(move.to[1]));
    text += move.piece === 'n' ? '나이트가 L자로 뛰어 이동합니다. ' : `${dx && dy ? '대각선' : dx ? '가로' : '세로'}로 ${Math.max(dx,dy)}칸 이동합니다. `;
  }
  if (move.flags.includes('e')) text += `앙파상으로 ${move.to[0]+move.from[1]}의 ${opponent} 폰을 잡습니다. `;
  else if (move.captured) text += `${move.to}의 ${opponent} ${PIECE_NAMES[move.captured]}${move.captured === 'n' ? '를' : '을'} 잡습니다. `;
  if (move.promotion) text += `폰이 ${PIECE_NAMES[move.promotion]}${move.promotion === 'n' ? '로' : '으로'} 승격합니다. `;
  if (after.isCheckmate()) text += `${opponent} 왕이 체크이며 피할 수 있는 수가 없습니다. 체크메이트입니다.`;
  else if (after.isCheck()) text += `${opponent} 왕이 체크입니다. 체크를 피하는 합법적인 응수는 ${after.moves().length}개입니다.`;
  else if (after.isStalemate()) text += `${opponent}은 체크가 아니지만 둘 수 있는 수가 없어 스테일메이트입니다.`;
  else if (after.isInsufficientMaterial()) text += '체크메이트할 기물이 부족하여 무승부입니다.';
  else text += `이제 ${opponent} 차례입니다.`;
  return text;
}

// A branch owns its history, future and evaluations. The source game is never mutated.
export class AnalysisLine {
  constructor(chess, moves = [], result = null) {
    this.base = cloneChess(chess);
    this.cursor = 0;
    this.steps = [];
    this.results = new Map(result ? [[0,result]] : []);
    const preview = cloneChess(chess);
    for (const uci of moves) {
      try {
        const move = preview.move(uci);
        this.steps.push({ ...move, uci:uciMove(move), explanation:describeMove(move) });
      } catch { break; }
    }
  }
  position(index = this.cursor) {
    const chess = cloneChess(this.base);
    for (const step of this.steps.slice(0,index)) chess.move(step.uci);
    return chess;
  }
  seek(index) { this.cursor = Math.max(0,Math.min(this.steps.length,index)); return this.position(); }
  play(uci) {
    const chess = this.position();
    const move = chess.move(uci); // Validate before touching existing future or cached evaluations.
    this.steps.splice(this.cursor);
    for (const index of this.results.keys()) if (index > this.cursor) this.results.delete(index);
    this.steps.push({ ...move, uci:uciMove(move), explanation:describeMove(move) });
    this.cursor++;
    return move;
  }
}

export function boardToFen(board, turn) {
  if (!['w','b'].includes(turn)) throw new Error('차례를 선택하세요.');
  const ranks = [];
  for (let rank=8;rank>=1;rank--) {
    let row='', empty=0;
    for (const file of 'abcdefgh') {
      const piece = board.get(file+rank);
      if (!piece) empty++;
      else {
        if (!PIECE_NAMES[piece.type] || !['w','b'].includes(piece.color)) throw new Error('알 수 없는 기물입니다.');
        if (empty) { row+=empty; empty=0; }
        row+=piece.color === 'w' ? piece.type.toUpperCase() : piece.type;
      }
    }
    if (empty) row+=empty;
    ranks.push(row);
  }
  return `${ranks.join('/')} ${turn} - - 0 1`;
}

export function editedPosition(board, turn) { return validatePosition(boardToFen(board,turn)); }

export function materialBalance(pieces) {
  const value={p:1,n:3,b:3,r:5,q:9,k:0};
  const score={w:0,b:0};
  for(const piece of pieces) if(piece) score[piece.color]+=value[piece.type];
  return {...score,difference:score.w-score.b};
}

export function exportLine(line, headers={}) {
  const chess=cloneChess(line.base);
  for(const key of ['White','Black','Date']) if(headers[key])chess.setHeader(key,headers[key]);
  chess.setHeader('Event','Analysis variation');
  chess.setHeader('Result','*');
  const comment=(index,text)=>{
    const result=line.results.get(index);
    const value=result?.score;
    const evaluation=value ? value.type==='mate' ? `#${value.winner==='b'||value.value<0?'-':''}${Math.abs(value.value)}` : (value.value/100).toFixed(2) : null;
    chess.setComment(`${text}${evaluation!==null?` [%eval ${evaluation}]`:''}`);
  };
  comment(0,'탐색 시작');
  line.steps.forEach((step,i)=>{chess.move(step.uci);comment(i+1,step.explanation);});
  // chess.js 1.4.0 can join adjacent move numbers when wrapping sparse comments.
  return chess.pgn({maxWidth:0});
}

export function restoreResults(snapshot, count, engineName = 'Stockfish 19 Lite') {
  const results=new Map();
  if(snapshot?.engine!==engineName||!Array.isArray(snapshot.results))return results;
  for(const entry of snapshot.results) {
    if(!Array.isArray(entry))continue;
    const [index,result]=entry;
    if(Number.isInteger(index)&&index>=0&&index<count&&['cp','mate'].includes(result?.score?.type)&&Number.isFinite(result.score.value)&&Array.isArray(result.lines))results.set(index,result);
  }
  return results;
}

export function movementGuide(type, color='w') {
  const origin = type === 'p' ? (color === 'w' ? 'd2' : 'd7') : 'd4';
  const from = [origin.charCodeAt(0)-97,Number(origin[1])-1];
  const targets = [];
  const add = (dx,dy,capture=false) => {
    const x=from[0]+dx,y=from[1]+dy;
    if (x>=0 && x<8 && y>=0 && y<8) targets.push({ square:'abcdefgh'[x]+(y+1), capture });
  };
  if (type === 'p') { const dy=color === 'w' ? 1 : -1; add(0,dy); add(0,dy*2); add(-1,dy,true); add(1,dy,true); }
  else if (type === 'n') for (const [dx,dy] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) add(dx,dy);
  else {
    const directions = type === 'b' ? [[1,1],[1,-1],[-1,1],[-1,-1]] : type === 'r' ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dx,dy] of directions) for(let distance=1;distance<=(type === 'k' ? 1 : 7);distance++) add(dx*distance,dy*distance);
  }
  return { origin, targets };
}
