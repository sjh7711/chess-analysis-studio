import { hasMoveReview } from './chess-core.js';

// Progress belongs to the captured review policy, which may be stricter than
// the cache accepted for displaying a single position on the board.
export function reviewProgress(game,results,isCached) {
  if(typeof isCached!=='function')throw new TypeError('Review progress requires the review job cache policy.');
  const positionTotal=game.positions.length,reviewTotal=game.moves.length;
  const cached=game.positions.map((_,index)=>Boolean(isCached(results.get(index))));
  const evaluated=cached.filter(Boolean).length;
  let reviewed=0;
  for(let index=1;index<=reviewTotal;index++) {
    if(cached[index-1]&&cached[index]
      &&hasMoveReview(results.get(index-1),results.get(index),game.moves[index-1]))reviewed++;
  }
  return {evaluated,reviewed,positionTotal,reviewTotal,done:evaluated+reviewed,
    total:positionTotal+reviewTotal,phase:evaluated<positionTotal?'position':'review'};
}
