import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess,parseGame,uciMove,classifyMove} from '../src/chess-core.js';

// A standard Queen's Gambit Accepted opening and legal example continuations.
// These are local capture-opportunity tests, not a forced-loss tablebase.
const PREFIX='1. d4 d5 2. c4 dxc4 3. e4 e6 *';
const BEST=['f1c4','f8b4','b1c3','c7c5','a2a3','b4a5','d4d5','g8f6','g1e2','e6d5','e4d5','e8g8','e1g1','f8e8'];
const PLAYED=['c1f4','g8f6','b1c3','f8b4','f1c4','f6e4','g1e2','e4c3','b2c3','b4d6','e1g1','e8g8','a2a4','d6f4','e2f4'];
const cp=value=>({type:'cp',value});
const mirrorUci=value=>value.replace(/[1-8]/g,n=>9-Number(n));
function mirrorFen(fen){
  const [board,turn,rights,ep,half,full]=fen.split(' ');
  return [board.split('/').reverse().map(rank=>rank.replace(/[a-zA-Z]/g,c=>c===c.toUpperCase()?c.toLowerCase():c.toUpperCase())).join('/'),
    turn==='w'?'b':'w',rights,ep==='-'?'-':mirrorUci(ep),half,full].join(' ');
}
function fixture({black=false,fen,played=PLAYED,best=BEST}={}){
  const prefix=parseGame(PREFIX),transform=black?mirrorUci:x=>x;
  let sourceFen=fen??prefix.positions.at(-1);
  if(black)sourceFen=mirrorFen(sourceFen);
  const chess=new Chess(sourceFen),move=chess.move(transform(played[0]));
  const moves=black||fen?[move]:[...prefix.moves,move],sign=black?-1:1,key='free-pawn-public-opening';
  const rootScore=cp(sign*40),playedScore=cp(sign*-90),bestPv=best.map(transform),playedPv=played.map(transform);
  const before={score:rootScore,depth:16,configKey:key,multipvComplete:true,bestmove:bestPv[0],
    lines:[{multipv:1,depth:16,score:{...rootScore},pv:bestPv}]};
  const after={score:playedScore,depth:16,configKey:key,multipvComplete:true,bestmove:playedPv[1],
    lines:[{multipv:1,depth:16,score:{...playedScore},pv:playedPv.slice(1)}],
    moveReview:{version:1,fen:move.before,uci:uciMove(move),configKey:key,beforeScore:{...rootScore},
      beforeDepth:16,beforeBestmove:before.bestmove,score:{...playedScore},depth:16,pv:playedPv,source:'search'}};
  return {move,before,after,context:{moves,moveIndex:moves.length-1}};
}
function grade(x,context=x.context){
  const original=JSON.stringify(x),value=classifyMove(x.before,x.after,x.move,context);
  assert.equal(JSON.stringify(x),original,'classification does not mutate scores, examples or history');return value;
}

test('a proved missed free pawn is semantic miss with unchanged ordinary-error severity and score loss',()=>{
  for(const black of [false,true]){
    const x=fixture({black}),ordinary=grade(x,{}),g=grade(x);
    assert.equal(ordinary.key,'mistake');assert.equal(g.key,'miss');
    assert.equal(g.severity,ordinary.severity);assert.equal(g.severity,2);
    assert.equal(g.loss,ordinary.loss);assert.equal(g.pointsLoss,ordinary.pointsLoss);
    assert.equal(g.opportunityEvidence.kind,'missed-free-pawn');
    assert.equal(g.opportunityEvidence.square,black?'c5':'c4');
    assert.deepEqual(g.opportunityEvidence.best,{samplePlies:6,gain:1,finalGain:1});
    assert.deepEqual(g.opportunityEvidence.played,{samplePlies:6,gain:0,finalGain:0});
    assert.equal(g.opportunityEvidence.fen,x.move.before);assert.equal(g.opportunityEvidence.uci,uciMove(x.move));
    const root=new Chess(x.move.before),capture=root.move(g.opportunityEvidence.first);
    assert.equal(capture.captured,'p');assert.equal(root.moves({verbose:true}).some(reply=>reply.captured&&reply.to===capture.to),false);
    assert.match(g.reason,/폰을 손해 없이 잡을 기회/);
  }
});

test('a protected pawn with a legal immediate recapture does not supply a free-capture label',()=>{
  const source=parseGame(PREFIX).positions.at(-1).split(' ');
  source[0]=source[0].replace('ppp2ppp','p1p2ppp').replace('/8/2pPP3/','/1p6/2pPP3/');
  for(const black of [false,true]){
    const x=fixture({black,fen:source.join(' ')}),root=new Chess(x.move.before),capture=root.move(x.before.bestmove);
    assert.ok(root.moves({verbose:true}).some(reply=>reply.captured&&reply.to===capture.to));
    assert.equal(grade(x).key,'mistake');assert.equal(grade(x).opportunityEvidence,undefined);
  }
});

test('actually collecting the same pawn and retaining equal compensation are not missed capture opportunities',()=>{
  for(const black of [false,true]){
    const captured=fixture({black,played:BEST});
    assert.equal(captured.move.captured,'p');assert.notEqual(grade(captured).key,'miss');
    assert.equal(grade(captured).opportunityEvidence,undefined);
    const sameGain=fixture({black,played:['c1f4','g8f6','f1c4','f8b4','b1c3','e8g8']});
    assert.equal(grade(sameGain).key,'mistake');assert.equal(grade(sameGain).opportunityEvidence,undefined);
    const lateRecovery=fixture({black,played:[...PLAYED.slice(0,6),'c4d3','e8g8','d3e4']});
    assert.equal(grade(lateRecovery).key,'mistake');assert.equal(grade(lateRecovery).opportunityEvidence,undefined);
  }
});

test('a checking continuation and a smaller existing evaluation error remain outside the quiet-mistake rule',()=>{
  const checking=fixture({played:['d1a4','b8c6','c1f4','g8f6','b1c3','f8b4']});
  assert.ok(checking.move.san.endsWith('+'));assert.equal(grade(checking).key,'mistake');
  assert.equal(grade(checking).opportunityEvidence,undefined);
  const smaller=fixture();smaller.after.moveReview.score=cp(-20);
  assert.notEqual(grade(smaller).key,'mistake');assert.equal(grade(smaller).opportunityEvidence,undefined);
});

test('stale depth, binding, incomplete sources and partial or illegal example lines cannot invent a missed pawn',()=>{
  for(const change of [
    x=>{x.before.multipvComplete=false;},x=>{x.after.moveReview.depth=15;},
    x=>{x.after.moveReview.configKey='old-policy';},x=>{x.after.moveReview.beforeScore=cp(41);},
    x=>{x.after.moveReview.source='unverified';},x=>{x.before.lines[0].depth=15;},
    x=>{x.before.lines[0].score=cp(41);},x=>{x.before.lines[0].pv=['f1c4'];},
    x=>{x.after.moveReview.pv=PLAYED.slice(0,5);},x=>{x.after.moveReview.pv.push('a1a8');},
  ]){
    const x=fixture();assert.equal(grade(x).key,'miss');change(x);
    assert.equal(grade(x).opportunityEvidence,undefined);
  }
});

test('missing, shifted and edited full history invalidate the opportunity cache',()=>{
  const x=fixture();assert.equal(grade(x).key,'miss');
  assert.equal(grade(x,{}).opportunityEvidence,undefined);
  assert.equal(grade(x,{...x.context,moveIndex:x.context.moveIndex+1}).opportunityEvidence,undefined);
  assert.equal(grade(x).key,'miss');
  const first=x.context.moves[0];x.context.moves[0]={...first,after:first.before};
  assert.equal(grade(x).opportunityEvidence,undefined);
  x.context.moves[0]=first;assert.equal(grade(x).key,'miss');
});
