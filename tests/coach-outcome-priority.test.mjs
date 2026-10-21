import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess, uciMove} from '../src/chess-core.js';
import {describeMove, explainMove, createInsightLine} from '../src/insight.js';

// Constructed positions and legal examples isolate explanation policy. Scores
// are synthetic inputs; no account PGN, game ID or proprietary caption is used.
const cp=value=>({type:'cp',value});
const mate=value=>({type:'mate',value,winner:'w'});
const result=(score,pv)=>({score,depth:16,configKey:'synthetic-coach-outcome',multipvComplete:true,
  bestmove:pv[0],lines:[{score,depth:16,multipv:1,pv}]});
function pv(fen,sans) {
  const chess=new Chess(fen);return sans.map(san=>uciMove(chess.move(san)));
}
function fixture(fen,san,reply,alternative=null,{beforeScore=cp(1000),afterScore=beforeScore}={}) {
  const chess=new Chess(fen),move=chess.move(san),response=pv(move.after,reply);
  const before=result(beforeScore,alternative?pv(fen,alternative):[uciMove(move),...response]);
  const after=result(afterScore,response),game={startFen:fen,moves:[move],positions:[fen,move.after],headers:{}};
  return {move,before,after,game,index:1,moves:game.moves,moveIndex:0};
}
function inspect(context) {
  const original=JSON.stringify(context),insight=explainMove(context.move,context.before,context.after,context);
  assert.equal(JSON.stringify(context),original,'prose must preserve all source evidence and game state');
  return insight;
}
const RECOVERY='r5k1/8/8/3n2p1/8/1B3N2/8/R6K w - - 0 1';
const RECOVERY_REPLY=['Kg7','Ra2','gxh4','Ra1','Ra7','Kg1','Ra8','Bxd5'];

test('a later settled capture on another square recovers the temporary knight deficit',()=>{
  const context=fixture(RECOVERY,'Nh4',RECOVERY_REPLY),insight=inspect(context);
  assert.equal(insight.grade.key,'best');
  assert.equal(insight.response.nearLoss,null);assert.equal(insight.response.consequence,null);
  assert.equal(insight.response.materialRecovery.capture.san,'Bxd5');
  assert.equal(insight.response.focus.length,8);assert.equal(insight.response.focus.incomplete,false);
  assert.match(insight.summary,/이 예상 수순.*h4의 나이트.*먼저 내주지만.*d5의 흑 나이트.*손해는 남지/);
  assert.doesNotMatch(insight.summary,/기물 점수 3점 손해|반드시|보장|강제로/);
  assert.match(insight.responseFact,/d5의 흑 나이트.*손해는 남지/);
  assert.match(insight.materialFact,/차이는 유지/);
  const line=createInsightLine({...context,insight},'response');
  assert.equal(line.steps.at(-1).san,'Bxd5');assert.equal(line.cursor,0);
});

test('a truncated or illegal continuation cannot promise the missing material recovery',()=>{
  for(const reply of [RECOVERY_REPLY.slice(0,5),RECOVERY_REPLY.slice(0,7)]) {
    const context=fixture(RECOVERY,'Nh4',reply),insight=inspect(context);
    assert.equal(insight.response.materialRecovery,undefined);
    assert.doesNotMatch(insight.summary,/손해는 남지|만회/);
  }
  const context=fixture(RECOVERY,'Nh4',RECOVERY_REPLY);
  context.before.lines[0].pv.push('a8h1');context.after.lines[0].pv.push('a8h1');
  assert.doesNotMatch(inspect(context).summary,/손해는 남지|만회/);
});

test('a compensating capture still hanging to an immediate recapture is not settled recovery',()=>{
  const context=fixture(RECOVERY.replace('r5k1','3r2k1'),'Nh4',
    ['Kg7','Ra2','gxh4','Ra1','Rd7','Kg1','Rd8','Bxd5']);
  const insight=inspect(context),final=new Chess(insight.response.final.fen());
  assert.ok(final.moves().includes('Rxd5'));
  assert.equal(insight.response.materialRecovery,undefined);
  assert.doesNotMatch(insight.summary,/손해는 남지|만회/);
});

const FREE='4k1n1/8/8/8/2p1P3/8/8/2BQKB1R w K - 0 1';
const lostPawn=(fen=FREE,alternative=['Bxc4','Nf6','Qd4'])=>fixture(fen,'Bf4',
  ['Nf6','Qd4','Kf8'],alternative,{beforeScore:cp(80),afterScore:cp(-100)});

test('a proven free pawn opportunity leads instead of a quiet unrelated opponent reply',()=>{
  const context=lostPawn(),insight=inspect(context),description=describeMove(context.move,context.before,context.after,context);
  assert.ok(insight.grade.severity>=1);
  assert.match(insight.summary,/^c4의 폰을 잡아도 바로 되잡히지 않았는데, 그 기회를 놓쳤습니다\./);
  assert.match(insight.summary,/대신 백 비숍이 c4의 흑 폰/);
  assert.doesNotMatch(insight.summary,/바로 다음 수에 흑 나이트가 g8에서 f6/);
  assert.equal(description.text,insight.summary);
});

test('an available legal recapture, short horizon or invalid suffix excludes the free-capture claim',()=>{
  const guarded=lostPawn(FREE.replace('/8/2p1P3','/3b4/2p1P3'));
  const after=new Chess(guarded.move.before);after.move('Bxc4');assert.ok(after.moves().includes('Bxc4'));
  for(const context of [guarded,lostPawn(FREE,['Bxc4'])])
    assert.doesNotMatch(inspect(context).summary,/잡아도 바로 되잡히지/);
  const invalid=lostPawn();invalid.before.lines[0].pv.push('a8a1');
  assert.doesNotMatch(inspect(invalid).summary,/잡아도 바로 되잡히지/);
});

test('an underpromotion keeps its actual promotion and check before discussing a different promotion plan',()=>{
  const context=fixture('8/1P1k2p1/8/8/8/8/7R/7K w - - 0 1','b8=N+',
    ['Kc7','Na6+','Kd6'],['Rg2','Kd6','b8=Q+','Kc5','Qb3'],{beforeScore:cp(200),afterScore:cp(-200)});
  const insight=inspect(context);
  assert.ok(insight.grade.severity>=1);
  assert.match(insight.summary,/^백 폰이 b7에서 b8로.*나이트로 승격.*체크/);
  assert.match(insight.summary,/승격하며 상대 왕을 체크/);
  assert.match(insight.alternativeFact,/이 대안의 예상 수순에서는 b7의 폰을 퀸으로 승격/);
  assert.doesNotMatch(insight.summary,/나이트.*강제|반드시.*나이트|스테일메이트|공격할 기회를 놓쳤|승격해 상대 왕/);
});

test('a preserved forced mate gets a compact continuity explanation and a concrete faster option',()=>{
  const fen='7k/8/5K2/8/8/8/8/4R3 w - - 0 1';
  const played=pv(fen,['Re6','Kg8','Re8+','Kh7','Rf8','Kh6','Rh8#']);
  const context=fixture(fen,'Re6',['Kg8','Re8+','Kh7','Rf8','Kh6','Rh8#'],
    ['Kf7','Kh7','Rh1#'],{beforeScore:mate(2),afterScore:mate(3)});
  context.after.moveReview={version:1,fen:context.move.before,uci:uciMove(context.move),configKey:context.before.configKey,
    beforeScore:{...context.before.score},beforeDepth:16,beforeBestmove:context.before.bestmove,
    score:mate(4),depth:16,pv:played,source:'search'};
  const insight=inspect(context);
  assert.equal(insight.grade.key,'good');assert.equal(insight.grade.mateEvidence.kind,'retained-verified-mate-in-two');
  assert.match(insight.summary,/강제 체크메이트로 이어지는 수순을 유지/);
  assert.match(insight.summary,/더 빠른 메이트.*킹이 f6에서 f7/);
  assert.doesNotMatch(insight.summary,/놓쳤|했어야|실전 수 뒤에도|룩이 h8에서 체크메이트/);
  const invalid=structuredClone(context);invalid.after.multipvComplete=false;
  assert.doesNotMatch(inspect(invalid).summary,/강제 체크메이트로 이어지는 수순을 유지/);
});
