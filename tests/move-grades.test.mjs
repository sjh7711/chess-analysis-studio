import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess, DEFAULT_POSITION, classifyMove, isRecapture, sacrificeCandidates, sacrificeEvidence, reviewedSacrificeEvidence, expectedPoints, MOVE_GRADES, uciMove } from '../src/chess-core.js';
const cp=(value,bestmove,lines=[])=>({score:{type:'cp',value},bestmove,lines});
const move={from:'e2',to:'e4',color:'w'};
const ranked=(value,best,other,otherValue,depth=16)=>({...cp(value,best),depth,multipvComplete:true,lines:[
  {multipv:1,depth,score:{type:'cp',value},pv:[best]},
  {multipv:2,depth,score:{type:'cp',value:otherValue},pv:[other]},
]});
function acceptedOffer(before,move,score,pv) {
  const uci=uciMove(move),depth=Math.min(16,Math.max(1,before.depth-1));
  return {...cp(score),moveReview:{version:1,fen:move.before,uci,configKey:before.configKey,
    beforeScore:before.score,beforeDepth:before.depth,beforeBestmove:before.bestmove,
    score:{type:'cp',value:score},depth:before.depth,pv:[uci],source:'best',
    sacrificeReview:{version:1,fen:move.after,rootFen:move.before,uci,configKey:before.configKey,
      requestedDepth:depth,restrictedMoves:[...new Set(sacrificeCandidates(move).flatMap(offer=>offer.captures))],status:'verified',
      branches:[{capture:pv[0],score:{type:'cp',value:score},depth,pv,multipvComplete:true,
        verified:true,status:'verified',source:'search',bestResponse:false}]}}};
}
function playedSequence(fen,sans) {
  const chess=new Chess(fen),moves=sans.map(san=>chess.move(san));
  return {moves,moveIndex:moves.length-1,move:moves.at(-1),previousMove:moves.at(-2)};
}

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
test('a sound legal bishop offer is distinguished from an inferior move without requiring PV acceptance',()=>{
  const chess=new Chess('r2q1rk1/ppp2ppp/2n5/3p4/3P4/3B1N2/PPP2PPP/R2Q1RK1 w - - 0 15');
  const sacrifice=chess.move('Bxh7+');
  const pv=['Kxh7','Ng5+','Kg8','Qh5'].map(san=>uciMove(chess.move(san)));
  const before=cp(0,uciMove(sacrifice)),after=cp(0,undefined,[{pv}]);
  assert.equal(classifyMove(before,after,sacrifice).key,'brilliant');
  assert.notEqual(classifyMove(before,cp(-300,undefined,[{pv}]),sacrifice).key,'brilliant');
  assert.equal(classifyMove(before,cp(0,undefined,[{pv:pv.slice(0,1)}]),sacrifice).key,'brilliant','a short PV does not erase a legal sacrifice');
  assert.notEqual(classifyMove(before,cp(-1),sacrifice).key,'brilliant','the resulting position must be at least equal');
});

test('an attacked but defended source is not confused with an already lost piece',()=>{
  const chess=new Chess('r2q1rk1/ppp2ppp/8/3p4/1n1P4/3B1N2/PPP2PPP/R2Q1RK1 w - - 0 15');
  assert.deepEqual(chess.attackers('d3','b'),['b4']);
  assert.ok(chess.attackers('d3','w').includes('c2'));
  const offer=chess.move('Bxh7+'),evidence=sacrificeEvidence(offer);
  assert.equal(evidence.existingLoss,0);
  assert.equal(evidence.moveGain,1);
  assert.equal(evidence.cost,2);
  assert.equal(classifyMove(cp(20,uciMove(offer)),cp(20),offer).key,'brilliant');
  const hanging=new Chess('q5k1/8/8/8/8/8/8/R5K1 w - - 0 30').move('Ra7');
  assert.equal(sacrificeEvidence(hanging),null,'moving an already hanging rook to another equally hanging square is not a new sacrifice');
});

test('legal sacrifice detection and favorable evaluation are symmetric for black',()=>{
  const fen='r2q1rk1/ppp2ppp/8/3p4/1n1P4/3B1N2/PPP2PPP/R2Q1RK1 w - - 0 15';
  const parts=fen.split(' ');
  parts[0]=parts[0].split('/').reverse().map(rank=>[...rank].reverse().map(c=>/[a-z]/.test(c)?c.toUpperCase():/[A-Z]/.test(c)?c.toLowerCase():c).join('')).join('/');
  parts[1]='b';
  const chess=new Chess(parts.join(' ')),offer=chess.move('Bxa2+');
  assert.equal(sacrificeEvidence(offer).cost,2);
  assert.equal(sacrificeEvidence(offer).existingLoss,0);
  assert.equal(classifyMove(cp(-20,uciMove(offer)),cp(-20),offer).key,'brilliant');
  assert.notEqual(classifyMove(cp(-20,uciMove(offer)),cp(1),offer).key,'brilliant');
});

test('a legal offered capture remains a sacrifice when the best response declines it',()=>{
  const chess=new Chess('b2r3r/k4p1p/p2q1np1/Np1P4/3p1Q2/P4PPB/1PP4P/1K2R3 w - - 0 25');
  const offer=chess.move('Re7+');
  assert.ok(chess.moves().includes('Qxe7'));
  const declined=chess.move('Kb6');
  assert.equal(classifyMove(cp(55,uciMove(offer)),cp(55,uciMove(declined),[{pv:[uciMove(declined)]}]),offer).key,'brilliant');
  assert.ok(sacrificeEvidence(offer).captures.includes('d6e7'));
  assert.equal(sacrificeEvidence({...offer,after:offer.after.replace(' b ',' w ')}),null,'stale resulting positions cannot establish an offer');
  const unrelated=offer.after.replace('p2q1np1','3q1np1');
  assert.notEqual(unrelated,offer.after);
  assert.equal(sacrificeEvidence({...offer,after:unrelated}),null,'the resulting board must be the actual legal move, not an unrelated position');
});

test('a one-pawn checking sacrifice can be sound even when its original square was defended',()=>{
  const chess=new Chess('3r3r/1R3p1p/Q5p1/1p6/1kq5/5PPB/2P4P/1K6 w - - 0 33');
  assert.ok(chess.attackers('c2','b').includes('c4'));
  assert.ok(chess.attackers('c2','w').includes('b1'));
  const offer=chess.move('c3+'),evidence=sacrificeEvidence(offer);
  assert.equal(evidence.cost,1);
  assert.equal(evidence.existingLoss,0);
  assert.ok(evidence.captures.includes('b4c3'));
  assert.equal(classifyMove(cp(300,uciMove(offer)),cp(300),offer).key,'brilliant');
});

test('immediate compensation later in a combination does not erase the initial rook sacrifice',()=>{
  const chess=new Chess('7r/1R3p1p/6p1/1p6/2q5/5PP1/1Q1r3P/1K1k1B2 w - - 6 37');
  const offer=chess.move('Rd7'),pv=['Rxd7','Bxc4','bxc4','Qxh8'].map(san=>uciMove(chess.move(san)));
  assert.equal(sacrificeEvidence(offer).cost,5);
  assert.equal(classifyMove(cp(400,uciMove(offer)),cp(400,undefined,[{pv}]),offer).key,'brilliant');
});

test('protected exchanges, pinned captures and gains exceeding the offer are not sacrifices',()=>{
  const protectedMove=new Chess('3q2k1/8/8/8/8/7R/2P5/6K1 w - - 0 30').move('Rd3');
  assert.equal(sacrificeEvidence(protectedMove),null,'a queen cannot profitably take a pawn-defended rook');
  const pinnedMove=new Chess('4k3/8/8/4n3/8/8/8/1B2R1K1 w - - 0 30').move('Bd3');
  assert.equal(sacrificeEvidence(pinnedMove),null,'a pinned knight cannot legally capture the offered bishop');
  const profitable=new Chess('r5k1/q7/8/8/8/8/8/R5K1 w - - 0 30').move('Rxa7');
  assert.equal(sacrificeEvidence(profitable),null,'taking a queen before losing a rook is an ordinary material gain');
});

test('en passant is included in legal pawn-offer exchange accounting',()=>{
  const chess=new Chess('8/8/8/5k2/3p4/8/4P3/6K1 w - - 0 30'),offer=chess.move('e4+');
  assert.equal(sacrificeEvidence(offer).cost,1);
  assert.ok(sacrificeEvidence(offer).captures.includes('d4e3'));
});

test('registered pawn offers retain their opening-book classification',()=>{
  const chess=new Chess();chess.move('d4');chess.move('d5');
  const offer=chess.move('c4');
  assert.equal(sacrificeEvidence(offer),null,'a quiet pawn offer is not enough for a brilliant label');
  assert.equal(classifyMove(cp(30,uciMove(offer)),cp(30),offer).key,'book');
});

test('an offer of another piece needs completed capture-branch compensation',()=>{
  const chess=new Chess('2rq1rk1/pb1n1ppp/3bpn2/1pp3N1/3P4/P1NBP3/1PQ2PPP/R1B2RK1 w - - 0 13');
  const previousMove=chess.move('Nxh7'),move=chess.move('Ng4'),before={...cp(0,uciMove(move)),depth:16,configKey:'offer-test'};
  assert.equal(sacrificeEvidence(move),null);
  assert.equal(sacrificeCandidates(move)[0].square,'f8');
  assert.equal(sacrificeCandidates(move)[0].cost,2);
  assert.equal(classifyMove(before,cp(0),move).key,'best','static exposure of another piece is not enough');
  const after=acceptedOffer(before,move,0,['h7f8','g8f8']);
  assert.ok(reviewedSacrificeEvidence(before,after,move));
  assert.equal(classifyMove(before,after,move,{previousMove}).key,'brilliant');
  assert.equal(classifyMove(before,after,move).key,'best','without linked history an existing other-piece offer is not a new sacrifice decision');
  assert.equal(after.score.value,0,'the primary evaluation remains separate from the illustrative branch');
});

test('continuing an earlier offer of another piece is not repeatedly awarded brilliant',()=>{
  const chess=new Chess('2rq1rk1/pb1n1ppN/3bp3/1pp5/3P2n1/P1NBP3/1PQ2PPP/R1B2RK1 w - - 1 14');
  const previousMove=chess.move('f4'),move=chess.move('cxd4'),before={...cp(-49,uciMove(move)),depth:16,configKey:'offer-test'};
  const after=acceptedOffer(before,move,-49,['h7f8','d6f8']);
  assert.ok(reviewedSacrificeEvidence(before,after,move),'the accepted branch remains a useful legal explanation');
  assert.notEqual(classifyMove(before,after,move,{previousMove}).key,'brilliant');
});

test('an old attack becoming legal after a check evasion is not a new offer of another piece',()=>{
  const chess=new Chess('b2r3r/4Rp1p/p2q1np1/kp1P4/1P1Q4/P4PPB/2P4P/1K6 b - - 0 27');
  assert.equal(chess.isCheck(),true);
  assert.equal(chess.isAttacked('e7','b'),true);
  const previousMove=chess.move('Ka4'),move=chess.move('Qc3'),before={...cp(59,uciMove(move)),depth:16,configKey:'offer-test'};
  const after=acceptedOffer(before,move,59,['d6e7','c3b3']);
  assert.ok(reviewedSacrificeEvidence(before,after,move));
  assert.notEqual(classifyMove(before,after,move,{previousMove}).key,'brilliant');
});

test('renewing an existing offer is special only with verified compensation, even when alternatives also offer material',()=>{
  const chess=new Chess('2r3k1/pb4p1/4p3/1p3p1q/3b1Pn1/P1NQ3P/1P4P1/R1B2R1K b - - 3 23');
  const move=chess.move('Be3'),before={...ranked(-877,uciMove(move),'h5h4',-871),configKey:'offer-test'};
  assert.equal(sacrificeEvidence(move),null,'moving an already hanging bishop does not establish a new offer by itself');
  assert.equal(sacrificeCandidates(move)[0].existingLoss,3);
  assert.equal(classifyMove(before,cp(-877),move).key,'best');
  const after=acceptedOffer(before,move,-877,['d3e3','g4e3']);
  assert.equal(classifyMove(before,after,move).key,'brilliant');
  const mate={type:'mate',value:-5,winner:'b'},laterMate={type:'mate',value:-7,winner:'b'};
  const alreadyMating={...before,score:mate,lines:before.lines.map(line=>({...line,score:line.multipv===1?mate:laterMate}))};
  const matingAfter=acceptedOffer(alreadyMating,move,-877,['d3e3','g4e3']);
  assert.notEqual(classifyMove(alreadyMating,matingAfter,move).key,'brilliant','a completed mating alternative that only retains an existing offer is already winning');
  const quiet=new Chess('q5k1/8/8/8/8/8/8/R5K1 w - - 0 30').move('Ra7');
  assert.equal(classifyMove({...cp(0,uciMove(quiet)),depth:16},cp(0),quiet).key,'best','an unrelated quiet hanging position remains ordinary without verified compensation');
});

test('capture-branch proof is bound to the current root, complete capture set, depth and legal continuation',()=>{
  const chess=new Chess('2r3k1/pb4p1/4p3/1p3p1q/3b1Pn1/P1NQ3P/1P4P1/R1B2R1K b - - 3 23');
  const move=chess.move('Be3'),before={...cp(-300,uciMove(move)),depth:16,configKey:'offer-test'};
  const good=acceptedOffer(before,move,-300,['d3e3','g4e3']);
  const rejected=[
    {version:0},{fen:move.before},{rootFen:move.after},{uci:'d4f2'},{configKey:'stale'},
    {requestedDepth:1},{status:'unverified'},{restrictedMoves:['d3e3']},
    ...[{depth:14},{verified:false},{status:'depth-limited'},{multipvComplete:false},
      {score:{type:'cp',value:1}},{score:{type:'mate',value:0}},{pv:['d3e3','g4g8']},{capture:'c1e3'},
      {source:'unknown'},{bestResponse:true}].map(branch=>({branches:[{...good.moveReview.sacrificeReview.branches[0],...branch}]})),
  ];
  for (const patch of rejected) {
    const after={...good,moveReview:{...good.moveReview,sacrificeReview:{...good.moveReview.sacrificeReview,...patch}}};
    assert.equal(reviewedSacrificeEvidence(before,after,move),null,JSON.stringify(patch));
    assert.notEqual(classifyMove(before,after,move).key,'brilliant',JSON.stringify(patch));
  }
  assert.equal(reviewedSacrificeEvidence({...before,depth:15},good,move),null);
});

test('an easy winning non-sacrificial alternative prevents a brilliant label',()=>{
  const chess=new Chess('r2q1rk1/ppp2ppp/2n5/3p4/3P4/3B1N2/PPP2PPP/R2Q1RK1 w - - 0 15');
  const offer=chess.move('Bxh7+');
  const comfortable=ranked(800,uciMove(offer),'f1e1',700);
  assert.notEqual(classifyMove(comfortable,cp(800),offer).key,'brilliant');
  const critical=ranked(800,uciMove(offer),'f1e1',200);
  assert.equal(classifyMove(critical,cp(800),offer).key,'brilliant');
  const otherSacrifice=ranked(800,uciMove(offer),'d3g6',700);
  assert.equal(classifyMove(otherSacrifice,cp(800),offer).key,'brilliant','another winning sacrifice is not evidence of an easy non-sacrificial win');
  const mate={type:'mate',value:3,winner:'w'},slowerMate={type:'mate',value:5,winner:'w'};
  const matingSacrifices={...otherSacrifice,score:mate,lines:otherSacrifice.lines.map(line=>({...line,score:line.multipv===1?mate:slowerMate}))};
  assert.equal(classifyMove(matingSacrifices,cp(800),offer).key,'brilliant','a mating alternative that itself introduces a new sacrifice does not erase the finding');
  assert.notEqual(classifyMove(cp(800,uciMove(offer)),cp(800),offer).key,'brilliant','without comparable alternatives the conservative fallback remains');
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
  const chess=new Chess('3qk3/3p4/8/8/8/8/4P3/4K3 w - - 0 30');
  chess.move('e4');chess.move('d5');
  const previousMove=chess.move('exd5'),recapture=chess.move('Qxd5');
  const before=ranked(0,uciMove(recapture),'e8f8',400);
  assert.equal(classifyMove(before,cp(0),recapture,{previousMove}).key,'best');
  assert.equal(classifyMove(before,cp(0),recapture).key,'great','capture history is necessary to recognize the recapture');
});

test('a recapture after a checking intermezzo is best rather than a fresh sacrifice of another piece',()=>{
  const sequence=playedSequence('b2r3r/k4p1p/p2q1np1/NppP4/3R1Q2/P4PPB/1PP4P/1K2R3 b - - 0 24',
    ['cxd4','Re7+','Kb6','Qxd4+']);
  const {move}=sequence,before={...ranked(55,uciMove(move),'a5c4',-250,14),configKey:'recapture-test'};
  const after=acceptedOffer(before,move,55,['b6a5','b2b4','a5a4']);
  assert.equal(isRecapture(move,sequence),true);
  assert.equal(isRecapture(move,{previousMove:sequence.previousMove}),false,'the immediately preceding king move alone does not reveal the recapture');
  assert.equal(sacrificeEvidence(move),null);
  assert.ok(reviewedSacrificeEvidence(before,after,move),'the legal knight-capture branch remains useful for explanations');
  assert.equal(classifyMove(before,after,move,sequence).key,'best');
});

test('multiple checking intermezzi do not erase a recapture or a new sacrifice by its moving piece',()=>{
  const sequence=playedSequence('6k1/5p1p/6N1/8/8/3B4/8/R6K b - - 0 30',
    ['hxg6','Ra8+','Kh7','Rh8+','Kg7','Bxg6']);
  assert.equal(isRecapture(sequence.move,sequence),true);
  assert.equal(sacrificeEvidence(sequence.move).cost,2);
  assert.equal(classifyMove(cp(20,uciMove(sequence.move)),cp(20),sequence.move,sequence).key,'brilliant',
    'a fresh sacrifice by the recapturing bishop keeps priority');
});

test('quiet intermezzi and a capturer that leaves and returns do not prove a delayed recapture',()=>{
  const quiet=playedSequence('6k1/5p1p/6N1/8/8/3B4/8/R6K b - - 0 30',['hxg6','Ra2','Kh7','Bxg6+']);
  assert.equal(isRecapture(quiet.move,quiet),false);
  const returning=playedSequence('8/8/6k1/7q/6N1/8/1Q6/2KB4 b - - 0 30',
    ['Qxg4','Qb6+','Qe6','Qg1+','Qg4','Bxg4']);
  assert.equal(isRecapture(returning.move,returning),false,'the original capturer must remain on the recapture square throughout');
});

test('delayed recapture uses the actual promoted capturer and en passant destination',()=>{
  const promoted=playedSequence('7k/8/8/8/5R2/8/1pN5/R3R1K1 b - - 0 30',
    ['bxa1=Q','Rh4+','Kg8','Nxa1']);
  assert.equal(promoted.moves[0].piece,'p');assert.equal(promoted.move.captured,'q');
  assert.equal(isRecapture(promoted.move,promoted),true);
  const enPassant=playedSequence('6k1/8/8/8/6Pp/8/7P/R5K1 b - g3 0 30',
    ['hxg3','Ra8+','Kh7','hxg3']);
  assert.equal(enPassant.moves[0].flags.includes('e'),true);
  assert.equal(isRecapture(enPassant.move,enPassant),true);
  const currentEp=playedSequence('6k1/3p4/8/4P3/8/8/8/6K1 b - - 0 30',['d5','exd6']);
  assert.equal(isRecapture(currentEp.move,currentEp),false,'en passant following a pawn push is not a recapture');
  const promotion=playedSequence('R6k/rP6/8/8/5R2/8/8/6K1 b - - 0 30',
    ['Rxa8','Rh4+','Kg8','bxa8=Q+']);
  assert.equal(isRecapture(promotion.move,promotion),false,'a promotion keeps the existing special-move policy');
});

test('stale or unrelated history cannot invent a delayed recapture and history changes invalidate grading',()=>{
  const sequence=playedSequence('b2r3r/k4p1p/p2q1np1/NppP4/3R1Q2/P4PPB/1PP4P/1K2R3 b - - 0 24',
    ['cxd4','Re7+','Kb6','Qxd4+']);
  const {move}=sequence,before={...ranked(55,uciMove(move),'a5c4',-250,14),configKey:'recapture-cache'};
  const after=acceptedOffer(before,move,55,['b6a5','b2b4','a5a4']);
  assert.equal(classifyMove(before,after,move,sequence).key,'best');
  const origin=sequence.moves[0];
  sequence.moves[0]={...origin,captured:'n'};
  assert.equal(isRecapture(move,sequence),false);
  assert.equal(classifyMove(before,after,move,sequence).key,'brilliant','a changed array must not reuse the old recapture grade');
  sequence.moves[0]=origin;
  assert.equal(classifyMove(before,after,move,sequence).key,'best');
  assert.equal(isRecapture(move,{...sequence,moveIndex:2}),false);
  assert.equal(isRecapture({...move,after:move.before},sequence),false);
  const unrelated=[...sequence.moves];unrelated[1]={...unrelated[1],before:origin.before};
  assert.equal(isRecapture(move,{...sequence,moves:unrelated}),false);
  const mutated={...origin};sequence.moves[0]=mutated;
  assert.equal(isRecapture(move,sequence),true);
  mutated.after=mutated.before;
  assert.equal(isRecapture(move,sequence),false,'editing a record in place invalidates the legal-record cache');
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
  assert.equal(classifyMove(cp(30),cp(30),far).key,'book','the registered position is not excluded by an arbitrary move number');
  const offBook=new Chess('4k3/8/8/8/8/8/4P3/4K3 w - - 0 30').move('e4');
  assert.equal(classifyMove(cp(30),cp(30),offBook).key,'excellent');
});

test('registered opening continuations beyond move ten remain book moves',()=>{
  // Lichess CC0 openings: Benko Gambit Accepted, King Walk Variation, 11.Kg2.
  const chess=new Chess('rn1q1rk1/4ppbp/3p1np1/2pP4/4P3/2N2NP1/PP3P1P/R1BQ1K1R w - - 1 11');
  const continuation=chess.move('Kg2');
  assert.equal(classifyMove(cp(30,uciMove(continuation)),cp(30),continuation).key,'book');
});
