export const ENGINES = Object.freeze({
  lite: { name: 'Stockfish 19 Lite', worker: '/engine/stockfish-19-lite-single.js', parallelWorker: '/engine/stockfish-19-lite.js' },
  full: { name: 'Stockfish 19', worker: '/engine/stockfish-19-single.js', parallelWorker: '/engine/stockfish-19.js' },
});
export const DEFAULT_ENGINE_ID = 'lite';
export const REVIEW_ENGINE_ID = 'lite';
export const FULL_ENGINE_SIZE = 99102793;
export const ENGINE_CHUNK_SIZE = 20 * 1024 * 1024;
export function engineChunks(parallel = false) {
  const size = parallel ? 99065439 : FULL_ENGINE_SIZE;
  return Array.from({ length: Math.ceil(size / ENGINE_CHUNK_SIZE) }, (_, i) => ({
  url: `/engine/stockfish-19${parallel ? '' : '-single'}.part-${i}.wasm`,
  start: i * ENGINE_CHUNK_SIZE,
  size: Math.min(ENGINE_CHUNK_SIZE, size - i * ENGINE_CHUNK_SIZE),
}));
}
export const AUTO_THREAD_FRACTION = 0.4;
export const AUTO_THREAD_LABEL = '자동 · 논리 코어 약 40%';
export const DEFAULT_PERFORMANCE = Object.freeze({ movetime: 0, multipv: 3, hash: 32, threadMode: 'auto', threads: 1, reviewMode: 'precise' });
export function engineId(value) { return Object.keys(ENGINES).find(id => id === value || ENGINES[id].name === value) || DEFAULT_ENGINE_ID; }
const logicalCores = value => Number.isFinite(value)&&value>=1?Math.floor(value):1;
const threadLimit = value => Math.min(8,logicalCores(value));
// Independent single-thread workers do not share memory and therefore do not
// require the isolation headers needed by the engine's internal pthread build.
export function availableReviewWorkers(cores = globalThis.navigator?.hardwareConcurrency || 1) {
  return Array.from({length:threadLimit(cores)},(_,index)=>index+1);
}
export function availableThreads(isolated = globalThis.crossOriginIsolated, cores = globalThis.navigator?.hardwareConcurrency || 1) {
  const maximum=isolated&&typeof SharedArrayBuffer!=='undefined'?threadLimit(cores):1;
  return Array.from({length:maximum},(_,index)=>index+1);
}
export function supportedThreads(isolated = globalThis.crossOriginIsolated, cores = globalThis.navigator?.hardwareConcurrency || 1) {
  return availableThreads(isolated,cores).at(-1);
}
// The detected task limit is authoritative. This is a conservative share of
// logical cores, not a measurement or promise of system-wide CPU utilization.
export function automaticThreads(maxThreads = availableReviewWorkers().at(-1), cores = globalThis.navigator?.hardwareConcurrency || 1) {
  return Math.max(1,Math.min(threadLimit(maxThreads),Math.floor(logicalCores(cores)*AUTO_THREAD_FRACTION)));
}
export function normalizePerformance(value = {}, maxThreads = availableReviewWorkers().at(-1), cores = globalThis.navigator?.hardwareConcurrency || 1) {
  value ||= {};
  const maximum=threadLimit(maxThreads),threadMode=value.threadMode==='manual'?'manual':'auto';
  return {
    reviewMode: value.reviewMode === 'fast' ? 'fast' : 'precise',
    movetime: [0, 500, 1000, 3000, 5000, 10000, 30000].includes(value.movetime) ? value.movetime : 0,
    multipv: [1, 2, 3, 5].includes(value.multipv) ? value.multipv : 3,
    hash: [16, 32, 64, 128, 256].includes(value.hash) ? value.hash : 32,
    threadMode,
    threads: threadMode==='auto'?automaticThreads(maximum,cores)
      :Number.isInteger(value.threads)&&value.threads>=1&&value.threads<=maximum?value.threads:1,
  };
}
export function searchOptions(depth, performance = DEFAULT_PERFORMANCE) {
  const limits = { 12: 600, 16: 1200, 20: 3000, 24: 5000 };
  return { depth, movetime: performance.movetime || limits[depth] || 1200, multipv: performance.multipv, hash: performance.hash, threads: performance.threads };
}
export function analysisKey(id, depth, performance, scope = 'position') {
  const options = scope === 'game' ? gameReviewOptions(depth, performance) : searchOptions(depth, performance);
  // The scope distinguishes a completed game review from an explicitly requested
  // position search with more candidates. v7 also separates reviews that can
  // carry a history-bound, deeper proof of a played move's mating continuation.
  return ['review-v7',scope,id, options.depth, options.movetime, options.multipv, options.hash, options.threads].join(':');
}

export function reviewOptions(depth, performance = DEFAULT_PERFORMANCE) {
  const options = searchOptions(depth, performance);
  if (performance.reviewMode === 'precise') return options;
  return { ...options, multipv: Math.min(2, options.multipv), movetime: Math.min(1500, Math.ceil(options.movetime / 2)) };
}

export function gameReviewOptions(depth, performance = DEFAULT_PERFORMANCE) {
  const options = reviewOptions(depth, performance);
  // Move grading uses the best move and its runner-up. More alternatives remain
  // available through searchOptions for a user-requested position analysis.
  return { ...options, multipv: Math.min(2, options.multipv) };
}

const fullEngineUrls = new Map();
export async function workerUrl(id, { signal, threads = 1, onProgress = () => {} } = {}) {
  const parallel = threads > 1;
  if (id !== 'full') return `${parallel ? ENGINES.lite.parallelWorker : ENGINES.lite.worker}?v=19.0.0`;
  if (fullEngineUrls.has(parallel)) return fullEngineUrls.get(parallel);
  let received = 0;
  onProgress(0);
  const chunks = engineChunks(parallel);
  const total = chunks.reduce((size,chunk)=>size+chunk.size,0);
  const parts = await Promise.all(chunks.map(async chunk => {
    const buffers = [];
    signal?.throwIfAborted();
    const response = await fetch(chunk.url, { signal });
    if (!response.ok) throw new Error('Stockfish 19 다운로드에 실패했습니다. 다시 시도하거나 Lite를 선택해 주세요.');
    const reader = response.body.getReader();
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffers.push(value); length += value.byteLength; received += value.byteLength;
      onProgress(Math.min(100, Math.floor(received / total * 100)));
    }
    if (length !== chunk.size) throw new Error('엔진 다운로드가 완전하지 않습니다. 다시 시도해 주세요.');
    return buffers;
  }));
  signal?.throwIfAborted();
  const binary = new Blob(parts.flat(), { type: 'application/wasm' });
  const header = new Uint8Array(await binary.slice(0, 4).arrayBuffer());
  if (header.join(',') !== '0,97,115,109') throw new Error('올바른 Stockfish 엔진 파일이 아닙니다.');
  signal?.throwIfAborted();
  // Stockfish.js accepts an alternate WASM URL in its worker URL hash.
  const url = `${parallel ? ENGINES.full.parallelWorker : ENGINES.full.worker}#${encodeURIComponent(URL.createObjectURL(binary))}`;
  fullEngineUrls.set(parallel, url);
  return url;
}
