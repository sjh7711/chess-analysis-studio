import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess,classifyMove,uciMove} from '../src/chess-core.js';
import {certifiedTacticalLoss} from '../src/capture-proof.js';

// Constructed public positions and legal continuations only. No account-game
// position, PGN, review label or engine dump is embedded in this test suite.
const SETUP='7k/8/5K2/8/8/8/8/4R3 w - - 0 1';
const quiet5=['f6e7','h8g7','e1e6','g7g8','e7f6','g8h8','f6g6','h8g8','e6e8'];
const quiet4=['e1e6','h8g8','e6e8','g8h7','e8f8','h7h6','f8h8'];
const quiet3=['e1e2','h8h7','e2e8','h7h6','e8h8'];
const check5=['e1e8','h8h7','e8e7','h7g8','e7e8','g8h7','e8f8','h7h6','f8h8'];
const still2=['f6g6','h8g8','e1e2','g8f8','e2e7','f8g8','e7e8'];
const BEST=['f6f7','h8h7','e1h1'];
function mirrorFen(fen){const [board,turn,rights,ep,half,full]=fen.split(' ');assert.equal(rights,'-');assert.equal(ep,'-');return [board.split('/').reverse().map(rank=>rank.replace(/[a-zA-Z]/g,c=>c===c.toUpperCase()?c.toLowerCase():c.toUpperCase())).join('/'),turn==='w'?'b':'w','-','-',half,full].join(' ');}
const mirrorUci=value=>value.replace(/[1-8]/g,n=>9-Number(n));
const mate=(distance,winner)=>({type:'mate',value:(winner==='w'?1:-1)*distance,winner});
function replay(fen,pv,allowDrawExtension=false){const chess=new Chess(fen),moves=[];for(const value of pv){if(!allowDrawExtension)assert.equal(chess.isGameOver(),false,value);moves.push(chess.move(value));}return{chess,moves};}
function fixture({black=false,fen=SETUP,played=quiet5,best=BEST,history=[],allowDrawExtension=false}={}){
  if(black){fen=mirrorFen(fen);played=played.map(mirrorUci);best=best.map(mirrorUci);history=history.map(mirrorUci);}
  const chess=new Chess(fen),prefix=history.map(u=>chess.move(u)),rootFen=chess.fen(),move=chess.move(played[0]),moves=[...prefix,move],winner=black?'b':'w';
  const actual=replay(rootFen,played,allowDrawExtension),alternative=replay(rootFen,best,allowDrawExtension);assert.equal(actual.chess.isCheckmate(),true);assert.equal(alternative.chess.isCheckmate(),true);
  const rootScore=mate(alternative.moves.filter(m=>m.color===winner).length,winner),playedScore=mate(actual.moves.filter(m=>m.color===winner).length,winner),childScore=mate(actual.moves.slice(1).filter(m=>m.color===winner).length,winner),key='public-synthetic-mate-policy';
  const result=(score,pv)=>({score:{...score},depth:16,configKey:key,multipvComplete:true,bestmove:pv[0],lines:[{multipv:1,depth:16,score:{...score},pv:[...pv]}]});
  const before=result(rootScore,best),after=result(childScore,played.slice(1));
  after.moveReview={version:1,fen:move.before,uci:uciMove(move),configKey:key,beforeScore:{...rootScore},beforeDepth:16,beforeBestmove:before.bestmove,score:{...playedScore},depth:16,pv:[...played],source:'search'};
  return{move,before,after,context:{moves,moveIndex:moves.length-1},actual,alternative,winner};
}
function grade(x){const before=JSON.stringify({move:x.move,before:x.before,after:x.after,context:x.context}),result=classifyMove(x.before,x.after,x.move,x.context);assert.equal(JSON.stringify({move:x.move,before:x.before,after:x.after,context:x.context}),before);return result;}

test('a quiet mate-in-two delay to root mate4/child mate3 or longer is proved for both colors',()=>{
  for(const black of [false,true])for(const played of [quiet4,quiet5]){
    const x=fixture({black,played}),g=grade(x);assert.equal(g.key,'miss');assert.equal(g.mateEvidence.kind,'missed-verified-mate-in-two');assert.equal(g.mateEvidence.checkingStart,false);
    const best=new Chess(x.move.before);best.move(x.before.bestmove);const defenses=best.moves({verbose:true});assert.equal(defenses.length,g.mateEvidence.certificates.length);
    for(const certificate of g.mateEvidence.certificates){const chess=new Chess(best.fen());chess.move(certificate.reply);assert.equal(chess.move(certificate.finish).san.endsWith('#'),true);}
    const actual=new Chess(x.move.after);actual.move(g.mateEvidence.escapingDefense);assert.equal(actual.moves().some(san=>san.endsWith('#')),false);
  }
});

test('one extra winning turn, a checking continuation and a capture are not this quiet-delay exception',()=>{
  for(const black of [false,true]){
    for(const played of [quiet3,check5]){const x=fixture({black,played});assert.equal(grade(x).mateEvidence,undefined);}
    const capture=fixture({black,fen:SETUP.replace('7k/8','7k/4p3'),played:quiet5});assert.equal(capture.move.captured,'p');assert.equal(grade(capture).mateEvidence,undefined);
  }
});

test('an actual move that still guarantees mate in two is not punished for a slower selected PV',()=>{
  for(const black of [false,true]){
    const x=fixture({black,played:still2}),chess=new Chess(x.move.after);
    for(const reply of chess.moves({verbose:true})){chess.move(uciMove(reply));assert.ok(chess.moves().some(san=>san.endsWith('#')));chess.undo();}
    assert.equal(grade(x).mateEvidence,undefined);
  }
});

test('one legal escape from the best setup defeats its nominal mate-in-two PV',()=>{
  const fen='5n1k/8/5K2/8/8/8/8/4R3 w - - 0 1',played=['f6e7','h8h7','e7f8','h7g6','e1f1','g6g5','f8g7','g5g4','g7h6','g4h4','f1f4','h4h3','h6h5','h3g3','h5g5','g3h3','f4g4','h3h2','g5h4','h2h1','h4g3','h1g1','g4f4','g1h1','f4f1'];
  for(const black of [false,true]){const x=fixture({black,fen,played}),chess=new Chess(x.move.before);chess.move(x.before.bestmove);chess.move(black?mirrorUci('f8h7'):'f8h7');assert.equal(chess.moves().some(san=>san.endsWith('#')),false);assert.equal(grade(x).mateEvidence,undefined);}
});

test('quiet-delay metadata requires completed matching depths, scores, full PVs and actual history',()=>{
  for(const mutate of [
    x=>{x.before.multipvComplete=false;},x=>{x.after.multipvComplete=false;},
    x=>{x.after.moveReview.depth=15;},x=>{x.after.depth=15;},
    x=>{x.after.moveReview.source='unverified';},
    x=>{x.after.configKey='unrelated';},x=>{x.after.moveReview.configKey='unrelated';},
    x=>{x.after.moveReview.score=mate(6,x.winner);},
    x=>{x.after.moveReview.score=mate(5,x.winner==='w'?'b':'w');},
    x=>{x.after.score=mate(2,x.winner);x.after.lines[0].score={...x.after.score};},
    x=>{x.after.score=mate(4,x.winner==='w'?'b':'w');x.after.lines[0].score={...x.after.score};},
    x=>{x.before.lines[0].pv.pop();},x=>{x.after.moveReview.pv.pop();},x=>{x.after.lines[0].pv.pop();},
    x=>{x.after.moveReview.pv.push('a1a2');},x=>{x.after.lines[0].pv.push('a1a2');},
    x=>{x.context.moves[0]={...x.context.moves[0],after:x.move.before};},
  ]){const x=fixture();assert.ok(grade(x).mateEvidence);mutate(x);assert.equal(grade(x).mateEvidence,undefined);}
  const x=fixture();assert.equal(classifyMove(x.before,x.after,x.move).mateEvidence,undefined);
});

test('a repeated full history and a fifty-move conclusion cannot supply a new quiet-mate proof',()=>{
  const cycle=['e1e2','h8g8','e2e1','g8h8'];
  const prefix=fixture({history:cycle});assert.ok(grade(prefix).mateEvidence,'a fully reconstructed, nonterminal prefix remains valid');
  prefix.context.moves[0]={...prefix.context.moves[0],after:prefix.move.before};assert.equal(grade(prefix).mateEvidence,undefined);
  const repeated=fixture({history:[...cycle,...cycle]});assert.equal(grade(repeated).mateEvidence,undefined);
  const clocked=fixture({fen:SETUP.replace(' 0 1',' 95 1'),allowDrawExtension:true});assert.equal(grade(clocked).mateEvidence,undefined);
});

function materialFixture(black=false){
  return fixture({black,fen:'n6k/8/5K2/8/8/8/8/R7 b - - 0 1',best:['a8b6','f6g6','b6c4','a1a8'],played:['h8g8','a1a8','g8h7','a8b8','h7h6','b8h8']});
}

test('a same-winner losing mate can carry a separately proved minor loss without changing raw engine records',()=>{
  for(const black of [false,true]){
    const x=materialFixture(black),g=grade(x);assert.notEqual(x.move.color,x.winner);assert.equal(g.key,'mistake');assert.equal(g.pointsLoss,0);assert.equal(g.loss,0);
    assert.equal(g.tacticalLoss.kind,'certified-material-loss');assert.equal(g.tacticalLoss.additional,3);assert.equal(g.tacticalLoss.proof.kind,'immediate-capture');
    const root=new Chess(x.move.before),args={root,move:x.move,bestUci:x.before.bestmove,playedPv:x.after.moveReview.pv,bestPv:x.before.lines[0].pv,playedSnapshot:g.tacticalLoss.played,bestSnapshot:g.tacticalLoss.best};
    assert.equal(certifiedTacticalLoss(args),null,'complete mating lines remain rejected unless the caller explicitly opts in');
  }
});

test('losing-mate material evidence needs both mating sources, the child proof and unchanged binding',()=>{
  for(const mutate of [
    x=>{x.before.score={type:'cp',value:900};x.before.lines[0].score={...x.before.score};x.after.moveReview.beforeScore={...x.before.score};},
    x=>{x.after.score={type:'cp',value:900};x.after.lines[0].score={...x.after.score};},
    x=>{x.after.score=mate(3,x.move.color);x.after.lines[0].score={...x.after.score};},
    x=>{x.after.multipvComplete=false;},x=>{x.after.depth=15;},x=>{x.after.configKey='unrelated';},
    x=>{x.before.score=mate(3,x.winner);x.before.lines[0].score={...x.before.score};x.after.moveReview.beforeScore={...x.before.score};},
    x=>{x.after.moveReview.score=mate(4,x.winner);},
    x=>{x.after.score=mate(4,x.winner);x.after.lines[0].score={...x.after.score};},
    x=>{x.after.moveReview.pv.pop();},x=>{x.before.lines[0].pv.pop();},x=>{x.after.lines[0].pv.pop();},
    x=>{x.after.moveReview.depth=15;},x=>{x.after.moveReview.configKey='unrelated';},
    x=>{x.after.moveReview.source='unverified';},
    x=>{x.after.moveReview.score=mate(3,x.move.color);},
    x=>{x.context.moves[0]={...x.context.moves[0],after:x.move.before};},
  ]){const x=materialFixture();assert.ok(grade(x).tacticalLoss);mutate(x);assert.equal(grade(x).tacticalLoss,undefined);}
});
