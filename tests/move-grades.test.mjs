import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, DEFAULT_POSITION, classifyMove, expectedPoints, MOVE_GRADES, uciMove } from '../src/chess-core.js';
const cp=(value,bestmove,lines=[])=>({score:{type:'cp',value},bestmove,lines});
const move={from:'e2',to:'e4',color:'w'};
const ranked=(value,best,other,otherValue,depth=16)=>({...cp(value,best),depth,multipvComplete:true,lines:[
  {multipv:1,depth,score:{type:'cp',value},pv:[best]},
  {multipv:2,depth,score:{type:'cp',value:otherValue},pv:[other]},
]});

function opportunity({color='w',original=0,offered=200,played=100,previousKey}={}) {
  const sign=color==='w'?1:-1;
  const chess=new Chess(DEFAULT_POSITION.replace(' w ',color==='w'?' b ':' w ').replace('0 1','0 30'));
  const previousMove=chess.move(color==='w'?'a6':'a3'),move=chess.move(color==='w'?'e4':'e5');
  const previous={...cp(original*sign,color==='w'?'e7e5':'e2e4'),depth:16,configKey:'grade-test'};
  const before={...cp(offered*sign,color==='w'?'d2d4':'d7d5'),depth:16,configKey:'grade-test',moveReview:{
    version:1,fen:previousMove.before,uci:uciMove(previousMove),configKey:previous.configKey,
    beforeScore:previous.score,beforeDepth:previous.depth,beforeBestmove:previous.bestmove,
    score:{type:'cp',value:offered*sign},depth:16,pv:[uciMove(previousMove)],
  }};
  const after=cp(played*sign),context={previous,previousMove,
    ...(previousKey?{previousGrade:{key:previousKey}}:{})};
  return {before,after,move,context};
}

test('ten move categories use expected-point loss with symmetric black evaluations',()=>{
  assert.equal(Object.keys(MOVE_GRADES).length,10);
  for(const [loss,key] of [[0,'best'],[10,'excellent'],[30,'good'],[75,'inaccuracy'],[150,'mistake'],[300,'blunder']]){
    assert.equal(classifyMove(cp(0,loss===0?'e2e4':undefined),cp(-loss),move).key,key);
    assert.equal(classifyMove(cp(0,loss===0?'e2e4':undefined),cp(loss),{...move,color:'b'}).key,key);
  }
  assert.equal(expectedPoints({type:'cp',value:0}),0.5);
  assert.equal(classifyMove(cp(800),cp(500),move).key,'inaccuracy');
});
test('great moves require a verified second candidate and a meaningful advantage over it',()=>{
  const before=ranked(70,'e2e4','d2d4',-100);
  assert.equal(classifyMove(before,cp(70),move).key,'great');
  assert.equal(classifyMove(cp(70,'e2e4'),cp(70),move).key,'best');
  assert.notEqual(classifyMove(before,cp(-200),move).key,'great');
});
test('a good accepted bishop sacrifice is distinguished from a bad or unverified sacrifice',()=>{
  const chess=new Chess('r2q1rk1/ppp2ppp/2n5/3p4/3P4/3B1N2/PPP2PPP/R2Q1RK1 w - - 0 15');
  const sacrifice=chess.move('Bxh7+');
  const pv=['Kxh7','Ng5+','Kg8','Qh5'].map(san=>uciMove(chess.move(san)));
  const before=cp(0,uciMove(sacrifice)),after=cp(0,undefined,[{pv}]);
  assert.equal(classifyMove(before,after,sacrifice).key,'brilliant');
  assert.notEqual(classifyMove(before,cp(-300,undefined,[{pv}]),sacrifice).key,'brilliant');
  assert.notEqual(classifyMove(before,cp(0,undefined,[{pv:pv.slice(0,1)}]),sacrifice).key,'brilliant');
});
test('misses include a verified opportunity even when some advantage remains',()=>{
  for (const color of ['w','b']) {
    const f=opportunity({color});
    assert.equal(classifyMove(f.before,f.after,f.move,f.context).key,'miss');
    assert.ok(expectedPoints(f.before.score,color)<.75);
    assert.ok(expectedPoints(f.after.score,color)>.55);
  }
});

test('a missed defensive recovery does not require a winning position',()=>{
  for (const color of ['w','b']) {
    const f=opportunity({color,original:-200,offered:0,played:-200});
    const grade=classifyMove(f.before,f.after,f.move,f.context);
    assert.equal(grade.key,'miss');
    assert.doesNotMatch(grade.reason,/승리/);
  }
});

test('only verified opponent errors or existing missed opportunities start a miss',()=>{
  const f=opportunity({original:0,offered:80,played:0,previousKey:'inaccuracy'});
  assert.equal(classifyMove(f.before,f.after,f.move,f.context).key,'inaccuracy');
  const continued={...f.context,previousGrade:{key:'miss'}};
  assert.equal(classifyMove(f.before,f.after,f.move,continued).key,'miss');
  assert.equal(classifyMove(f.before,f.after,f.move,f.context).key,'inaccuracy','context changes invalidate the cached grade');
  const slight=opportunity({offered:200,played:175});
  assert.equal(classifyMove(slight.before,slight.after,slight.move,slight.context).key,'good','small losses do not become misses');
});

test('unrelated history and unreviewed adjacent scores cannot invent a missed opportunity',()=>{
  const f=opportunity();
  assert.equal(classifyMove(f.before,f.after,f.move,{previous:f.context.previous}).key,'inaccuracy');
  const unrelated={...f.context,previousMove:{...f.context.previousMove,after:f.context.previousMove.before}};
  assert.equal(classifyMove(f.before,f.after,f.move,unrelated).key,'inaccuracy');
  const stale={...f.before,moveReview:{...f.before.moveReview,configKey:'old-settings'}};
  assert.equal(classifyMove(stale,f.after,f.move,f.context).key,'inaccuracy');
});

test('mate changes follow expected-point loss without an invented opportunity',()=>{
  assert.equal(classifyMove({score:{type:'mate',value:3,winner:'w'}},cp(900),move).key,'good');
  assert.equal(classifyMove(cp(-900),{score:{type:'mate',value:-1,winner:'b'}},move).key,'good');
  assert.equal(classifyMove(cp(0),{score:{type:'mate',value:-1,winner:'b'}},move).key,'blunder');
  assert.equal(classifyMove({score:{type:'mate',value:3,winner:'w'}},cp(0),move,{previous:cp(0)}).key,'blunder');
});

test('zero loss alone does not turn an unranked or tied move into the engine top choice',()=>{
  assert.equal(classifyMove(cp(0,'d2d4'),cp(0),move).key,'excellent');
  assert.equal(classifyMove(cp(0,'d2d4'),cp(30),move).key,'excellent');
  assert.equal(classifyMove(cp(0,'e2e4'),cp(0),move).key,'best');
});

test('an equal score in a completed root iteration establishes a co-best move',()=>{
  const before=ranked(25,'d2d4','e2e4',25);
  assert.equal(classifyMove(before,cp(25),move).key,'best');
  assert.equal(classifyMove({...before,multipvComplete:false},cp(25),move).key,'excellent');
  const stale={...before,lines:before.lines.map(line=>line.multipv===2?{...line,depth:15}:line)};
  assert.equal(classifyMove(stale,cp(25),move).key,'excellent');
});

test('near-equal scores and saturated winning chances do not establish co-best moves',()=>{
  assert.equal(classifyMove(ranked(25,'d2d4','e2e4',24),cp(24),move).key,'excellent');
  assert.equal(classifyMove(ranked(10000,'d2d4','e2e4',9999),cp(9999),move).key,'excellent');
  const mate={type:'mate',value:3,winner:'w'},slower={type:'mate',value:5,winner:'w'};
  const before={...ranked(0,'d2d4','e2e4',0),score:mate,lines:[
    {multipv:1,depth:16,score:mate,pv:['d2d4']},{multipv:2,depth:16,score:slower,pv:['e2e4']},
  ]};
  assert.equal(classifyMove(before,{score:slower},move).key,'excellent');
  const tied={...before,lines:before.lines.map(line=>({...line,score:mate}))};
  assert.equal(classifyMove(tied,{score:mate},move).key,'best');
});

test('direct recaptures stay best even when every alternative loses material',()=>{
  const chess=new Chess(DEFAULT_POSITION.replace('0 1','0 30'));
  chess.move('e4');chess.move('d5');
  const previousMove=chess.move('exd5'),recapture=chess.move('Qxd5');
  const before=ranked(0,uciMove(recapture),'g8f6',400);
  assert.equal(classifyMove(before,cp(0),recapture,{previousMove}).key,'best');
  assert.equal(classifyMove(before,cp(0),recapture).key,'great','capture history is necessary to recognize the recapture');
});

test('a forced only legal move is not a great find',()=>{
  const chess=new Chess('8/8/8/8/8/8/2k5/Kr6 w - - 0 30'),forced=chess.move('Ka2');
  const before=ranked(0,uciMove(forced),'a1b2',-400);
  assert.equal(classifyMove(before,cp(0),forced).key,'best');
});

test('a stale second candidate cannot produce a great-move label',()=>{
  const before={...ranked(70,'e2e4','d2d4',-100),lines:[{multipv:2,depth:12,score:{type:'cp',value:-100},pv:['d2d4']}]};
  assert.equal(classifyMove(before,cp(70),move).key,'best');
});
test('book moves need an actual opening match and do not hide engine-detected mistakes',()=>{
  const chess=new Chess(),e4=chess.move('e4');
  assert.equal(classifyMove(cp(30),cp(30),e4).key,'book');
  assert.equal(classifyMove(cp(30),cp(-300),e4).key,'blunder');
  const far={...e4,before:e4.before.replace('0 1','0 30')};
  assert.equal(classifyMove(cp(30),cp(30),far).key,'excellent');
});
