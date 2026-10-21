import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGame, gameAt } from '../src/chess-core.js';
import { AnalysisLine, StudySceneStore } from '../src/study.js';

const gameFixture=()=>parseGame('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *');
const branch=game=>new AnalysisLine(gameAt(game,2),['g1f3','b8c6','f1c4']);

test('a saved study scene retains its exact line, cursor, future, results and explanation context',()=>{
  const game=gameFixture(),line=branch(game),store=new StudySceneStore();
  line.seek(1);
  const result={score:{type:'cp',value:42},moveReview:{verified:true}};
  line.results.set(1,result);
  const steps=line.steps,results=line.results,base=line.base,prefix=line.prefixMoves;
  const fen=line.position().fen(),insightContext={game,index:2},coachExpanded={game,index:2};
  assert.equal(store.save(game,line,{insightContext,coachExpanded}),true);
  const restored=store.take(game);
  assert.equal(restored.game,game);assert.equal(restored.line,line);
  assert.equal(restored.insightContext,insightContext);assert.equal(restored.coachExpanded,coachExpanded);
  assert.equal(line.cursor,1);assert.equal(line.position().fen(),fen);
  assert.equal(line.steps,steps);assert.equal(line.steps.length,3);
  assert.equal(line.results,results);assert.equal(line.results.get(1),result);
  assert.equal(line.base,base);assert.equal(line.prefixMoves,prefix);
  assert.equal(store.peek(game),null);
});

test('original selection changes across repeated tab visits cannot seek or truncate the saved study scene',()=>{
  const game=gameFixture(),line=branch(game),store=new StudySceneStore();
  line.seek(2);
  const fen=line.position().fen(),steps=line.steps;
  let originalIndex=2;
  for (const nextIndex of [6,0,5]) {
    store.save(game,line);
    originalIndex=nextIndex;
    const original=gameAt(game,originalIndex);
    assert.equal(original.fen(),game.positions[originalIndex]);
    assert.notEqual(original.fen(),fen);
    const restored=store.take(game);
    assert.equal(restored.line,line);assert.equal(restored.line.position().fen(),fen);
    assert.equal(restored.line.cursor,2);assert.equal(restored.line.steps,steps);
    assert.equal(originalIndex,nextIndex);
  }
});

test('a missing active line does not overwrite the previously saved study scene',()=>{
  const game=gameFixture(),line=branch(game),store=new StudySceneStore();
  const context={game,index:2};store.save(game,line,{insightContext:context});
  const scene=store.peek(game);
  assert.equal(store.save(game,null),false);assert.equal(store.save(game,undefined),false);
  assert.equal(store.peek(game),scene);assert.equal(store.peek(game).insightContext,context);
});

test('game identity protects a scene even when another game has identical PGN',()=>{
  const game=gameFixture(),other=gameFixture(),line=branch(game),store=new StudySceneStore();
  store.save(game,line);
  assert.equal(store.peek(other),null);assert.equal(store.peek(game).line,line);
  assert.equal(store.take(other),null);
  assert.equal(store.peek(game),null,'a mismatched restoration discards the stale owner');
  assert.equal(store.take(game),null);
});

test('discard and replacing a saved scene release the previous game and branch',()=>{
  const first=gameFixture(),second=gameFixture(),store=new StudySceneStore();
  store.save(first,branch(first));
  const next=branch(second);store.save(second,next);
  assert.equal(store.peek(first),null);assert.equal(store.take(second).line,next);
  store.save(second,next);store.discard();
  assert.equal(store.peek(second),null);assert.equal(store.invalidate(),false);
});

test('settings invalidation clears saved grade proof while preserving manual history and visible position',()=>{
  const game=gameFixture(),line=branch(game),store=new StudySceneStore();
  line.kind='manual';line.seek(2);
  line.results.set(0,{score:{type:'cp',value:10}});
  line.results.set(2,{score:{type:'cp',value:20},moveReview:{verified:true}});
  const steps=line.steps,results=line.results,base=line.base,prefix=line.prefixMoves,fen=line.position().fen();
  store.save(game,line,{insightContext:{game},coachExpanded:{game}});
  assert.equal(store.invalidate(),true);
  const scene=store.take(game);
  assert.equal(scene.line,line);assert.equal(line.results,results);assert.equal(results.size,0);
  assert.equal(line.steps,steps);assert.equal(line.base,base);assert.equal(line.prefixMoves,prefix);
  assert.equal(line.cursor,2);assert.equal(line.position().fen(),fen);assert.equal(line.kind,'manual');
  assert.equal(scene.insightContext,null);assert.equal(scene.coachExpanded,null);
});

test('invalidating frozen explanation or PV scenes detaches stale proof without losing explored moves',()=>{
  for (const frozen of [true,false]) {
    const game=gameFixture(),line=branch(game),store=new StudySceneStore();
    line.kind=frozen?'manual':'pv';line.explanationSnapshot=frozen;line.seek(1);
    Object.assign(line,{title:'saved explanation',reviewKind:'alternative',reviewScope:'full',reviewIndex:3,
      fullLength:18,sourceDepth:18,sourceScore:{type:'cp',value:100},startLabel:'old source',focusNote:'old focus',
      refinementStatus:'complete',pendingRefinement:{replacement:{}},explanationRequest:{context:{}},
      conditional:true,bestResponse:false});
    line.results.set(1,{moveReview:{verified:true}});
    const steps=line.steps,prefix=line.prefixMoves,fen=line.position().fen();
    store.save(game,line,{insightContext:{game},coachExpanded:{game}});store.invalidate();
    const scene=store.take(game);
    assert.equal(scene.line,line);assert.equal(line.kind,'manual');assert.equal(line.results.size,0);
    assert.equal(line.steps,steps);assert.equal(line.prefixMoves,prefix);assert.equal(line.cursor,1);
    assert.equal(line.position().fen(),fen);assert.equal(scene.insightContext,null);assert.equal(scene.coachExpanded,null);
    for (const key of ['explanationSnapshot','title','reviewKind','reviewScope','reviewIndex','fullLength','sourceDepth','sourceScore','startLabel','focusNote','refinementStatus','pendingRefinement','explanationRequest','conditional','bestResponse']) {
      assert.equal(Object.hasOwn(line,key),false,`${key} cannot survive a settings change`);
    }
  }
});
