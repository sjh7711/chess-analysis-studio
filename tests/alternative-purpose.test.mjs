import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess,uciMove,classifyMove} from '../src/chess-core.js';
import {createInsightLine,describeHumanMove,describeMove,explainMove,insightIdentity,refineInsight} from '../src/insight.js';
import {reviewMove} from '../src/review.js';

// Independent synthetic boards and legal example lines. These scores isolate
// explanation policy; they are not measurements or copied review labels.
const result=(score,pv,depth=16)=>({score,depth,bestmove:pv[0],multipvComplete:true,
  lines:[{score,depth,pv,multipv:1}]});
const cp=(value,pv,depth)=>result({type:'cp',value},pv,depth);
const mate=(value,winner,pv,depth)=>result({type:'mate',value,winner},pv,depth);
function fixture(fen,san,best,reply) {
  const actual=new Chess(fen),move=actual.move(san),branch=new Chess(fen);
  const alternative=best.map(next=>uciMove(branch.move(next))),response=reply.map(next=>uciMove(actual.move(next)));
  const game={startFen:fen,moves:[move],positions:[fen,move.after],headers:{}};
  return {move,alternative,response,game,index:1};
}

test('normal grades retain the alternative pawn move that opens a bishop development route',()=>{
  const context=fixture('5bkr/p3p2p/8/8/8/8/PP6/2K5 b - - 0 12','a6',['e5','Kd2'],['Kd2']);
  const {move,alternative,response}=context,before=cp(0,alternative),after=cp(0,response);
  const original=JSON.stringify({context,before,after}),insight=explainMove(move,before,after,context);
  assert.equal(insight.grade.severity,0);
  assert.match(insight.alternativeFact,/e7에서 e5.*f8의 비숍이 나올 길을 열/);
  assert.doesNotMatch(insight.alternativeFact,/강제|승리|반드시/);
  const line=createInsightLine({...context,before,after,insight},'alternative');
  assert.equal(line.base.fen(),move.before);assert.equal(line.cursor,0);
  assert.match(line.steps[0].explanation,/f8의 비숍이 나올 길/);
  assert.equal(JSON.stringify({context,before,after}),original);
});

test('a normally graded alternative explains development with a concrete legal attack',()=>{
  const context=fixture('6k1/8/8/4n3/8/8/P7/2B3K1 w - - 0 4','a3',['Bf4','Kh7'],['Kh7']);
  const insight=explainMove(context.move,cp(0,context.alternative),cp(0,context.response),context);
  assert.equal(insight.grade.severity,0);
  assert.match(insight.alternativeFact,/c1에서 f4.*e5의 나이트를 공격하며 전개/);
});

test('an escaping rook can attack a knight at the same time without promising a capture',()=>{
  const context=fixture('6k1/7p/2R5/4n3/8/8/P7/6K1 w - - 0 20','Ra6',['Rc5','Kh8'],['Kh8']);
  const before=cp(0,context.alternative),after=cp(0,context.response),insight=explainMove(context.move,before,after,context);
  assert.equal(insight.grade.severity,0);
  assert.match(insight.alternativeFact,/공격을 피하면서 e5의 나이트를 공격/);
  const move=new Chess(context.move.before).move('Rc5');
  assert.match(describeHumanMove(move),/공격받던 룩.*피하면서 e5의 나이트를 공격/);
  assert.doesNotMatch(insight.alternativeFact,/잡습니다|이득|강제/);
});

test('two newly connected rooks have a shared main, alternative and playback purpose',()=>{
  const context=fixture('8/p6R/3R4/8/5k1P/8/6K1/8 w - - 0 20','Rd4+',['Rhd7','Ke3'],['Ke3']);
  const before=cp(0,context.alternative),after=cp(0,context.response),insight=explainMove(context.move,before,after,context);
  assert.match(insight.alternativeFact,/d파일에 두 룩을 연결해 서로 지키게/);
  assert.match(describeHumanMove(new Chess(context.move.before).move('Rhd7')),/d파일에 두 룩을 연결/);
  const line=createInsightLine({...context,before,after,insight},'alternative');
  assert.match(line.steps[0].explanation,/두 룩을 연결/);
  assert.equal(line.cursor,0);assert.equal(line.base.fen(),context.move.before);
});

test('a blocker, an absolute pin, or already connected rooks cannot establish a new mutual defence',()=>{
  for(const [fen,san] of [
    ['7k/7R/8/3P4/3R4/8/8/6K1 w - - 0 20','Rhd7'],
    ['k3r3/8/8/8/R7/8/4R3/4K3 w - - 0 20','Ra2'],
    ['7k/3R4/3R4/8/8/8/8/6K1 w - - 0 20','Rd8+'],
  ])assert.doesNotMatch(describeHumanMove(new Chess(fen).move(san)),/두 룩을 연결|서로 지키/);
});

function matingAlternative() {
  return fixture('7k/8/5K2/8/8/4Q3/8/8 w - - 0 20','Qd4',
    ['Qe6','Kh7','Qf7+','Kh6','Qg6#'],['Kg8']);
}
test('a non-error grade still explains a fully verified mating alternative conditionally',()=>{
  const context=matingAlternative(),before=mate(3,'w',context.alternative),after=cp(9000,context.response);
  const insight=explainMove(context.move,before,after,context);
  assert.equal(insight.grade.severity,0);
  assert.match(insight.alternativeFact,/e3에서 e6/);
  assert.match(insight.alternativeFact,/예상 수순.*g6.*체크메이트/);
  assert.doesNotMatch(insight.alternativeFact,/강제|반드시|메이트.*없어|놓쳤/);
});

test('a mismatched score, incomplete mate or illegal suffix is not a proven mating alternative',()=>{
  const context=matingAlternative();
  for(const before of [mate(4,'w',context.alternative),mate(-3,'b',context.alternative),
    mate(3,'w',context.alternative.slice(0,-1)),mate(3,'w',[...context.alternative,'h6h7'])]) {
    const insight=explainMove(context.move,before,cp(9000,context.response),context);
    assert.doesNotMatch(insight.alternativeFact,/체크메이트/);
  }
});

test('a refined normally graded alternative keeps the original board and grade but gains the verified purpose',()=>{
  const context=fixture('6k1/7p/2R5/4n3/8/8/P7/6K1 w - - 0 20','Ra6',['Rc5','Kh8'],['Kh8']);
  context.before=cp(0,context.alternative);context.after=cp(0,context.response);
  context.insight=explainMove(context.move,context.before,context.after,context);
  const raw=JSON.stringify({game:context.game,before:context.before,after:context.after}),grade=JSON.stringify(context.insight.grade);
  const deeper=cp(0,context.alternative,18);deeper.explanationIdentity=insightIdentity(context,'alternative');
  const updated=refineInsight(context,'alternative',deeper);
  assert.match(updated.alternativeFact,/공격을 피하면서 e5의 나이트를 공격/);
  assert.equal(JSON.stringify(updated.grade),grade);assert.equal(JSON.stringify({game:context.game,before:context.before,after:context.after}),raw);
});

test('the same recommended root is identified without telling the player to play it instead',()=>{
  const context=fixture('7k/8/8/2P5/8/8/8/K7 w - - 0 20','c6',['c6','Kh7'],['Kh7']);
  const insight=explainMove(context.move,cp(0,context.alternative),cp(0,context.response),context);
  assert.match(insight.alternativeFact,/실전 수와 같은 수가 추천/);
  assert.match(insight.alternativeFact,/통과 폰/);
  assert.doesNotMatch(insight.alternativeFact,/대신|했어야/);
});

test('a verified checking skewer names the king in front and the knight captured after its retreat',()=>{
  const context=fixture('8/4k3/6Bn/8/8/8/P7/3R3K b - - 0 20','Nf7',['Nf7','Rd7+','Ke8','Rxf7'],['Rd7+','Ke8','Rxf7']);
  const before=cp(900,context.alternative),after=cp(900,context.response),original=JSON.stringify({context,before,after});
  const insight=explainMove(context.move,before,after,context);
  assert.match(insight.summary,/d7에서 체크하면서 e7의 왕 뒤 f7의 나이트/);
  assert.match(insight.summary,/왕이 피한 뒤.*f7의 흑 나이트를 잡/);
  assert.match(insight.summary,/3점 손해/);
  assert.doesNotMatch(insight.summary,/필연|강제|반드시/);
  assert.equal(describeMove(context.move,before,after,context).text,insight.summary);
  assert.equal(JSON.stringify({context,before,after}),original);
});

test('a discovered check connects the vacated square and newly opened rook-capture ray',()=>{
  const context=fixture('6k1/8/5q2/8/8/8/P4n2/2K2R2 w - - 0 20','a3',['a3','Nd3+','Kc2','Qxf1'],['Nd3+','Kc2','Qxf1']);
  const insight=explainMove(context.move,cp(-900,context.alternative),cp(-900,context.response),context);
  assert.match(insight.summary,/나이트를 f2에서 d3로 옮겨 체크하면서 f6의 퀸이 f1의 룩을 공격할 길/);
  assert.match(insight.summary,/이어서.*f1의 백 룩을 잡/);
  assert.match(insight.summary,/5점 손해/);
});

test('a later capture by a different attacker is not attributed to the first discovered check',()=>{
  const context=fixture('5rk1/8/5q2/8/8/8/P4n2/2K2R2 w - - 0 20','a3',
    ['a3','Nd3+','Kc2','Qe7','a4','Rxf1'],['Nd3+','Kc2','Qe7','a4','Rxf1']);
  const insight=explainMove(context.move,cp(-900,context.alternative),cp(-900,context.response),context);
  assert.match(insight.summary,/퀸을 f6에서 e7로 옮겨 f8의 룩이 f1의 룩을 공격할 길/);
  assert.doesNotMatch(insight.summary,/나이트를 f2에서 d3로 옮겨.*f6의 퀸이/);
  assert.match(insight.summary,/5점 손해/);
});

test('a new absolute pin is tied to the actual queen-for-rook exchange rather than a free queen',()=>{
  const context=fixture('5rk1/8/8/8/2K1Q3/6q1/P7/8 w - - 0 20','a3',['a3','Rf4','Qxf4','Qxf4+','Kb3'],['Rf4','Qxf4','Qxf4+','Kb3']);
  const insight=explainMove(context.move,cp(-500,context.alternative),cp(-500,context.response),context);
  assert.match(insight.summary,/f4에서 e4의 퀸을 c4의 왕 앞에 핀/);
  assert.match(insight.summary,/이어지는 교환.*f4의 백 퀸을 잡/);
  assert.match(insight.summary,/4점 손해/);
  assert.doesNotMatch(insight.summary,/공짜|9점 손해|움직일 수 없/);
});

test('an already existing pin and an incomplete or illegal tactical line do not create a new setup claim',()=>{
  const context=fixture('6k1/8/8/8/2K1Qr2/6q1/P7/8 w - - 0 20','a3',['a3','Qg5','Qxf4','Qxf4+'],['Qg5','Qxf4','Qxf4+']);
  const insight=explainMove(context.move,cp(-500,context.alternative),cp(-500,context.response),context);
  assert.doesNotMatch(insight.summary,/핀으로 묶/);
  const other=fixture('5rk1/8/8/8/2K1Q3/6q1/P7/8 w - - 0 20','a3',['a3'],['Rf4','Qxf4','Qxf4+']);
  for(const pv of [other.response.slice(0,2),[...other.response,'a8a7']]) {
    const result=explainMove(other.move,cp(-500,other.alternative),cp(-500,pv),other);
    assert.doesNotMatch(result.summary,/핀으로 묶/);
  }
});

test('the app game/index context binds grading and explanation to the actual history, not a proof for the same FEN',async()=>{
  const root=new Chess('6k1/8/R7/5K2/8/8/7P/8 w - - 0 1');root.move('Kf6');root.move('Kh8');
  const move=new Chess(root.fen()).move('Ke6'),alternative=['f6g6','h8g8','a6a8'];
  const response=['h8g7','e6f5','g7h7','a6a7','h7g8','f5g6','g8h8','a7a8'];
  const before=mate(2,'w',alternative,4);before.configKey='synthetic-actual-history';
  let after=mate(4,'w',response,4);after.configKey=before.configKey;
  after.moveReview={version:1,fen:move.before,uci:uciMove(move),configKey:before.configKey,
    beforeScore:before.score,beforeDepth:4,beforeBestmove:before.bestmove,score:{type:'cp',value:500},depth:4,
    pv:[uciMove(move),...response.slice(0,3)],source:'search',
    sacrificeReview:{version:1,fen:move.after,rootFen:move.before,uci:uciMove(move),configKey:before.configKey,
      requestedDepth:3,restrictedMoves:[],branches:[],status:'not-eligible'}};
  const proof=mate(5,'w',[uciMove(move),...response],8);
  after=await reviewMove({reset:async()=>{},analyze:async()=>structuredClone(proof)},root,before,after,move);
  assert.deepEqual(after.moveReview.mateReview.historyMoves,['f5f6','g8h8']);
  // This legitimate game starts at the same board but has not played that history.
  const game={startFen:move.before,moves:[move],positions:[move.before,move.after],headers:{}},context={game,index:1};
  const raw=JSON.stringify({game,before,after}),expected=classifyMove(before,after,move,{moves:game.moves,moveIndex:0});
  assert.notDeepEqual(classifyMove(before,after,move,{}),expected,'The fixture must detect history-sensitive grading.');
  assert.deepEqual(explainMove(move,before,after,context).grade,expected);
  assert.deepEqual(describeMove(move,before,after,context).grade,expected);
  assert.equal(JSON.stringify({game,before,after}),raw);
});

test('history-bound KRK outcome evidence separates a maintained win from an unverified mating distance',()=>{
  const context=fixture('4R3/8/8/3K4/8/8/3k4/8 w - - 0 20','Re4',['Re4','Kd1'],['Kd1']);
  const before=mate(8,'w',context.alternative),after=cp(500,context.response),raw=JSON.stringify({context,before,after});
  const insight=explainMove(context.move,before,after,{game:context.game,index:1});
  assert.equal(insight.grade.endgameEvidence?.kind,'preserved-king-rook-vs-king');
  assert.equal(insight.grade.severity,0);
  assert.match(insight.summary,/룩으로 4번째 가로줄을 제어해 상대 왕이 이동할 공간을 제한/);
  assert.match(insight.summary,/룩을 가진 백의 이론적 승리 국면은 유지/);
  assert.doesNotMatch(insight.summary,/메이트가 이어지는지|메이트.*없어|최단|강제|반드시|8수/);
  assert.equal(insight.summary,describeMove(context.move,before,after,{game:context.game,index:1}).text);
  const deeper=cp(550,context.response,18),full={...context,before,after,insight};
  deeper.explanationIdentity=insightIdentity(full,'response');
  const updated=refineInsight(full,'response',deeper);
  assert.match(updated.summary,/백의 이론적 승리 국면은 유지/);
  assert.deepEqual(updated.grade,insight.grade);
  assert.equal(JSON.stringify({context,before,after}),raw);
});

test('KRK prose names the actual winning colour when the bare king moves',()=>{
  const context=fixture('8/8/8/3K4/4R3/8/3k4/8 b - - 0 20','Kc1',['Kd1','Re1+'],['Re1+','Kb2']);
  const insight=explainMove(context.move,cp(500,context.alternative),cp(900,context.response),{game:context.game,index:1});
  assert.equal(insight.grade.endgameEvidence?.winner,'w');
  assert.match(insight.summary,/룩을 가진 백의 이론적 승리 국면은 유지/);
  assert.doesNotMatch(insight.summary,/흑의 이론적 승리|무승부|메이트할 수 있습니다/);
});
