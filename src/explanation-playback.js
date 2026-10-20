import { uciMove } from './chess-core.js';
import { cloneChess } from './study.js';

const SOURCE_FIELDS=['sourceScore','sourceDepth','fullLength','focusNote','title','startLabel','conditional','bestResponse'];
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const token=step=>step?.uci||uciMove(step);

function historySignature(moves) {
  return JSON.stringify(moves.map(move=>[move.before,uciMove(move),move.after]));
}

function baseSignature(line) {
  const history=line.base.history({verbose:true}),prefix=line.prefixMoves;
  if (!Array.isArray(prefix)||historySignature(prefix)!==historySignature(history)) return null;
  return JSON.stringify([line.base.fen(),history[0]?.before||line.base.fen(),historySignature(history)]);
}

function replay(line,count) {
  const chess=cloneChess(line.base);
  for(let index=0;index<count;index++) {
    const step=line.steps[index],uci=token(step);
    if (typeof uci!=='string'||!/^[a-h][1-8][a-h][1-8][nbrq]?$/.test(uci)||chess.isGameOver()) return null;
    const played=chess.move(uci);
    if (step.before!==played.before||step.after!==played.after) return null;
  }
  return chess;
}

// Adopt a completed explanation without seeking, changing the visible past, or
// touching a playback clock. The caller owns rendering and pending refinements.
export function mergeExplanationLine(current,replacement) {
  let future,metadata,root,hasRoot;
  try {
    if (!current||!replacement||current===replacement||!Array.isArray(current.steps)||!Array.isArray(replacement.steps)
      || !(current.results instanceof Map)||!(replacement.results instanceof Map)
      || !Number.isInteger(current.cursor)||current.cursor<0||current.cursor>current.steps.length
      || replacement.steps.length<current.cursor||current.kind!=='pv'||replacement.kind!=='pv'
      || !Number.isInteger(current.reviewIndex)||current.reviewIndex<1||current.reviewIndex!==replacement.reviewIndex
      || !['response','alternative','sacrifice'].includes(current.reviewKind)||current.reviewKind!==replacement.reviewKind
      || !['core','full'].includes(current.reviewScope)||current.reviewScope!==replacement.reviewScope
      || Object.isFrozen(current)||Object.isSealed(current.steps)) return false;
    const base=baseSignature(current);
    if (!base||base!==baseSignature(replacement)) return false;
    for(let index=0;index<current.cursor;index++) {
      if (token(current.steps[index])!==token(replacement.steps[index])) return false;
    }
    const visible=replay(current,current.cursor),nextVisible=replay(replacement,current.cursor);
    if (!visible||!nextVisible||visible.fen()!==nextVisible.fen()||!replay(replacement,replacement.steps.length)) return false;
    if (current.position().fen()!==visible.fen()) return false;
    // Prepare independent data before making any changes. Cached replacement
    // steps and source results must never acquire edits made during playback.
    future=structuredClone(replacement.steps.slice(current.cursor));
    metadata=new Map(SOURCE_FIELDS.map(key=>[key,own(replacement,key)?structuredClone(replacement[key]):undefined]));
    hasRoot=replacement.results.has(0);
    root=hasRoot?structuredClone(replacement.results.get(0)):undefined;
    for(const key of SOURCE_FIELDS) {
      const descriptor=Object.getOwnPropertyDescriptor(current,key);
      if (descriptor&&(own(replacement,key)?descriptor.writable!==true:descriptor.configurable!==true)) return false;
      if (!descriptor&&own(replacement,key)&&!Object.isExtensible(current)) return false;
    }
  } catch { return false; }

  // Keep the line, steps array, base, prefix, cursor, and already-shown step
  // objects alive. Only the unvisited suffix and its stale evaluations change.
  current.steps.splice(current.cursor,current.steps.length-current.cursor,...future);
  for(const index of current.results.keys())if(index>current.cursor)current.results.delete(index);
  if(hasRoot)current.results.set(0,root);else current.results.delete(0);
  for(const [key,value] of metadata) {
    if(own(replacement,key))current[key]=value;else delete current[key];
  }
  return true;
}
