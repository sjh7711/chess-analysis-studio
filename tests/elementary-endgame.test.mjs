import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess,classifyMove,uciMove} from '../src/chess-core.js';
import {elementaryEndgameEvidence} from '../src/endgame-evidence.js';

// Synthetic elementary positions; no account-game FEN or engine dump is used.
const SETUP='7k/8/5K2/8/8/8/8/4R3 w - - 0 1';
const square=s=>String.fromCharCode(104-(s.charCodeAt(0)-97))+(9-Number(s[1]));
const rotateUci=u=>square(u.slice(0,2))+square(u.slice(2,4))+u.slice(4);
function rotateFen(fen){const fields=fen.split(' ');fields[0]=fields[0].split('/').reverse().map(row=>[...row].reverse().map(c=>/[a-z]/.test(c)?c.toUpperCase():/[A-Z]/.test(c)?c.toLowerCase():c).join('')).join('/');fields[1]=fields[1]==='w'?'b':'w';return fields.join(' ');}
function position({fen=SETUP,history=[],actual='e1e2',black=false}={}){
  if(black){fen=rotateFen(fen);history=history.map(rotateUci);actual=rotateUci(actual);}
  const chess=new Chess(fen),moves=history.map(u=>chess.move(u)),move=chess.move(actual);moves.push(move);
  return {move,context:{moves,moveIndex:moves.length-1}};
}
const cp=value=>({type:'cp',value});
const mate=(distance,winner='w')=>({type:'mate',value:(winner==='w'?1:-1)*distance,winner});
function review({black=false,fen=SETUP,history=[],actual='e1e2',best='f6f7',rootScore=cp(1800),playedScore=cp(400),bestPv,playedPv,childScore}={}){
  const x=position({fen,history,actual,black}),transform=u=>black?rotateUci(u):u;
  const score=value=>black?{...value,value:-value.value,...(value.type==='mate'?{winner:value.winner==='w'?'b':'w'}:{})}:{...value};
  bestPv=(bestPv||[best]).map(transform);playedPv=(playedPv||[actual,'h8g8','e2e3']).map(transform);
  const root=score(rootScore),played=score(playedScore),child=score(childScore||playedScore),key='elementary-public-synthetic';
  const before={score:root,depth:16,bestmove:transform(best),multipvComplete:true,configKey:key,lines:[{multipv:1,depth:16,score:{...root},pv:bestPv}]};
  const after={score:child,depth:16,bestmove:playedPv[1],multipvComplete:true,configKey:key,lines:[{multipv:1,depth:16,score:{...child},pv:playedPv.slice(1)}],
    moveReview:{version:1,fen:x.move.before,uci:transform(actual),configKey:key,beforeDepth:16,beforeBestmove:before.bestmove,beforeScore:{...root},depth:16,score:played,pv:playedPv,source:'search'}};
  return {...x,before,after};
}
function evidence(x){const saved=JSON.stringify(x),value=elementaryEndgameEvidence(x.move,x.context);assert.equal(JSON.stringify(x),saved);return value;}
function grade(x){const saved=JSON.stringify(x),value=classifyMove(x.before,x.after,x.move,x.context);assert.equal(JSON.stringify(x),saved);return value;}
function legalPv(fen,pv){const chess=new Chess(fen);for(const u of pv){assert.equal(chess.isGameOver(),false);chess.move(u);}return chess;}

test('both colors preserve an elementary win across large CP changes without altering stored engine evidence',()=>{
  for(const black of [false,true]){const x=review({black}),before=JSON.stringify({before:x.before,after:x.after}),g=grade(x);
    assert.equal(g.key,'excellent');assert.equal(g.loss,0);assert.equal(g.pointsLoss,0);
    assert.equal(g.endgameEvidence.winner,black?'b':'w');assert.equal(g.endgameEvidence.kind,'preserved-king-rook-vs-king');
    assert.equal(g.endgameEvidence.drawClaimsChecked,true);assert.equal(g.endgameEvidence.maxHalfmove,66);
    assert.equal(JSON.stringify({before:x.before,after:x.after}),before);
    legalPv(x.move.before,x.before.lines[0].pv);legalPv(x.move.before,x.after.moveReview.pv);
  }
});

test('an engine CP to mate representation remains unchanged for either winning color',()=>{
  for(const black of [false,true]){const x=review({black,actual:'f6f7',best:'e1e2',rootScore:cp(600),playedScore:mate(2),childScore:mate(1),bestPv:['e1e2','h8g8'],playedPv:['f6f7','h8h7','e1h1']});
    assert.equal(legalPv(x.move.before,x.after.moveReview.pv).isCheckmate(),true);
    const g=grade(x);assert.equal(g.key,'excellent');assert.equal(g.pointsLoss,0);assert.ok(g.endgameEvidence);
    assert.equal(x.after.moveReview.score.type,'mate');assert.equal(x.before.score.type,'cp');
  }
});

test('an engine mate to CP representation is outcome evidence, not a shortest-mate claim',()=>{
  for(const black of [false,true]){const x=review({black,rootScore:mate(3),playedScore:cp(400),bestPv:['f6f7','h8h7','e1e2','h7h8','e2h2']});
    assert.equal(legalPv(x.move.before,x.before.lines[0].pv).isCheckmate(),true);
    const g=grade(x);assert.equal(g.key,'excellent');assert.equal(g.loss,0);assert.equal(g.pointsLoss,0);assert.equal(g.mateEvidence,undefined);
  }
});

test('the losing king retains the same proven outcome for both colors',()=>{
  for(const black of [false,true]){const x=review({black,fen:SETUP.replace(' w ',' b '),actual:'h8g8',best:'h8h7',rootScore:cp(500),playedScore:cp(1800),bestPv:['h8h7','e1e2'],playedPv:['h8g8','e1e2']});
    const g=grade(x);assert.equal(g.key,'excellent');assert.equal(g.loss,0);assert.equal(g.pointsLoss,0);assert.notEqual(g.endgameEvidence.winner,x.move.color);
  }
});

test('two safely winning rook candidates do not create a false unique-move award from raw score differences',()=>{
  for(const black of [false,true]){const x=review({black,actual:'f6f7',best:'f6f7',rootScore:cp(600),playedScore:cp(600),bestPv:['f6f7','h8h7'],playedPv:['f6f7','h8h7']});
    x.before.lines.push({multipv:2,depth:16,score:cp(black?500:-500),pv:[black?rotateUci('e1e2'):'e1e2']});
    const g=grade(x);assert.equal(g.key,'best');assert.ok(g.endgameEvidence);assert.notEqual(g.key,'great');
  }
});

test('an available immediate rook mate remains a concrete missed chance',()=>{
  for(const black of [false,true]){const x=review({black,fen:'8/8/5K1k/8/8/8/8/R7 w - - 0 1',actual:'a1a2',best:'a1h1',rootScore:mate(1),playedScore:cp(900),bestPv:['a1h1'],playedPv:['a1a2','h6h7']});
    assert.equal(legalPv(x.move.before,x.before.lines[0].pv).isCheckmate(),true);
    const g=grade(x);assert.ok(g.endgameEvidence);assert.equal(g.key,'miss');assert.match(g.reason,/한 수/);
  }
});

test('a quiet mate in two requires every defense and still overrides preserved outcome evidence',()=>{
  for(const black of [false,true]){const x=review({black,rootScore:mate(2),playedScore:cp(400),bestPv:['f6f7','h8h7','e1h1']}),g=grade(x);
    assert.ok(g.endgameEvidence);assert.equal(g.key,'miss');assert.equal(g.mateEvidence.kind,'missed-verified-mate-in-two');assert.equal(g.mateEvidence.checkingStart,false);
    const root=new Chess(x.move.before);root.move(x.before.bestmove);const defenses=root.moves({verbose:true});assert.equal(g.mateEvidence.certificates.length,defenses.length);
    for(const defense of defenses){root.move(uciMove(defense));assert.ok(root.moves().some(s=>s.endsWith('#')));root.undo();}
    const actual=new Chess(x.move.after);actual.move(g.mateEvidence.escapingDefense);assert.equal(actual.moves().some(s=>s.endsWith('#')),false);
  }
});

test('a selected or truncated quiet mating line does not replace completed bound proof',()=>{
  for(const change of [x=>{x.before.lines[0].pv.pop();},x=>{x.after.moveReview.depth--;},x=>{x.after.configKey='other';},x=>{x.after.moveReview.source='unverified';},x=>{x.before.lines[0].pv.push('a1a1');}]){
    const x=review({rootScore:mate(2),playedScore:cp(400),bestPv:['f6f7','h8h7','e1h1']});change(x);assert.equal(grade(x).mateEvidence,undefined);
  }
});

test('a rook which can be captured immediately before or after the move is not certified',()=>{
  for(const black of [false,true]){
    const offered=position({black,fen:'8/8/8/4k3/3R4/8/8/K7 w - - 0 1',actual:'d4d5'});assert.ok(new Chess(offered.move.after).moves({verbose:true}).some(m=>m.captured==='r'));assert.equal(evidence(offered),null);
    const escaped=position({black,fen:'8/8/8/4k3/3R4/8/8/K7 b - - 0 1',actual:'e5f5'});assert.ok(new Chess(escaped.move.before).moves({verbose:true}).some(m=>m.captured==='r'));assert.equal(evidence(escaped),null);
  }
});

test('stalemate and the conservative fifty-move reserve prevent a win certificate',()=>{
  for(const black of [false,true]){
    const stale=position({black,fen:'7k/5K2/6R1/8/8/8/8/8 w - - 0 1',actual:'g6g7'});assert.equal(new Chess(stale.move.after).isStalemate(),true);assert.equal(evidence(stale),null);
    assert.ok(evidence(position({black,fen:SETUP.replace(' 0 1',' 65 1')})));
    for(const clock of [66,67,99])assert.equal(evidence(position({black,fen:SETUP.replace(' 0 1',` ${clock} 1`)})),null);
  }
});

const CYCLE=['e1e2','h8g8','e2e1','g8h8'];
test('a second occurrence before or immediately after the move withholds historical outcome evidence',()=>{
  for(const black of [false,true]){
    assert.equal(evidence(position({black,history:CYCLE,actual:'e1e2'})),null);
    assert.equal(evidence(position({black,history:CYCLE.slice(0,3),actual:'g8h8'})),null);
  }
});

test('a defender may claim the third repetition on the next reply, even if the current board is not drawn',()=>{
  const x=position({history:[...CYCLE,...CYCLE.slice(0,2)],actual:'e2e1'}),chess=new Chess(x.context.moves[0].before);
  for(const move of x.context.moves)chess.move(uciMove(move));assert.equal(chess.isThreefoldRepetition(),false);chess.move('g8h8');assert.equal(chess.isThreefoldRepetition(),true);
  assert.equal(evidence(x),null);
});

test('a genuine capture resets obsolete repetition history while preserving full legal prefix validation',()=>{
  const x=position({fen:'7k/8/5K2/8/8/8/4p3/4R3 w - - 0 1',history:['e1d1','h8g8','d1e1','g8h8','e1e2'],actual:'h8g8'});
  assert.equal(x.context.moves[4].captured,'p');assert.ok(evidence(x));
  const altered={...x,context:{...x.context,moves:x.context.moves.map(m=>({...m}))}};altered.context.moves[0].to='d2';assert.equal(evidence(altered),null);
});

test('forged pawn or capture flags cannot erase a genuine reversible cycle',()=>{
  for(const kind of ['piece','captured']){
    const x=position({history:CYCLE,actual:'e1e2'});assert.equal(evidence(x),null);
    x.context.moves=x.context.moves.map(m=>({...m}));x.context.moves[3][kind]='p';assert.equal(evidence(x),null);
  }
});

test('in-place history mutations invalidate cached evidence instead of reusing the earlier win',()=>{
  for(const change of [x=>{x.context.moves[0].after=x.move.before;},x=>{x.context.moves[0].to='a4';},x=>{x.context.moves[0].piece='p';},x=>{x.context.moves[0].color='b';},x=>{x.context.moves[0].captured='p';}]){
    const x=position({history:CYCLE.slice(0,2),actual:'e2e3'});x.context.moves=x.context.moves.map(m=>({...m}));assert.ok(evidence(x));change(x);assert.equal(evidence(x),null);
  }
});

test('missing, shifted and mismatched history never receives elementary evidence',()=>{
  const x=position();assert.equal(elementaryEndgameEvidence(x.move),null);assert.equal(elementaryEndgameEvidence(x.move,{moves:x.context.moves,moveIndex:-1}),null);
  assert.equal(elementaryEndgameEvidence({...x.move,color:'b'},x.context),null);
  assert.equal(elementaryEndgameEvidence({...x.move,after:x.move.before},x.context),null);
  assert.equal(elementaryEndgameEvidence({...x.move,before:undefined},x.context),null);
  const broken=position({history:CYCLE.slice(0,2),actual:'e2e3'});broken.context.moves[0]=null;assert.equal(evidence(broken),null);
});

test('queen endings, extra material and transitions into or out of KRK remain outside this theorem',()=>{
  for(const item of [
    {fen:SETUP.replace('4R3','4Q3'),actual:'e1e2'},
    {fen:SETUP.replace('/8/4R3','/P7/4R3'),actual:'e1e2'},
    {fen:'7k/8/5K2/8/8/8/4p3/4R3 w - - 0 1',actual:'e1e2'},
    {fen:'8/8/8/4k3/3R4/8/8/K7 b - - 0 1',actual:'e5d4'}
  ])assert.equal(evidence(position(item)),null);
});

test('unchanged repeated rendering uses cached elementary evidence without replaying the history',()=>{
  const x=position({history:CYCLE.slice(0,2),actual:'e2e3'}),first=evidence(x),original=Chess.prototype.move;let calls=0;
  Chess.prototype.move=function(...args){calls++;return original.apply(this,args);};
  try{for(let i=0;i<30;i++)assert.equal(elementaryEndgameEvidence(x.move,x.context),first);assert.equal(calls,0);}finally{Chess.prototype.move=original;}
});

function sequentialHistory(){const chess=new Chess(SETUP),moves=['e1e2','h8g8','e2e3','g8f8','e3e4'].map(u=>chess.move(u));return {chess,moves};}
test('sequential certificates reuse one history array without changing any supplied position or move',()=>{
  const {chess,moves}=sequentialHistory(),saved=JSON.stringify(moves),finalFen=chess.fen(),finalHistory=chess.history();
  for(let moveIndex=0;moveIndex<moves.length;moveIndex++){
    const proof=elementaryEndgameEvidence(moves[moveIndex],{moves,moveIndex});assert.ok(proof);assert.equal(proof.winner,'w');
    assert.equal(JSON.stringify(moves),saved);assert.equal(chess.fen(),finalFen);assert.deepEqual(chess.history(),finalHistory);
  }
});

test('a new move object at an earlier index is rechecked after later sequential certificates',()=>{
  const {moves}=sequentialHistory();for(let moveIndex=0;moveIndex<moves.length;moveIndex++)assert.ok(elementaryEndgameEvidence(moves[moveIndex],{moves,moveIndex}));
  const saved=JSON.stringify(moves),earlier={...moves[1]};assert.ok(elementaryEndgameEvidence(earlier,{moves,moveIndex:1}));assert.equal(JSON.stringify(moves),saved);
  assert.ok(elementaryEndgameEvidence({...moves[4]},{moves,moveIndex:4}));assert.equal(JSON.stringify(moves),saved);
});

test('editing an earlier prefix invalidates later cached and new-object certificates after sequential use',()=>{
  const item=sequentialHistory(),moves=item.moves.map(m=>({...m}));for(let moveIndex=0;moveIndex<moves.length;moveIndex++)assert.ok(elementaryEndgameEvidence(moves[moveIndex],{moves,moveIndex}));
  moves[0].captured='p';assert.equal(elementaryEndgameEvidence(moves[4],{moves,moveIndex:4}),null);assert.equal(elementaryEndgameEvidence({...moves[3]},{moves,moveIndex:3}),null);
  delete moves[0].captured;assert.ok(elementaryEndgameEvidence(moves[4],{moves,moveIndex:4}));
  moves[1]=null;assert.equal(elementaryEndgameEvidence(moves[4],{moves,moveIndex:4}),null);
});

test('replacing index zero with a different legal starting board rebinds the shared prefix cache',()=>{
  const a=position(),b=position({fen:SETUP.replace('4R3','R7'),actual:'a1a2'}),moves=[a.move];
  assert.ok(elementaryEndgameEvidence(a.move,{moves,moveIndex:0}));moves[0]=b.move;
  const saved=JSON.stringify(moves);assert.ok(elementaryEndgameEvidence(b.move,{moves,moveIndex:0}));assert.equal(JSON.stringify(moves),saved);
});
