import { reviewMove } from './review.js';

// One foreground lease includes the parent evaluation and move comparison.
// A branch can therefore receive a grade before the original review reaches it.
export async function analyzeForeground(worker, { chess, parent, before, cached, move,
  options, comparisonOptions=options, overviewOptions=options, overview=false,
  configKey, force=false, isCached=()=>false, signal } = {}) {
  const check = () => signal?.throwIfAborted();
  const evaluate = async position => {
    check();
    await worker.reset?.();
    check();
    const result=await worker.analyze(position,options);
    check();
    return {...result,requestedDepth:options.depth,configKey,...(overview?{overview:true}:{})};
  };
  check();
  if(move && parent && !isCached(before))before=await evaluate(parent);
  let result=!force && isCached(cached) ? {...cached} : await evaluate(chess);
  check();
  if(move && parent && isCached(before)) {
    result=await reviewMove(worker,parent,before,result,move,before.overview?overviewOptions:comparisonOptions);
    check();
  }
  return {before,result};
}
