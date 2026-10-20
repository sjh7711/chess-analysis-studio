import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, positionCommand } from '../src/chess-core.js';
import { AnalysisLine, PlaybackClock } from '../src/study.js';
import { mergeExplanationLine } from '../src/explanation-playback.js';

const cp=value=>({type:'cp',value});
const serialized=value=>JSON.stringify(value,(_,item)=>typeof item==='bigint'?String(item):item instanceof Map?{entries:[...item]}:item);
const evaluation=value=>({score:cp(value),depth:16,bestmove:'g1f3',lines:[{multipv:1,depth:16,score:cp(value),pv:['g1f3','b8c6']}]});
function base() {const chess=new Chess();chess.move('a3');chess.move('a6');return chess;}
function line(moves=['e2e4','e7e5','g1f3','b8c6','f1c4','g8f6'],chess=base()) {
  const value=new AnalysisLine(chess,moves,evaluation(20));
  Object.assign(value,{kind:'pv',reviewIndex:12,reviewKind:'response',reviewScope:'core',
    sourceScore:cp(20),sourceDepth:16,fullLength:moves.length,focusNote:'기존 설명',title:'기존 응수',startLabel:'실전 수 이후'});
  return value;
}
function pair() {
  const current=line(),replacement=line(['e2e4','e7e5','g1f3','d7d6','d2d4','e5d4']);
  Object.assign(current,{explanationSnapshot:true});
  Object.assign(replacement,{sourceScore:cp(70),sourceDepth:18,fullLength:18,focusNote:'새 교환 설명',title:'심층 응수'});
  replacement.results.set(0,evaluation(70));
  return {current,replacement};
}
function snapshot(value) {
  return {json:serialized(value),fen:value.position().fen(),history:positionCommand(value.position()),
    base:value.base,prefix:value.prefixMoves,steps:value.steps,results:value.results,entries:[...value.results],cursor:value.cursor};
}
function assertUnchanged(value,original) {
  assert.equal(serialized(value),original.json);assert.equal(value.position().fen(),original.fen);
  assert.equal(positionCommand(value.position()),original.history);assert.equal(value.cursor,original.cursor);
  for(const key of ['base','steps','results'])assert.equal(value[key],original[key]);
  assert.equal(value.prefixMoves,original.prefix);assert.deepEqual([...value.results],original.entries);
}

test('automatic adoption changes only the unvisited suffix and preserves the displayed board and objects',()=>{
  const {current,replacement}=pair();current.seek(2);
  const primary=evaluation(11),past=evaluation(12),shown=evaluation(13),stale=evaluation(14);
  current.results.set(0,primary);current.results.set(1,past);current.results.set(2,shown);current.results.set(4,stale);
  replacement.results.set(2,evaluation(999));replacement.results.set(3,evaluation(888));
  const original=snapshot(current),cache=serialized(replacement),primarySnapshot=JSON.stringify(primary),shownSteps=current.steps.slice(0,2);
  assert.equal(mergeExplanationLine(current,replacement),true);
  assert.equal(current.position().fen(),original.fen);assert.equal(positionCommand(current.position()),original.history);
  assert.equal(current.cursor,2);assert.equal(current.base,original.base);assert.equal(current.prefixMoves,original.prefix);
  assert.equal(current.steps,original.steps);assert.equal(current.results,original.results);
  for(let index=0;index<2;index++)assert.equal(current.steps[index],shownSteps[index]);
  assert.deepEqual(current.steps.map(step=>step.uci),replacement.steps.map(step=>step.uci));
  assert.equal(current.results.get(1),past);assert.equal(current.results.get(2),shown);
  assert.deepEqual([...current.results.keys()],[0,1,2]);
  assert.equal(current.results.get(0).score.value,70);assert.notEqual(current.results.get(0),replacement.results.get(0));
  assert.equal(current.sourceDepth,18);assert.equal(current.sourceScore.value,70);
  assert.equal(current.fullLength,18);assert.equal(current.focusNote,'새 교환 설명');assert.equal(current.title,'심층 응수');
  assert.equal(current.explanationSnapshot,true);
  current.steps[2].explanation='개인 메모';current.results.get(0).score.value=123;current.sourceScore.value=456;
  assert.equal(serialized(replacement),cache);assert.equal(JSON.stringify(primary),primarySnapshot);
});

test('already displayed explanations and the current missing score are not replaced by new commentary or evaluations',()=>{
  const {current,replacement}=pair();current.seek(3);
  current.steps[0].explanation='이미 읽은 첫 문장';current.steps[2].explanation='현재 문장';
  replacement.steps[0].explanation='다르게 쓴 첫 문장';replacement.steps[2].explanation='새 현재 문장';
  replacement.results.set(3,evaluation(400));
  assert.equal(current.results.has(3),false);
  assert.equal(mergeExplanationLine(current,replacement),true);
  assert.equal(current.steps[0].explanation,'이미 읽은 첫 문장');assert.equal(current.steps[2].explanation,'현재 문장');
  assert.equal(current.results.has(3),false,'do not introduce a score at the currently displayed position');
});

test('at the root a different future can be adopted without moving pieces and the deeper root result is refreshed',()=>{
  const current=line(),replacement=line(['d2d4','d7d5']);
  replacement.results.set(0,evaluation(80));replacement.sourceDepth=20;
  const fen=current.position().fen(),prefix=current.prefixMoves;
  assert.equal(mergeExplanationLine(current,replacement),true);
  assert.equal(current.cursor,0);assert.equal(current.position().fen(),fen);assert.equal(current.prefixMoves,prefix);
  assert.deepEqual(current.steps.map(step=>step.uci),['d2d4','d7d5']);
  assert.equal(current.results.get(0).score.value,80);assert.equal(current.sourceDepth,20);
});

test('divergence anywhere through the displayed move rejects the whole update atomically',()=>{
  for(const cursor of [1,2,3]) {
    const current=line(),replacement=line(cursor===3?['e2e4','e7e5','f1c4']:['d2d4','d7d5','c1f4']);
    current.seek(cursor);current.results.set(cursor,evaluation(50));
    const original=snapshot(current);
    assert.equal(mergeExplanationLine(current,replacement),false);assertUnchanged(current,original);
  }
});

test('a replacement shorter than the cursor is rejected, but an equal-length visited prefix may safely end there',()=>{
  const current=line(),tooShort=line(['e2e4']);current.seek(2);current.results.set(4,evaluation(80));
  const original=snapshot(current);
  assert.equal(mergeExplanationLine(current,tooShort),false);assertUnchanged(current,original);
  const ending=line(['e2e4','e7e5']);
  assert.equal(mergeExplanationLine(current,ending),true);
  assert.equal(current.cursor,2);assert.equal(current.steps.length,2);assert.equal(current.position().fen(),original.fen);
  assert.equal(current.results.has(4),false);
});

test('the same FEN reached with a different repetition history or prefix cannot be merged',()=>{
  const history=new Chess();for(const san of ['Nf3','Nf6','Ng1','Ng8'])history.move(san);
  const current=line(['e2e4','e7e5'],history),replacement=line(['e2e4','e7e5'],new Chess(history.fen()));
  assert.equal(current.base.fen(),replacement.base.fen());
  const original=snapshot(current);
  assert.equal(mergeExplanationLine(current,replacement),false);assertUnchanged(current,original);
  const forged=line(['e2e4','e7e5'],history);forged.prefixMoves=[];
  assert.equal(mergeExplanationLine(current,forged),false);assertUnchanged(current,original);
});

test('different review identity, side of the reviewed move, scope or base FEN cannot transplant a future',()=>{
  for(const change of [value=>value.reviewIndex++,value=>value.reviewKind='alternative',value=>value.reviewScope='full',
    value=>value.kind='manual',value=>{const fen=value.base.fen().split(' ');fen[5]='9';value.base=new Chess(fen.join(' '));}]) {
    const {current,replacement}=pair();current.seek(1);change(replacement);const original=snapshot(current);
    assert.equal(mergeExplanationLine(current,replacement),false);assertUnchanged(current,original);
  }
});

test('a malformed replacement future or uncloneable source is rejected before any current state changes',()=>{
  for(const change of [value=>value.steps[4].uci='e1e8',value=>value.steps[4].after=value.steps[4].before,
    value=>value.sourceScore={type:'cp',value:30,unexpected(){}}]) {
    const {current,replacement}=pair();current.seek(2);change(replacement);const original=snapshot(current);
    assert.equal(mergeExplanationLine(current,replacement),false);assertUnchanged(current,original);
  }
});

test('conditional metadata is copied independently and obsolete source flags are removed',()=>{
  const {current,replacement}=pair();current.reviewKind=replacement.reviewKind='sacrifice';
  current.seek(1);replacement.conditional=true;replacement.bestResponse=false;
  assert.equal(mergeExplanationLine(current,replacement),true);
  assert.equal(current.conditional,true);assert.equal(current.bestResponse,false);
  const ordinary=line();current.reviewKind='response';ordinary.reviewKind='response';
  assert.equal(mergeExplanationLine(current,ordinary),true);
  assert.equal(Object.hasOwn(current,'conditional'),false);assert.equal(Object.hasOwn(current,'bestResponse'),false);
});

test('adoption never restarts, cancels or advances the playback controller or its reading interval',()=>{
  const {current,replacement}=pair();current.seek(2);const calls=[];
  const clock=new PlaybackClock(()=>calls.push('advance'),{setTimer:(fn,delay)=>({fn,delay}),clearTimer:timer=>calls.push(['clear',timer])});
  clock.ready(2500);current.playing=true;current.playback=clock;
  const original={timer:clock.timer,phase:clock.phase,revision:clock.revision,calls:[...calls]};
  assert.equal(mergeExplanationLine(current,replacement),true);
  assert.equal(current.playing,true);assert.equal(current.playback,clock);
  assert.equal(clock.timer,original.timer);assert.equal(clock.phase,original.phase);assert.equal(clock.revision,original.revision);
  assert.deepEqual(calls,original.calls);
});
