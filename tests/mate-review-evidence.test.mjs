import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess,assessedMoveResult,classifyMove,hasMateReview,needsMateReview,validatedMateReview,uciMove} from '../src/chess-core.js';

function fixture({black=false,history=[],quiet=false,fen}={}) {
  const preserved=quiet==='preserved';
  fen ||= quiet?(black?'7r/8/8/8/8/2k5/8/1K6 b - - 0 30':preserved?'6k1/8/5K2/8/8/8/8/7R w - - 0 30':'6k1/8/5K2/8/8/8/8/R7 w - - 0 30')
    :(black?'8/8/3q4/8/8/2k5/8/K7 b - - 0 30':'7k/8/5K2/8/8/4Q3/8/8 w - - 0 30');
  const winner=black?'b':'w',sign=black?-1:1,actual=quiet?(black?'c3d2':preserved?'h1h2':'f6e7'):(black?'d6d7':'e3e2'),best=quiet?(black?'h8a8':preserved?'h1h3':'a1h1'):(black?'d6a3':'e3h6');
  const bestPv=quiet?(black?['h8a8','b1c1','a8a1']:preserved?['h1h3','g8f8','h3h8']:['a1h1','g8f8','h1h8']):(black?['d6a3','a1b1','a3b2']:['e3h6','h8g8','h6g7']);
  const primaryPv=quiet?(black?['c3d2','b1b2','h8b8','b2a2']:preserved?['h1h2','g8f8','h2h3','f8g8']:['f6e7','g8g7','a1g1','g7h7']):(black?['d6d7','a1b1','d7d3','b1c1']:['e3e2','h8g8','e2e6','g8f8']);
  const proofPv=quiet?(black?['c3d2','b1b2','h8b8','b2a2','d2c2','a2a1','b8a8']:preserved?['h1h2','g8f8','h2h3','f8g8','h3h4','g8f8','h4h8']:['f6e7','g8g7','a1g1','g7h7','e7f7','h7h8','g1h1']):(black?['d6d7','a1b1','d7b5','b1a1','b5b2']:['e3e2','h8g8','e2g4','g8h8','g4g7']);
  const childPv=preserved?['g8f8','h2h8']:proofPv.slice(1);
  const chess=new Chess(fen),root=new Chess(fen),moves=[];for(const uci of history){moves.push(chess.move(uci));root.move(uci);}const move=chess.move(actual);moves.push(move);
  const rootScore={type:'mate',value:2*sign,winner},childScore={type:'mate',value:(preserved?1:quiet?3:2)*sign,winner},playedScore={type:'cp',value:900*sign},proofScore={type:'mate',value:(quiet?4:3)*sign,winner};
  const before={score:{...rootScore},depth:16,configKey:'mate-proof-test',bestmove:best,multipvComplete:true,lines:[{multipv:1,depth:16,score:{...rootScore},pv:bestPv}]};
  const after={score:{...childScore},depth:16,configKey:before.configKey,bestmove:proofPv[1],multipvComplete:true,
    lines:[{multipv:1,depth:16,score:{...childScore},pv:childPv}],moveReview:{version:1,fen:move.before,uci:actual,configKey:before.configKey,beforeDepth:16,beforeBestmove:best,
      beforeScore:{...rootScore},depth:16,score:{...playedScore},pv:primaryPv,source:'search'}};
  const record={version:1,scope:'played-mate-proof',fen:move.before,afterFen:move.after,uci:actual,configKey:before.configKey,startFen:fen,historyMoves:[...history],
    beforeScore:{...rootScore},beforeDepth:16,beforeBestmove:best,beforePv:[...bestPv],childScore:{...childScore},childDepth:16,childBestmove:after.bestmove,childPv:[...childPv],
    playedScore:{...playedScore},playedDepth:16,playedSource:'search',playedPv:[...primaryPv],requestedDepth:20,minimumDepth:18,requestedMultipv:1,movetime:1200,searchMoves:[actual],status:'complete',
    result:{score:{...proofScore},depth:20,bestmove:actual,multipvComplete:true,lines:[{multipv:1,depth:20,score:{...proofScore},pv:[...proofPv]}]}};
  return {before,after,move,record,root,context:{moves,moveIndex:moves.length-1}};
}
const attach=x=>{x.after.moveReview.mateReview=x.record;return x;};
function assertOriginalUnchanged(x,fn){const state=()=>JSON.stringify({before:x.before,after:x.after,move:x.move,context:x.context,rootFen:x.root.fen(),history:x.root.history()});const snapshot=state();const result=fn();assert.equal(state(),snapshot);return result;}

test('a fully certified quiet mate in two can be missed only with independent longer-mate conflict proof',()=>{
  for(const black of [false,true]){const x=fixture({black,quiet:true});assert.equal(classifyMove(x.before,x.after,x.move,x.context).mateEvidence,undefined);attach(x);assert.ok(validatedMateReview(x.before,x.after,x.move,x.context));
    const g=assertOriginalUnchanged(x,()=>classifyMove(x.before,x.after,x.move,x.context));assert.equal(g.key,'miss');assert.equal(g.mateEvidence.checkingStart,false);assert.equal(g.reason.includes('체크로 시작'),false);}
});

test('quiet mate certification rejects an escaping defender and preserves an actual alternative mate in two',()=>{
  const falseProof=attach(fixture({quiet:true,fen:'6k1/p7/5K2/8/8/8/8/R7 w - - 0 30'}));assert.ok(validatedMateReview(falseProof.before,falseProof.after,falseProof.move));assert.equal(classifyMove(falseProof.before,falseProof.after,falseProof.move,falseProof.context).mateEvidence,undefined);
  const preserved=attach(fixture({quiet:'preserved'}));assert.ok(validatedMateReview(preserved.before,preserved.after,preserved.move));assert.equal(classifyMove(preserved.before,preserved.after,preserved.move,preserved.context).key,'excellent');
  preserved.record.result.lines[0].pv.pop();assert.equal(classifyMove(preserved.before,preserved.after,preserved.move,preserved.context).mateEvidence,undefined);
});

test('a separate deeper complete played-root mate proof repairs the assessment for either color without changing source scores',()=>{
  for(const black of [false,true]){const x=fixture({black});assert.equal(needsMateReview(x.before,x.after,x.move,x.root),true);const original=assessedMoveResult(x.before,x.after,x.move);assert.equal(original.score.type,'cp');attach(x);
    assert.equal(hasMateReview(x.before,x.after,x.move,x.root),true);assert.equal(needsMateReview(x.before,x.after,x.move,x.root),false);
    const proof=assertOriginalUnchanged(x,()=>validatedMateReview(x.before,x.after,x.move,x.root));assert.equal(proof,x.record.result);
    const assessed=assertOriginalUnchanged(x,()=>assessedMoveResult(x.before,x.after,x.move,x.context));assert.deepEqual(assessed.score,{type:'mate',value:black?-2:2,winner:black?'b':'w'});
    assert.deepEqual(assessed.lines[0].pv,x.record.result.lines[0].pv.slice(1));assert.equal(assessed.depth,20);assert.equal(x.after.moveReview.score.type,'cp');assert.equal(x.before.score.value,black?-2:2);
    const grade=assertOriginalUnchanged(x,()=>classifyMove(x.before,x.after,x.move,x.context));assert.equal(grade.key,'miss');assert.equal(grade.mateEvidence.kind,'missed-verified-mate-in-two');assert.equal(grade.loss,0);assert.equal(grade.pointsLoss,0);
    assert.notEqual(grade.key,'best');assert.notEqual(grade.key,'great');}
});

test('bound CP, shallow and failed attempts are cached but are never consumed as mating evidence',()=>{
  for(const state of ['cp','shallow','failed']){const x=attach(fixture());if(state==='cp'){x.record.result.score={type:'cp',value:900};x.record.result.lines[0].score={type:'cp',value:900};x.record.result.lines[0].pv=[...x.record.playedPv];}
    if(state==='shallow'){x.record.status='depth-limited';x.record.result.depth=17;x.record.result.lines[0].depth=17;}
    if(state==='failed'){x.record.status='unverified';x.record.result=null;}
    assert.equal(hasMateReview(x.before,x.after,x.move,x.root),true);assert.equal(needsMateReview(x.before,x.after,x.move,x.root),false);
    assert.equal(validatedMateReview(x.before,x.after,x.move),null);assert.equal(assessedMoveResult(x.before,x.after,x.move).score.type,'cp');}
});

test('changed root, child, primary, history, config, score, scope and search budget cannot reuse proof',()=>{
  for(const change of [x=>{x.record.configKey='other';},x=>{x.record.scope='unrestricted-root';},x=>{x.record.fen=x.move.after;},x=>{x.record.afterFen=x.move.before;},
    x=>{x.record.beforePv.pop();},x=>{x.record.childPv.pop();},x=>{x.record.playedPv.pop();},x=>{x.record.beforeScore.value=3;},x=>{x.record.childScore.value=4;},
    x=>{x.record.playedDepth=15;},x=>{x.record.playedSource='candidate';},x=>{x.record.searchMoves=[];},x=>{x.record.requestedDepth=22;},x=>{x.record.minimumDepth=17;},
    x=>{x.record.movetime=1201;},x=>{x.record.historyMoves=['e3e2'];},x=>{x.record.result.bestmove=x.before.bestmove;},
  ]){const x=attach(fixture());assert.ok(validatedMateReview(x.before,x.after,x.move));change(x);assert.equal(hasMateReview(x.before,x.after,x.move),false);assert.equal(validatedMateReview(x.before,x.after,x.move),null);}
});

test('wrong mate direction, distance, incomplete iteration or an illegal/terminal-extended PV is rejected',()=>{
  for(const change of [x=>{x.record.result.score.winner='b';x.record.result.lines[0].score.winner='b';},x=>{x.record.result.score.value=5;x.record.result.lines[0].score.value=5;},
    x=>{x.record.result.score.value=-4;x.record.result.lines[0].score.value=-4;},x=>{x.record.result.multipvComplete=false;},x=>{x.record.result.depth=17;x.record.result.lines[0].depth=17;},
    x=>{x.record.result.lines[0].pv.pop();},x=>{x.record.result.lines[0].pv.push('g8h8');},x=>{x.record.result.lines[0].pv[1]='a1a1';},x=>{x.record.result.lines[0].pv[1]='Kg8';},x=>{x.record.result.lines[0].pv[0]=x.before.bestmove;},
  ]){const x=attach(fixture());change(x);assert.equal(validatedMateReview(x.before,x.after,x.move),null);assert.equal(assessedMoveResult(x.before,x.after,x.move).score.type,'cp');}
});

test('external actual history must match even when a different legal history reaches the same complete FEN',()=>{
  const cycle=['e3e2','h8g8','e2e3','g8h8'],x=attach(fixture({history:cycle}));assert.ok(validatedMateReview(x.before,x.after,x.move,x.root));
  const alternate=new Chess(x.record.startFen);for(const u of ['e3d3','h8g8','d3e3','g8h8'])alternate.move(u);assert.equal(alternate.fen(),x.root.fen());
  assert.equal(hasMateReview(x.before,x.after,x.move,alternate),false);assert.equal(validatedMateReview(x.before,x.after,x.move,alternate),null);
  x.context.moves[0]={...x.context.moves[0],after:x.move.after};assert.equal(assessedMoveResult(x.before,x.after,x.move,x.context).score.type,'cp');
});

test('repetition, fifty-move history and an already available immediate finish prevent the trigger',()=>{
  const loop=['e3e2','h8g8','e2e3','g8h8'],repeat=attach(fixture({history:[...loop,...loop]}));assert.equal(repeat.root.isThreefoldRepetition(),true);
  assert.equal(needsMateReview(repeat.before,repeat.after,repeat.move,repeat.root),false);assert.equal(validatedMateReview(repeat.before,repeat.after,repeat.move),null);
  const fifty=attach(fixture({fen:'7k/8/5K2/8/8/4Q3/8/8 w - - 95 30'}));assert.equal(needsMateReview(fifty.before,fifty.after,fifty.move,fifty.root),false);
  const root=new Chess('7k/8/5KQ1/8/8/8/8/8 w - - 0 30'),move=root.move('Qg4'),score={type:'mate',value:1,winner:'w'};
  const before={score,depth:16,configKey:'immediate-test',multipvComplete:true,bestmove:'g6g7',lines:[{multipv:1,depth:16,score,pv:['g6g7']}]};
  const after={score,depth:16,configKey:before.configKey,multipvComplete:true,bestmove:'h8h7',lines:[{multipv:1,depth:16,score,pv:['h8h7','g4g7']}],
    moveReview:{version:1,fen:move.before,uci:'g6g4',configKey:before.configKey,beforeScore:score,beforeDepth:16,beforeBestmove:'g6g7',score:{type:'cp',value:900},depth:16,pv:['g6g4','h8h7','g4g7'],source:'search'}};
  assert.equal(needsMateReview(before,after,move,new Chess(move.before)),false);assert.equal(classifyMove(before,after,move,{moves:[move],moveIndex:0}).key,'miss');
  const high=fixture();high.before.depth=21;high.after.depth=21;high.after.moveReview.depth=21;high.after.moveReview.beforeDepth=21;assert.equal(needsMateReview(high.before,high.after,high.move),false);
});

test('stable proof validation is cached and in-place proof edits invalidate cached grades',()=>{
  const x=attach(fixture()),first=classifyMove(x.before,x.after,x.move,x.context),original=Chess.prototype.move;let calls=0;
  Chess.prototype.move=function(...args){calls++;return original.apply(this,args);};
  try{for(let n=0;n<100;n++)assert.equal(classifyMove(x.before,x.after,x.move,x.context),first);assert.equal(calls,0);}finally{Chess.prototype.move=original;}
  x.record.result.lines[0].pv.pop();assert.equal(assessedMoveResult(x.before,x.after,x.move).score.type,'cp');assert.notEqual(classifyMove(x.before,x.after,x.move,x.context),first);
});
