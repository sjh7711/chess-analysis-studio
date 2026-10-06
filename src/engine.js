import { parseInfo, positionCommand, terminalResult } from './chess-core.js';
import { workerUrl } from './engine-options.js';

export class StockfishEngine {
  constructor(WorkerType = Worker, { engineId = 'lite', hash = 32, threads = 1, onLoad = () => {} } = {}) {
    this.pending = null;
    this.searchGeneration = 0;
    this.idle = Promise.resolve();
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
            clearTimeout(this.readyTimer);
            resolve();
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
  async analyze(chess, { depth = 16, movetime = 1200, multipv = 3, onInfo } = {}) {
    const generation = this.searchGeneration;
    await this.ready;
    await this.idle;
    if (this.closed || generation !== this.searchGeneration) throw new DOMException('Cancelled', 'AbortError');
    if (this.pending) throw new Error('An engine search is already running.');
    const terminal = terminalResult(chess);
    if (terminal) return terminal;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('분석 시간이 초과되었습니다. 다시 시도해 주세요.')), movetime + 15000);
      this.idle = new Promise(done => { this.resolveIdle = done; });
      this.pending = { resolve, reject, timer, turn: chess.turn(), lines: new Map(), onInfo, cancelled: false };
      this.send(`setoption name MultiPV value ${multipv}`);
      this.send(positionCommand(chess));
      this.send(`go depth ${depth} movetime ${movetime}`);
    });
  }
  handleLine(line) {
    const pending = this.pending;
    if (!pending) return;
    const info = parseInfo(line, pending.turn);
    if (info && !pending.cancelled) {
      pending.lines.set(info.multipv, info);
      pending.onInfo?.(info);
    }
    if (line.startsWith('bestmove ')) {
      clearTimeout(pending.timer);
      this.pending = null;
      this.resolveIdle?.();
      this.resolveIdle = null;
      if (pending.cancelled) return;
      const lines = [...pending.lines.values()].sort((a, b) => a.multipv - b.multipv);
      const first = lines.find(item => item.multipv === 1);
      if (!first) { pending.reject(new Error('엔진 평가를 얻지 못했습니다. 다시 분석해 주세요.')); return; }
      pending.resolve({ score: first.score, depth: first.depth, lines, bestmove: line.split(' ')[1] });
    }
  }
  cancel() {
    this.searchGeneration++;
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
    this.resolveIdle?.();
    this.resolveIdle = null;
    this.abort.abort();
    this.worker?.terminate();
    this.closed = true;
  }
  dispose() { this.fail(new DOMException('Cancelled', 'AbortError')); }
}
