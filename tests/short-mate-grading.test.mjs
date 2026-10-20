import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess,classifyMove,uciMove} from '../src/chess-core.js';

function fixture({black=false,kind='allowed',fen,history=[],actual,best,pv,bestPv}={}) {
  const allowed=kind.startsWith('allowed'),distance=kind==='allowed-two'?2:1,winner=black?'b':'w',actor=allowed?(black?'w':'b'):winner,sign=winner==='w'?1:-1;
  fen ||= allowed?(distance===2?(black?'8/8/3q4/8/8/2k5/7P/K6R w - - 0 30':'r6k/p7/5K2/8/8/4Q3/8/8 b - - 0 30'):(black?'8/8/8/8/8/1qk5/7P/K6R w - - 0 30':'r6k/p7/5KQ1/8/8/8/8/8 b - - 0 30'))
    :(black?'8/8/3q4/8/8/2k5/8/K7 b - - 0 30':'7k/8/5K2/8/8/4Q3/8/8 w - - 0 30');
  actual ||= allowed?(black?'h2h3':'a7a6'):(black?'d6d7':'e3e2');
  best ||= allowed?(black?'h1c1':'a8f8'):(black?'d6a3':'e3h6');
  pv ||= allowed?(distance===2?[actual,...(black?['d6a3','a1b1','a3b2']:['e3h6','h8g8','h6g7'])]:[actual,black?'b3b2':'g6g7']):[actual,...(black?['a1b1','d7d3','b1c1']:['h8g8','e2e6','g8f8'])];
  bestPv ||= allowed?[best,black?'c3d2':'f6e7']:(black?['d6a3','a1b1','a3b2']:['e3h6','h8g8','h6g7']);
  const chess=new Chess(fen),moves=history.map(u=>chess.move(u)),move=chess.move(actual);moves.push(move);assert.equal(move.color,actor);
  const rootScore=allowed?{type:'cp',value:sign*900}:{type:'mate',value:sign*2,winner},playedScore=allowed?{type:'mate',value:sign*distance,winner}:{type:'cp',value:sign*900};
  const before={score:{...rootScore},depth:16,bestmove:best,multipvComplete:true,configKey:'short-mate-test',lines:[{multipv:1,depth:16,score:{...rootScore},pv:[...bestPv]}]};
  const after={score:{...playedScore},depth:16,bestmove:pv[1],multipvComplete:true,configKey:before.configKey,
    lines:[{multipv:1,depth:16,score:{...playedScore},pv:pv.slice(1)}],moveReview:{version:1,fen:move.before,uci:actual,configKey:before.configKey,
      beforeDepth:16,beforeBestmove:best,beforeScore:{...rootScore},depth:16,score:{...playedScore},pv:[...pv],source:'search'}};
  return {before,after,move,context:{moves,moveIndex:moves.length-1}};
}
function grade(item){const snapshot=JSON.stringify(item),g=classifyMove(item.before,item.after,item.move,item.context);assert.equal(JSON.stringify(item),snapshot);return g;}

test('an avoidable opponent mate in one is a concrete mistake even when losing chances already saturate',()=>{
  for(const black of [false,true]){const x=fixture({black}),root=new Chess(x.move.before),actual=new Chess(x.move.after);
    assert.ok(actual.moves().some(s=>s.endsWith('#')));root.move(x.before.bestmove);assert.equal(root.moves().some(s=>s.endsWith('#')),false);
    const g=grade(x);assert.equal(g.key,'mistake');assert.equal(g.mateEvidence.kind,'allowed-mate-in-one');assert.ok(g.pointsLoss<.05);}
});

test('allowing a fully verified checking mate in two is a mistake for either color',()=>{
  for(const black of [false,true]){const x=fixture({black,kind:'allowed-two'}),g=grade(x);assert.equal(g.key,'mistake');assert.equal(g.mateEvidence.kind,'allowed-mate-in-two');assert.equal(g.mateEvidence.certificates.length,1);assert.ok(g.pointsLoss<.05);}
});

test('an alternative which also permits checking mate in two and a selected line with an escaping defense are not new mistakes',()=>{
  const same=fixture({kind:'allowed-two',best:'a8b8',bestPv:['a8b8','e3h6','h8g8','h6g7']});assert.equal(grade(same).mateEvidence,undefined);
  const escape=fixture({kind:'allowed-two',fen:'7k/p5r1/5Kn1/8/8/4Q3/8/8 b - - 0 30',best:'g7f7',bestPv:['g7f7','f6f7']});
  const proof=new Chess(escape.move.after);proof.move('Qh6+');proof.move('Rh7');assert.equal(proof.moves().some(s=>s.endsWith('#')),false);assert.equal(grade(escape).mateEvidence,undefined);
});

test('a missed checking mate in two is proved over every legal defense for either color',()=>{
  for(const black of [false,true]){const x=fixture({black,kind:'missed'}),root=new Chess(x.move.before);assert.equal(root.moves().some(s=>s.endsWith('#')),false);
    root.move(x.before.bestmove);for(const reply of root.moves()){root.move(reply);assert.ok(root.moves().some(s=>s.endsWith('#')));root.undo();}
    const g=grade(x);assert.equal(g.key,'miss');assert.equal(g.mateEvidence.kind,'missed-verified-mate-in-two');assert.equal(g.mateEvidence.certificates.length,1);assert.ok(g.pointsLoss<.05);}
});

test('all defenses receive separate mating certificates, and one unproved defense rejects a selected mating PV',()=>{
  const positive=fixture({kind:'missed',fen:'7k/6r1/5K2/8/8/3BQ3/8/8 w - - 0 30',bestPv:['e3h6','h8g8','h6g7']});
  const g=grade(positive);assert.equal(g.key,'miss');assert.equal(g.mateEvidence.certificates.length,2);
  const negative=fixture({kind:'missed',fen:'7k/6r1/5Kn1/8/8/4Q3/8/8 w - - 0 30',bestPv:['e3h6','h8g8','h6g7']});
  const root=new Chess(negative.move.before);root.move('Qh6+');root.move('Rh7');assert.equal(root.moves().some(s=>s.endsWith('#')),false);
  assert.notEqual(grade(negative).key,'miss');
});

test('source binding, whole legal PVs and completed matching searches remain mandatory',()=>{
  for(const kind of ['allowed','allowed-two','missed'])for(const change of [
    x=>{x.after.moveReview.depth--;},x=>{x.after.moveReview.configKey='different';},x=>{x.before.multipvComplete=false;},
    x=>{x.after.moveReview.fen=x.move.after;},x=>{x.after.moveReview.source='unverified';},x=>{x.after.moveReview.pv[0]='a1a1';},
    x=>{x.before.lines[0].pv.push('a1a1');},x=>{x.context={};},
  ]){const x=fixture({kind});change(x);assert.equal(grade(x).mateEvidence,undefined);}
  for(const change of [x=>{x.after.depth=15;},x=>{x.after.configKey='different';},x=>{x.after.multipvComplete=false;},x=>{x.after.lines[0].pv.push('a1a1');},
    x=>{x.after.score={type:'mate',value:3,winner:'w'};},x=>{x.before.score.value=3;x.after.moveReview.beforeScore.value=3;x.before.lines[0].score.value=3;},
  ]){const x=fixture({kind:'missed'});change(x);assert.equal(grade(x).mateEvidence,undefined);}
  const sign=fixture();sign.after.moveReview.score.value=-1;assert.equal(grade(sign).mateEvidence,undefined);
});

test('an only legal response and a best alternative which also allows mate are not blamed by the new floor',()=>{
  const forced=fixture({fen:'7k/8/5K1Q/8/8/8/8/8 b - - 0 30',actual:'h8g8',best:'h8g8',pv:['h8g8','h6g7'],bestPv:['h8g8','h6g7']});
  assert.equal(new Chess(forced.move.before).moves().length,1);assert.equal(grade(forced).mateEvidence,undefined);
  const noDefense=fixture({best:'a8g8',bestPv:['a8g8','g6h6']});assert.ok(new Chess(noDefense.move.before).move('Rg8'));
  assert.equal(grade(noDefense).mateEvidence,undefined);
});

test('actual full history and the fifty-move limit can invalidate an apparent mating certificate',()=>{
  const repeated=fixture({kind:'missed',history:['e3e2','h8g8','e2e3','g8h8','e3e2','h8g8','e2e3','g8h8']});
  const before=new Chess(repeated.context.moves[0].before);for(const m of repeated.context.moves.slice(0,-1))before.move(uciMove(m));assert.equal(before.isThreefoldRepetition(),true);
  assert.equal(grade(repeated).mateEvidence,undefined);
  const fifty=fixture({fen:'r6k/p7/5KQ1/8/8/8/8/8 b - - 99 30',actual:'a8b8',pv:['a8b8','g6g7']});
  assert.equal(new Chess(fifty.move.after).isDrawByFiftyMoves(),true);assert.equal(grade(fifty).mateEvidence,undefined);
});

test('in-place score, PV and history edits invalidate earlier short-mate proof',()=>{
  const pv=fixture();assert.ok(grade(pv).mateEvidence);pv.after.moveReview.pv.push('h8g8');assert.equal(grade(pv).mateEvidence,undefined);
  const history=fixture({kind:'missed'});assert.ok(grade(history).mateEvidence);history.context.moves[0]={...history.move,after:history.move.before};assert.equal(grade(history).mateEvidence,undefined);
  const score=fixture({kind:'missed'});assert.ok(grade(score).mateEvidence);score.after.score={type:'mate',value:4,winner:'w'};assert.equal(grade(score).mateEvidence,undefined);
});

test('unchanged short-mate evidence does not replay positions during repeated rendering',()=>{
  for(const kind of ['allowed','allowed-two','missed']){const x=fixture({kind}),first=grade(x),original=Chess.prototype.move;let calls=0;
    Chess.prototype.move=function(...args){calls++;return original.apply(this,args);};
    try{for(let i=0;i<100;i++)assert.equal(classifyMove(x.before,x.after,x.move,x.context),first);assert.equal(calls,0);}finally{Chess.prototype.move=original;}}
});
