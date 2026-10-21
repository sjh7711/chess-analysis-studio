const hasScore = result => ['cp', 'mate'].includes(result?.score?.type)
  && Number.isFinite(result.score.value);

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
