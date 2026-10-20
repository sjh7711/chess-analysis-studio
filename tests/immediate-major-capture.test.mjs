import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess,classifyMove,uciMove,expectedPoints} from '../src/chess-core.js';

const cp=value=>({type:'cp',value});
function result(score,pv){return {score,depth:16,bestmove:pv[0],multipvComplete:true,configKey:'synthetic-immediate-major',lines:[{multipv:1,depth:16,score:{...score},pv}]};}
function mirrorFen(fen){const [board,turn,rights,ep,half,full]=fen.split(' ');assert.equal(rights,'-');assert.equal(ep,'-');return [board.split('/').reverse().map(rank=>rank.replace(/[a-zA-Z]/g,c=>c===c.toUpperCase()?c.toLowerCase():c.toUpperCase())).join('/'),turn==='w'?'b':'w','-','-',half,full].join(' ');}
const mirrorUci=uci=>uci.replace(/[1-8]/g,n=>9-Number(n));
function fixture({black=false,recapture=false,promotion=false}={}){
  let fen=promotion?'8/8/8/8/p6P/1k6/8/R5K1 w - - 0 30':recapture?'q5k1/p6p/8/8/8/8/5B2/Q3K3 w - - 0 30':'q5k1/p7/8/8/8/8/8/Q3K3 w - - 0 30';
  let best=promotion?['a1b1','b3c3','g1f2']:['a1b1','a8d8','e1f1'];
  let played=promotion?['a1a4','b3a4','g1f2','a4b3','h4h5','b3c4','f2e3','c4d5','h5h6','d5d6','h6h7','d6d7','h7h8q']
    :recapture?['a1a7','a8a7','f2a7','g8f7']:['a1a7','a8a7','e1f1','a7a5'];
  if(black){fen=mirrorFen(fen);best=best.map(mirrorUci);played=played.map(mirrorUci);}
  const root=new Chess(fen),move=root.move(played[0]);
  const verify=pv=>{const chess=new Chess(fen),moves=pv.map(uci=>{assert.equal(chess.isGameOver(),false);return chess.move(uci);});return {chess,moves};};
  const actual=verify(played),alternative=verify(best),sign=black?-1:1;
  const before=result(cp((promotion?700:-600)*sign),best),after=result(cp((promotion?630:-800)*sign),played.slice(1));
  after.moveReview={version:1,fen:move.before,uci:uciMove(move),configKey:before.configKey,beforeScore:{...before.score},beforeDepth:16,beforeBestmove:before.bestmove,score:{...after.score},depth:16,pv:played,source:'search'};
  return {move,before,after,actual,alternative};
}
function unchanged(item){const source=()=>JSON.stringify({move:item.move,before:item.before,after:item.after}),raw=source(),grade=classifyMove(item.before,item.after,item.move);assert.equal(source(),raw);return grade;}

test('capturing a pawn before immediately losing the queen does not hide a settled major loss, for either color',()=>{
  for(const black of [false,true]){
    const item=fixture({black}),grade=unchanged(item);
    assert.equal(item.move.captured,'p');
    assert.equal(item.actual.moves[1].captured,'q');
    assert.ok(item.alternative.moves.every(m=>!m.captured));
    assert.equal(grade.key,'mistake');
    assert.deepEqual(grade.tacticalLoss.played,{start:1,end:2,loss:8});
    assert.equal(grade.tacticalLoss.additional,8);
    assert.equal(grade.loss,200);
    assert.equal(grade.pointsLoss,expectedPoints(item.before.score,item.move.color)-expectedPoints(item.after.score,item.move.color));
  }
});

test('a queen exchange and an available but omitted recapture are not uncompensated losses',()=>{
  for(const black of [false,true]){
    const item=fixture({black,recapture:true});
    assert.deepEqual(item.actual.moves.filter(m=>m.captured).map(m=>m.captured),['p','q','q']);
    assert.equal(unchanged(item).tacticalLoss,undefined);
    item.after.moveReview.pv=item.after.moveReview.pv.slice(0,2);
    assert.equal(unchanged(item).tacticalLoss,undefined,'the missing legal bishop recapture leaves the exchange unsettled');
  }
});

test('a later legal promotion can compensate a rook offered while taking a pawn, for either color',()=>{
  for(const black of [false,true]){
    const item=fixture({black,promotion:true});
    assert.equal(item.move.captured,'p');assert.equal(item.actual.moves[1].captured,'r');
    assert.equal(item.actual.moves[12].promotion,'q','the compensation occurs after the twelve-ply exchange window');
    assert.equal(item.actual.moves[12].color,item.move.color);
    assert.equal(unchanged(item).tacticalLoss,undefined);
    assert.equal(unchanged(item).key,'excellent');
  }
});

test('capture-start evidence retains complete-depth, configuration, binding and legal-suffix requirements',()=>{
  for(const mutate of [
    item=>{item.before.multipvComplete=false;},
    item=>{item.after.moveReview.depth=15;},
    item=>{item.after.moveReview.configKey='unrelated';},
    item=>{item.after.moveReview.beforeScore=cp(-500);},
    item=>{item.after.moveReview.fen=item.move.after;},
    item=>{item.after.moveReview.pv.push('a5h5');},
    item=>{item.before.lines[0].pv.push('a8a7');},
  ]){const item=fixture();mutate(item);assert.equal(unchanged(item).tacticalLoss,undefined);}
});

test('cached capture-start evidence is reused and revalidates in-place PV or score changes',()=>{
  const item=fixture(),grade=unchanged(item),original=Chess.prototype.move;let calls=0;
  Chess.prototype.move=function(...args){calls++;return original.apply(this,args);};
  try{
    for(let i=0;i<20;i++)assert.equal(classifyMove(item.before,item.after,item.move),grade);
    assert.equal(calls,0);
    item.after.moveReview.pv.push('a5h5');
    assert.equal(classifyMove(item.before,item.after,item.move).tacticalLoss,undefined);
    assert.ok(calls>0);
    item.after.moveReview.pv.pop();
    assert.equal(classifyMove(item.before,item.after,item.move).tacticalLoss.additional,8);
    item.after.moveReview.score=cp(-599);
    assert.equal(classifyMove(item.before,item.after,item.move).tacticalLoss,undefined);
  }finally{Chess.prototype.move=original;}
});

function laterPawnFixture({black=false,captureFirst=false,bestAlsoLoses=false}={}){
  let fen=captureFirst?'q5k1/8/8/8/p7/3p4/2P1P3/R3K3 w - - 0 30':'q5k1/8/8/8/8/2Pp4/4P3/R3K3 w - - 0 30';
  let played=captureFirst?['a1a4','a8a4','e1f1','a4c2','e2e4']:['e1f1','a8a1','f1f2','a1c3','e2e4'];
  let best=bestAlsoLoses?['e1d1','a8a1','d1d2','a1c3','d2d1']:['a1b1','d3e2','e1e2'];
  if(black){fen=mirrorFen(fen);played=played.map(mirrorUci);best=best.map(mirrorUci);}
  const chess=new Chess(fen),move=chess.move(played[0]);
  const verify=pv=>{const c=new Chess(fen);return pv.map(uci=>{assert.equal(c.isGameOver(),false);return c.move(uci);});};
  const actual=verify(played),alternative=verify(best),sign=black?-1:1;
  const before=result(cp(-600*sign),best),after=result(cp(-800*sign),played.slice(1));
  after.moveReview={version:1,fen:move.before,uci:uciMove(move),configKey:before.configKey,beforeScore:{...before.score},beforeDepth:16,beforeBestmove:before.bestmove,score:{...after.score},depth:16,pv:played,source:'search'};
  return {move,before,after,actual,alternative};
}

test('a later pawn-only loss cannot mask an earlier settled major capture, for either color',()=>{
  for(const black of [false,true])for(const captureFirst of [false,true]){
    const item=laterPawnFixture({black,captureFirst}),grade=unchanged(item);
    assert.equal(item.actual[1].captured,'r');assert.equal(item.actual[3].captured,'p');
    assert.equal(grade.key,'mistake');
    assert.equal(grade.tacticalLoss.additional,captureFirst?4:5);
    assert.deepEqual(grade.tacticalLoss.played,captureFirst?{start:1,end:2,loss:4}:{start:2,end:3,loss:5});
    assert.equal(grade.tacticalLoss.best.loss,0);
  }
});

test('major-window selection still accounts for the best branch losing the same rook and pawn',()=>{
  for(const black of [false,true]){
    const item=laterPawnFixture({black,bestAlsoLoses:true});
    assert.deepEqual(item.alternative.filter(m=>m.captured).map(m=>m.captured),['r','p']);
    assert.equal(unchanged(item).tacticalLoss,undefined);
  }
});
