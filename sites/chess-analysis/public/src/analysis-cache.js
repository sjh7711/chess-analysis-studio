// A manual branch must use its own complete position policy. Original-game
// roots can have fewer candidates or a shallower overview depth, so their
// timing must not decide which evidence grades a newly explored move.
export function isPositionResultCached(result, key) {
  return !!result && (!!result.terminal || result.configKey === key && !result.overview);
}
