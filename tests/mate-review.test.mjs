import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess,uciMove,hasMoveReview,needsMateReview,hasMateReview,validatedMateReview,assessedMoveResult,classifyMove} from '../src/chess-core.js';
import {reviewMove} from '../src/review.js';

// Synthetic king-and-rook position, with a short mating route and a legal
// longer route. These fixtures do not contain account games or engine dumps.
function fixture({color='w',history=false,depth=4}={}) {
  const white=color==='w',chess=new Chess(white?'7k/8/R4K2/8/8/8/8/8 w - - 0 1':'8/8/8/8/8/r4k2/8/7K b - - 0 1');
  if(history){assert.equal(white,true);chess.load('6k1/8/R7/5K2/8/8/8/8 w - - 0 1');chess.move('f5f6');chess.move('g8h8');}
  const first=white?['f6g6','h8g8','a6a8']:['f3g3','h1g1','a3a1'],actual=white?'f6e6':'f3e3',child=white?['h8g7','e6f5','g7h7','a6a7','h7g8','f5g6','g8h8','a7a8']:['h1g2','e3f4','g2h2','a3a2','h2g1','f4g3','g1h1','a2a1'],sign=white?1:-1;
  const copy=new Chess(chess.fen()),move=copy.move(actual),score={type:'mate',value:sign*2,winner:color},childScore={type:'mate',value:sign*4,winner:color},configKey='synthetic-mate-v1';
  const before={score,depth,bestmove:first[0],engineBestmove:first[0],multipvComplete:true,configKey,lines:[{score:{...score},depth,multipv:1,pv:first}]};
  const after={score:childScore,depth,bestmove:child[0],engineBestmove:child[0],multipvComplete:true,configKey,lines:[{score:{...childScore},depth,multipv:1,pv:child}],
    moveReview:{version:1,fen:move.before,uci:actual,configKey,beforeScore:{...score},beforeDepth:depth,beforeBestmove:first[0],score:{type:'cp',value:sign*500},depth,pv:[actual,...child.slice(0,3)],source:'search',
      sacrificeReview:{version:1,fen:move.after,rootFen:move.before,uci:actual,configKey,requestedDepth:Math.min(16,Math.max(1,depth-1)),restrictedMoves:[],branches:[],status:'not-eligible'}}};
  const proofScore={type:'mate',value:sign*5,winner:color},proofDepth=Math.min(22,depth+4),proof={score:proofScore,depth:proofDepth,bestmove:actual,engineBestmove:actual,multipvComplete:true,lines:[{score:{...proofScore},depth:proofDepth,multipv:1,pv:[actual,...child]}]};
  assert.equal(hasMoveReview(before,after,move),true);return {chess,move,before,after,proof};
}
function engineFor(result){const calls=[];return {calls,reset:async()=>{calls.push({kind:'reset'});},analyze:async(chess,options)=>{calls.push({kind:'analyze',fen:chess.fen(),history:chess.history(),options:structuredClone(options)});if(result instanceof Error)throw result;return structuredClone(result);}};}
const stripProof=after=>{const copy=structuredClone(after);delete copy.moveReview.mateReview;return copy;};

test('deeper played-only proof uses reset, bounded budget and immutable primary results',async()=>{
  const f=fixture(),engine=engineFor(f.proof),snapshot=JSON.stringify({before:f.before,after:f.after,move:f.move,proof:f.proof}),position=f.chess.fen();assert.equal(needsMateReview(f.before,f.after,f.move,f.chess),true);
  const after=await reviewMove(engine,f.chess,f.before,f.after,f.move,{depth:15,movetime:4000,multipv:5,searchMoves:['a1a2'],hash:64});
  assert.deepEqual(engine.calls.map(call=>call.kind),['reset','analyze']);assert.deepEqual(engine.calls[1].options,{depth:8,movetime:1200,multipv:1,searchMoves:[uciMove(f.move)],hash:64});assert.equal(engine.calls[1].fen,f.move.before);
  assert.equal(hasMateReview(f.before,after,f.move,f.chess),true);assert.equal(after.moveReview.mateReview.status,'complete');assert.deepEqual(validatedMateReview(f.before,after,f.move,f.chess),f.proof);
  assert.deepEqual(stripProof(after),f.after);assert.equal(f.chess.fen(),position);assert.equal(JSON.stringify({before:f.before,after:f.after,move:f.move,proof:f.proof}),snapshot);
  const assessed=assessedMoveResult(f.before,after,f.move);assert.equal(assessed.score.type,'mate');assert.equal(assessed.score.value,4);assert.deepEqual(assessed.lines[0].pv,f.proof.lines[0].pv.slice(1));assert.equal(f.before.bestmove,'f6g6');
  assert.equal(['best','great','brilliant'].includes(classifyMove(f.before,after,f.move,{moves:[f.move],moveIndex:0}).key),false,'A longer proved mate must not be promoted to global best or a special award.');
});

test('black winning mate is validated with the correct score sign and distance',async()=>{
  const f=fixture({color:'b'}),after=await reviewMove(engineFor(f.proof),f.chess,f.before,f.after,f.move,{movetime:300});assert.equal(after.moveReview.mateReview.movetime,300);
  assert.equal(validatedMateReview(f.before,after,f.move,f.chess).score.value,-5);assert.equal(assessedMoveResult(f.before,after,f.move).score.value,-4);
});

test('CP continuation is cached but never becomes a mate evaluation',async()=>{
  const f=fixture(),cp=structuredClone(f.proof);cp.score={type:'cp',value:600};cp.lines[0].score={...cp.score};cp.lines[0].pv=f.after.moveReview.pv;
  const engine=engineFor(cp),after=await reviewMove(engine,f.chess,f.before,f.after,f.move,{movetime:1200});assert.equal(hasMateReview(f.before,after,f.move,f.chess),true);assert.equal(validatedMateReview(f.before,after,f.move,f.chess),null);assert.equal(needsMateReview(f.before,after,f.move,f.chess),false);
  assert.deepEqual(assessedMoveResult(f.before,after,f.move).score,{type:'cp',value:500});const reused=await reviewMove(engine,f.chess,f.before,after,f.move,{movetime:1200});assert.deepEqual(reused,after);assert.equal(engine.calls.length,2);
});

test('an incomplete depth gain is cached and leaves primary evaluation unchanged',async()=>{
  const f=fixture(),shallow=structuredClone(f.proof);shallow.depth=5;shallow.lines[0].depth=5;const engine=engineFor(shallow),after=await reviewMove(engine,f.chess,f.before,f.after,f.move,{movetime:1200});
  assert.equal(after.moveReview.mateReview.status,'depth-limited');assert.equal(hasMateReview(f.before,after,f.move,f.chess),true);assert.equal(validatedMateReview(f.before,after,f.move,f.chess),null);assert.deepEqual(stripProof(after),f.after);
  await reviewMove(engine,f.chess,f.before,after,f.move,{movetime:1200});assert.equal(engine.calls.length,2);
});

test('a complete iteration at the minimum two-depth gain is sufficient proof',async()=>{
  const f=fixture(),minimum=structuredClone(f.proof);minimum.depth=6;minimum.lines[0].depth=6;const after=await reviewMove(engineFor(minimum),f.chess,f.before,f.after,f.move);
  assert.equal(after.moveReview.mateReview.requestedDepth,8);assert.equal(after.moveReview.mateReview.minimumDepth,6);assert.equal(after.moveReview.mateReview.status,'complete');assert.equal(validatedMateReview(f.before,after,f.move,f.chess).depth,6);
});

for(const kind of ['illegal-pv','wrong-distance','incomplete-iteration'])test(kind+' cannot be consumed and is cached as a failed attempt',async()=>{
  const f=fixture(),invalid=structuredClone(f.proof);if(kind==='illegal-pv')invalid.lines[0].pv[2]='a9a8';if(kind==='wrong-distance'){invalid.score.value=6;invalid.lines[0].score.value=6;}if(kind==='incomplete-iteration')invalid.multipvComplete=false;
  const engine=engineFor(invalid),after=await reviewMove(engine,f.chess,f.before,f.after,f.move);assert.equal(after.moveReview.mateReview.status,'unverified');assert.equal(after.moveReview.mateReview.result,null);assert.equal(hasMateReview(f.before,after,f.move,f.chess),true);assert.equal(validatedMateReview(f.before,after,f.move,f.chess),null);assert.deepEqual(stripProof(after),f.after);
  await reviewMove(engine,f.chess,f.before,after,f.move);assert.equal(engine.calls.length,2);
});

test('optional search errors cache a bound failure while cancellation propagates',async()=>{
  const f=fixture(),failed=await reviewMove(engineFor(new Error('unavailable')),f.chess,f.before,f.after,f.move);assert.equal(failed.moveReview.mateReview.status,'unverified');assert.equal(hasMateReview(f.before,failed,f.move,f.chess),true);
  const abort=new Error('cancelled');abort.name='AbortError';await assert.rejects(reviewMove(engineFor(abort),f.chess,f.before,f.after,f.move),error=>error===abort);assert.equal(f.after.moveReview.mateReview,undefined);
  const engine=engineFor(f.proof);engine.reset=async()=>{throw abort;};await assert.rejects(reviewMove(engine,f.chess,f.before,f.after,f.move),error=>error===abort);assert.equal(engine.calls.length,0);
});

test('full root history is forwarded and retained in the proof binding',async()=>{
  const f=fixture({history:true}),engine=engineFor(f.proof),history=f.chess.history(),fen=f.chess.fen(),after=await reviewMove(engine,f.chess,f.before,f.after,f.move);
  assert.deepEqual(engine.calls[1].history,history);assert.deepEqual(after.moveReview.mateReview.historyMoves,['f5f6','g8h8']);assert.equal(hasMateReview(f.before,after,f.move,f.chess),true);assert.deepEqual(f.chess.history(),history);assert.equal(f.chess.fen(),fen);
  assert.equal(hasMateReview(f.before,after,f.move,new Chess(fen)),false);
});

test('a primary PV change invalidates cached evidence and requests fresh proof',async()=>{
  const f=fixture(),engine=engineFor(f.proof),first=await reviewMove(engine,f.chess,f.before,f.after,f.move),changed=structuredClone(first);changed.moveReview.pv=changed.moveReview.pv.slice(0,2);
  assert.equal(hasMateReview(f.before,changed,f.move,f.chess),false);assert.equal(needsMateReview(f.before,changed,f.move,f.chess),true);await reviewMove(engine,f.chess,f.before,changed,f.move);assert.equal(engine.calls.filter(call=>call.kind==='analyze').length,2);
});

test('depth cap skips searches that cannot meet the required two-depth gain',async()=>{
  const f=fixture({depth:21}),engine=engineFor(f.proof);assert.equal(needsMateReview(f.before,f.after,f.move,f.chess),false);const after=await reviewMove(engine,f.chess,f.before,f.after,f.move);assert.equal(engine.calls.length,0);assert.deepEqual(after,f.after);
});

function depthFixture(settings={}) {
  const value=fixture(settings);
  value.before.searchMode='depth';value.after.searchMode='depth';value.proof.searchMode='depth';
  return value;
}

test('fixed-depth mate confidence completes its target and binds a null time limit without altering primary inputs',async()=>{
  for(const color of ['w','b']) {
    const f=depthFixture({color,history:color==='w'}),engine=engineFor(f.proof);
    const original=JSON.stringify({before:f.before,after:f.after,proof:f.proof,move:f.move,history:f.chess.history()});
    const after=await reviewMove(engine,f.chess,f.before,f.after,f.move,{searchMode:'depth',depth:16,movetime:1,multipv:5,hash:64});
    assert.deepEqual(engine.calls.map(call=>call.kind),['reset','analyze']);
    assert.deepEqual(engine.calls[1].options,{searchMode:'depth',depth:8,multipv:1,hash:64,searchMoves:[uciMove(f.move)]});
    assert.equal(engine.calls[1].fen,f.move.before);assert.deepEqual(engine.calls[1].history,f.chess.history());
    const record=after.moveReview.mateReview;
    assert.equal(record.searchMode,'depth');assert.equal(record.movetime,null);assert.equal(record.status,'complete');
    assert.equal(record.result.searchMode,'depth');assert.equal(record.result.depth,record.requestedDepth);
    assert.equal(hasMateReview(f.before,after,f.move,f.chess),true);
    assert.deepEqual(validatedMateReview(f.before,after,f.move,f.chess),f.proof);
    assert.deepEqual(stripProof(after),f.after);
    assert.equal(JSON.stringify({before:f.before,after:f.after,proof:f.proof,move:f.move,history:f.chess.history()}),original);
  }
});

test('fixed-depth mate confidence cannot cache a failure, partial depth, foreign mode or invalid mating evidence',async()=>{
  const cases=[
    proof=>{throw new Error('confidence worker unavailable');},
    proof=>{proof.depth-=2;proof.lines[0].depth=proof.depth;},
    proof=>{proof.multipvComplete=false;},
    proof=>{delete proof.searchMode;},
    proof=>{proof.searchMode='time';},
    proof=>{proof.lines[0].pv[2]='a9a8';},
    proof=>{proof.score.value++;proof.lines[0].score.value++;},
    proof=>{proof.bestmove='a6a7';},
  ];
  for(const mutate of cases) {
    const f=depthFixture(),original=JSON.stringify({before:f.before,after:f.after,proof:f.proof,history:f.chess.history()});
    const engine={async reset(){},async analyze(chess,options){
      assert.equal(options.searchMode,'depth');assert.equal('movetime' in options,false);
      const proof=structuredClone(f.proof);mutate(proof);return proof;
    }};
    await assert.rejects(reviewMove(engine,f.chess,f.before,f.after,f.move,{searchMode:'depth'}));
    assert.equal(f.after.moveReview.mateReview,undefined);
    assert.equal(needsMateReview(f.before,f.after,f.move,f.chess),true);
    assert.equal(JSON.stringify({before:f.before,after:f.after,proof:f.proof,history:f.chess.history()}),original);
  }
});

test('fixed-depth mate proof bindings reject timed, incomplete and changed root policies even after a cache hit',async()=>{
  const mutations=[
    (record,f)=>{record.movetime=1200;},(record,f)=>{delete record.movetime;},
    (record,f)=>{delete record.searchMode;},(record,f)=>{delete record.result.searchMode;},
    (record,f)=>{record.status='unverified';record.result=null;},
    (record,f)=>{record.result.depth=record.minimumDepth;record.result.lines[0].depth=record.minimumDepth;},
    (record,f)=>{delete f.before.searchMode;},
  ];
  for(const mutate of mutations) {
    const f=depthFixture(),after=await reviewMove(engineFor(f.proof),f.chess,f.before,f.after,f.move,{searchMode:'depth'});
    assert.equal(hasMateReview(f.before,after,f.move,f.chess),true);
    assert.deepEqual(validatedMateReview(f.before,after,f.move,f.chess),f.proof);
    mutate(after.moveReview.mateReview,f);
    assert.equal(hasMateReview(f.before,after,f.move,f.chess),false);
    assert.equal(validatedMateReview(f.before,after,f.move,f.chess),null);
    assert.equal(needsMateReview(f.before,after,f.move,f.chess),true);
  }
});
