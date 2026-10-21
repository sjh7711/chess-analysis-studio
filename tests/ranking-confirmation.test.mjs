import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess,uciMove,positionCommand,classifyMove,hasMoveReview,hasRankingReview,needsRankingReview,assessedMoveResult} from '../src/chess-core.js';
import {reviewMove} from '../src/review.js';

const cp=value=>({type:'cp',value});
const snapshot=item=>JSON.stringify({before:item.before,after:item.after,move:item.move,root:positionCommand(item.chess),options:item.options});
function fixture({black=false,history=false}={}) {
  const chess=new Chess(black?'3k3r/8/8/8/8/8/8/1K5Q b - - 0 30':'q5k1/8/8/8/8/8/8/R3K3 w - - 0 30');
  if(history)for(const san of Array.isArray(history)?history:['Ke2','Qb8','Ke1','Qa8'])chess.move(san);
  const move=chess.move(black?'Rg8':'Rb1');chess.undo();
  const sign=black?-1:1,played=uciMove(move),best=black?'h8h7':'a1a2',second=black?'d8c8':'e1f1';
  const response=black?['h1h4','d8c7']:['a8a5','e1f2'];
  const before={score:cp(100*sign),depth:12,bestmove:best,multipvComplete:true,configKey:'ranking-v1:game:lite:16:1200:2:32:1',
    lines:[{multipv:1,depth:12,score:cp(100*sign),pv:[best,...response]},
      {multipv:2,depth:12,score:cp(80*sign),pv:[second]}]};
  const after={score:cp(900*sign),depth:12,bestmove:response[0],multipvComplete:true,configKey:before.configKey,
    lines:[{multipv:1,depth:12,score:cp(900*sign),pv:[...response]}],
    moveReview:{version:1,fen:move.before,uci:played,configKey:before.configKey,beforeScore:{...before.score},beforeDepth:12,beforeBestmove:best,
      score:cp(120*sign),depth:12,pv:[played,...response],source:'search'}};
  const options={depth:16,movetime:3000,multipv:5};
  return {chess,move,before,after,options,played,best,response,sign};
}

function confirmation(item,{tied=false,notBest=false,depth=12,incomplete=false,actualPv}={}) {
  const actual={multipv:notBest||tied?2:1,depth,score:cp((notBest?90:110)*item.sign),pv:actualPv||[item.played,...item.response]};
  const other={multipv:notBest||tied?1:2,depth,score:cp((tied?110:100)*item.sign),pv:[item.best,...item.response]};
  const lines=[actual,other].sort((a,b)=>a.multipv-b.multipv),first=lines[0];
  return {score:{...first.score},depth,bestmove:first.pv[0],engineBestmove:first.pv[0],multipvComplete:!incomplete,lines};
}

async function reviewed(item,changes={}) {
  const calls=[],value=confirmation(item,changes),engine={
    async reset(){calls.push({type:'reset'});},
    async analyze(chess,settings){calls.push({type:'analyze',history:positionCommand(chess),settings});return value;},
  };
  const after=await reviewMove(engine,item.chess,item.before,item.after,item.move,item.options);
  return {after,calls,engine,value};
}

test('an independently better played score needs a completed unrestricted confirmation before becoming best',async()=>{
  for(const black of [false,true]) {
    const item=fixture({black}),original=snapshot(item);
    assert.equal(classifyMove(item.before,item.after,item.move).key,'excellent');
    assert.equal(needsRankingReview(item.before,item.after,item.move),true);
    const {after,calls}=await reviewed(item);
    assert.equal(snapshot(item),original,'raw root and child evidence stays untouched');
    assert.equal(after.score,item.after.score);assert.equal(after.lines,item.after.lines);assert.equal(after.bestmove,item.after.bestmove);
    assert.equal(after.moveReview.score,item.after.moveReview.score);assert.equal(after.moveReview.pv,item.after.moveReview.pv);
    assert.equal(hasMoveReview(item.before,after,item.move),true);assert.equal(hasRankingReview(item.before,after,item.move),true);
    assert.equal(needsRankingReview(item.before,after,item.move),false);
    const grade=classifyMove(item.before,after,item.move);
    assert.equal(grade.key,'best');assert.equal(grade.loss,0);assert.equal(grade.pointsLoss,0);
    assert.equal(assessedMoveResult(item.before,after,item.move).score.value,item.after.moveReview.score.value);
    assert.equal(calls[0].type,'reset');
    assert.deepEqual(calls[1].settings,{...item.options,depth:12,movetime:1200,multipv:2});
    assert.equal(calls[1].history,positionCommand(item.chess));
  }
});

test('a true equal score in one completed unrestricted candidate set can confirm an alternative best move',async()=>{
  const item=fixture(),{after}=await reviewed(item,{tied:true});
  assert.notEqual(after.moveReview.rankingReview.result.bestmove,item.played);
  assert.equal(classifyMove(item.before,after,item.move).key,'best');
});

test('a completed unrestricted check that keeps another move best preserves the original assessment',async()=>{
  const item=fixture(),old=classifyMove(item.before,item.after,item.move),{after}=await reviewed(item,{notBest:true});
  assert.equal(hasRankingReview(item.before,after,item.move),true);
  assert.deepEqual(classifyMove(item.before,after,item.move),old);
});

test('an incomplete or shallower check never creates best evidence and is retained as a bounded attempted check',async()=>{
  for(const settings of [{depth:11},{incomplete:true}]) {
    const item=fixture(),{after}=await reviewed(item,settings);
    assert.equal(classifyMove(item.before,after,item.move).key,'excellent');
    assert.equal(after.moveReview.rankingReview.status,settings.depth?'depth-limited':'unverified');
    assert.equal(hasRankingReview(item.before,after,item.move),true);
  }
});

test('a cached bound confirmation is reused without another reset or global search',async()=>{
  const item=fixture(),{after}=await reviewed(item),snapshot=JSON.stringify(after);
  const reused=await reviewMove({reset(){assert.fail('cached confirmation reset');},analyze(){assert.fail('cached confirmation search');}},
    item.chess,item.before,after,item.move,item.options);
  assert.equal(reused,after);assert.equal(JSON.stringify(after),snapshot);
});

test('confirmation search retains the exact root history, respects the smaller time budget, and removes a caller restriction',async()=>{
  const item=fixture({history:true});item.options={...item.options,movetime:250,searchMoves:[item.played]};
  const {calls}=await reviewed(item),settings=calls[1].settings;
  assert.deepEqual(item.chess.history(),['Ke2','Qb8','Ke1','Qa8']);
  assert.equal(calls[1].history,positionCommand(item.chess));
  assert.equal(settings.movetime,250);assert.equal('searchMoves' in settings,false);
  assert.equal(settings.depth,item.before.depth);assert.equal(settings.multipv,item.before.lines.length);
  const {after}=await reviewed(item);
  assert.deepEqual(after.moveReview.rankingReview.historyMoves,['e1e2','a8b8','e2e1','b8a8']);
  assert.equal(after.moveReview.rankingReview.startFen,item.chess.history({verbose:true})[0].before);
});

test('the normal played-only review can add one unrestricted confirmation without replacing its first score or PV',async()=>{
  const item=fixture(),after={...item.after};delete after.moveReview;
  const calls=[],engine={async reset(){calls.push('reset');},async analyze(chess,settings){
    calls.push(settings);
    return settings.searchMoves?{lines:[{score:cp(120),depth:12,pv:[item.played,...item.response]}]}:confirmation(item);
  }};
  const result=await reviewMove(engine,item.chess,item.before,after,item.move,item.options);
  assert.deepEqual(calls[0].searchMoves,[item.played]);assert.equal(calls[1],'reset');assert.equal('searchMoves' in calls[2],false);
  assert.equal(result.moveReview.score.value,120);assert.deepEqual(result.moveReview.pv,[item.played,...item.response]);
  assert.equal(result.score,after.score);assert.equal(result.lines,after.lines);
  assert.equal(classifyMove(item.before,result,item.move).key,'best');
});

test('only bound equally deep CP inversions trigger an optional global check',()=>{
  for(const change of [
    item=>{item.before.multipvComplete=false;},
    item=>{item.after.moveReview.source='candidate';},
    item=>{item.after.moveReview.source='best';},
    item=>{item.after.moveReview.depth=11;},
    item=>{item.after.moveReview.depth=13;},
    item=>{item.after.moveReview.score=cp(100);},
    item=>{item.after.moveReview.score=cp(90);},
    item=>{item.after.moveReview.score={type:'mate',value:1,winner:'w'};},
    item=>{item.after.moveReview.configKey='another-scope';},
    item=>{item.after.moveReview.fen=item.move.after;},
    item=>{item.after.moveReview.pv.push('a1h8');},
    item=>{item.before.lines[0].pv.push('a1h8');},
  ]) {
    const item=fixture();change(item);assert.equal(needsRankingReview(item.before,item.after,item.move),false);
  }
});

test('optional confidence failures preserve primary evidence and do not retry on every cache read',async()=>{
  const item=fixture(),before=snapshot(item),result=await reviewMove({async analyze(){throw new Error('optional failure');}},item.chess,item.before,item.after,item.move,item.options);
  assert.equal(snapshot(item),before);assert.equal(result.moveReview.rankingReview.status,'unverified');
  assert.equal(hasRankingReview(item.before,result,item.move),true);assert.equal(classifyMove(item.before,result,item.move).key,'excellent');
  await reviewMove({analyze(){assert.fail('failed optional check should not repeat automatically');}},item.chess,item.before,result,item.move,item.options);
});

test('cancellation during reset or global search propagates without publishing optional evidence',async()=>{
  for(const phase of ['reset','analyze']) {
    const item=fixture(),before=snapshot(item),engine={
      async reset(){if(phase==='reset')throw new DOMException('Cancelled','AbortError');},
      async analyze(){throw new DOMException('Cancelled','AbortError');},
    };
    await assert.rejects(reviewMove(engine,item.chess,item.before,item.after,item.move,item.options),{name:'AbortError'});
    assert.equal(snapshot(item),before);
  }
});

test('paired, stale, partial, mismatched or illegal confirmation metadata cannot establish a global best',async()=>{
  const changes=[
    item=>{item.record.version=2;},item=>{item.record.scope='reference-pair';},
    item=>{item.record.fen=item.move.after;},item=>{item.record.afterFen=item.move.before;},item=>{item.record.uci=item.best;},
    item=>{item.record.startFen=item.move.after;},item=>{item.record.historyMoves=['a1b1'];},
    item=>{item.record.historyMoves=['Rb1'];},item=>{item.record.historyMoves=null;},
    item=>{item.record.configKey='another-config';},item=>{item.record.beforeDepth++;},item=>{item.record.beforeBestmove=item.played;},
    item=>{item.record.beforeScore.value++;},item=>{item.record.playedScore.value++;},item=>{item.record.playedDepth++;},
    item=>{item.record.playedSource='candidate';},item=>{item.record.playedPv.push('a1h8');},item=>{item.record.requestedDepth++;},
    item=>{item.record.requestedMultipv=1;},item=>{item.record.movetime=1201;},item=>{item.record.movetime=0;},
    item=>{item.record.searchMoves=[item.played,item.best];},item=>{item.record.status='unverified';},
    item=>{item.record.result.multipvComplete=false;},item=>{item.record.result.depth--;},
    item=>{item.record.result.bestmove=item.best;},item=>{item.record.result.score.value++;},
    item=>{item.record.result.lines[0].depth--;},item=>{item.record.result.lines[1].multipv=1;},
    item=>{item.record.result.lines[1].pv=[item.played];},item=>{item.record.result.lines[0].pv.push('a1h8');},
    item=>{item.record.result.lines[1].pv.push('a1h8');},item=>{item.record.result.lines[0].pv[1]='Qa5+';},
    item=>{item.after.moveReview.pv.push('a1h8');},
  ];
  for(const change of changes) {
    const item=fixture(),{after}=await reviewed(item);item.after=after;item.record=after.moveReview.rankingReview;
    assert.equal(classifyMove(item.before,after,item.move).key,'best');
    change(item);
    assert.equal(hasRankingReview(item.before,after,item.move),false);
    assert.equal(classifyMove(item.before,after,item.move).key,'excellent');
  }
});

test('mutating confirmation evidence invalidates an already cached best decision',async()=>{
  const item=fixture(),{after}=await reviewed(item);
  assert.equal(classifyMove(item.before,after,item.move).key,'best');
  after.moveReview.rankingReview.result.lines[1].pv.push('a1h8');
  assert.equal(classifyMove(item.before,after,item.move).key,'excellent');
});

test('a changed root or primary review invalidates confirmation binding without altering their raw scores',async()=>{
  for(const change of [
    item=>{item.before.score.value++;item.before.lines[0].score.value++;item.after.moveReview.beforeScore.value++;},
    item=>{item.before.configKey='changed';item.after.moveReview.configKey='changed';},
    item=>{item.after.moveReview.score.value++;},
  ]) {
    const item=fixture(),{after}=await reviewed(item);item.after=after;change(item);
    assert.equal(hasMoveReview(item.before,after,item.move),true);assert.equal(hasRankingReview(item.before,after,item.move),false);
    assert.equal(classifyMove(item.before,after,item.move).key,'excellent');
  }
});

test('a confirmed ordinary best does not borrow the old search runner-up gap to invent a great award',async()=>{
  const item=fixture();item.before.lines[1].score=cp(-200);
  const {after}=await reviewed(item);
  assert.equal(classifyMove(item.before,after,item.move).key,'best');
});

test('unchanged confirmation cache hits do not replay the stored PVs',async()=>{
  const item=fixture(),{after}=await reviewed(item),grade=classifyMove(item.before,after,item.move),original=Chess.prototype.move;
  let calls=0;Chess.prototype.move=function(...args){calls++;return original.apply(this,args);};
  try {
    for(let index=0;index<100;index++)assert.equal(classifyMove(item.before,after,item.move),grade);
    assert.equal(calls,0);
  } finally {Chess.prototype.move=original;}
});

test('equal root FENs with different real repetition histories cannot reuse confirmation or extend a repeated endpoint',async()=>{
  const first=fixture({history:true}),second=fixture({history:['Kf2','Qc8','Ke1','Qa8']});
  assert.equal(first.chess.fen(),second.chess.fen());
  assert.notEqual(positionCommand(first.chess),positionCommand(second.chess));
  const actualPv=['a1b1','a8b8','e1e2','b8a8','b1a1','a8b8','e2f2','b8a8','f2e2','a8b8'];
  const prefix=position=>{const chess=new Chess(position.history({verbose:true})[0].before);for(const move of position.history({verbose:true}))chess.move(uciMove(move));return chess;};
  const firstBranch=prefix(first.chess),secondBranch=prefix(second.chess);
  for(const uci of actualPv.slice(0,9)){firstBranch.move(uci);secondBranch.move(uci);}
  assert.equal(firstBranch.isThreefoldRepetition(),true);assert.equal(secondBranch.isThreefoldRepetition(),false);
  const secondSnapshot=snapshot(second),{after:secondAfter}=await reviewed(second,{actualPv});
  assert.equal(snapshot(second),secondSnapshot);assert.equal(classifyMove(second.before,secondAfter,second.move).key,'best');
  assert.equal(hasRankingReview(second.before,secondAfter,second.move,second.chess),true);
  const transplanted={...first.after,moveReview:{...first.after.moveReview,rankingReview:structuredClone(secondAfter.moveReview.rankingReview)}};
  assert.equal(hasRankingReview(first.before,transplanted,first.move,first.chess),false);
  assert.equal(needsRankingReview(first.before,transplanted,first.move,first.chess),true);
  const firstSnapshot=snapshot(first),calls=[];
  const repaired=await reviewMove({async reset(){},async analyze(chess){calls.push(positionCommand(chess));return confirmation(first,{actualPv});}},
    first.chess,first.before,transplanted,first.move,first.options);
  assert.deepEqual(calls,[positionCommand(first.chess)]);assert.equal(snapshot(first),firstSnapshot);
  assert.equal(repaired.moveReview.rankingReview.status,'unverified');
  assert.equal(classifyMove(first.before,repaired,first.move).key,'excellent');
  assert.equal(classifyMove(second.before,secondAfter,second.move).key,'best','the independent valid history retains its evidence');
});

function depthFixture(settings={}) {
  const item=fixture(settings);
  item.before.searchMode='depth';item.after.searchMode='depth';
  item.options={...item.options,searchMode:'depth'};
  return item;
}

async function reviewedDepth(item,changes={}) {
  const value={...confirmation(item,changes),searchMode:'depth'},calls=[];
  const engine={async reset(){calls.push({type:'reset'});},async analyze(chess,settings){
    calls.push({type:'analyze',history:positionCommand(chess),settings:structuredClone(settings)});
    return structuredClone(value);
  }};
  return {after:await reviewMove(engine,item.chess,item.before,item.after,item.move,item.options),calls,value};
}

test('fixed-depth ranking completes the root depth without a time budget and binds immutable depth evidence',async()=>{
  for(const black of [false,true]) {
    const item=depthFixture({black,history:!black}),original=snapshot(item),{after,calls,value}=await reviewedDepth(item);
    const record=after.moveReview.rankingReview;
    assert.equal(snapshot(item),original);
    assert.deepEqual(calls.map(call=>call.type),['reset','analyze']);
    assert.deepEqual(calls[1].settings,{depth:item.before.depth,multipv:2,searchMode:'depth'});
    assert.equal(calls[1].history,positionCommand(item.chess));
    assert.equal(record.movetime,null);assert.equal(record.searchMode,'depth');assert.equal(record.status,'complete');
    assert.equal(record.requestedDepth,item.before.depth);assert.equal(record.result.searchMode,'depth');
    assert.deepEqual(record.result,value);assert.equal(hasRankingReview(item.before,after,item.move,item.chess),true);
    assert.equal(classifyMove(item.before,after,item.move).key,'best');
    assert.equal(after.score,item.after.score);assert.equal(after.lines,item.after.lines);
    assert.equal(after.moveReview.score,item.after.moveReview.score);assert.equal(after.moveReview.pv,item.after.moveReview.pv);
    value.lines[0].pv.push('a9a8');
    assert.equal(hasRankingReview(item.before,after,item.move,item.chess),true,'stored evidence is detached from a mutable worker response');
  }
});

test('fixed-depth ranking propagates failures and rejects incomplete, foreign-policy, illegal or inconsistent results',async()=>{
  const cases=[
    value=>{throw new Error('confidence worker unavailable');},
    value=>{value.depth--;for(const line of value.lines)line.depth--;},
    value=>{value.multipvComplete=false;},
    value=>{delete value.searchMode;},
    value=>{value.searchMode='time';},
    value=>{value.lines[0].pv.push('a9a8');},
    value=>{value.lines[0].score.value++;},
    value=>{value.bestmove='h1h8';},
  ];
  for(const mutate of cases) {
    const item=depthFixture(),original=snapshot(item),value={...confirmation(item),searchMode:'depth'};
    const engine={async reset(){},async analyze(chess,settings){
      assert.equal(settings.searchMode,'depth');assert.equal('movetime' in settings,false);
      mutate(value);return value;
    }};
    await assert.rejects(reviewMove(engine,item.chess,item.before,item.after,item.move,item.options));
    assert.equal(snapshot(item),original,'a failed optional search cannot mutate or attach a reusable attempted proof');
    assert.equal(item.after.moveReview.rankingReview,undefined);
    assert.equal(needsRankingReview(item.before,item.after,item.move,item.chess),true);
  }
});

test('fixed-depth ranking metadata cannot reuse timed or incomplete proof bindings',async()=>{
  const mutations=[
    record=>{record.movetime=1200;},record=>{record.movetime=0;},record=>{delete record.movetime;},
    record=>{delete record.searchMode;},record=>{delete record.result.searchMode;},
    record=>{record.status='unverified';record.result=null;},
    record=>{record.status='depth-limited';record.result.depth--;for(const line of record.result.lines)line.depth--;},
  ];
  for(const mutate of mutations) {
    const item=depthFixture(),{after}=await reviewedDepth(item);
    assert.equal(hasRankingReview(item.before,after,item.move,item.chess),true);
    mutate(after.moveReview.rankingReview);
    assert.equal(hasRankingReview(item.before,after,item.move,item.chess),false);
    assert.equal(classifyMove(item.before,after,item.move).key,'excellent');
  }
  const item=depthFixture(),{after}=await reviewedDepth(item);
  delete item.before.searchMode;
  assert.equal(hasRankingReview(item.before,after,item.move,item.chess),false,'the proof is bound to the root search policy');
});
