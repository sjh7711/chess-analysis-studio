import { parseInfo, positionCommand, terminalResult, uciMove } from './chess-core.js';
import { workerUrl } from './engine-options.js';

function recordIteration(pending, info) {
  if (!pending.rootMoves.has(info.pv[0]) || info.multipv < 1 || info.multipv > pending.multipv) return;
  const previous = pending.rootLines.get(info.pv[0]);
  if (!previous || info.depth >= previous.depth) pending.rootLines.set(info.pv[0], info);
  let iteration = pending.iterations.get(info.depth);
  // A repeated first line begins another batch at this depth. Keep its previous
  // complete snapshot until every candidate in the replacement batch arrives.
  if (!iteration || (info.multipv === 1 && iteration.has(1))) {
    iteration = new Map();
    pending.iterations.set(info.depth, iteration);
  }
  iteration.set(info.multipv, info);
  const lines = Array.from({ length: pending.multipv }, (_, index) => iteration.get(index + 1));
  if (lines.some(item => !item) || new Set(lines.map(item => item.pv[0])).size !== pending.multipv) return;
  if (!pending.completed || info.depth >= pending.completed[0].depth) pending.completed = lines;
}

function finalResult(pending, engineBestmove) {
  // A timed stop can choose a root move from an unfinished deeper iteration.
  // Present the last complete candidate set as one consistent snapshot instead
  // of pairing its score with that newer move. Preserve the raw UCI choice too.
  let lines = pending.completed;
  if (!lines) {
    const line = pending.rootLines.get(engineBestmove);
    if (!line) throw new Error('엔진 최선수와 일치하는 평가를 얻지 못했습니다. 다시 분석해 주세요.');
    // No complete iteration is available: only this move's own evaluation is
    // reliable. Other partial candidates must not imply a completed ranking.
    lines = [{ ...line, multipv: 1 }];
  }
  const first = lines[0];
  return { score: first.score, depth: first.depth, lines, bestmove: first.pv[0], engineBestmove, multipvComplete: Boolean(pending.completed) };
}

// Search activity is not an evaluation. In a long iteration Stockfish also
// reports bounds and current-move/node messages with no publishable score/PV.
// Keep those metrics observable without admitting them to the result snapshot.
function searchActivity(line) {
  if (!line.startsWith('info ') || line.startsWith('info string ')) return null;
  const metrics = {};
  for (const key of ['depth', 'seldepth', 'multipv', 'nodes', 'nps', 'time', 'hashfull']) {
    const match = line.match(new RegExp(`\\b${key} (\\d+)(?=\\s|$)`));
    const value = match ? Number(match[1]) : NaN;
    if (Number.isSafeInteger(value)) metrics[key] = value;
  }
  return Object.keys(metrics).length ? metrics : null;
}

export class StockfishEngine {
  constructor(WorkerType = Worker, { engineId = 'lite', hash = 32, threads = 1, onLoad = () => {} } = {}) {
    this.pending = null;
    this.resetPending = null;
    this.initialized = false;
    this.searchGeneration = 0;
    this.idle = Promise.resolve();
    this.searchQueue = Promise.resolve();
    this.closed = false;
    this.abort = new AbortController();
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      this.readyTimer = setTimeout(() => this.fail(new Error('엔진을 불러오지 못했습니다. 다시 시도하거나 Lite를 선택해 주세요.')), engineId === 'full' ? 180000 : 20000);
      workerUrl(engineId, { signal: this.abort.signal, threads, onProgress: onLoad }).then(url => {
      if (this.closed) return;
      onLoad(100);
      this.worker = new WorkerType(url);
      this.worker.onmessage = event => {
        for (const line of String(event.data).split('\n')) {
          if (line === 'uciok') {
            if (threads > 1) this.send(`setoption name Threads value ${threads}`);
            this.send(`setoption name Hash value ${hash}`);
            this.send('isready');
          } else if (line === 'readyok') {
            if (!this.initialized) {
              this.initialized = true;
              clearTimeout(this.readyTimer);
              resolve();
            } else if (this.resetPending) {
              const reset = this.resetPending;
              clearTimeout(reset.timer);
              this.resetPending = null;
              this.resolveIdle?.();
              this.resolveIdle = null;
              if (!reset.cancelled) reset.resolve();
            }
          } else this.handleLine(line);
        }
      };
      this.worker.onerror = event => {
        console.error('Stockfish worker:',event.message);
        this.fail(new Error('Stockfish 실행 중 오류가 발생했습니다. 새로고침 후 다시 시도해 주세요.'));
      };
      this.worker.onmessageerror = () => this.fail(new Error('엔진 응답을 읽지 못했습니다.'));
      this.send('uci');
      }).catch(error => this.fail(error));
    });
    // Cancellation can precede the caller awaiting initialization.
    this.ready.catch(() => {});
  }
  send(command) { if (!this.closed) this.worker.postMessage(command); }
  async reset() {
    const generation = this.searchGeneration;
    await this.ready;
    // A queued operation may reserve a new idle promise before this one wakes.
    // Recheck it in the same continuation that reserves the reset barrier.
    for (;;) {
      const idle = this.idle;
      await idle;
      if (this.closed || generation !== this.searchGeneration) throw new DOMException('Cancelled', 'AbortError');
      if (idle === this.idle) break;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('분석 초기화 응답을 받지 못했습니다. 다시 시도해 주세요.')), 10000);
      this.idle = new Promise(done => { this.resolveIdle = done; });
      this.resetPending = { resolve, reject, timer, cancelled: false };
      // Stockfish clears the transposition table and search histories for a new
      // game. The ready acknowledgement keeps the next job behind that work.
      this.send('ucinewgame');
      this.send('isready');
    });
  }
  analyze(chess, options = {}) {
    const generation=this.searchGeneration;
    const task=this.searchQueue.catch(()=>{}).then(async()=>{
      if(this.closed || generation!==this.searchGeneration)throw new DOMException('Cancelled','AbortError');
      // Reset and search share one queue reservation, so another queued search
      // cannot reset early and then inherit this one's transposition table.
      if(options.searchMode==='depth')await this.reset();
      return this.search(chess,options);
    });
    this.searchQueue=task.catch(()=>{});
    return task;
  }
  async search(chess, { depth = 16, movetime = 1200, multipv = 3, searchMoves, onInfo, onSearchInfo, searchMode } = {}) {
    const generation = this.searchGeneration;
    await this.ready;
    for (;;) {
      const idle = this.idle;
      await idle;
      if (this.closed || generation !== this.searchGeneration) throw new DOMException('Cancelled', 'AbortError');
      if (idle === this.idle) break;
    }
    if (this.pending) throw new Error('An engine search is already running.');
    if(searchMode==='depth' && (!Number.isInteger(depth)||depth<1||depth>128))throw new Error('유효한 탐색 깊이가 필요합니다.');
    if (!Number.isInteger(multipv) || multipv < 1) throw new Error('후보 수는 1 이상의 정수여야 합니다.');
    const legalMoves = new Set(chess.moves({ verbose: true }).map(uciMove));
    let roots;
    if (searchMoves !== undefined) {
      if (!Array.isArray(searchMoves) || !searchMoves.length || searchMoves.some(move => typeof move !== 'string' || !legalMoves.has(move))) {
        throw new Error('제한 분석에는 현재 국면의 합법적인 UCI 수가 필요합니다.');
      }
      roots = [...new Set(searchMoves)];
    }
    const terminal = terminalResult(chess);
    if (terminal) return terminal;
    const rootMoves = roots ? new Set(roots) : legalMoves;
    const candidateCount = Math.min(multipv, rootMoves.size);
    return new Promise((resolve, reject) => {
      // A watchdog is a failed job, never a lower-depth completed evaluation.
      // It does not publish partial scores when the device cannot finish.
      const timeout=searchMode==='depth'?(depth>=24?600000:depth>=20?300000:180000):movetime+15000;
      const timer = setTimeout(() => this.fail(new Error('분석을 완료하지 못했습니다. 깊이를 낮추거나 다시 시도해 주세요.')), timeout);
      this.idle = new Promise(done => { this.resolveIdle = done; });
      this.pending = { resolve, reject, timer, turn: chess.turn(), rootMoves, multipv: candidateCount, iterations: new Map(), rootLines: new Map(), completed: null, onInfo, onSearchInfo, cancelled: false, searchMode, requestedDepth:depth };
      this.send(`setoption name MultiPV value ${candidateCount}`);
      this.send(positionCommand(chess));
      this.send(`go depth ${depth}${searchMode==='depth'?'':` movetime ${movetime}`}${roots ? ` searchmoves ${roots.join(' ')}` : ''}`);
    });
  }
  handleLine(line) {
    const pending = this.pending;
    if (!pending) return;
    if (!pending.cancelled && typeof pending.onSearchInfo === 'function') {
      const activity = searchActivity(line);
      if (activity) {
        try { Promise.resolve(pending.onSearchInfo(activity)).catch(() => {}); }
        catch { /* An activity observer cannot interrupt the engine protocol. */ }
      }
    }
    const info = parseInfo(line, pending.turn);
    if (info && !pending.cancelled) {
      recordIteration(pending, info);
      pending.onInfo?.(info);
    }
    if (line.startsWith('bestmove ')) {
      clearTimeout(pending.timer);
      this.pending = null;
      this.resolveIdle?.();
      this.resolveIdle = null;
      if (pending.cancelled) return;
      try {
        const result=finalResult(pending,line.trim().split(/\s+/)[1]);
        if(pending.searchMode==='depth'){
          if(!result.multipvComplete || result.depth!==pending.requestedDepth){
            const error=new Error('설정한 깊이의 분석을 완료하지 못했습니다. 다시 시도해 주세요.');
            error.code='INCOMPLETE_DEPTH';throw error;
          }
          result.searchMode='depth';result.requestedDepth=pending.requestedDepth;
        }
        pending.resolve(result);
      }
      catch (error) { pending.reject(error); }
    }
  }
  cancel() {
    this.searchGeneration++;
    if (this.resetPending && !this.resetPending.cancelled) {
      this.resetPending.cancelled = true;
      this.resetPending.reject(new DOMException('Cancelled', 'AbortError'));
      // Drain its readyok before a later job; an acknowledgement has no UCI id.
    }
    if (!this.pending || this.pending.cancelled) return;
    this.pending.cancelled = true;
    this.pending.reject(new DOMException('Cancelled', 'AbortError'));
    this.send('stop');
    // Drain bestmove before another search, retaining the worker and its hash table.
  }
  fail(error) {
    clearTimeout(this.readyTimer);
    this.rejectReady?.(error);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
    if (this.resetPending) { clearTimeout(this.resetPending.timer); this.resetPending.reject(error); this.resetPending = null; }
    this.resolveIdle?.();
    this.resolveIdle = null;
    this.abort.abort();
    this.worker?.terminate();
    this.closed = true;
  }
  dispose() { this.fail(new DOMException('Cancelled', 'AbortError')); }
}
