import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Chess, parseGame, uciMove } from '../src/chess-core.js';
import { createInsightLine, describeMove, explainMove, explainMistake, insightIdentity, refineInsight } from '../src/insight.js';
import { SAMPLE_PGN } from '../src/sample.js';

const game=parseGame(readFileSync(new URL('./fixtures/review-example.pgn',import.meta.url),'utf8'));
const cp=(value,pv=[])=>({score:{type:'cp',value},bestmove:pv[0],lines:[{pv}],depth:16});
const at=(n,color)=>game.moves.find(m=>Number(m.before.split(' ')[5])===n && m.color===color);

test('provided 151-ply game produces short factual descriptions, including its final draw',()=>{
  assert.equal(game.moves.length,151);
  for (const move of game.moves) {
    const description=describeMove(move,null,null);
    assert.equal(description.grade,null);
    assert.ok(description.text.length>5 && description.text.length<180);
    assert.doesNotMatch(description.text,/undefined|NaN|이론/);
  }
  assert.match(describeMove(game.moves.at(-1),null,null).text,/기물.*무승부/);
});

test('Nf3 develops and attacks e5, while d6 defends that attacked pawn',()=>{
  const knight=at(2,'w'),pawn=at(2,'b');
  const development=describeMove(knight,cp(30,[uciMove(knight)]),cp(30));
  assert.equal(development.grade.key,'book');
  assert.match(development.text,/e5의 폰을 공격하고 d4 칸도 제어하며 나이트를 전개/);
  assert.match(describeMove(pawn,cp(30),cp(59)).text,/e5의 폰을 뒷받침하고 c8의 비숍이 나올 길/);
});

test('a truncated capture line with a possible recapture does not claim a settled pawn loss',()=>{
  const move=at(17,'b');
  const description=describeMove(move,cp(-50,['d5c5']),cp(143,['f3e4']));
  assert.match(description.text,/바로 다음 수에 백 폰이 e4의 흑 폰을 잡을 수/);
  assert.match(description.text,/후속 응수가 부족/);
  assert.doesNotMatch(description.text,/수비 없이|잃을 수/);
  assert.doesNotMatch(description.text,/평가|1\.93|국면/);
});

test('a legal delayed queen loss is described, and a queen exchange is not a free loss',()=>{
  const chess=new Chess('4k2r/7p/8/8/7Q/8/8/4K3 w - - 0 1');
  const move=chess.move('Qxh7');
  assert.match(describeMove(move,cp(0,['h4e4']),cp(-800,['h8h7'])).text,/퀸이 상대 룩의 공격 범위에 놓여.*흑 룩이 h7의 백 퀸을 잡을 수/);
  const trade=new Chess('3qk3/8/8/8/8/8/8/3QK3 w - - 0 1');
  const exchange=trade.move('Qxd8+');
  const description=describeMove(exchange,cp(300,['e1e2']),cp(0,['e8d8']));
  assert.doesNotMatch(description.text,/수비 없이|잃을 수/);
});

test('a mismatch or illegal PV never invents a capture beyond its legal prefix',()=>{
  const move=at(17,'b');
  const invalid=cp(143,['f3e4','a8h8','h8d1']);
  assert.doesNotMatch(describeMove(move,cp(-50),invalid).text,/룩|퀸/);
  const mismatched={...invalid,bestmove:'h2h3'};
  assert.doesNotMatch(describeMove(move,cp(-50),mismatched).text,/fxe4|잡을 수|잃을 수/);
});

test('promotion and en passant descriptions identify the real captured square',()=>{
  assert.match(describeMove(at(37,'w'),null,null).text,/백 폰이 f8의 흑 룩을 잡고 퀸으로 승격/);
  const chess=new Chess('7k/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
  const move=chess.move('exd6');
  assert.match(describeMove(move,null,null).text,/앙파상으로 d5의 흑 폰을 잡습니다/);
});

test('a knight developed to the edge is not described as central development',()=>{
  const chess=new Chess('4k3/8/8/8/2p5/8/8/1N2K3 w - - 0 4');
  const move=chess.move('Na3');
  const comment=describeMove(move,null,null);
  assert.match(comment.text,/c4의 폰을 공격하며 나이트를 전개/);
  assert.doesNotMatch(comment.text,/중앙/);
});

test('loss explanations identify verified tactical causes rather than just naming the captured square',()=>{
  const cases=[
    {fen:'k7/8/3p4/4P3/8/5N2/8/4K3 w - - 0 10',move:'Nh4',pv:['d6e5'],cause:/폰을 지키던 나이트가 자리를 떠나.*e5의 백 폰을 잡/},
    {fen:'k7/8/2b5/3N4/4P3/8/8/4K3 w - - 0 10',move:'Nb4',pv:['c6e4'],cause:/비숍의 공격길이 열려.*e4의 백 폰을 잡/},
    {fen:'k7/8/8/5n2/8/8/2R1K3/7R w - - 0 10',move:'Rg1',pv:['f5d4','e2f2','d4c2'],cause:/나이트의 동시 공격.*c2의 백 룩을 잡/},
    {fen:'k1r5/8/8/8/8/8/6Q1/4K3 w - - 0 10',move:'Qg1',pv:['c8c1','e1f2','c1g1','f2g1'],cause:/체크에 대응하는 사이.*g1의 백 퀸을 잡/},
    {fen:'k3r3/8/5b2/8/8/2P5/4N3/4K2R w - - 0 10',move:'Rg1',pv:['f6c3','e1f1'],cause:/폰을 지키는 나이트가 왕을 보호하느라 되잡을 수 없어.*c3의 백 폰을 잡/},
    {fen:'k7/8/8/8/3p4/8/4P3/7K w - - 0 10',move:'e4',pv:['d4e3'],cause:/앙파상을 허용해.*e4의 백 폰을 잡/},
  ];
  for (const {fen,move:san,pv,cause} of cases) {
    const chess=new Chess(fen),move=chess.move(san);
    for (const uci of pv) assert.ok(chess.move(uci),'fixture continuation must be legal');
    const description=describeMove(move,cp(0),cp(-300,pv));
    assert.equal(description.grade.key,'blunder');
    assert.match(description.text,/^이 수로 인해/);
    assert.match(description.text,cause,san);
    assert.doesNotMatch(description.text,/예상 응수가 이어지면|undefined|NaN/);
  }
});

test('the sample pawn exchange explains the missed development instead of treating an equal recapture as the mistake',()=>{
  const move=parseGame(SAMPLE_PGN).moves[11];
  assert.equal(move.san,'dxe4');
  const alternative=new Chess(move.before),bishop=alternative.move('Bc5');
  assert.equal(alternative.get('f2'),undefined,'the suggested bishop does not attack a pawn on empty f2');
  assert.equal(alternative.isCheck(),false,'the development is not check');
  assert.ok(alternative.attackers('d4','b').includes('c5'));
  const description=describeMove(move,cp(-25,[uciMove(bishop)]),cp(88,['d3e4','d8h4']));
  assert.equal(description.grade.key,'mistake');
  assert.match(description.text,/폰을 잡기보다 비숍을 먼저 전개할 기회/);
  assert.match(description.text,/흑 비숍을 f8에서 c5로.*중앙의 d4 칸을 제어하며 전개/);
  assert.equal(description.text.split('.').filter(Boolean).length,2);
  assert.doesNotMatch(description.text,/차이는 유지|기물.*손해|f2.*폰|체크|Bc5|dxe4/);
});

test('a verified tactical loss retains its cause and adds the concrete defensive alternative',()=>{
  const chess=new Chess('k7/8/3p4/4P3/8/5N2/8/4K3 w - - 0 10');
  const move=chess.move('Nh4');
  const before=cp(0,['e1e2']),after=cp(-300,['d6e5']);
  const description=describeMove(move,before,after);
  assert.match(description.text,/폰을 지키던 나이트가 자리를 떠나/);
  assert.match(description.text,/대신 백 킹이 e1에서 e2로 이동/);
  assert.equal(description.text.split('.').filter(Boolean).length,2);
});

test('a corrupt or mismatched alternative never invents a missed development opportunity',()=>{
  const move=parseGame(SAMPLE_PGN).moves[11];
  const before={...cp(-25,['f8c5']),bestmove:'a8h8'};
  const description=describeMove(move,before,cp(88,['d3e4','d8h4']));
  assert.match(description.text,/백 폰이 e4의 흑 폰을 잡을 수/);
  assert.doesNotMatch(description.text,/전개할 기회|대신|비숍|체크/);
});

test('a missed immediate knight fork is explained before a speculative pawn loss seven plies later',()=>{
  const chess=new Chess('k6r/8/2n5/8/4PPb1/5N2/P3B3/1K6 w - - 0 13');
  const move=chess.move('Bd3');
  const pv=['Rh7','Kb2','Rf7','Kb1','Rf6','Kb2','Rxf4'].map(san=>uciMove(chess.move(san)));
  const description=describeMove(move,cp(200,['f3e5']),cp(0,pv));
  assert.ok(description.grade.severity>=1);
  assert.match(description.text,/^나이트로 두 기물을 동시에 공격할 기회를 놓쳤습니다\./);
  assert.match(description.text,/대신 백 나이트를 f3에서 e5로 옮겨 c6의 나이트·g4의 비숍을 동시에 공격/);
  assert.doesNotMatch(description.text,/긴 예상|7번째|f4의.*폰|Bd3|Ne5/);
  assert.equal(description.text.split('.').filter(Boolean).length,2);
});

test('an immediate verified loss remains ahead of the same missed knight fork',()=>{
  const chess=new Chess('k6r/8/2n5/8/4PPb1/5N2/P3B3/1K6 w - - 0 13');
  const move=chess.move('Bd3');
  const description=describeMove(move,cp(200,['f3e5']),cp(-100,['g4f3']));
  assert.match(description.text,/^이 수로 인해 나이트를 지키던 비숍이 자리를 떠나/);
  assert.match(description.text,/바로 다음 수에 흑 비숍이 f3의 백 나이트를 잡을 수/);
  assert.match(description.text,/대신 백 나이트를 f3에서 e5로/);
  assert.doesNotMatch(description.text,/기회를 놓쳤습니다/);
});

test('brilliant offers explain the current board purpose without inventing their acceptance',()=>{
  const positions=[
    {fen:'b2r3r/k4p1p/p2q1np1/Np1P4/3p1Q2/P4PPB/1PP4P/1K2R3 w - - 0 25',san:'Re7+',reply:'a7b6',purpose:/^백 룩이 e1에서 e7로 이동해 상대 왕을 체크합니다\./},
    {fen:'3r3r/Rb3p1p/p4np1/1p1q4/kP6/P1Q2PPB/2P4P/1K6 w - - 2 30',san:'Rxb7',reply:'d5c4',purpose:/^백 룩이 b7의 흑 비숍을 잡습니다\./},
    {fen:'3r3r/1R3p1p/Q5p1/1p6/1kq5/5PPB/2P4P/1K6 w - - 0 33',san:'c3+',reply:'b4b3',purpose:/^백 폰이 c2에서 c3로 이동해 상대 왕을 체크합니다\./},
    {fen:'3r3r/1R3p1p/6p1/1p6/2q5/5PPB/1Q5P/1K1k4 w - - 4 36',san:'Bf1',reply:'d1e1',purpose:/^c4의 퀸을 공격합니다\./},
    {fen:'7r/1R3p1p/6p1/1p6/2q5/5PP1/1Q1r3P/1K1k1B2 w - - 6 37',san:'Rd7',reply:'d1e1',purpose:/^d2의 룩을 공격합니다\./},
  ];
  for (const {fen,san,reply,purpose} of positions) {
    const chess=new Chess(fen),move=chess.move(san),response=chess.move(reply);
    assert.equal(response.captured,undefined,'the supplied continuation declines the offer');
    const description=describeMove(move,cp(0,[uciMove(move)]),cp(0,[reply]));
    assert.equal(description.grade.key,'brilliant',san);
    assert.match(description.text,purpose,san);
    assert.match(description.grade.reason,/기물을 내줄 수 있는 수지만/,'the separate grading evidence is retained');
    assert.doesNotMatch(description.text,/기물을 희생하면서|흑 (?:퀸|룩|비숍|나이트|폰)[이가].*잡습니다|상대가.*잡습니다|강제로|반드시/);
    assert.equal(description.text.split('.').filter(Boolean).length,1);
  }
});

test('great moves lead with the verified tactic rather than the grading terminology',()=>{
  const chess=new Chess('k7/8/2q5/8/4P1r1/5N2/8/4K3 w - - 0 15'),move=chess.move('Ne5');
  const before={...cp(0,[uciMove(move)]),multipvComplete:true,lines:[
    {multipv:1,depth:16,score:{type:'cp',value:0},pv:[uciMove(move)]},
    {multipv:2,depth:16,score:{type:'cp',value:-200},pv:['e1f1']},
  ]};
  const description=describeMove(move,before,cp(0));
  assert.equal(description.grade.key,'great');
  assert.match(description.text,/^c6의 퀸·g4의 룩을 동시에 공격합니다\./);
  assert.match(description.grade.reason,/다른 후보보다 예상 승점을 크게 지키는/);
  assert.doesNotMatch(description.text,/희생|기물을 내줄|예상 승점|다른 후보/);
});

function acceptedSacrificeFixture() {
  const chess=new Chess('b2r3r/k4p1p/p2q1np1/Np1P4/3p1Q2/P4PPB/1PP4P/1K2R3 w - - 0 25');
  const move=chess.move('Re7+'),uci=uciMove(move);
  const branchChess=new Chess(move.after),pv=['Qxe7','Nc6+','Kb6','Nxe7','Rhg8','Ka2'].map(san=>uciMove(branchChess.move(san)));
  const before={...cp(0,[uci,'a7b6']),configKey:'coach-acceptance'};
  const after={...cp(-900,['a7b6']),moveReview:{version:1,fen:move.before,uci,configKey:before.configKey,
    beforeScore:before.score,beforeDepth:before.depth,beforeBestmove:before.bestmove,
    score:{type:'cp',value:0},depth:16,pv:[uci,'a7b6'],source:'best',sacrificeReview:{
      version:1,status:'verified',fen:move.after,rootFen:move.before,uci,configKey:before.configKey,
      requestedDepth:15,restrictedMoves:['d6e7'],branches:[{capture:'d6e7',score:{type:'cp',value:300},depth:15,pv,
        multipvComplete:true,verified:true,status:'verified',source:'search',bestResponse:false}],
    }}};
  const game={startFen:move.before,moves:[move],positions:[move.before,move.after],headers:{}};
  return {game,index:1,move,before,after};
}

test('the lightbulb explains a good quiet move and offers manual defence exploration without inventing a sacrifice',()=>{
  const chess=new Chess('4k3/4p3/8/8/8/8/8/4K1N1 w - - 0 30'),move=chess.move('Nf3');
  const game={startFen:move.before,moves:[move],positions:[move.before,move.after],headers:{}};
  const before=cp(0,['e1f1']),after=cp(-30,['e7e5']),original=JSON.stringify(game);
  const insight=explainMove(move,before,after);
  assert.equal(insight.kind,'move');
  assert.equal(insight.grade.key,'good');
  assert.match(insight.moveFact,/백 나이트가 g1에서 f3로 이동/);
  assert.match(insight.summary,/중앙의 d4·e5 칸을 제어/);
  assert.match(insight.reason,/예상 승점의 감소를 작게/);
  assert.equal(insight.sacrifice,null);
  assert.equal(createInsightLine({game,index:1,insight,before,after},'sacrifice'),null);
  const line=createInsightLine({game,index:1,insight,before,after},'response');
  assert.equal(line.cursor,0);
  assert.equal(line.base.fen(),move.after);
  assert.match(line.steps[0].explanation,/중앙에 폰을 세워 d4 칸을 제어/);
  assert.doesNotMatch(line.steps[0].explanation,/세로로 2칸|이제 백 차례/);
  assert.equal(JSON.stringify(game),original);
});

test('a verified acceptance example has its own score, a short core, and no effect on the actual game or best defence',()=>{
  const context=acceptedSacrificeFixture(),original=JSON.stringify(context);
  const {move,before,after}=context,insight=explainMove(move,before,after);
  assert.equal(insight.grade.key,'brilliant');
  assert.deepEqual(insight.response.pv,['a7b6']);
  assert.match(insight.sacrificeFact,/이 예시에서는/);
  assert.match(insight.sacrificeFact,/체크하면서 e7의 퀸·d8의 룩도 겨냥/);
  assert.match(insight.sacrificeFact,/e7의 흑 퀸을 잡습니다/);
  const core=createInsightLine({...context,insight},'sacrifice');
  const full=createInsightLine({...context,insight},'sacrifice','full');
  const defence=createInsightLine({...context,insight},'response');
  assert.deepEqual(core.steps.map(step=>step.san),['Qxe7','Nc6+','Kb6','Nxe7']);
  assert.equal(full.steps.length,6);
  assert.equal(core.fullLength,6);
  assert.equal(core.cursor,0);
  assert.equal(core.base.fen(),move.after);
  assert.equal(core.sourceScore.value,300);
  assert.equal(core.results.get(0).score.value,300);
  assert.equal(core.sourceDepth,15);
  assert.equal(defence.results.get(0).score.value,0);
  assert.equal(after.score.value,-900);
  assert.equal(core.conditional,true);
  assert.equal(core.bestResponse,false);
  assert.match(core.title,/상대가 희생을 받아들이면/);
  assert.match(core.startLabel,/희생 수락을 가정한 예시/);
  assert.match(core.focusNote,/상대가 이 포획을 선택한 경우의 예시/);
  assert.doesNotMatch(core.focusNote,/최선의 방어 수순과 다르/);
  assert.match(core.steps[1].explanation,/체크하면서 e7의 퀸·d8의 룩도 겨냥/);
  assert.doesNotMatch(core.steps[1].explanation,/L자로|이제 흑 차례/);
  assert.equal(core.seek(4).get('e7').type,'n');
  assert.equal(defence.cursor,0);
  assert.equal(JSON.stringify(context),original);
});

test('the lightbulb revalidates stale, shallow, unrelated and illegal acceptance branches before exposing them',()=>{
  const base=acceptedSacrificeFixture(),insight=explainMove(base.move,base.before,base.after);
  const mutations=[
    f=>{f.before.configKey='changed';},
    f=>{f.before.depth=17;},
    f=>{f.after.moveReview.sacrificeReview.rootFen=f.move.after;},
    f=>{f.after.moveReview.sacrificeReview.fen=f.move.before;},
    f=>{f.after.moveReview.sacrificeReview.uci='e1e6';},
    f=>{f.after.moveReview.sacrificeReview.status='depth-limited';},
    f=>{f.after.moveReview.sacrificeReview.restrictedMoves=['a7b6'];},
    f=>{f.after.moveReview.sacrificeReview.branches[0].verified=false;},
    f=>{f.after.moveReview.sacrificeReview.branches[0].multipvComplete=false;},
    f=>{f.after.moveReview.sacrificeReview.branches[0].depth=14;},
    f=>{f.after.moveReview.sacrificeReview.branches[0].score.value=-100;},
    f=>{f.after.moveReview.sacrificeReview.branches[0].pv.push('a8h1');},
    f=>{f.after.moveReview.sacrificeReview.branches[0].pv=['d6e7'];},
  ];
  for(const mutate of mutations) {
    const context=structuredClone(base);mutate(context);
    assert.equal(explainMove(context.move,context.before,context.after).sacrifice,null);
    assert.equal(createInsightLine({...context,insight},'sacrifice'),null,'an old displayed explanation cannot bypass current source validation');
  }
});

test('the unified lightbulb preserves mistake explanations and requires completed analysis for every grade',()=>{
  const move=at(17,'b'),before=cp(-50,['d5c5']),after=cp(143,['f3e4']);
  const original=explainMistake(move,before,after),unified=explainMove(move,before,after);
  assert.equal(unified.kind,'mistake');
  for(const key of ['grade','reason','summary','response','alternative','basis']) assert.deepEqual(unified[key],original[key]);
  assert.equal(unified.sacrifice,null);
  assert.equal(explainMove(move,null,after),null);
  assert.equal(explainMove(move,before,null),null);
  assert.equal(explainMove(null,before,after),null);
});

test('a sacrifice capture already used by the best defence opens only the ordinary response without changing the grade or evaluation',()=>{
  const context=acceptedSacrificeFixture(),{move,before,after}=context;
  const previousInsight=explainMove(move,before,after),grade=previousInsight.grade;
  const pv=after.moveReview.sacrificeReview.branches[0].pv;
  before.lines[0].pv=[uciMove(move),...pv];
  after.bestmove=pv[0];after.lines[0].pv=[...pv];after.moveReview.pv=[uciMove(move),...pv];
  const original=JSON.stringify(context),insight=explainMove(move,before,after);
  assert.deepEqual(insight.grade,grade);
  assert.equal(insight.sacrifice,null);
  assert.equal(insight.sacrificeFact,'');
  assert.deepEqual(insight.response.pv,pv);
  assert.equal(createInsightLine({...context,insight},'sacrifice'),null);
  assert.equal(createInsightLine({...context,insight:previousInsight},'sacrifice'),null,'an older separate example cannot bypass current best-response deduplication');
  const response=createInsightLine({...context,insight},'response');
  assert.equal(response.steps[0].uci,pv[0]);
  assert.equal(response.sourceScore.value,0);
  assert.equal(after.score.value,-900);
  assert.equal(after.moveReview.sacrificeReview.branches[0].score.value,300);
  assert.equal(JSON.stringify(context),original);
});

function attackingSacrificeFixture(score={type:'mate',value:-11,winner:'b'}) {
  const chess=new Chess('2rq1rk1/pb1n1ppN/3bpn2/1pp5/3P4/P1NBP3/1PQ2PPP/R1B2RK1 b - - 0 13');
  const move=chess.move('Ng4'),uci=uciMove(move),before={...cp(-50,[uci,'f2f4']),configKey:'coach-king-attack'};
  const pv=['h7f8','d6h2','g1h1','d8h4','d3h7','g8f8','f1d1','h2g3','h1g1','h4h2','g1f1','h2g2','f1e1','g3f2','e1d2','f2e3','d2e1','g2g1','e1e2','g1f2','e2d3','c5c4'];
  const after={...cp(-50,['f2f4']),moveReview:{version:1,fen:move.before,uci,configKey:before.configKey,
    beforeScore:before.score,beforeDepth:before.depth,beforeBestmove:before.bestmove,
    score:before.score,depth:16,pv:[uci,'f2f4'],source:'best',sacrificeReview:{
      version:1,status:'verified',fen:move.after,rootFen:move.before,uci,configKey:before.configKey,
      requestedDepth:15,restrictedMoves:['h7f8'],branches:[{capture:'h7f8',score,depth:15,pv,
        multipvComplete:true,verified:true,status:'verified',source:'search',bestResponse:false}],
    }}};
  return {game:{startFen:move.before,moves:[move],positions:[move.before,move.after],headers:{}},index:1,move,before,after};
}

test('a rook offer is not explained as compensated by its first small pawn capture',()=>{
  const context=attackingSacrificeFixture(),original=JSON.stringify(context);
  const insight=explainMove(context.move,context.before,context.after);
  const core=createInsightLine({...context,insight},'sacrifice');
  const full=createInsightLine({...context,insight},'sacrifice','full');
  assert.deepEqual(core.steps.map(step=>step.san),['Nxf8','Bxh2+','Kh1','Qh4','Bh7+','Kxf8']);
  assert.equal(insight.sacrifice.focus.payoff,null,'the pawn and knight do not fully recover the rook within this core');
  assert.equal(core.steps.length,6);
  assert.equal(full.steps.length,22);
  assert.match(insight.sacrificeFact,/기물을 바로 되찾기보다 비숍의 체크로 상대 왕을 압박/);
  assert.match(insight.sacrificeFact,/이 응수에는 흑이 11수 안에 체크메이트할 것으로 분석/);
  assert.match(insight.sacrificeFact,/핵심 장면 뒤에도 공격이 이어지는 예상 수순/);
  assert.doesNotMatch(insight.sacrificeFact,/룩을 되찾|기물을 모두 회수|폰으로 보상|중앙 공격|갬빗/);
  assert.equal(core.seek(6).isCheckmate(),false);
  assert.equal(full.seek(22).isCheckmate(),true);
  assert.equal(JSON.stringify(context),original);
});

test('an attacking example with only a centipawn score does not invent a forced mate or a material recovery',()=>{
  const context=attackingSacrificeFixture({type:'cp',value:-50});
  const insight=explainMove(context.move,context.before,context.after);
  assert.equal(insight.sacrifice.focus.length,6);
  assert.match(insight.sacrificeFact,/이 응수 뒤의 평가는 \+0\.50 \(흑 기준\)로 조금 유리/);
  assert.match(insight.sacrificeFact,/기물 회수 외의 보상도 반영한 예상/);
  assert.doesNotMatch(insight.sacrificeFact,/체크메이트|기물을 모두 되찾|강제로/);
});

function deeperExplanation(context,kind,pv,score={type:'cp',value:100},depth=20) {
  return {score,depth,bestmove:pv[0],multipvComplete:true,lines:[{multipv:1,score,depth,pv}],
    explanationIdentity:insightIdentity(context,kind),searchGoal:{depth,movetime:1000,multipv:1,
      restrictedMoves:kind==='sacrifice'?[...context.after.moveReview.sacrificeReview.restrictedMoves]:[]}};
}

test('deeper acceptance explanations replace stale mate claims without changing game grades or the main evaluation',()=>{
  const context=attackingSacrificeFixture(),insight=explainMove(context.move,context.before,context.after);
  const original=JSON.stringify(context),identity=insightIdentity(context,'sacrifice');
  assert.match(insight.sacrificeFact,/11수 안에 체크메이트/);
  const pv=insight.sacrifice.pv.slice(0,12),result=deeperExplanation(context,'sacrifice',pv,{type:'cp',value:-1034},18);
  const refined=refineInsight({...context,insight},'sacrifice',result);
  assert.ok(refined);
  assert.equal(refined.grade,insight.grade);
  assert.equal(refined.summary,insight.summary);
  assert.equal(refined.evaluation,insight.evaluation);
  assert.equal(refined.response,insight.response);
  assert.equal(refined.alternative,insight.alternative);
  assert.match(refined.sacrificeFact,/\+10\.34 \(흑 기준\)로 유리/);
  assert.doesNotMatch(refined.sacrificeFact,/11수|체크메이트/);
  assert.equal(insightIdentity({...context,insight:refined},'sacrifice'),identity,'cache identity never incorporates a refined result');
  const line=createInsightLine({...context,insight:refined},'sacrifice');
  assert.equal(line.sourceDepth,18);
  assert.equal(line.sourceScore.value,-1034);
  assert.equal(line.results.get(0).score.value,-1034);
  assert.equal(line.cursor,0);
  assert.deepEqual(line.steps.map(step=>step.uci),pv.slice(0,line.steps.length));
  assert.equal(JSON.stringify(context),original);
  const worse=deeperExplanation(context,'sacrifice',pv,{type:'cp',value:200},18);
  assert.match(refineInsight({...context,insight},'sacrifice',worse).sacrificeFact,/-2\.00 \(흑 기준\)로 불리/);
  assert.doesNotMatch(refineInsight({...context,insight},'sacrifice',worse).sacrificeFact,/보상도 반영|대등한 편/);
});

test('refinement updates only its selected legal continuation and uses the actual completed child depth',()=>{
  const context=acceptedSacrificeFixture(),insight=explainMove(context.move,context.before,context.after);
  const pv=[...insight.sacrifice.pv],result=deeperExplanation(context,'response',pv,{type:'cp',value:200},16);
  const refined=refineInsight({...context,insight},'response',result);
  assert.ok(refined,'root depth 16 includes the played move, so child depth 16 is one ply deeper');
  assert.equal(refined.grade,insight.grade);
  assert.equal(refined.summary,insight.summary);
  assert.equal(refined.sacrifice,insight.sacrifice);
  assert.equal(refined.alternative,insight.alternative);
  assert.match(refined.responseFact,/흑 퀸이 e7의 백 룩을 잡을 수/);
  const line=createInsightLine({...context,insight:refined},'response','full');
  assert.equal(line.sourceDepth,16);
  assert.equal(line.sourceScore.value,200);
  assert.equal(line.base.fen(),context.move.after);
  assert.deepEqual(line.steps.map(step=>step.uci),pv);
  result.score.value=999;
  assert.equal(refined.response.result.score.value,200,'attached explanation snapshots do not share mutable cache objects');
  assert.equal(refined.response.score.value,200);
  const sameDepth=deeperExplanation(context,'response',pv,{type:'cp',value:200},15);
  assert.equal(refineInsight({...context,insight},'response',sameDepth),null);
  const alternative=deeperExplanation(context,'alternative',[uciMove(context.move),'a7b6']);
  const changed=refineInsight({...context,insight},'alternative',alternative);
  assert.match(changed.alternativeFact,/실전 수와 같은 수가 추천/);
  assert.doesNotMatch(changed.alternativeFact,/대신.*했어야/);
  assert.equal(changed.response,insight.response);
  assert.equal(changed.sacrifice,insight.sacrifice);
  const losing=refineInsight({...context,insight},'sacrifice',deeperExplanation(context,'sacrifice',pv,{type:'cp',value:-200}));
  assert.match(losing.sacrificeFact,/e7의 흑 퀸을 잡습니다/);
  assert.match(losing.sacrificeFact,/-2\.00 \(백 기준\)로 불리/,'a short material gain must not hide a worse deeper evaluation');
});

test('refinement rejects stale identities, partial iterations, mismatched candidates and illegal suffixes',()=>{
  const context=acceptedSacrificeFixture(),insight=explainMove(context.move,context.before,context.after);
  const result=deeperExplanation(context,'response',insight.sacrifice.pv);
  const mutations=[
    r=>{r.explanationIdentity='another position';},r=>{r.multipvComplete=false;},
    r=>{r.lines[0].score={type:'cp',value:999};},r=>{r.lines[0].depth=19;},
    r=>{r.lines[0].multipv=2;},r=>{r.lines.push({...r.lines[0],multipv:2});},
    r=>{r.bestmove='a7b6';},r=>{r.lines[0].pv.push('a8h1');},
    r=>{r.searchGoal.restrictedMoves=['d6e7'];},
  ];
  for(const mutate of mutations) {
    const changed=structuredClone(result);mutate(changed);
    assert.equal(refineInsight({...context,insight},'response',changed),null);
  }
  const refined=refineInsight({...context,insight},'response',result);
  const stale=structuredClone(context);stale.before.configKey='new options';
  assert.equal(createInsightLine({...stale,insight:refined},'response'),null);
  const capture=deeperExplanation(context,'sacrifice',insight.sacrifice.pv);
  capture.searchGoal.restrictedMoves=[];
  assert.equal(refineInsight({...context,insight},'sacrifice',capture),null);
});

test('a refined PV cannot continue after a repetition reached through the original game history',()=>{
  const game=parseGame('1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 *');
  const move=game.moves.at(-1),before=cp(0,[uciMove(move)]),after=cp(0,['f6g8']);
  const context={game,index:game.moves.length,move,before,after},insight=explainMove(move,before,after);
  const pv=['f6g8','g1f3','g8f6','f3g1','f6g8','g1f3'];
  const fresh=new Chess(move.after);
  for(const uci of pv)fresh.move(uci);
  assert.equal(refineInsight({...context,insight},'response',deeperExplanation(context,'response',pv)),null,
    'the same legal moves exceed the claim endpoint once real history is restored');
});

test('a verified material payoff beyond six plies can extend the key example without opening the whole line',()=>{
  const context=acceptedSacrificeFixture(),chess=new Chess(context.move.after);
  const pv=['Qxe7','Nc6+','Kb6','Na5','Ka7','Nc6+','Kb6','Nxe7','Rhg8','Ka2'].map(san=>uciMove(chess.move(san)));
  context.after.moveReview.sacrificeReview.branches[0].pv=pv;
  const insight=explainMove(context.move,context.before,context.after),core=createInsightLine({...context,insight},'sacrifice');
  assert.equal(core.steps.length,8);
  assert.equal(core.fullLength,10);
  assert.equal(core.steps.at(-1).san,'Nxe7');
  assert.match(insight.sacrificeFact,/e7의 흑 퀸을 잡습니다/);
  assert.equal(core.cursor,0);
});

test('an already hanging piece is not described as newly exposed by an unrelated king move',()=>{
  const chess=new Chess('k6r/8/8/8/7Q/8/8/4K3 w - - 0 15'),move=chess.move('Kf1');
  const description=describeMove(move,cp(0,['h4e4']),cp(-800,['h8h4']));
  assert.match(description.text,/이미 공격받던 h4의 퀸을 지키지 않아/);
  assert.match(description.text,/흑 룩이 h4의 백 퀸을 잡을 수/);
  assert.doesNotMatch(description.text,/이 수로 인해.*수비 없이|새로.*공격/);
});
