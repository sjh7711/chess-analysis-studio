export const ENGINES = Object.freeze({
  lite: { name: 'Stockfish 19 Lite', worker: '/engine/stockfish-19-lite-single.js', parallelWorker: '/engine/stockfish-19-lite.js' },
  full: { name: 'Stockfish 19', worker: '/engine/stockfish-19-single.js', parallelWorker: '/engine/stockfish-19.js' },
});
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
export const DEFAULT_PERFORMANCE = Object.freeze({ movetime: 0, multipv: 3, hash: 32, threads: 1, reviewMode: 'fast' });
export function engineId(value) { return Object.keys(ENGINES).find(id => id === value || ENGINES[id].name === value) || 'lite'; }
export function supportedThreads(isolated = globalThis.crossOriginIsolated, cores = globalThis.navigator?.hardwareConcurrency || 1) {
  return isolated && typeof SharedArrayBuffer !== 'undefined' ? [1, 2, 4, 8].filter(n => n <= cores).at(-1) || 1 : 1;
}
export function normalizePerformance(value = {}, maxThreads = 8) {
  value ||= {};
  return {
    reviewMode: value.reviewMode === 'precise' ? 'precise' : 'fast',
    movetime: [0, 500, 1000, 3000, 5000, 10000, 30000].includes(value.movetime) ? value.movetime : 0,
    multipv: [1, 2, 3, 5].includes(value.multipv) ? value.multipv : 3,
    hash: [16, 32, 64, 128, 256].includes(value.hash) ? value.hash : 32,
    threads: [1, 2, 4, 8].includes(value.threads) && value.threads <= maxThreads ? value.threads : 1,
  };
}
export function searchOptions(depth, performance = DEFAULT_PERFORMANCE) {
  const limits = { 12: 600, 16: 1200, 20: 3000, 24: 5000 };
  return { depth, movetime: performance.movetime || limits[depth] || 1200, multipv: performance.multipv, hash: performance.hash, threads: performance.threads };
}
export function analysisKey(id, depth, performance) {
  const options = searchOptions(depth, performance);
  return [id, options.depth, options.movetime, options.multipv, options.hash, options.threads].join(':');
}

export function reviewOptions(depth, performance = DEFAULT_PERFORMANCE) {
  const options = searchOptions(depth, performance);
  if (performance.reviewMode === 'precise') return options;
  return { ...options, multipv: Math.min(2, options.multipv), movetime: Math.min(1500, Math.ceil(options.movetime / 2)) };
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
