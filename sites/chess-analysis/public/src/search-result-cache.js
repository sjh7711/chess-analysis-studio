import { Chess, uciMove } from './chess-core.js';

// Bump this namespace whenever the shipped JS/WASM/NNUE or cold-search policy
// changes. Scheduling and observer callbacks are not search inputs.
export const SEARCH_CACHE_REVISION = 'stockfish.js-19.0.0-cold-v1';
const uci = move => typeof move === 'string' && /^[a-h][1-8][a-h][1-8][nbrq]?$/.test(move);
const positive = value => Number.isSafeInteger(value) && value > 0;
const encodedBytes = value => new TextEncoder().encode(value).byteLength;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// The effective constructor settings belong here: per-query hash/threads
// properties do not change a running worker's UCI options. Preserve the full
// history and restricted-root order rather than identifying a query by FEN.
export function exactSearchKey({ engineId, hash, threads, position, depth, multipv,
  searchMoves, searchMode, revision = SEARCH_CACHE_REVISION } = {}) {
  if (searchMode !== 'depth' || threads !== 1 || !['lite', 'full'].includes(engineId)
    || !positive(hash) || !positive(depth) || depth > 128 || !positive(multipv)
    || typeof revision !== 'string' || !revision
    || typeof position !== 'string' || !position.startsWith('position fen ')
    || !position.slice(13).trim()
    || searchMoves !== undefined && (!Array.isArray(searchMoves) || !searchMoves.length || searchMoves.some(move => !uci(move)))) return null;
  return JSON.stringify([revision, 'depth', engineId, hash, threads, position, depth, multipv, searchMoves ?? null]);
}

function queryFor(key) {
  if (typeof key !== 'string') return null;
  try {
    const fields = JSON.parse(key);
    if (!Array.isArray(fields) || fields.length !== 9) return null;
    const [revision, searchMode, engineId, hash, threads, position, depth, multipv, roots] = fields;
    const searchMoves = roots === null ? undefined : roots;
    if (exactSearchKey({revision, searchMode, engineId, hash, threads, position, depth, multipv, searchMoves}) !== key) return null;
    const parts = position.slice('position fen '.length).split(' moves ');
    if (parts.length > 2 || parts[0].trim().split(/\s+/).length !== 6) return null;
    const chess = new Chess(parts[0]);
    if (parts.length === 2) {
      if (!parts[1]) return null;
      for (const move of parts[1].split(' ')) {
        if (!uci(move)) return null;
        chess.move(move);
      }
    }
    // Terminal evaluations are cheap and history-dependent. Let the engine
    // compute them directly instead of storing them as a completed search.
    if (chess.isGameOver()) return null;
    const legal = new Set(chess.moves({verbose:true}).map(uciMove));
    if (searchMoves?.some(move => !legal.has(move))) return null;
    const rootMoves = searchMoves ? new Set(searchMoves) : legal;
    return { chess, depth, roots: rootMoves, count: Math.min(multipv, rootMoves.size) };
  } catch { return null; }
}

const bounded = value => !!(value?.lowerbound || value?.upperbound || value?.lowerBound
  || value?.upperBound || value?.bound && value.bound !== 'exact');
function validScore(score) {
  return !!score && !bounded(score) && ['cp', 'mate'].includes(score.type)
    && Number.isSafeInteger(score.value)
    && (score.type !== 'mate' || ['w', 'b'].includes(score.winner));
}
const sameScore = (left, right) => left.type === right.type && left.value === right.value
  && (left.winner ?? null) === (right.winner ?? null);

function completedResult(query, result) {
  if (!query || !result || result.terminal || result.cancelled || result.aborted
    || bounded(result) || own(result, 'moveReview') || own(result, 'overview') || own(result, 'configKey')
    || result.searchMode !== 'depth' || result.depth !== query.depth || result.requestedDepth !== query.depth
    || result.multipvComplete !== true || !validScore(result.score)
    || !Array.isArray(result.lines) || result.lines.length !== query.count || !query.count
    || !uci(result.bestmove) || result.bestmove !== result.lines[0]?.pv?.[0]
    || result.engineBestmove !== undefined && !query.roots.has(result.engineBestmove)) return false;
  const seen = new Set();
  for (const [index, line] of result.lines.entries()) {
    if (!line || bounded(line) || line.depth !== query.depth || line.multipv !== index + 1
      || !validScore(line.score) || !Array.isArray(line.pv) || !line.pv.length
      || line.pv.some(move => !uci(move)) || !query.roots.has(line.pv[0]) || seen.has(line.pv[0])) return false;
    seen.add(line.pv[0]);
    try {
      const probe = new Chess(query.chess.fen());
      for (const move of line.pv) probe.move(move);
    } catch { return false; }
  }
  return sameScore(result.score, result.lines[0].score);
}

// Store completed results only. No running promise/engine lease is shared, so
// cancellation and foreground priority remain owned by the worker pool.
export class CompletedSearchCache {
  #entries = new Map();
  #bytes = 0;
  #stats = { hits:0, misses:0, writes:0, rejections:0, evictions:0 };

  constructor({ maxEntries = 512, maxBytes = 8 * 1024 * 1024 } = {}) {
    if (!positive(maxEntries) || !positive(maxBytes)) throw new RangeError('Search cache limits must be positive safe integers.');
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get metrics() { return { ...this.#stats, entries:this.#entries.size, bytes:this.#bytes }; }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) { this.#stats.misses++; return undefined; }
    this.#entries.delete(key); this.#entries.set(key, entry);
    this.#stats.hits++;
    return structuredClone(entry.result);
  }

  set(key, result) {
    try {
      if (!completedResult(queryFor(key), result)) { this.#stats.rejections++; return false; }
      const copy = structuredClone(result), bytes = encodedBytes(key) + encodedBytes(JSON.stringify(copy));
      if (bytes > this.maxBytes) { this.#stats.rejections++; return false; }
      const previous = this.#entries.get(key);
      if (previous) { this.#bytes -= previous.bytes; this.#entries.delete(key); }
      this.#entries.set(key, { result:copy, bytes }); this.#bytes += bytes; this.#stats.writes++;
      while (this.#entries.size > this.maxEntries || this.#bytes > this.maxBytes) {
        const oldest = this.#entries.keys().next().value, entry = this.#entries.get(oldest);
        this.#entries.delete(oldest); this.#bytes -= entry.bytes; this.#stats.evictions++;
      }
      return true;
    } catch { this.#stats.rejections++; return false; }
  }

  clear() {
    this.#entries.clear(); this.#bytes = 0;
    this.#stats = { hits:0, misses:0, writes:0, rejections:0, evictions:0 };
  }
}
