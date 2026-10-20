import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess, parseGame, gameAt, uciMove, sacrificeCandidates, classifyMove} from '../src/chess-core.js';
import {describeMove, explainMove, insightIdentity, refineInsight, createInsightLine} from '../src/insight.js';

// Compact public-game positions and Stockfish 19 Lite observations (depth16,
// 1200ms, MultiPV2, Hash32). Synthetic safety cases are labeled separately. They test
// causal explanations, not historical !! annotations or a proprietary rubric.
const cp = value => ({type:'cp',value});
const mate = (value,winner) => ({type:'mate',value,winner});
const result = (score,pv,depth=16,secondary=null) => ({score,depth,bestmove:pv[0],multipvComplete:true,
  lines:[{score,depth,multipv:1,pv},...(secondary?[{...secondary,depth,multipv:2}]:[])]});

function position(fen,san,beforeScore,afterScore,beforePv,afterPv,secondary=null,afterDepth=16) {
  const chess=new Chess(fen),move=chess.move(san),before=result(beforeScore,beforePv,16,secondary),after=result(afterScore,afterPv,afterDepth);
  before.configKey='specific-public-review';
  return {move,before,after,game:{startFen:fen,moves:[move],positions:[fen,move.after],headers:{}},index:1};
}

function acceptance(context,pv,score,depth=15) {
  const {move,before,after}=context;
  const captures=[...new Set(sacrificeCandidates(move).flatMap(offer=>offer.captures))].sort();
  after.moveReview={version:1,fen:move.before,uci:uciMove(move),configKey:before.configKey,beforeScore:before.score,
    beforeDepth:before.depth,beforeBestmove:before.bestmove,score:before.score,depth:16,
    pv:[uciMove(move),...(before.bestmove===uciMove(move)?before.lines[0].pv.slice(1):after.lines[0].pv)],
    source:before.bestmove===uciMove(move)?'best':'candidate',
    sacrificeReview:{version:1,status:'verified',fen:move.after,rootFen:move.before,uci:uciMove(move),configKey:before.configKey,
      requestedDepth:15,restrictedMoves:captures,branches:[{capture:pv[0],score,depth,pv,multipvComplete:true,
        verified:true,status:'verified',source:'search',bestResponse:false}]}};
  return context;
}

function operaKnight() {
  return acceptance(position('rn2kb1r/p3qppp/2p2n2/1p2p1B1/2B1P3/1QN5/PPP2PPP/R3K2R w KQkq - 0 10','Nxb5',cp(424),cp(422),
    ['c3b5','e7b4','b3b4','f8b4','c2c3','c6b5','c4b5','b8d7'],['e7b4','b3b4','f8b4','c2c3','c6b5','c4b5','b8d7'],
    {score:cp(172),pv:['g5f6','e7f6','c3b5','c6b5','c4b5','b8c6']}),
    ['c6b5','c4b5','e8d8','e1c1','d8c7','d1d3'],cp(593));
}

function operaQueen() {
  return acceptance(position('4kb1r/p2n1ppp/4q3/4p1B1/4P3/1Q6/PPP2PPP/2KR4 w k - 0 16','Qb8+',mate(2,'w'),mate(1,'w'),
    ['b3b8','d7b8','d1d8'],['d7b8','d1d8'],{score:cp(259),pv:['b3b7','f7f6','b7c8','e8e7']}),
    ['d7b8','d1d8'],mate(1,'w'),16);
}

function operaRook() {
  return acceptance(position('3rkb1r/p2nqppp/5n2/1B2p1B1/4P3/1Q6/PPP2PPP/2KR3R w k - 3 13','Rxd7',cp(732),cp(720),
    ['d1d7','d8d7','h1d1','e7b4','g5f6','g7f6','b5d7','e8d8'],['f6d7','g5e7','f8e7','b5d7','d8d7','b3b8','d7d8','b8b5'],
    {score:cp(542),pv:['d1d5','h7h6','g5f6','e7f6','h1d1']}),
    ['f6d7','g5e7','f8e7','b5d7','d8d7','b3b8','d7d8','b8b5'],cp(720),16);
}

function rubinsteinKnight() {
  const context=acceptance(position('2rr2k1/1b2qppp/pb2pn2/1p2P3/1P3P2/P1NB4/1B2Q1PP/R4R1K b - - 2 20','Ng4',cp(-296),cp(-378),
    ['d8d3','e2d3','f6g4','d3h3','g4f2','f1f2','b6f2','a1d1'],['d3e4','g4h2','e2h5','b7e4','c3e4','h2f1','a1f1'],
    {score:cp(-279),pv:['f6g4','d3e4','g4h2','e2h5']}),
    ['e2g4','d8d3','a1c1','c8d8','f4f5','e6f5'],cp(-452),16);
  context.after.moveReview.score=cp(-279);
  return context;
}

function rubinsteinRook() {
  return acceptance(position('2rr2k1/1b3ppp/pb2p3/1p2P3/1P2BPnq/P1N3P1/1B2Q2P/R4R1K b - - 0 22','Rxc3',cp(-675),cp(-767),
    ['c8c3','e4b7','c3g3','f1f3','g3f3','b7f3','g4f2','h1g1'],['e4b7','c3g3','a1c1','g3h3','c1c2','h3h2','e2h2','g4h2'],
    {score:cp(-439),pv:['h4e7','e2g4','c8c3','f4f5']}),
    ['g3h4','d8d2','f1f2','b7e4','e2e4','g4f2','h1g1','f2e4','g1h1'],cp(-1461));
}

function rubinsteinSecondRook() {
  return acceptance(position('3r2k1/1b3ppp/pb2p3/1p2P3/1P2BPnP/P1r5/1B2Q2P/R4R1K b - - 0 23','Rd2',cp(-1245),cp(-1902),
    ['d8d2','e4b7','d2e2','f1f2','e2f2','h1g1','f2b2','g1f1'],['e4b7','d2e2','f1f2','g4f2','h1g2','e2b2'],
    {score:cp(-8),pv:['c3e3','e2e3','b6e3','e4b7','d8d2']}),
    ['e4b7','d2e2','f1f2','g4f2','h1g2','e2b2'],cp(-1902),16);
}

function intermezzo() {
  // Synthetic neutral scores isolate the primary-PV intermezzo in this public
  // Kasparov position; they are not a new engine or Chess.com observation.
  const pv=['d6e7','a5c6','a7b6','c6e7','h8g8','b1a2'];
  return acceptance(position('b2r3r/k4p1p/p2q1np1/Np1P4/3p1Q2/P4PPB/1PP4P/1K2R3 w - - 0 25','Re7+',cp(0),cp(0),
    ['e1e7',...pv],pv),pv,cp(300));
}

function assertLegal(context) {
  for(const [fen,pv] of [[context.move.before,context.before.lines[0].pv],[context.move.after,context.after.lines[0].pv],
    ...context.after.moveReview?.sacrificeReview?.branches?.map(branch=>[context.move.after,branch.pv])||[]]) {
    const chess=new Chess(fen);
    for(const uci of pv) assert.equal(uciMove(chess.move(uci)),uci);
  }
}

test('Opera 10.Nxb5 explains the accepted knight offer and the bishop check, with a conditional caption',()=>{
  const context=operaKnight();assertLegal(context);
  const original=JSON.stringify(context),description=describeMove(context.move,context.before,context.after),insight=explainMove(context.move,context.before,context.after);
  assert.equal(description.grade.key,'brilliant');
  assert.match(description.text,/b5.*나이트/);
  assert.match(description.text,/비숍|체크/);
  assert.match(description.text,/잡으면|받아들이면|이 예시|예상 수순/);
  assert.match(insight.summary,/b5.*나이트/);
  assert.match(insight.sacrificeFact,/비숍|체크/);
  assert.doesNotMatch(insight.sacrificeFact,/킹의 체크|·킹/,'a checking castle is not a check delivered by the king');
  assert.equal(JSON.stringify(context),original);
});

test('Opera 16.Qb8+ connects the queen offer to the actual d8 rook mate even when acceptance is the primary response',()=>{
  const context=operaQueen();assertLegal(context);
  const description=describeMove(context.move,context.before,context.after),insight=explainMove(context.move,context.before,context.after);
  assert.equal(description.grade.key,'brilliant');
  assert.equal(insight.sacrifice,null,'a primary response must not be duplicated as a separate acceptance example');
  assert.match(description.text,/퀸/);
  assert.match(description.text,/룩|d8/);
  assert.match(description.text,/체크메이트/);
  assert.match(insight.summary,/체크메이트/);
  const line=createInsightLine({...context,insight},'response');
  assert.deepEqual(line.steps.map(move=>move.san),['Nxb8','Rd8#']);
});

test('Opera 13.Rxd7 distinguishes the knight-acceptance queen gain from the primary rook recapture',()=>{
  const context=operaRook();assertLegal(context);
  const description=describeMove(context.move,context.before,context.after),insight=explainMove(context.move,context.before,context.after);
  assert.equal(description.grade.key,'brilliant');
  assert.equal(insight.response.moves[0].piece,'r');
  assert.equal(insight.sacrifice.moves[0].piece,'n');
  assert.match(description.text,/d7.*룩/);
  assert.match(description.text,/e7.*퀸/);
  assert.match(insight.sacrificeFact,/e7.*퀸/);
  assert.match(insight.sacrificeFact,/잡으면|이 예시|예상 수순/);
});

test('Rubinstein 20...Ng4 connects taking the knight to the d3 bishop loss, rather than stopping at the e5 pawn threat',()=>{
  const context=rubinsteinKnight();assertLegal(context);
  const description=describeMove(context.move,context.before,context.after),insight=explainMove(context.move,context.before,context.after);
  assert.equal(description.grade.key,'brilliant');
  assert.match(description.text,/g4.*나이트/);
  assert.match(description.text,/d3.*비숍/);
  assert.match(description.text,/룩/);
  assert.match(insight.summary,/d3.*비숍/);
  assert.match(insight.sacrificeFact,/d3.*비숍/);
});

test('Rubinstein 22...Rxc3 names the offered h4 queen, not the moved rook, and does not invent a mate from a cp score',()=>{
  const context=rubinsteinRook();assertLegal(context);
  const description=describeMove(context.move,context.before,context.after),insight=explainMove(context.move,context.before,context.after);
  assert.equal(description.grade.key,'brilliant');
  assert.equal(insight.sacrifice.offer.square,'h4');assert.equal(insight.sacrifice.offer.piece,'q');
  assert.match(description.text,/h4.*퀸/);
  assert.match(insight.summary,/h4.*퀸/);
  assert.match(insight.sacrificeFact,/h4.*퀸/);
  assert.doesNotMatch(insight.sacrificeFact,/c3의 룩을 잡으면|체크메이트|반드시|무조건/);
});

test('Rubinstein 23...Rd2 links the primary b7 bishop capture to the rook taking the e2 queen',()=>{
  const context=rubinsteinSecondRook();assertLegal(context);
  const description=describeMove(context.move,context.before,context.after),insight=explainMove(context.move,context.before,context.after);
  assert.equal(description.grade.key,'brilliant');
  assert.equal(insight.sacrifice,null);
  assert.match(description.text,/e2.*퀸/);
  assert.match(description.text,/퀸.*(?:잡|포획|되찾)|(?:잡|포획).*퀸/);
  assert.match(insight.summary,/e2.*퀸/);
  assert.doesNotMatch(insight.summary,/강제 체크메이트|반드시/);
});

test('a depth-limited or illegal acceptance branch cannot appear as verified causal compensation',()=>{
  for(const mutate of [
    context=>{context.after.moveReview.sacrificeReview.status='depth-limited';},
    context=>{context.after.moveReview.sacrificeReview.branches[0].depth=14;},
    context=>{context.after.moveReview.sacrificeReview.branches[0].pv.push('a8h1');},
  ]) {
    const context=rubinsteinRook();mutate(context);
    const original=JSON.stringify(context),insight=explainMove(context.move,context.before,context.after),description=describeMove(context.move,context.before,context.after);
    assert.equal(insight.sacrifice,null);
    assert.equal(insight.sacrificeFact,'');
    assert.doesNotMatch(description.text,/h4의 퀸을 잡으면|기물을 모두 되찾|강제 체크메이트/);
    assert.equal(JSON.stringify(context),original);
  }
});

test('a primary Qxe7 Nc6+ Kb6 Nxe7 continuation resolves the intermezzo before claiming a material result',()=>{
  const context=intermezzo();assertLegal(context);
  const original=JSON.stringify(context),insight=explainMove(context.move,context.before,context.after);
  assert.equal(insight.grade.key,'brilliant');
  assert.equal(insight.sacrifice,null);
  assert.ok(insight.response.focus.length>=4);
  assert.match(insight.summary,/e7.*퀸|퀸.*되찾/);
  assert.match(insight.responseFact,/e7.*퀸|퀸.*되찾/);
  assert.doesNotMatch(insight.response.focus.note,/백 \d+점 손해/);
  const line=createInsightLine({...context,insight},'response');
  assert.deepEqual(line.steps.slice(0,4).map(move=>move.san),['Qxe7','Nc6+','Kb6','Nxe7']);
  assert.equal(JSON.stringify(context),original);
});

test('a primary acceptance ending at an unanswered intermediate check cannot assert its later queen recovery',()=>{
  const context=intermezzo(),pv=['d6e7','a5c6'];
  context.after.bestmove=pv[0];context.after.lines[0].pv=pv;
  context.after.moveReview.pv=['e1e7',...pv];
  context.after.moveReview.sacrificeReview.branches[0].pv=pv;
  const insight=explainMove(context.move,context.before,context.after);
  assert.doesNotMatch(insight.summary,/e7의 흑 퀸을 잡|퀸을 되찾|기물을 모두 회수|체크메이트/);
  assert.doesNotMatch(insight.materialFact,/백 \d+점 손해/);
  assert.doesNotMatch(insight.response.focus.note,/백 \d+점 손해/);
});

test('a synthetic continuation does not describe an existing b7 weakness as a newly removed defender',()=>{
  const context=position('rn1qkbnr/ppp2ppp/8/4p3/2B1P3/5Q2/PPP2PPP/RNB1K2R b KQkq - 1 6','Nf6',cp(116),cp(318),
    ['d8f6','f3b3','b8d7','b3b7','a8b8'],['f3b3','d8e7','b3b7','e7b4','b7b4','f8b4','c2c3','b4c5']);
  assertLegal(context);
  assert.deepEqual(new Chess(context.move.before).attackers('b7','b'),[]);
  const description=describeMove(context.move,context.before,context.after);
  assert.equal(description.grade.key,'mistake');
  assert.doesNotMatch(description.text,/이 수로 인해 b7의 폰이 수비 없이 남아|b7.*수비를 떠나/);
});

test('Rotlevi 19.e5 Lite mistake gives a concrete king-side tactic rather than just an evaluation fall',()=>{
  const context=position('2rr2k1/1bb1qppp/p3pn2/1p6/1P2PP2/P1NB4/1B2Q1PP/R4RK1 w - - 1 19','e5',cp(-182),cp(-366),
    ['f1f3','d8d7','a1f1','e7d8'],['f6g4','d3e4','c7b6','g1h1','g4h2','e2h5','b7e4','c3e4','h2f1','a1f1']);
  context.after.moveReview={version:1,fen:context.move.before,uci:'e4e5',configKey:context.before.configKey,beforeScore:context.before.score,
    beforeDepth:16,beforeBestmove:context.before.bestmove,score:cp(-365),depth:15,source:'search',
    pv:['e4e5','c7b6','g1h1','f6g4','d3e4','g4h2','e2h5','b7e4','c3e4','h2f1','a1f1']};
  assertLegal(context);
  const description=describeMove(context.move,context.before,context.after);
  assert.equal(description.grade.key,'mistake');
  assert.match(description.text,/체크|h2의 (?:백 )?폰|f1의 (?:백 )?룩|왕을/);
  assert.doesNotMatch(description.text,/유리하던 국면.*불리|예상 승점/);
});

test('a pre-existing pin is described as a real capture constraint rather than a newly opened attack line',()=>{
  const context=position('k3r3/8/5b2/8/8/2P5/4N3/4K2R w - - 0 10','Rg1',cp(0),cp(-300),
    ['e1f1'],['f6c3','e1f1']);assertLegal(context);
  const insight=explainMove(context.move,context.before,context.after);
  assert.equal(insight.grade.key,'blunder');
  assert.match(insight.summary,/c3.*폰/);
  assert.match(insight.summary,/나이트|왕/);
  assert.doesNotMatch(insight.summary,/새로.*핀|왕을 향한.*공격길이 열/);
});

test('a quiet seven-ply capture remains a conditional long-term estimate',()=>{
  const context=position('k6r/8/2n5/8/4PPb1/5N2/P3B3/1K6 w - - 0 13','Bd3',cp(0),cp(-300),['b1b2'],
    ['h8h7','b1b2','h7f7','b2b1','f7f6','b1b2','f6f4']);assertLegal(context);
  const insight=explainMove(context.move,context.before,context.after);
  assert.equal(insight.grade.key,'blunder');
  assert.match(insight.riskFact,/긴 예상|이후 선택|달라질/);
  assert.doesNotMatch(insight.summary,/강제로.*폰|반드시.*폰|확정.*손해/);
});

test('a deeper primary refinement updates the same concrete payoff without mutating grades, scores, or source data',()=>{
  const context=intermezzo(),insight=explainMove(context.move,context.before,context.after),original=JSON.stringify(context);
  const deeper=result(cp(0),['d6e7','a5c6','a7b6','c6e7','h8g8','b1a2'],18);
  deeper.explanationIdentity=insightIdentity(context,'response');
  const refined=refineInsight({...context,insight},'response',deeper);
  assert.ok(refined);
  assert.match(refined.responseFact,/e7.*퀸|퀸.*되찾/);
  assert.match(refined.summary,/e7.*퀸|퀸.*되찾/);
  assert.deepEqual(refined.grade,classifyMove(context.before,context.after,context.move));
  assert.deepEqual(context.before.score,cp(0));assert.deepEqual(context.after.score,cp(0));
  assert.equal(JSON.stringify(context),original);
});

test('initial compact and expanded captions stop at a threefold endpoint using the actual game history',()=>{
  const game=parseGame('1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 *'),index=6,move=game.moves[index-1];
  const before=result(cp(0),['e7e5']),after=result(cp(300),['f3g1','f6g8','e2e4','d7d5','e4d5']);
  const context={game,index,moves:game.moves,moveIndex:index-1},original=JSON.stringify({game,before,after});
  const initialFen=gameAt(game,index).fen(),description=describeMove(move,before,after,context),insight=explainMove(move,before,after,context);
  assert.equal(description.grade.key,'blunder');
  assert.deepEqual(insight.response.pv,['f3g1','f6g8']);
  assert.doesNotMatch(description.text,/d5.*폰.*잡|폰.*d5.*잡/);
  assert.doesNotMatch(insight.summary,/d5.*폰.*잡|폰.*d5.*잡/);
  const line=createInsightLine({game,index,before,after,insight},'response','full');
  assert.equal(line.cursor,0);
  assert.equal(line.base.fen(),initialFen);
  assert.equal(line.steps.length,2);
  assert.equal(line.seek(2).isThreefoldRepetition(),true);
  assert.equal(JSON.stringify({game,before,after}),original);
});
