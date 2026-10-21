import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess} from '../node_modules/chess.js/dist/esm/chess.js';
import {certifyMaterialAttack,immediateMaterialCaptures,certifiedTacticalLoss,inspectCertifiedTacticalLoss} from '../src/capture-proof.js';
import {classifyMove,expectedPoints} from '../src/chess-core.js';

const uci=move=>move.from+move.to+(move.promotion||'');
const raw=chess=>JSON.stringify({fen:chess.fen(),history:chess.history({verbose:true})});
function mirrorFen(fen){const [board,turn,rights,ep,half,full]=fen.split(' ');assert.equal(rights,'-');assert.equal(ep,'-');return [board.split('/').reverse().map(rank=>rank.replace(/[a-zA-Z]/g,c=>c===c.toUpperCase()?c.toLowerCase():c.toUpperCase())).join('/'),turn==='w'?'b':'w','-','-',half,full].join(' ');}
const mirrorUci=value=>value.replace(/[1-8]/g,n=>9-Number(n));
function fixture(kind='immediate',black=false){
  const examples={
    immediate:{fen:'r5k1/8/8/8/8/8/8/B3K3 w - - 0 30',played:['e1f1','a8a1','f1f2','a1a5'],best:['a1b2','a8a4','e1f2'],start:2,end:3},
    checking:{fen:'8/4k3/6Bn/1B6/6NK/8/8/3R4 b - - 0 30',played:['h6f7','d1d7','e7e8','d7f7'],best:['h6g8','d1h1','e7d8'],start:4,end:4},
    quiet:{fen:'6R1/2k2n2/5K2/8/8/8/8/8 b - - 0 30',played:['f7h6','g8g6','c7c6','g6h6','c6b7'],best:['f7d6','g8h8','c7c6'],start:4,end:4},
  };
  let {fen,played,best,start,end}=examples[kind];
  if(black){fen=mirrorFen(fen);played=played.map(mirrorUci);best=best.map(mirrorUci);}
  const root=new Chess(fen),source=new Chess(fen),move=source.move(played[0]);
  for(const pv of [played,best]){const chess=new Chess(fen);for(const step of pv){assert.equal(chess.isGameOver(),false,step);chess.move(step);}}
  return {root,move,bestUci:best[0],playedPv:played,bestPv:best,playedSnapshot:{start,end,loss:3},bestSnapshot:{start:0,end:0,loss:0}};
}
function inspectUnchanged(item){const position=raw(item.root),source=JSON.stringify({...item,root:null}),result=inspectCertifiedTacticalLoss(item);assert.equal(raw(item.root),position);assert.equal(JSON.stringify({...item,root:null}),source);return result;}

test('an immediate undefended minor capture is certified for either color without changing the source',()=>{
  for(const black of [false,true]){
    const item=fixture('immediate',black),{evidence,work}=inspectUnchanged(item);
    assert.equal(evidence.kind,'certified-material-loss');assert.equal(evidence.proof.kind,'immediate-capture');
    assert.equal(evidence.additional,3);assert.equal(evidence.certifiedLoss,3);assert.equal(evidence.sampledAdditional,3);
    assert.ok(work.nodes<=4096);assert.equal(work.exhausted,false);
    const after=new Chess(item.move.after),captures=immediateMaterialCaptures(after);
    assert.ok(captures.some(c=>c.uci===item.playedPv[1]&&c.captured==='b'&&c.gain===3));
  }
});

test('checking and quiet attacks require certificates for every legal defender reply, for both colors',()=>{
  for(const kind of ['checking','quiet'])for(const black of [false,true]){
    const item=fixture(kind,black),{evidence}=inspectUnchanged(item);
    assert.ok(evidence,kind);assert.equal(evidence.proof.kind,kind==='checking'?'checking-capture':'attacking-capture');
    const chess=new Chess(item.move.after);chess.move(item.playedPv[1]);
    const replies=chess.moves({verbose:true}).map(uci).sort();
    assert.deepEqual(evidence.proof.certificates.map(c=>c.reply).sort(),replies);
    assert.ok(replies.length>=2);
    for(const certificate of evidence.proof.certificates){
      const response=new Chess(chess.fen());response.move(certificate.reply);
      const finish=response.move(certificate.finish);assert.ok(['n','b','r','q'].includes(finish.captured));
      assert.ok(certificate.gain>=3);
    }
  }
});

test('one escaping defense or a pinned, illegal capture prevents a material certificate',()=>{
  const escape=new Chess('6R1/2k5/7n/4K3/8/8/8/8 w - - 0 30'),saved=raw(escape);
  const after=new Chess(escape.fen());after.move('g8g6');assert.ok(after.moves({verbose:true}).some(m=>uci(m)==='h6f7'));
  assert.equal(certifyMaterialAttack(escape,'g8g6'),null);assert.equal(raw(escape),saved);
  const pinned=new Chess('4k3/4r2Q/8/8/8/8/8/4R1K1 b - - 0 30');
  assert.equal(certifyMaterialAttack(pinned,'e7h7'),null);
  assert.equal(immediateMaterialCaptures(pinned).some(m=>m.uci==='e7h7'),false);
});

test('a legal equal-value recapture is accounted for even if a supplied PV omits it',()=>{
  const root=new Chess('q5k1/p6p/8/8/8/8/5B2/Q3K3 w - - 0 30'),move=root.move('a1a7');
  assert.equal(certifyMaterialAttack(root,'a8a7'),null,'Bxa7 recaptures the queen');
  assert.equal(immediateMaterialCaptures(root).some(m=>m.uci==='a8a7'),false);
  root.undo();
  const item={root,move,bestUci:'a1b1',playedPv:['a1a7','a8a7'],bestPv:['a1b1','a8d8','e1f1'],playedSnapshot:{start:1,end:2,loss:8},bestSnapshot:{start:0,end:0,loss:0}};
  assert.equal(inspectUnchanged(item).evidence,null);
});

test('a later own promotion outside the near window is possible compensation, for either color',()=>{
  for(const black of [false,true]){
    let fen='8/8/8/8/p6P/1k6/8/R5K1 w - - 0 30',played=['a1a4','b3a4','g1f2','a4b3','h4h5','b3c4','f2e3','c4d5','h5h6','d5d6','h6h7','d6d7','h7h8q'],best=['a1b1','b3c3','g1f2'];
    if(black){fen=mirrorFen(fen);played=played.map(mirrorUci);best=best.map(mirrorUci);}
    const root=new Chess(fen),other=new Chess(fen),move=other.move(played[0]);
    const item={root,move,bestUci:best[0],playedPv:played,bestPv:best,playedSnapshot:{start:1,end:2,loss:4},bestSnapshot:{start:0,end:0,loss:0}};
    assert.equal(inspectUnchanged(item).evidence,null);
  }
});

test('only the guaranteed loss is reported when a sampled continuation later loses an additional pawn',()=>{
  const fen='r5k1/8/8/8/8/2P5/8/B3K3 w - - 0 30',root=new Chess(fen),other=new Chess(fen),move=other.move('e1f1');
  const item={root,move,bestUci:'a1b2',playedPv:['e1f1','a8a1','f1f2','a1a3','f2g2','a3c3'],bestPv:['a1b2','a8a4','e1f2'],playedSnapshot:{start:2,end:6,loss:4},bestSnapshot:{start:0,end:0,loss:0}};
  const {evidence}=inspectUnchanged(item);assert.ok(evidence);assert.equal(evidence.sampledAdditional,4);assert.equal(evidence.additional,3);assert.equal(evidence.certifiedLoss,3);
});

test('source binding, complete PV legality, bounded work and snapshot arithmetic are required',()=>{
  for(const mutate of [
    item=>{item.move={...item.move,after:item.move.before};},
    item=>{item.playedPv.push('a5h8');},
    item=>{item.bestPv.push('a4h5');},
    item=>{item.playedPv=[...item.playedPv,...Array(64).fill('a1a2')];},
    item=>{item.playedSnapshot.loss=4;},
    item=>{item.playedSnapshot.start=7;},
    item=>{item.playedSnapshot.end=13;},
    item=>{item.bestUci='a1c3';},
    item=>{item.bestPv[0]='e1f1';},
  ]){const item=fixture();mutate(item);assert.equal(inspectUnchanged(item).evidence,null);}
  const exhausted=fixture();exhausted.nodeBudget=1;
  const result=inspectUnchanged(exhausted);assert.equal(result.evidence,null);assert.equal(result.work.exhausted,true);
  assert.equal(certifyMaterialAttack(new Chess(fixture().move.after),'a8a1',3,{nodeBudget:1}),null);
});

test('best alternatives that still lose the minor and mutated inputs cannot reuse an earlier certificate',()=>{
  const item=fixture();assert.ok(inspectUnchanged(item).evidence);
  item.bestUci='e1d1';item.bestPv=['e1d1','a8a1','d1d2'];
  assert.equal(inspectUnchanged(item).evidence,null);
  const fresh=fixture();assert.ok(certifiedTacticalLoss(fresh));fresh.playedPv[1]='a8b8';
  assert.equal(inspectUnchanged(fresh).evidence,null);fresh.playedPv[1]='a8a1';assert.ok(inspectUnchanged(fresh).evidence);
});

test('actual repetition and fifty-move history override an otherwise valid quiet attack',()=>{
  const chess=new Chess('8/2k5/5KRn/8/8/8/8/8 b - - 0 30');
  for(const move of ['c7b7','g6g8','b7c7','g8g6','c7b7','g6g8','b7c7'])chess.move(move);
  assert.equal(chess.isGameOver(),false);const source=raw(chess),after=new Chess(chess.fen());
  assert.ok(certifyMaterialAttack(after,'g8g6'),'a FEN-only reconstruction has no repeated history');
  assert.equal(certifyMaterialAttack(chess,'g8g6'),null);assert.equal(raw(chess),source);
  const fifty=new Chess('6R1/2k5/5K1n/8/8/8/8/8 w - - 99 30');
  assert.equal(certifyMaterialAttack(fifty,'g8g6'),null);
  assert.ok(certifyMaterialAttack(new Chess(fifty.fen().replace(' 99 ',' 0 ')),'g8g6'));
});

function reviewedFixture(black=false,winning=false){
  const item=fixture('quiet',black),sign=item.move.color==='w'?1:-1;
  const score=value=>({type:'cp',value:value*sign});
  const result=(value,pv)=>({score:score(value),depth:16,configKey:'synthetic-capture-proof',multipvComplete:true,bestmove:pv[0],lines:[{multipv:1,depth:16,score:score(value),pv:[...pv]}]});
  const before=result(winning?1000:-600,item.bestPv),after=result(winning?800:-800,item.playedPv.slice(1));
  after.moveReview={version:1,fen:item.move.before,uci:uci(item.move),configKey:before.configKey,beforeScore:{...before.score},beforeDepth:16,beforeBestmove:before.bestmove,score:{...after.score},depth:16,pv:[...item.playedPv],source:'search'};
  return {item,before,after,context:{moves:[{...item.move}],moveIndex:0}};
}

test('the production caller preserves raw scores, PVs and expected-point loss while applying only the losing-side certificate',()=>{
  for(const black of [false,true]){
    const {item,before,after,context}=reviewedFixture(black),rawSource=JSON.stringify({before,after,context});
    const grade=classifyMove(before,after,item.move,context);
    assert.equal(grade.key,'mistake');assert.equal(grade.tacticalLoss.kind,'certified-material-loss');assert.equal(grade.tacticalLoss.additional,3);
    assert.equal(grade.loss,200);assert.equal(grade.pointsLoss,expectedPoints(before.score,item.move.color)-expectedPoints(after.score,item.move.color));
    assert.equal(JSON.stringify({before,after,context}),rawSource,'certification must not replace the engine record');
    assert.equal(classifyMove(before,after,item.move,context),grade,'unchanged evidence reuses its grade');
    const won=reviewedFixture(black,true),positive=classifyMove(won.before,won.after,won.item.move,won.context);
    assert.equal(positive.tacticalLoss,undefined,'the new minor-loss rule does not punish already-winning simplifications');
  }
});

test('the production certificate requires bound completed searches and revalidates mutated PV and history',()=>{
  for(const mutate of [
    data=>{data.before.multipvComplete=false;},
    data=>{data.after.moveReview.depth=15;},
    data=>{data.after.moveReview.configKey='unrelated';},
    data=>{data.after.moveReview.fen=data.item.move.after;},
    data=>{data.after.moveReview.pv.push('b7h8');},
    data=>{data.context.moves[0].after=data.item.move.before;},
  ]){
    const data=reviewedFixture();assert.equal(classifyMove(data.before,data.after,data.item.move,data.context).tacticalLoss?.additional,3);
    mutate(data);assert.equal(classifyMove(data.before,data.after,data.item.move,data.context).tacticalLoss,undefined);
  }
  const absent=reviewedFixture();assert.equal(classifyMove(absent.before,absent.after,absent.item.move).tacticalLoss,undefined,'without actual history there is no new capture proof');
});
