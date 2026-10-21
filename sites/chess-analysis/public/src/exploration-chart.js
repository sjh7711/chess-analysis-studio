const hasScore = result => ['cp', 'mate'].includes(result?.score?.type)
  && Number.isFinite(result.score.value);

// A branch opened before its source was analyzed must acquire that completed
// root before reviewing its first move. Keep independent or frozen roots intact.
export function seedExplorationBase(game,line,gameResults) {
  if(!line||line.explanationSnapshot||line.kind==='edited'||line.results.has(0))return false;
  const index=line.prefixMoves?.length;
  if(!Number.isInteger(index)||game.positions[index]!==line.base.fen())return false;
  const result=gameResults.get(index);
  if(!hasScore(result))return false;
  line.results.set(0,result);
  return true;
}

// Chart the route actually being explored: the game's past, then this branch.
// Future positions in the original game are not evidence for the new branch.
export function explorationChart(game, line, gameResults) {
  const positions = game.positions;
  const baseFen = line.base.fen();
  const preferred = line.prefixMoves?.length;
  const matched = line.kind === 'edited' ? -1
    : Number.isInteger(preferred) && positions[preferred] === baseFen
      ? preferred : positions.indexOf(baseFen);
  const originIndex = Math.max(0, matched);
  const results = new Map();
  if (matched >= 0) {
    for (let index = 0; index <= originIndex; index++) {
      const result = gameResults.get(index);
      if (hasScore(result)) results.set(index, result);
    }
  }
  for (let index = 0; index <= line.steps.length; index++) {
    const result = line.results.get(index);
    if (hasScore(result)) results.set(originIndex + index, result);
  }
  return { results, cursor: originIndex + line.cursor,
    count: originIndex + line.steps.length + 1, originIndex };
}
