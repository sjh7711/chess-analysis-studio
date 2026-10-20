import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess, parseGame, uciMove} from '../src/chess-core.js';
import {createInsightLine, describeMove, explainMove, insightIdentity, refineInsight} from '../src/insight.js';
import {SAMPLE_PGN} from '../src/sample.js';

// Synthetic legal continuations isolate explanation policy. The supplied scores
// are test inputs, not fresh engine observations or proprietary classifications.
const result=(score,pv,depth=16)=>({score,depth,bestmove:pv[0],multipvComplete:true,
  lines:[{score,depth,pv,multipv:1}]});
const cp=(value,pv,depth)=>result({type:'cp',value},pv,depth);
const mate=(value,winner,pv,depth)=>result({type:'mate',value,winner},pv,depth);
function position(fen,san,sans=[]) {
  const chess=new Chess(fen),move=chess.move(san),pv=sans.map(next=>uciMove(chess.move(next)));
  const game={startFen:fen,moves:[move],positions:[fen,move.after],headers:{}};
  return {move,pv,game,index:1};
}
const longMate=()=>position('k7/7p/2K5/1Q6/8/8/8/8 b - - 0 20','h6',
  ['Qb6','h5','Qb5','h4','Qb6','h3','Qb7#']);
function missedTwoContext() {
  const context=position('7k/8/5K2/8/8/4Q3/8/8 w - - 0 30','Qe2',['Kg8','Qe6','Kf8']);
  const {move,pv}=context,before=mate(2,'w',['e3h6','h8g8','h6g7']),after=cp(900,pv);
  before.configKey=after.configKey='synthetic-missed-two';
  after.moveReview={version:1,fen:move.before,uci:uciMove(move),configKey:before.configKey,
    beforeDepth:before.depth,beforeBestmove:before.bestmove,beforeScore:{...before.score},depth:16,
    score:{...after.score},pv:[uciMove(move),...pv],source:'search'};
  return {...context,before,after,moves:context.game.moves,moveIndex:0};
}

test('even an equally evaluated move leads with a legal opponent mate rather than a minor board purpose',()=>{
  const move=parseGame(SAMPLE_PGN).moves[44],pv=['f2e1']; // Public sample: Qxh5 Qe1#.
  const before=mate(-1,'b',[uciMove(move),...pv]),after=mate(-1,'b',pv);
  const raw=JSON.stringify({move,before,after}),insight=explainMove(move,before,after);
  assert.equal(insight.grade.severity,0);
  for(const text of [insight.summary,insight.responseFact,insight.riskFact,describeMove(move,before,after).text])
    assert.match(text,/예상 수순.*흑 퀸이 f2에서 e1.*체크메이트할 수/);
  assert.doesNotMatch(insight.summary,/필연|강제로|반드시/);
  assert.equal(JSON.stringify({move,before,after}),raw);
});

test('a complete seven-ply opponent mate is identified as a full predicted line, without moving the viewed board',()=>{
  const context=longMate(),{move,pv}=context,before=mate(4,'w',[uciMove(move),...pv]),after=mate(4,'w',pv);
  const raw=JSON.stringify({context,before,after}),insight=explainMove(move,before,after,context);
  assert.match(insight.summary,/전체 예상 수순.*백 퀸이 b6에서 b7.*체크메이트할 수/);
  const line=createInsightLine({...context,before,after,insight},'response','full');
  assert.equal(line.steps.length,7);assert.equal(line.cursor,0);assert.equal(line.base.fen(),move.after);
  assert.equal(JSON.stringify({context,before,after}),raw);
});

test('wrong distance, wrong winner, a truncated mate and an illegal suffix cannot assert an opponent mate',()=>{
  const {move,pv}=longMate();
  for(const after of [mate(3,'w',pv),mate(-4,'b',pv),mate(4,'w',pv.slice(0,5)),mate(4,'w',[...pv,'a8a7'])]) {
    const before={...after,bestmove:uciMove(move),lines:[{pv:[uciMove(move),...pv],score:after.score,depth:16,multipv:1}]};
    const insight=explainMove(move,before,after);
    assert.equal(insight.grade.severity,0);
    assert.doesNotMatch(insight.summary,/체크메이트/);
    assert.equal(insight.riskFact,'');
  }
});

test('a deeper verified mate updates explanation only, and a later unverified score removes its stale mate statement',()=>{
  const context=longMate(),{move,pv}=context,before=mate(4,'w',[uciMove(move),...pv]),after=mate(4,'w',pv.slice(0,1));
  context.before=before;context.after=after;context.insight=explainMove(move,before,after,context);
  const raw=JSON.stringify({game:context.game,before,after}),grade=JSON.stringify(context.insight.grade);
  const deeper=mate(4,'w',pv,18);deeper.explanationIdentity=insightIdentity(context,'response');
  const updated=refineInsight(context,'response',deeper);
  assert.match(updated.summary,/전체 예상 수순.*체크메이트/);
  assert.equal(JSON.stringify(updated.grade),grade);
  const noMate=cp(0,pv.slice(0,1),20);noMate.explanationIdentity=insightIdentity(context,'response');
  const replaced=refineInsight({...context,insight:updated},'response',noMate);
  assert.doesNotMatch(replaced.summary,/체크메이트/);assert.equal(replaced.riskFact,'');
  assert.equal(JSON.stringify({game:context.game,before,after}),raw);
});

test('a moving checking queen lost to a pawn is a concrete risk even when the supplied grade remains best',()=>{
  const {move,pv}=position('7k/8/8/8/8/2p5/8/1Q5K w - - 0 20','Qb2+',['cxb2']);
  const before=cp(1000,[uciMove(move),...pv]),after=cp(1000,pv),insight=explainMove(move,before,after);
  assert.equal(insight.grade.key,'best');
  assert.match(insight.summary,/흑 폰이 b2의 백 퀸을 잡을 수/);
  assert.match(insight.riskFact,/교환 후 백이 기물 점수 9점 손해/);
  assert.equal(insight.response.focus.length,1);
});

test('an earlier pawn capture does not conceal the nearby rook loss and the combined exchange balance',()=>{
  const context=position('7k/8/8/8/8/1q6/1P5P/R6K w - - 0 20','h3',['Qxb2','Kg1','Qxa1+','Kh2']);
  const {move,pv}=context,before=cp(1000,[uciMove(move),...pv]),after=cp(1000,pv),insight=explainMove(move,before,after,context);
  assert.equal(insight.response.consequence.capture.captured,'p');
  assert.equal(insight.response.nearLoss.capture.captured,'r');
  assert.equal(insight.response.focus.length,4);
  assert.match(insight.summary,/흑 퀸이 a1의 백 룩을 잡/);
  assert.match(insight.summary,/교환 후 백이 기물 점수 6점 손해/);
});

test('an opponent promotion is included in the net balance, rather than calling the rook alone the entire loss',()=>{
  const {move,pv}=position('7k/8/8/8/8/8/Pp6/1R5K w - - 0 20','Ra1',['bxa1=Q+','Kh2']);
  const insight=explainMove(move,cp(1000,[uciMove(move),...pv]),cp(1000,pv));
  assert.match(insight.riskFact,/백 룩을 잡고 퀸으로 승격/);
  assert.match(insight.riskFact,/교환과 승격을 반영하면 백이 기물 점수 13점 손해/);
  assert.doesNotMatch(insight.riskFact,/기물 점수 5점 손해/);
});

test('the main risk separates the current reply loss from an exchange total that includes a previous capture',()=>{
  const fen='7k/8/3q4/8/5n2/3Q4/8/3R3K b - - 0 20',chess=new Chess(fen);
  const previous=chess.move('Nxd3'),move=chess.move('Rxd3'),pv=[uciMove(chess.move('Qxd3'))];
  const game={startFen:fen,moves:[previous,move],positions:[fen,previous.after,move.after],headers:{}};
  const before=cp(1000,[uciMove(move),...pv]),after=cp(1000,pv),raw=JSON.stringify({game,before,after});
  const insight=explainMove(move,before,after,{game,index:2});
  assert.equal(insight.response.nearLoss.loss,11);
  assert.equal(insight.response.nearLoss.replyLoss,5);
  assert.match(insight.riskFact,/흑 퀸이 d3의 백 룩.*기물 점수 5점 손해/);
  assert.doesNotMatch(insight.summary,/11점 손해/);
  assert.match(insight.materialFact,/앞선 포획부터 이어진 교환.*백 11점 손해/);
  assert.equal(JSON.stringify({game,before,after}),raw);
});

test('capturing a newly promoted queen is not attributed to losing an original nine-point queen',()=>{
  const {move,pv}=position('1r5k/P7/8/8/8/8/8/7K w - - 0 20','a8=Q',['Rxa8']);
  const insight=explainMove(move,cp(1000,[uciMove(move),...pv]),cp(1000,pv));
  assert.equal(insight.response.nearLoss,null);
  assert.doesNotMatch(insight.summary,/9점 손해|퀸을 잃/);
});

test('an equal major exchange and an unfinished available recapture do not become a final loss',()=>{
  const cases=[
    position('4rk2/1p3p2/p3rnp1/3pR2p/3P3P/1B4P1/PP3PK1/2R5 w - - 5 29','Rxe6',['Rxe6','Kf3']),
    position('kr5r/8/7b/8/8/4R3/8/2RK4 w - - 0 20','Rh3',['Bxc1']),
  ];
  for(const {move,pv} of cases) {
    const insight=explainMove(move,cp(1000,[uciMove(move),...pv]),cp(1000,pv));
    assert.equal(insight.response.nearLoss,null);assert.equal(insight.riskFact,'');
    assert.doesNotMatch(insight.summary,/기물 점수 .*손해/);
  }
});

test('a centipawn horizon cannot prove a prior non-immediate mate was lost, while a verified alternative still explains its finish',()=>{
  const context=position('k7/7p/2K5/8/3Q4/8/8/8 w - - 0 20','Qe3',['h6']),{move,pv}=context;
  assert.equal(new Chess(move.before).moves().some(san=>san.endsWith('#')),false);
  const before=mate(2,'w',['d4b6','h7h6','b6b7']),after=cp(0,pv),insight=explainMove(move,before,after,context);
  assert.match(insight.reason,/이번 수순에서 확인되지 않았습니다/);
  assert.match(insight.summary,/이 수 뒤에도 메이트가 이어지는지는/);
  assert.match(insight.alternativeFact,/예상 수순.*퀸이 b7에서 체크메이트/);
  assert.doesNotMatch(insight.summary,/메이트.*놓쳤|메이트.*없어졌|강제/);
});

test('a board-certified missed mate in two leads with the short finish, rather than the centipawn horizon',()=>{
  const context=missedTwoContext(),{move,before,after}=context,raw=JSON.stringify(context);
  const insight=explainMove(move,before,after,context);
  assert.equal(insight.grade.mateEvidence.kind,'missed-verified-mate-in-two');
  assert.match(insight.summary,/^두 수로 끝낼 수 있는 체크메이트 기회를 놓쳤습니다\./);
  assert.match(insight.alternativeFact,/h6.*체크.*예상 수순.*퀸이 g7에서 체크메이트/);
  assert.match(insight.reason,/^두 수로 끝낼 수 있는/);
  assert.equal(JSON.stringify(context),raw);
});

test('a deeper surviving mate is kept separate from a certified shorter missed finish and cannot change the grade',()=>{
  const context=missedTwoContext();context.insight=explainMove(context.move,context.before,context.after,context);
  const deeper=mate(2,'w',['h8g8','e2g4','g8h8','g4g7'],18);
  deeper.explanationIdentity=insightIdentity(context,'response');
  const state=()=>JSON.stringify({game:context.game,before:context.before,after:context.after});
  const raw=state(),updated=refineInsight(context,'response',deeper);
  assert.match(updated.summary,/^두 수로 끝낼 수 있는 체크메이트 기회를 놓쳤습니다\./);
  assert.match(updated.summary,/실전 수 뒤에도 이 예상 수순에서는 퀸이 g7에서 체크메이트/);
  assert.deepEqual(updated.grade,context.insight.grade);
  assert.equal(state(),raw);
});

test('shallow, incomplete or distance-mismatched alternatives cannot claim a verified two-move finish',()=>{
  for(const change of [
    x=>{x.before.depth=15;x.before.lines[0].depth=15;},
    x=>{x.before.lines[0].pv.pop();},
    x=>{x.before.score.value=3;x.before.lines[0].score.value=3;x.after.moveReview.beforeScore.value=3;},
  ]) {
    const context=missedTwoContext();change(context);
    assert.doesNotMatch(explainMove(context.move,context.before,context.after,context).summary,/두 수로 끝낼 수 있는 체크메이트 기회/);
  }
  const context=missedTwoContext();context.insight=explainMove(context.move,context.before,context.after,context);
  const alternate=mate(3,'w',['e3h6','h8g8','h6g7'],18);alternate.explanationIdentity=insightIdentity(context,'alternative');
  const updated=refineInsight(context,'alternative',alternate);
  assert.doesNotMatch(updated.summary,/두 수로 끝낼 수 있는 체크메이트 기회/);
});

test('a quiet intermediate move cannot freeze a temporary knight capture into a settled bishop loss',()=>{
  // Black's bishop is captured on b5; the same white knight is then taken by
  // c6xb5 after a queen move. The pawn trade does not end the larger exchange.
  const context=position('7k/8/2p5/1b6/3p4/N3P3/8/3Q3K b - - 0 30','Kg8',
    ['Nxb5','dxe3','Qe2','cxb5','Kh2']);
  const {move,pv}=context,before=cp(-900,[uciMove(move),...pv]),after=cp(-900,pv),raw=JSON.stringify({context,before,after});
  const insight=explainMove(move,before,after,context);
  assert.equal(insight.response.nearLoss,null);
  assert.equal(insight.riskFact,'');
  assert.doesNotMatch(insight.summary,/기물 점수 2점 손해/);
  assert.match(insight.materialFact,/흑 1점 이득/);
  assert.equal(insight.response.focus.length,4);
  assert.equal(insight.response.focus.incomplete,false);
  assert.match(insight.response.focus.note,/흑 1점 이득/);
  const core=createInsightLine({...context,before,after,insight},'response');
  assert.deepEqual(core.steps.map(step=>step.san),['Nxb5','dxe3','Qe2','cxb5']);
  assert.match(core.focusNote,/흑 1점 이득/);
  assert.equal(core.cursor,0);assert.equal(core.base.fen(),move.after);
  assert.equal(JSON.stringify({context,before,after}),raw);
});

test('a later recapture after a quiet move still reports a genuine net loss when it does not compensate the queen',()=>{
  const {move,pv}=position('7k/8/8/8/8/2p5/8/1Q1R3K w - - 0 20','Qb2+',
    ['cxb2','Kh2','Kg8','Rb1','Kh8','Rxb2']);
  const insight=explainMove(move,cp(1000,[uciMove(move),...pv]),cp(1000,pv));
  assert.equal(insight.response.nearLoss.end,6);
  assert.equal(insight.response.nearLoss.loss,8);
  assert.match(insight.riskFact,/b2의 백 퀸.*기물 점수 8점 손해/);
  assert.equal(insight.response.focus.length,6);
});
