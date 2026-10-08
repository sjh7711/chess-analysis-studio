import { Chess, parseGame, gameAt, classifyMove, MOVE_GRADES, GRADING_BASIS, formatScore, scoreValue, pvToSan, exportPgn } from './chess-core.js';
import { StockfishEngine } from './engine.js';
import { ENGINES, engineId, normalizePerformance, supportedThreads, searchOptions, reviewOptions, analysisKey, DEFAULT_PERFORMANCE } from './engine-options.js';
import { pieceSvg, pieceSnapshot, pieceTransitions, StepNavigation, capturedPieces, capturedMarkup } from './pieces.js';
import { BoardAnnotations } from './annotations.js';
import { SAMPLE_PGN } from './sample.js';
import { AnalysisLine, PlaybackClock, PIECE_NAMES, editedPosition, materialBalance, exportLine, restoreResults, moveText } from './study.js';
import { createInsightLine, describeMove, explainMistake, moveLabel, moveTurn } from './insight.js';
import { completionAlerts } from './notification-center.js';
import { MoveSounds } from './move-sounds.js';

const $ = id => document.getElementById(id);
const moveSounds=new MoveSounds({button:$('move-sound')});
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const STORAGE = 'chessreview.v1';
const LIBRARY = 'chessreview.library.v1';
let removedGame = null, exportFilename = 'chess-review.pgn', insightContext = null, insightMarkup = '';
let coachCache=null;
let moveListScroll=0, restoreMoveListScroll=false;
let renderedBoard=null, renderedFlipped=false, editorPieceId=0;
const pieceMotions=new Map();
const stepNavigation=new StepNavigation(()=>pieceMotions.size>0);
const settings = { 12: true, 16: true, 20: true, 24: true };
const maxThreads = supportedThreads();
let selectedEngine = 'lite', performanceOptions = normalizePerformance({}, maxThreads);
const state = { game:parseGame(SAMPLE_PGN), index:59, flipped:false, results:new Map(), line:null, editor:null, playing:false, selected:null, mode:null, preview:null, error:null, tab:'moves', chartMode:'game' };
const annotations=new BoardAnnotations($('board'),{isFlipped:()=>state.flipped,enabled:()=>!state.editor,toggleButton:$('annotation-mode'),clearButton:$('annotation-clear')});
let engine = null, engineConfig = '', generation = 0, debounce, toastTimer, pendingPromotion, draggedSquare, suppressClickUntil = 0, previewPaint = 0;
const playback = new PlaybackClock(advancePlayback);
window.addEventListener('analysis-notice',({detail:{message,test}})=>{
  toast(message);
  if(!test)document.title='✓ 분석 완료 · 체스 분석';
});

try {
  const saved = JSON.parse(localStorage.getItem(STORAGE));
  if (saved?.input) {
    state.game = parseGame(saved.input, saved.kind);
    state.index = Math.min(state.game.moves.length, Math.max(0, Number(saved.index) || 0));
    if (settings[saved.depth]) $('depth').value = saved.depth;
    selectedEngine = engineId(saved.engine);
    performanceOptions = normalizePerformance(saved.performance, maxThreads);
    state.results = restoreResults(saved,state.game.positions.length,ENGINES[selectedEngine].name);
    for (const [index,result] of state.results) if (!isCached(result)) state.results.delete(index);
  }
} catch { /* Unavailable or outdated local storage never prevents startup. */ }

function snapshotCurrent() { return { input:state.game.input, kind:state.game.kind, index:state.index, depth:$('depth').value, engine:ENGINES[selectedEngine].name, performance:performanceOptions, results:[...state.results] }; }
function persist() {
  try { localStorage.setItem(STORAGE, JSON.stringify(snapshotCurrent())); }
  catch { /* Private browsing and storage limits are non-fatal. */ }
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
}
function currentChess() { return state.line ? state.line.position() : gameAt(state.game, state.index); }
function evaluationColor() { return state.flipped ? 'b' : 'w'; }
function evaluationSide() { return state.flipped ? '흑' : '백'; }
function displayScore(score) { return formatScore(score, evaluationColor()); }
function displayValue(score) { return scoreValue(score, evaluationColor()); }
function evaluationHint() { return `${evaluationSide()} 기준 (+ ${evaluationSide()} 우세, − ${state.flipped ? '백' : '흑'} 우세)`; }
function currentResult() { return state.line ? state.line.results.get(state.line.cursor) : state.results.get(state.index); }
function gradeAt(index) { return classifyMove(state.results.get(index-1),state.results.get(index),state.game.moves[index-1],{previous:state.results.get(index-2)}); }
function shownResult() { return state.editor ? null : currentResult() || (state.preview?.fen === currentChess().fen() ? state.preview : null); }
function configKey() { return analysisKey(selectedEngine,Number($('depth').value),performanceOptions); }
function isCached(result) {
  if (!result) return false;
  if (result.terminal) return true;
  if (result.overview && performanceOptions.reviewMode === 'precise') return false;
  if (result.configKey) return result.configKey === configKey();
  return selectedEngine === 'lite' && configKey() === analysisKey('lite',Number($('depth').value),DEFAULT_PERFORMANCE) && result.requestedDepth === Number($('depth').value);
}
function createEngine(run) {
  const nextConfig = `${selectedEngine}:${performanceOptions.hash}:${performanceOptions.threads}`;
  if (engine && !engine.closed && engineConfig === nextConfig) return engine;
  engine?.dispose();
  engineConfig = nextConfig;
  return new StockfishEngine(Worker, { engineId:selectedEngine, ...performanceOptions, onLoad:percent => {
    if (engineConfig !== nextConfig) return;
    $('engine-download').hidden = selectedEngine !== 'full' || percent >= 100;
    $('engine-download').textContent = `Stockfish 19 다운로드 ${percent}%`;
  } });
}

function stopJob() {
  if (state.playing) playback.hold();
  completionAlerts.cancel();
  generation++;
  clearTimeout(debounce);
  engine?.cancel();
  state.mode = null;
  state.preview = null;
  $('engine-download').hidden = true;
}

function scheduleAnalysis(autoReview = false) {
  if (state.mode === 'full' || state.editor) return;
  stopJob();
  renderAnalysis();
  if (state.line) renderStudy();
  const game = state.game;
  debounce = setTimeout(async () => {
    const work = analyzeCurrent();
    const run = generation;
    await work;
    if (autoReview && run === generation && game === state.game && !state.line && !state.editor && !state.error && game.moves.length && [...state.results.values()].filter(isCached).length < game.positions.length) analyzeGame();
  }, 140);
}

function updatePreview(info, fen, run) {
  if (run !== generation || (state.line ? state.line.position().fen() : state.game.positions[state.index]) !== fen) return;
  if (!state.preview || state.preview.fen !== fen) state.preview = { fen, lines:[] };
  state.preview.lines = [...state.preview.lines.filter(line => line.multipv !== info.multipv), info].sort((a,b) => a.multipv - b.multipv);
  if (info.multipv === 1) { state.preview.score = info.score; state.preview.depth = info.depth; state.preview.bestmove = info.pv[0]; }
  if (state.preview.score && !currentResult() && performance.now()-previewPaint >= 100) { previewPaint=performance.now(); renderAnalysis(); }
}

async function analyzeCurrent(force = false) {
  if (state.mode === 'full' || state.editor) return;
  if (!force && isCached(currentResult()) && !currentResult().overview) { renderAnalysis(); schedulePlayback(); return; }
  stopJob();
  const run = generation;
  const chess = currentChess();
  const fen = chess.fen();
  const index = state.index;
  const line = state.line;
  const cursor = line?.cursor;
  const options = searchOptions(Number($('depth').value),performanceOptions);
  state.mode = 'position';
  state.error = null;
  renderAnalysis();
  if (state.line) renderStudy();
  try {
    engine = createEngine(run);
    const result = await engine.analyze(chess, { ...options, onInfo:info => updatePreview(info, fen, run) });
    if (run !== generation) return;
    result.requestedDepth = options.depth;
    result.configKey = configKey();
    if (line) line.results.set(cursor,result);
    else { state.results.set(index, result); persist(); }
  } catch (error) {
    if (run === generation && error.name !== 'AbortError') { state.error = error.message; toast(error.message, true); }
  } finally {
    if (run === generation) { state.mode = null; state.preview = null; renderResults(); schedulePlayback(); }
  }
}

async function analyzeGame(restart = false) {
  if (state.editor) return;
  if (state.mode === 'full' && !restart) {
    stopJob(); persist(); renderResults(); toast('분석을 중단했습니다. 완료된 국면은 저장되어 있습니다.'); return;
  }
  pausePlayback();
  if (state.line) { state.line = null; state.selected = null; state.chartMode = 'game'; renderBoard(); renderStudy(); }
  stopJob();
  if (restart) { state.results.clear(); persist(); }
  const run = generation;
  const options = searchOptions(Number($('depth').value),performanceOptions);
  const overviewOptions = reviewOptions(Number($('depth').value),performanceOptions);
  completionAlerts.begin(run);
  document.title='체스 분석';
  let analyzed=0;
  state.mode = 'full'; state.error = null;
  const chess = new Chess(state.game.startFen);
  renderResults();
  try {
    engine = createEngine(run);
    for (let index = 0; index < state.game.positions.length; index++) {
      if (run !== generation) return;
      if (!isCached(state.results.get(index))) {
        state.preview = null;
        const fen = chess.fen();
        const detailed = index === state.index || performanceOptions.reviewMode === 'precise';
        const result = await engine.analyze(chess, { ...(detailed ? options : overviewOptions), onInfo:info => updatePreview(info, fen, run) });
        if (run !== generation) return;
        result.requestedDepth = options.depth;
        result.configKey = configKey();
        result.overview = !detailed;
        state.results.set(index, result);
        analyzed++;
        state.preview = null;
        renderResults();
        if (analyzed % 5 === 0) persist();
      }
      const move = state.game.moves[index];
      if (move) chess.move({ from:move.from, to:move.to, promotion:move.promotion });
    }
    while (run === generation && currentResult()?.overview) {
      const detailedIndex=state.index;
      const result = await engine.analyze(currentChess(), options);
      if (run !== generation) return;
      state.results.set(detailedIndex,{...result,requestedDepth:options.depth,configKey:configKey()});
    }
    if (run === generation && analyzed) completionAlerts.complete(run,`${state.game.headers.White || '백'} vs ${state.game.headers.Black || '흑'} · ${state.game.positions.length}개 국면 분석 완료`);
  } catch (error) {
    if (run === generation && error.name !== 'AbortError') { state.error = error.message; toast(error.message, true); }
  } finally {
    if (run === generation) { completionAlerts.cancel(run); state.mode = null; state.preview = null; renderResults(); persist(); }
  }
}

function renderGame() {
  const h = state.game.headers;
  for (const [id, side, label] of [['moves-white-header', 'White', '백'], ['moves-black-header', 'Black', '흑']]) {
    const name = h[side]?.trim();
    const heading = name && name !== '?' ? `${label} · ${name}` : label;
    $(id).textContent = heading;
    $(id).title = heading;
  }
  $('game-title').innerHTML = `${escape(h.White || '백')} <span>vs</span> ${escape(h.Black || '흑')}`;
  const tc = /^\d+$/.test(h.TimeControl) ? `${Number(h.TimeControl)/60}분` : h.TimeControl?.includes('+') ? `${h.TimeControl.split('+')[0]/60}분 + ${h.TimeControl.split('+')[1]}초` : null;
  $('game-meta').textContent = [h.Site === '?' ? null : h.Site, h.Date === '????.??.??' ? null : h.Date, tc, state.game.kind === 'fen' ? 'FEN 국면 분석' : `${state.game.moves.length}번 이동`].filter(Boolean).join(' · ');
  $('game-result').textContent = ({'1-0':'1–0','0-1':'0–1','1/2-1/2':'½–½'})[h.Result] || '—';
  $('game-result-label').textContent = ({'1-0':'백 승리','0-1':'흑 승리','1/2-1/2':'무승부'})[h.Result] || '분석 보드';
  $('chart-last').textContent = state.game.moves.length ? `${state.game.moves.at(-1).before.split(' ')[5]}수` : '현재 국면';
  renderAll();
}

function renderBoard() {
  const chess = currentChess();
  const files = state.flipped ? 'hgfedcba' : 'abcdefgh';
  const ranks = state.flipped ? '12345678' : '87654321';
  const history = chess.history({ verbose:true });
  const captured=capturedPieces(state.editor?[]:history);
  annotations.sync(state.editor?'editor':chess.fen());
  const lastMove = state.editor ? null : history.at(-1);
  const legal = !state.editor && state.selected ? chess.moves({ square:state.selected, verbose:true }) : [];
  const checkedKing = !state.editor && chess.isCheck() ? chess.board().flat().find(p => p?.type === 'k' && p.color === chess.turn())?.square : null;
  const checkLabel = checkedKing ? (chess.isCheckmate() ? '체크메이트' : '체크') : '';
  let html = '';
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
    const square = files[col] + ranks[row];
    const piece = state.editor ? state.editor.board.get(square) : chess.get(square);
    const dark = (square.charCodeAt(0) - 97 + Number(square[1])) % 2 === 1;
    const classes = ['square', dark ? 'dark' : '', [lastMove?.from,lastMove?.to].includes(square) ? 'last-move' : '', state.selected === square ? 'selected' : '', checkedKing === square ? 'in-check' : ''].filter(Boolean).join(' ');
    const label = `${square}${piece ? ` ${piece.color === 'w' ? '백' : '흑'} ${PIECE_NAMES[piece.type]}` : ' 빈 칸'}${checkedKing === square ? ` · ${checkLabel}` : ''}`;
    html += `<button class="${classes}" data-square="${square}" draggable="${!!piece}" role="gridcell" aria-label="${label}" aria-selected="${state.selected === square}">${row === 7 ? `<span class="coordinate file">${files[col]}</span>` : ''}${col === 0 ? `<span class="coordinate rank">${ranks[row]}</span>` : ''}${piece ? pieceSvg(piece.type,piece.color) : ''}${legal.some(m => m.to === square) ? `<span class="legal-dot ${piece ? 'capture' : ''}"></span>` : ''}</button>`;
  }
  $('board').innerHTML = html;
  animateBoard(state.editor ? {key:state.editor,pieces:[...state.editor.board].map(([square,piece])=>({...piece,square}))} : pieceSnapshot(chess,history));
  const h = state.game.headers;
  const material=materialBalance(state.editor?state.editor.board.values():chess.board().flat());
  for (const [location,color] of [['top',state.flipped ? 'w' : 'b'],['bottom',state.flipped ? 'b' : 'w']]) {
    const side = color === 'w' ? 'White' : 'Black';
    $(`${location}-player`).textContent = h[side] || (color === 'w' ? '백' : '흑');
    $(`${location}-rating`).textContent = h[`${side}Elo`] || '';
    const advantage = material[color] - material[color === 'w' ? 'b' : 'w'];
    $(`${location}-material`).textContent = `기물 ${material[color]}점${advantage > 0 ? ` (+${advantage})` : ''}`;
    $(`${location}-material`).setAttribute('aria-label',`${color === 'w' ? '백' : '흑'} 기물 점수 ${material[color]}점${advantage > 0 ? `, ${advantage}점 우세` : ''}`);
    $(`${location}-side`).textContent = side.toUpperCase();
    $(`${location}-captured`).innerHTML=capturedMarkup(captured[color],color);
    const active = (state.editor?.turn || chess.turn()) === color;
    const strip = $(`${location}-player`).closest('.player-strip');
    strip.classList.toggle('active-turn',active);
    strip.setAttribute('aria-label',`${color === 'w' ? '백' : '흑'} ${h[side] || ''}${active ? ' · 현재 차례' : ''}`);
    const avatar = $(`${location}-player`).parentElement.previousElementSibling;
    avatar.className = `avatar ${color === 'w' ? 'light-avatar' : 'dark-avatar'}`;
    avatar.textContent = color === 'w' ? '♔' : '♚';
  }
  const cursor = state.line ? state.line.cursor : state.index;
  const length = state.line ? state.line.steps.length : state.game.moves.length;
  $('move-position').textContent = `${state.line ? '탐색 ' : ''}${cursor} / ${length}`;
  $('first').disabled = $('prev').disabled = !!state.editor || cursor === 0;
  $('next').disabled = $('last').disabled = !!state.editor || cursor === length;
  renderArrow();
}

function renderArrow() {
  const arrow = $('best-arrow');
  const move = shownResult()?.bestmove;
  const nextStep = state.line?.steps[state.line.cursor];
  const arrowMove = state.line?.kind === 'pv' ? nextStep?.uci : move;
  if (state.editor || !$('show-arrow').checked || !arrowMove || !/^[a-h][1-8][a-h][1-8]/.test(arrowMove) || (state.selected && state.selected !== arrowMove.slice(0,2))) { arrow.setAttribute('visibility','hidden'); return; }
  const xy = square => { let col = square.charCodeAt(0)-97, row = 8-Number(square[1]); if (state.flipped) { col=7-col; row=7-row; } return [col*100+50,row*100+50]; };
  const [x1,y1] = xy(arrowMove.slice(0,2)), [x2,y2] = xy(arrowMove.slice(2,4));
  const length = Math.hypot(x2-x1,y2-y1);
  arrow.setAttribute('x1',x1); arrow.setAttribute('y1',y1);
  arrow.setAttribute('x2',x2-(x2-x1)*17/length); arrow.setAttribute('y2',y2-(y2-y1)*17/length);
  arrow.setAttribute('visibility','visible');
}

function renderCoach() {
  const cursor=state.line ? state.line.cursor : state.index;
  const move=state.line ? state.line.steps[cursor-1] : state.game.moves[cursor-1];
  const results=state.line ? state.line.results : state.results;
  const before=results.get(cursor-1), after=results.get(cursor), previous=results.get(cursor-2);
  let comment;
  if (state.editor) comment={grade:null,text:'기물 배치를 적용하면 이 국면에서 둘 수 있는 수를 분석합니다.'};
  else if (!move) comment={grade:null,text:`${currentChess().turn()==='w'?'백':'흑'} 차례입니다. 추천 수순을 열거나 보드에서 수를 두어 살펴보세요.`};
  else {
    if (!coachCache || coachCache.move!==move || coachCache.before!==before || coachCache.after!==after || coachCache.previous!==previous) coachCache={move,before,after,previous,comment:describeMove(move,before,after,{previous})};
    comment=coachCache.comment;
  }
  $('coach-move').textContent=state.editor ? '배치 편집' : move ? moveLabel(move) : '시작 국면';
  $('coach-grade').textContent=comment.grade?.label || (move && !state.editor ? '분석 대기' : '');
  $('coach-symbol').textContent=comment.grade?.symbol || '♟';
  $('coach-symbol').className=comment.grade?.key || 'pending';
  $('coach-text').textContent=comment.text;
}

function renderAnalysis() {
  const result = shownResult();
  const busy = !!state.mode;
  $('engine-status-dot').className = `status-dot${state.error ? ' error' : busy ? ' busy' : ''}`;
  $('engine-name').textContent = ENGINES[selectedEngine].name;
  $('engine-settings-open').title = `엔진 및 성능 설정 · ${performanceOptions.threads} 스레드 · ${performanceOptions.multipv} 라인 · ${performanceOptions.hash} MB`;
  if (!busy) $('engine-download').hidden = true;
  renderCoach();
  $('arrow-label').textContent=state.line?.kind==='pv'?'다음 재생 수 표시':'추천 수 표시';
  $('show-arrow').setAttribute('aria-label',$('arrow-label').textContent);
  $('evaluation-basis').textContent = `평가 · ${evaluationSide()} 기준`;
  $('rail-score').textContent = displayScore(result?.score);
  const rail = $('eval-fill').parentElement;
  rail.classList.toggle('flipped',state.flipped);
  rail.setAttribute('aria-label',`${evaluationHint()} · ${displayScore(result?.score)}`);
  rail.title = evaluationHint();
  const value = result?.score ? displayValue(result.score) : 0;
  $('eval-fill').style.height = `${100 / (1 + Math.exp(-Math.max(-2000,Math.min(2000,value))/230))}%`;
  $('rail-score').style.color = (value < -180) !== state.flipped ? 'var(--eval-rail-light)' : 'var(--eval-rail-dark)';
  const complete = [...state.results.values()].filter(isCached).length;
  $('analyze-game').textContent = state.mode === 'full' ? '분석 중단' : `${state.game.moves.length ? (complete === state.game.positions.length ? '전체 대국 다시 분석' : complete > 0 ? '남은 대국 분석' : '전체 대국 분석') : '현재 국면 분석'}`;
  $('depth').disabled = state.mode === 'full' || !!state.editor;
  $('analyze-position').disabled = state.mode === 'full' || !!state.editor;
  $('analyze-game').disabled = $('copy-fen').disabled = !!state.editor;
  $('restart-game').hidden = state.mode === 'full' || !state.game.moves.length || complete === 0 || complete === state.game.positions.length;
  $('restart-game').disabled = !!state.editor;
  $('analysis-progress').hidden = state.mode !== 'full';
  $('progress-text').textContent = `${performanceOptions.reviewMode === 'fast' ? '빠른 검토' : '정밀 검토'} · ${complete} / ${state.game.positions.length} 국면`;
  const percent = Math.round(complete/state.game.positions.length*100);
  $('progress-percent').textContent = `${percent}%`;
  $('progress-bar').max = state.game.positions.length;
  $('progress-bar').value = complete;
  $('analysis-progress').title='원본 대국 전체의 분석 진행도입니다. 시작 국면도 포함하며, 재생 진행도와는 별개입니다.';
  $('pv-lines').style.setProperty('--pv-columns',Math.min(performanceOptions.multipv,3));
  if (result?.lines?.length) {
    const fen = currentChess().fen();
    $('pv-lines').innerHTML = result.lines.map((line,i) => {
      const position = new Chess(fen);
      const number = position.moveNumber();
      let move, reply;
      const play = uci => position.move({ from:uci.slice(0,2), to:uci.slice(2,4), promotion:uci[4] });
      try { move = play(line.pv[0]); } catch { return ''; }
      try { if (line.pv[1]) reply = play(line.pv[1]); } catch { /* A partial PV can still show its legal first move. */ }
      const notation = `${number}${move.color === 'w' ? '.' : '...'} ${move.san}`;
      const replyText = reply ? `${reply.color === 'w' ? '백' : '흑'} 응수 ${reply.san}` : notation;
      const moveLabel = `${PIECE_NAMES[move.piece]} ${move.from} ${move.captured ? '×' : '→'} ${move.to}${move.promotion ? ` · ${PIECE_NAMES[move.promotion]} 승격` : ''}`;
      const score = displayScore(line.score);
      const squares = `${move.from} ${move.captured ? '×' : '→'} ${move.to}${move.promotion ? `=${move.promotion.toUpperCase()}` : ''}`;
      return `<button class="pv-row${i === 0 ? ' pv-best' : ''}" data-pv="${i}" aria-label="${escape(`${i+1}순위 ${move.color === 'w' ? '백' : '흑'} ${moveLabel}, ${evaluationSide()} 기준 평가 ${score}, 전체 예상 수순 탐색`)}" title="${escape(`${moveLabel} · ${pvToSan(fen,line.pv)}`)} · 깊이 ${line.depth}"><span class="pv-number">${i+1}</span><span class="pv-score">${score}</span><span class="pv-move"><span class="pv-piece">${pieceSvg(move.piece,move.color)}</span><strong>${escape(squares)}</strong></span><span class="pv-reply">${escape(replyText)}</span><span class="pv-play">전체 수순 보기</span></button>`;
    }).join('');
  } else $('pv-lines').innerHTML = `<p class="empty-text">${escape(result?.terminal || (state.mode === 'full' ? '이 국면의 분석 차례를 기다리고 있습니다.' : state.error || '분석 중…'))}</p>`;
  renderArrow();
}

function renderMoves(scroll = false) {
  rememberMoveListScroll();
  const rows = new Map();
  let visible=0;
  const loss=Number($('move-filter').value), side=$('move-side').value;
  state.game.moves.forEach((move,i) => {
    if(side!=='all'&&move.color!==side)return;
    if(loss) { const grade=gradeAt(i+1); if(!grade||(loss===200 ? grade.key!=='blunder' : grade.severity<({50:1,100:2}[loss])))return; }
    visible++;
    const number = move.before.split(' ')[5];
    if (!rows.has(number)) rows.set(number, { w:null,b:null });
    rows.get(number)[move.color] = { move,index:i+1 };
  });
  const cell = item => {
    if (!item) return '<span></span>';
    const { move,index } = item;
    const grade = gradeAt(index);
    const badge = grade && grade.key !== 'good' ? `<span class="move-badge ${grade.key}" title="${grade.label}">${grade.symbol}</span>` : '';
    return `<button data-index="${index}" class="move-button${state.index === index ? ' current' : ''}" aria-label="${escape(`${move.before.split(' ')[5]}${move.color === 'w' ? '. 백' : '... 흑'} ${move.san}${grade ? ` ${grade.label}` : ''}`)}" aria-current="${state.index === index ? 'step' : 'false'}"><span>${escape(move.san)}</span>${badge}<span class="move-score" title="${state.results.has(index)?`이 수를 둔 뒤의 평가 · ${evaluationHint()}`:'아직 분석되지 않은 국면'}">${displayScore(state.results.get(index)?.score)}</span></button>`;
  };
  $('move-filter-count').textContent=`${visible}개`;
  $('move-list').innerHTML = [...rows].map(([number,row]) => `<div class="move-row"><span class="move-number">${number}.</span>${cell(row.w)}${cell(row.b)}</div>`).join('') || `<p class="empty-text">${state.game.moves.length?'조건에 맞는 분석된 수가 없습니다.':'FEN 국면입니다. 보드에서 직접 수를 두어 탐색하세요.'}</p>`;
  if (!$('moves-content').hidden) $('move-list').scrollTop = moveListScroll;
  if (scroll && !$('moves-content').hidden) {
    const active = $('move-list').querySelector('.current');
    if (active) {
      const row = active.parentElement;
      $('move-list').scrollTop += row.getBoundingClientRect().top - $('move-list').getBoundingClientRect().top - $('move-list').clientHeight/2 + row.clientHeight/2;
      moveListScroll=$('move-list').scrollTop;
    }
  }
  renderInsight();
}

function renderInsight() {
  if (state.line?.kind === 'pv' && state.line.reviewIndex === insightContext?.index && state.game === insightContext?.game) {
    renderInsightDetail(insightContext);
    return;
  }
  let message = '수를 선택하면 평가가 표시됩니다.';
  const move = state.game.moves[state.index-1];
  const before = state.results.get(state.index-1), after = state.results.get(state.index);
  const grade = gradeAt(state.index);
  if (state.editor) message = '배치 적용 후 편집한 국면을 분석합니다.';
  else if (state.line) message = escape(state.line.cursor ? state.line.steps[state.line.cursor-1].explanation : '탐색 시작 국면입니다. 다음 수를 누르거나 보드에서 직접 수를 두세요.');
  else if (grade) {
    message = `<strong>${escape(moveLabel(move))} · ${grade.label}</strong>`;
    if (grade.severity >= 1) {
      message += grade.loss >= 90000 ? ' · 강제 메이트 평가가 바뀌었습니다.' : ` · 평가 ${Number(grade.loss/100).toFixed(2)} 손실`;
      if (before.bestmove) {
        try { message += `<br>추천 수: <strong>${escape(moveText(new Chess(move.before).move(before.bestmove)))}</strong>`; } catch { /* Ignore an invalid cached move. */ }
      }
    } else message += ` · ${escape(grade.reason || '국면의 평가를 잘 유지했습니다.')}`;
  } else if (state.mode === 'full') message = '앞뒤 국면을 모두 분석하면 이 수의 평가가 표시됩니다.';
  else if (move) message = `<strong>${escape(moveLabel(move))}</strong> · 전체 대국을 분석하면 수의 분류를 확인할 수 있어요.`;
  const insight = !state.editor && !state.line && explainMistake(move,before,after,{previous:state.results.get(state.index-2)});
  if (insight) {
    insightContext = { game:state.game,index:state.index,insight,before,after };
    renderInsightDetail(insightContext);
    return;
  }
  insightContext = null;
  $('insight-title').textContent = state.editor ? '배치 편집' : state.line ? state.line.title || '탐색 수순' : '수 설명';
  $('insight-evaluation').textContent = '';
  $('insight-playback').textContent = state.line ? `${state.line.cursor} / ${state.line.steps.length}` : '';
  setInsightContent(`<p class="insight-empty">${message}</p>`);
}

function setInsightContent(markup) {
  if (markup === insightMarkup) return;
  insightMarkup = markup;
  $('insight-content').innerHTML = markup;
  $('insight-content').scrollTop = 0;
}

function renderInsightDetail({game,index,insight,before,after}) {
  const move = game.moves[index-1];
  $('insight-title').textContent = `${moveLabel(move)} · ${insight.grade.label}`;
  $('insight-evaluation').textContent = `${insight.lossText} · 수 전 ${displayScore(before.score)} → 수 후 ${displayScore(after.score)} (${evaluationSide()} 기준)`;
  $('insight-playback').textContent = state.line ? `${state.line.title} · ${state.line.cursor} / ${state.line.steps.length}` : '';
  const section = (kind,title,line,fact) => {
    const selected = state.line?.reviewIndex === index && state.line.reviewKind === kind;
    const full=selected && state.line.reviewScope==='full';
    const coreLabel=kind==='response'?'핵심 응수':'대안 첫 장면';
    return `<section class="insight-line${selected ? ' selected-line' : ''}"><h3>${title}${selected ? `<span class="insight-selected">${full?'전체 수순 탐색':'핵심 장면 탐색'}</span>` : ''}</h3><p>${escape(fact || '저장된 분석에 탐색 가능한 수순이 없습니다. 이 국면을 다시 분석해 주세요.')}</p>${line.moves.length ? `<div class="insight-actions"><button class="button outline" data-insight-play="${kind}" data-insight-scope="core" aria-pressed="${selected&&!full}">${coreLabel} 보기 · ${line.focus.length}번 이동</button>${line.moves.length>line.focus.length?`<button class="text-button insight-full" data-insight-play="${kind}" data-insight-scope="full" aria-pressed="${full}">전체 예상 수순 보기 · ${line.moves.length}번 이동</button>`:''}</div>${line.focus.note?`<p class="insight-note">${escape(line.focus.note)}</p>`:''}${kind==='response'&&insight.riskFact?`<p class="insight-risk">장기 예상: ${escape(insight.riskFact)}</p>`:''}` : ''}</section>`;
  };
  setInsightContent(`${section('response','상대가 이용하는 수',insight.response,insight.responseFact)}${section('alternative','대신 둘 수 있었던 수',insight.alternative,insight.alternativeFact)}${insight.reason ? `<details class="insight-more"><summary>상세 설명</summary><p>${escape(insight.reason)}</p></details>` : ''}`);
}

function startInsight(kind,scope='core') {
  if (!insightContext || state.game !== insightContext.game || !['response','alternative'].includes(kind)) return;
  const line = createInsightLine(insightContext,kind,scope);
  if (!line) return;
  pausePlayback(); stopJob();
  state.line = line; state.selected = null; state.tab = 'study';
  state.chartMode = 'line';
  renderAll(); scheduleAnalysis();
}

function renderChart() {
  $('chart-line').disabled = !state.line;
  if (!state.line) state.chartMode = 'game';
  for (const mode of ['game','line']) $('chart-'+mode).setAttribute('aria-pressed',String(state.chartMode === mode));
  const branch = state.chartMode === 'line' && state.line;
  const results = branch ? branch.results : state.results;
  const cursor = branch ? branch.cursor : state.index;
  const count = branch ? branch.steps.length+1 : state.game.positions.length;
  $('chart-start').textContent = branch ? '탐색 시작' : '시작';
  $('chart-last').textContent = branch ? `${branch.steps.length}번 이동` : state.game.moves.length ? `${state.game.moves.length}번 이동` : '현재 국면';
  $('chart-status').textContent = `${evaluationSide()} 기준 · ${state.editor ? '배치 편집 중' : state.mode==='full' ? '전체 대국 분석 중' : results.size===count ? '분석 완료' : `${results.size}/${count} 국면 분석`}`;
  $('chart-status').title = evaluationHint();
  $('chart-top-label').textContent = `${evaluationSide()} 우세`;
  $('chart-bottom-label').textContent = `${state.flipped ? '백' : '흑'} 우세`;
  $('chart-current-score').textContent = displayScore(results.get(cursor)?.score);
  $('chart-current-score').title = evaluationHint();
  $('eval-chart').setAttribute('aria-valuemax',String(count-1));
  $('eval-chart').setAttribute('aria-valuenow',String(cursor));
  $('eval-chart').setAttribute('aria-valuetext',`${branch?'탐색 수순':'원본 대국'} · ${cursor} / ${count-1}번 이동`);
  const x = index => count === 1 ? 300 : index/(count-1)*600;
  const y = score => 64-Math.tanh(displayValue(score)/420)*55;
  let svg = '<line x1="0" y1="64" x2="600" y2="64" stroke="#c6d1bc" stroke-width="1" stroke-dasharray="4 4"/>';
  let points = [];
  const flush = () => {
    if (points.length > 1) {
      const coords = points.map(p => p.join(',')).join(' ');
      svg += `<polygon points="${points[0][0]},64 ${coords} ${points.at(-1)[0]},64" fill="#93ac7680"/><polyline points="${coords}" stroke="#728e54" stroke-width="2" fill="none" vector-effect="non-scaling-stroke"/>`;
    } else if (points.length === 1) svg += `<circle cx="${points[0][0]}" cy="${points[0][1]}" r="3" fill="#728e54"/>`;
    points = [];
  };
  for (let i=0;i<count;i++) {
    const result = results.get(i);
    if (result) points.push([x(i),y(result.score)]); else flush();
  }
  flush();
  svg += `<line class="chart-cursor" x1="${x(cursor)}" y1="0" x2="${x(cursor)}" y2="128" stroke="#566d43" stroke-width="1.7" stroke-dasharray="3 3"/><rect x="${Math.max(0,Math.min(592,x(cursor)-4))}" y="1" width="8" height="10" rx="2" fill="#566d43"/>`;
  const selected = results.get(cursor);
  if (selected) svg += `<circle cx="${x(cursor)}" cy="${y(selected.score)}" r="4" fill="#f9fcf0" stroke="#5d7a46" stroke-width="2"/>`;
  $('eval-chart').innerHTML = svg;
  $('chart-empty').hidden = results.size > 0;
}

function renderReview() {
  const counts = Object.fromEntries(['w','b'].map(color=>[color,Object.fromEntries(Object.keys(MOVE_GRADES).map(key=>[key,0]))]));
  const critical = [];
  let reviewed = 0;
  state.game.moves.forEach((move,i) => {
    const grade = gradeAt(i+1);
    if (grade) { counts[move.color][grade.key]++; reviewed++; if (grade.severity >= 2) critical.push({ index:i+1,move,...grade }); }
  });
  if (!reviewed) { $('review-content').innerHTML = '<div class="summary-empty">전체 대국 분석 후 수별 분류가 표시됩니다.</div>'; return; }
  $('review-content').innerHTML = `<div class="summary-counts">${['w','b'].map(color => `<div class="summary-player"><h4>${color === 'w' ? '♔' : '♚'} ${escape(state.game.headers[color === 'w' ? 'White' : 'Black'] || (color === 'w' ? '백' : '흑'))}</h4>${Object.entries(MOVE_GRADES).map(([key,{label,symbol}]) => `<div class="summary-stat"><span><i class="grade-icon ${key}" aria-hidden="true">${symbol}</i>${label}</span><b>${counts[color][key]}</b></div>`).join('')}</div>`).join('')}</div><p class="review-explanation">${reviewed} / ${state.game.moves.length}번 이동 분류 완료 · ${[...state.results.values()].some(r=>r.overview)?'빠른 검토 포함':'정밀 검토'}</p><details class="grading-guide"><summary>수 분류 기준</summary><p>${GRADING_BASIS}</p><p>탁월수: 예상 응수에서 손해를 감수한 기물 희생으로 국면을 유지한 경우. 훌륭한 수: 다른 후보보다 예상 승점을 10%p 이상 지킨 최선의 수. 놓친 기회: 상대 실수로 생긴 승리 기회를 놓친 경우. 이론: 공개 오프닝 목록과 일치한 첫 10수 안의 수입니다.</p><p>탁월수와 훌륭한 수는 확인된 수순을 바탕으로 보수적으로 추정합니다. 이론은 등록된 수순에 한하며 모든 오프닝을 포함하지는 않습니다.</p><p>예상 승점은 두는 쪽의 폰 단위 평가를 1 ÷ (1 + exp(−평가 ÷ 2.5))로 환산합니다. 체크메이트는 0 또는 1로 계산합니다.</p><p><a href="https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-etc" target="_blank" rel="noopener noreferrer">Chess.com 공식 분류 설명</a> · <a href="https://github.com/lichess-org/chess-openings" target="_blank" rel="noopener noreferrer">오프닝 자료 · CC0</a></p></details>${critical.length ? '<h3>다시 살펴볼 수</h3>' : ''}${critical.sort((a,b) => b.pointsLoss-a.pointsLoss).slice(0,5).map(item => `<button class="critical-button" data-review-index="${item.index}"><span>${escape(item.move.before.split(' ')[5])}${item.move.color === 'w' ? '.' : '...'} ${escape(item.move.san)} <small>(${item.move.color === 'w' ? '백' : '흑'})</small></span><span>${item.label} ↗</span></button>`).join('')}`;
}

function renderResults() { renderAnalysis(); renderMoves(); renderChart(); renderReview(); renderStudy(); }
function renderAll() { renderBoard(); renderResults(); }

function pausePlayback() {
  stepNavigation.cancel();
  playback.stop();
  state.playing = false;
}

function schedulePlayback() {
  if (!state.playing || !state.line) return;
  if (state.error) pausePlayback();
  else if (state.mode || !isCached(currentResult())) playback.hold();
  else playback.ready(Number($('playback-speed').value));
  renderStudy();
}

function stepBoard(direction, line=state.line) {
  if (state.editor) return;
  pausePlayback();
  renderStudy();
  const game=state.game;
  stepNavigation.request(()=>{
    if (state.editor || state.game!==game || (line && state.line!==line)) return;
    if (line) seekLine(line.cursor+direction);
    else navigate(state.index+direction);
  });
}

function navigate(index,{analyze=true}={}) {
  if(state.editor){toast('배치를 적용하거나 취소한 뒤 이동하세요.');return;}
  const previous=state.line?null:state.index;
  pausePlayback();
  state.index = Math.max(0,Math.min(state.game.moves.length,index));
  state.line = null; state.editor = null; state.selected = null; state.preview = null;
  if (state.tab === 'study') state.tab = 'moves';
  $('editor-panel').hidden = true;
  state.chartMode = 'game';
  if (state.mode !== 'full') stopJob();
  renderAll(); renderMoves(true); persist(); if(analyze)scheduleAnalysis();
  if(previous!==null&&Math.abs(state.index-previous)===1)void moveSounds.play(state.index>previous?state.game.moves[state.index-1]:{});
}

function startExploration() {
  if (state.editor) return;
  pausePlayback(); stopJob();
  if (!state.line) {
    state.line = new AnalysisLine(currentChess(), [], currentResult());
    state.line.kind = 'manual';
  }
  state.selected = null;
  state.tab = 'study';
  state.chartMode = 'line';
  renderAll(); scheduleAnalysis();
}

function startPv(index) {
  const result = shownResult();
  const recommendation = result?.lines[index];
  if (!recommendation) return;
  const line = new AnalysisLine(currentChess(),recommendation.pv,currentResult());
  if (!line.steps.length) { toast('재생 가능한 추천 수순이 없습니다.',true); return; }
  line.kind = 'pv';
  line.title = '추천 수 · 전체 예상 수순';
  line.sourceScore = recommendation.score;
  line.sourceDepth = recommendation.depth;
  pausePlayback(); stopJob();
  state.line = line; state.selected = null; state.tab = 'study';
  state.chartMode = 'line';
  renderAll(); scheduleAnalysis();
}

function seekLine(index, keepPlaying = false,{analyze=true}={}) {
  if (!state.line || state.editor) return;
  const previous=state.line.cursor;
  if (!keepPlaying) pausePlayback();
  stopJob(); state.line.seek(index); state.selected = null; state.tab = 'study';
  renderAll(); if(analyze)scheduleAnalysis();
  if(Math.abs(state.line.cursor-previous)===1)void moveSounds.play(state.line.cursor>previous?state.line.steps[state.line.cursor-1]:{});
}

function togglePlayback() {
  if (!state.line || !state.line.steps.length || state.editor) return;
  stepNavigation.cancel();
  if (state.playing) { pausePlayback(); renderStudy(); return; }
  if (state.line.cursor === state.line.steps.length) seekLine(0,false);
  state.playing = true;
  if (state.line.cursor===0) advancePlayback();
  else scheduleAnalysis();
  renderStudy();
}

function advancePlayback() {
  if (!state.playing || !state.line) return;
  const line=state.line;
  // Restarting or switching between response and alternative first animates
  // back to the correct base position, then starts the first replayed move.
  stepNavigation.request(()=>{
    if(!state.playing || state.line!==line)return;
    seekLine(line.cursor+1,true);
    if(line.cursor>=line.steps.length){pausePlayback();renderStudy();}
  });
}

function playMove(uci) {
  if (state.editor) return;
  pausePlayback(); stopJob();
  try {
    const line = state.line || new AnalysisLine(currentChess(),[],currentResult());
    const move=line.play(uci);
    line.kind = 'manual';
    for(const key of ['title','reviewKind','reviewScope','fullLength','focusNote'])delete line[key];
    state.line = line; state.selected = null; state.error = null; state.tab = 'study';
    state.chartMode = 'line';
    renderAll(); scheduleAnalysis();
    void moveSounds.play(move);
  } catch { renderStudy(); toast('둘 수 없는 수입니다. 표시된 이동 칸을 선택하세요.',true); }
}

function animateBoard(next) {
  const previous=renderedBoard, flipped=renderedFlipped;
  renderedBoard=next;renderedFlipped=state.flipped;
  if (!previous) return;
  const plans=pieceTransitions(previous,next);
  const still=({from,to})=>from && to && from.square===to.square && from.type===to.type && from.color===to.color && flipped===state.flipped;
  const hide=square=>{const piece=$('board').querySelector(`[data-square="${square}"] .piece`);if(piece)piece.style.visibility='hidden';};
  // Selection changes and dragend can repaint the same position mid-animation.
  // Keep its existing motion and hide the newly rendered destination piece.
  if (plans.every(still)) {
    for (const {from,to} of plans) if(from.id!==to.id && pieceMotions.has(from.id)) {
      const motion=pieceMotions.get(from.id);pieceMotions.delete(from.id);motion.id=to.id;pieceMotions.set(to.id,motion);
    }
    for (const motion of pieceMotions.values()) if(motion.to)hide(motion.to);
    return;
  }
  const bounds=$('board').getBoundingClientRect(), size=bounds.width/8;
  const visible=new Map([...pieceMotions].map(([id,{ghost}])=>{
    const rect=ghost.getBoundingClientRect();
    return [id,[(rect.left-bounds.left)/size,(rect.top-bounds.top)/size]];
  }));
  const interrupted=[...pieceMotions.values()];pieceMotions.clear();
  for (const {animation,ghost} of interrupted) { animation.cancel();ghost.remove(); }
  const coords = (square,flip) => {
    const x=square.charCodeAt(0)-97,y=8-Number(square[1]);
    return flip ? [7-x,7-y] : [x,y];
  };
  for (const plan of plans) {
    const {from,to}=plan, current=from && visible.get(from.id);
    if (still(plan) && !current) continue;
    const [x1,y1]=current || coords((from||to).square,from?flipped:state.flipped);
    const [x2,y2]=coords((to||from).square,to?state.flipped:flipped);
    const piece=from || to, id=(to || from).id;
    const ghost=document.createElement('div'); ghost.className='flying-piece'; ghost.innerHTML=pieceSvg(piece.type,piece.color);
    ghost.setAttribute('aria-hidden','true');ghost.dataset.from=from?.square || '';ghost.dataset.to=to?.square || '';
    ghost.style.left=`${x2*12.5}%`; ghost.style.top=`${y2*12.5}%`;
    $('move-animation').append(ghost);
    if(to)hide(to.square);
    const animation=ghost.animate([{transform:`translate(${(x1-x2)*size}px,${(y1-y2)*size}px)`,opacity:from?1:0},{transform:'translate(0,0)',opacity:to?1:0}],{duration:matchMedia('(prefers-reduced-motion: reduce)').matches?120:240,easing:'ease-in-out',fill:'both'});
    const motion={id,animation,ghost,to:to?.square};pieceMotions.set(id,motion);
    animation.finished.catch(()=>{}).finally(()=>{
      if(pieceMotions.get(motion.id)!==motion)return;
      pieceMotions.delete(motion.id);ghost.remove();
      const destination=to && $('board').querySelector(`[data-square="${to.square}"] .piece`);
      if(destination)destination.style.visibility='';
      stepNavigation.flush();
    });
  }
}

function rememberMoveListScroll() {
  if (!$('moves-content').hidden && !restoreMoveListScroll) moveListScroll=$('move-list').scrollTop;
}

function renderPanels() {
  rememberMoveListScroll();
  const movesWereHidden=$('moves-content').hidden;
  if (state.tab === 'study' && (!state.line || state.editor)) state.tab = 'moves';
  for (const name of ['moves','study','review']) {
    $(name === 'study' ? 'study-panel' : `${name}-content`).hidden = state.tab !== name;
    $(`${name}-tab`).classList.toggle('active',state.tab === name);
    $(`${name}-tab`).setAttribute('aria-pressed',String(state.tab === name));
  }
  $('study-tab').disabled = !!state.editor;
  $('export').hidden = state.tab === 'study';
  if(movesWereHidden && !$('moves-content').hidden){
    restoreMoveListScroll=true;
    $('move-list').scrollTop=moveListScroll;
  }
  sizeNotation();
}

function revealStudyMove() {
  const list = $('study-steps'), active = list.querySelector('.current');
  if (active && !list.closest('[hidden]')) {
    const bounds = list.getBoundingClientRect(), target = active.getBoundingClientRect();
    if (target.top < bounds.top || target.bottom > bounds.bottom) list.scrollTop += target.top - bounds.top - list.clientHeight/2 + active.clientHeight/2;
  }
}

function renderStudy() {
  renderPanels();
  $('editor-panel').hidden = !state.editor;
  $('mobile-study-caption').hidden = $('mobile-study-controls').hidden = !state.line || !!state.editor;
  if (!state.line) return;
  const line=state.line;
  $('study-position').textContent=`이동 ${line.cursor} / ${line.steps.length}`;
  $('study-position').title=`백·흑의 이동을 각각 한 번으로 셉니다. 총 ${line.steps.length}번 이동 후 재생이 끝납니다.`;
  $('study-review').hidden = line.reviewIndex == null;
  const ended = line.cursor === line.steps.length;
  const seconds=Number($('playback-speed').value)/1000;
  $('playback-phase').textContent=state.playing
    ? state.line.cursor===0 && pieceMotions.size ? '재생 시작 위치로 이동 중…' : playback.phase==='reading' ? `분석 완료 · ${seconds}초 확인 후 다음 수` : `현재 수 분석 중 · 완료 후 ${seconds}초간 결과 표시`
    : state.error ? '현재 국면을 분석하지 못했습니다. 다시 분석해 주세요.'
    : state.mode || !isCached(currentResult()) || currentResult()?.overview ? '현재 국면 분석 중 · 자동으로 재생하지 않습니다.'
    : ended && line.steps.length ? line.reviewScope==='core' ? line.fullLength>line.steps.length ? '핵심 장면에서 멈췄습니다. 후속 수순은 아래의 전체 예상 수순을 선택하세요.' : '핵심 장면에서 멈췄습니다. 저장된 후속 수순은 없습니다.' : '선택한 수순의 끝입니다. 다시 재생하거나 원본으로 돌아갈 수 있습니다.'
    : line.steps.length ? '분석 완료 · 재생을 누르면 수순이 진행됩니다.' : '분석 완료 · 기물을 움직여 탐색하세요.';
  const branchLabel = line.reviewKind ? `${line.reviewScope==='core'?'핵심 장면':'전체 예상 수순'} · ${line.reviewKind === 'response' ? '상대 응수' : '대안'} · ${moveTurn(line.steps[0])}부터` : line.kind==='pv' ? '추천 수 · 전체 예상 수순' : '탐색 범위';
  $('study-endpoint').textContent = line.steps.length ? `${branchLabel} · ${line.steps.length}번 이동 · ${moveTurn(line.steps.at(-1))}까지` : '';
  $('study-endpoint').hidden = !line.steps.length;
  $('study-first').disabled=$('study-prev').disabled=line.cursor===0;
  $('study-next').disabled=$('study-last').disabled=line.cursor===line.steps.length;
  $('study-play').disabled=$('mobile-study-play').disabled=!line.steps.length;
  $('mobile-study-prev').disabled=line.cursor===0;
  $('mobile-study-next').disabled=line.cursor===line.steps.length;
  $('study-play').textContent=state.playing?'일시정지':line.cursor===line.steps.length && line.steps.length?'다시 재생':'재생';
  $('mobile-study-play').textContent=$('study-play').textContent;
  const rows = new Map(), list = $('study-steps'), previousScroll = list.scrollTop;
  line.steps.forEach((step,i) => {
    const number = step.before.split(' ')[5];
    if (!rows.has(number)) rows.set(number,{w:null,b:null});
    rows.get(number)[step.color] = {step,index:i+1};
  });
  const cell = item => item ? `<button data-step="${item.index}" class="move-button${line.cursor===item.index?' current':''}" aria-current="${line.cursor===item.index?'step':'false'}" aria-label="${escape(`${item.step.before.split(' ')[5]}${item.step.color==='w'?'. 백':'... 흑'} ${item.step.san}`)}"><span>${escape(item.step.san)}</span><span class="move-score" title="${line.results.has(item.index)?`이 수를 둔 뒤의 평가 · ${evaluationHint()}`:'아직 분석되지 않은 국면'}">${displayScore(line.results.get(item.index)?.score)}</span></button>` : '<span></span>';
  list.innerHTML = `<button data-step="0" class="study-start${line.cursor===0?' current':''}">${escape(line.startLabel || '시작 국면')}</button>` + [...rows].map(([number,row])=>`<div class="move-row"><span class="move-number">${number}.</span>${cell(row.w)}${cell(row.b)}</div>`).join('');
  list.scrollTop = previousScroll;
  if (list.dataset.cursor !== String(line.cursor)) revealStudyMove();
  list.dataset.cursor = String(line.cursor);
  const text=line.cursor ? line.steps[line.cursor-1].explanation : '탐색 시작 국면입니다. 다음 수를 누르거나 보드에서 직접 수를 두세요.';
  $('mobile-study-caption').textContent=`${line.cursor} / ${line.steps.length} · ${text}`;
}

function startEditor() {
  if (state.editor) return;
  pausePlayback(); stopJob(); state.selected=null;
  const chess=currentChess();
  state.editor={board:new Map(pieceSnapshot(chess).pieces.map(piece=>[piece.square,piece])),turn:chess.turn(),tool:'move'};
  $('editor-turn').value=state.editor.turn;
  $('editor-error').hidden=true;
  renderEditorTools(); renderAll();
}

function renderEditorTools() {
  if (!state.editor) return;
  $('editor-palette').innerHTML=['w','b'].map(color=>`<div>${['k','q','r','b','n','p'].map(type=>`<button data-editor-tool="${color}${type}" aria-label="${color==='w'?'백':'흑'} ${PIECE_NAMES[type]} 추가" aria-pressed="${state.editor.tool===color+type}">${pieceSvg(type,color)}</button>`).join('')}</div>`).join('');
  for (const button of $('editor-tools').querySelectorAll('[data-editor-tool]')) button.setAttribute('aria-pressed',String(button.dataset.editorTool===state.editor.tool));
}

function editSquare(square) {
  const editor=state.editor;
  $('editor-error').hidden=true;
  if (editor.tool==='erase') { editor.board.delete(square); state.selected=null; }
  else if (editor.tool!=='move') { editor.board.set(square,{id:`editor:${++editorPieceId}`,color:editor.tool[0],type:editor.tool[1]}); state.selected=null; }
  else if (state.selected && state.selected!==square) { const piece=editor.board.get(state.selected); editor.board.delete(state.selected); if(piece)editor.board.set(square,piece); state.selected=null; }
  else state.selected=state.selected===square?null:editor.board.has(square)?square:null;
  renderBoard();
}

function squareClicked(square) {
  stepNavigation.cancel();
  if (state.editor) { editSquare(square); return; }
  if (state.playing) { pausePlayback(); renderStudy(); }
  const chess = currentChess();
  if (state.selected) {
    const candidates = chess.moves({square:state.selected,verbose:true}).filter(move => move.to === square);
    if (candidates.length) {
      if (candidates.some(move => move.promotion)) {
        pendingPromotion = { from:state.selected,to:square };
        $('promotion-options').innerHTML = ['q','r','b','n'].map(type => `<button data-promote="${type}" aria-label="${PIECE_NAMES[type]} 승격">${pieceSvg(type,chess.turn())}</button>`).join('');
        $('promotion-dialog').showModal();
      } else playMove(state.selected+square);
      return;
    }
  }
  state.selected = state.selected === square ? null : chess.get(square) ? square : null;
  renderBoard();
}

function setGame(game, saved = null) {
  pausePlayback(); stopJob(); state.game = game; state.index = game.moves.length; state.results = new Map(); state.line = null; state.editor = null; state.selected = null; state.error = null;
  if(saved){
    state.index=Math.min(game.moves.length,Math.max(0,Number(saved.index)||0));
    selectedEngine=engineId(saved.engine);performanceOptions=normalizePerformance(saved.performance,maxThreads);
    if(settings[saved.depth])$('depth').value=saved.depth;
    state.results=restoreResults(saved,game.positions.length,ENGINES[selectedEngine].name);
    for(const [index,result] of state.results)if(!isCached(result))state.results.delete(index);
  }
  $('move-filter').value='0';$('move-side').value='all';
  state.chartMode='game'; $('editor-panel').hidden=true;
  moveListScroll=0;restoreMoveListScroll=false;$('move-list').scrollTop=0;
  renderGame(); renderMoves(true); persist(); scheduleAnalysis(true);
}

$('board').addEventListener('click', event => { if(Date.now()<suppressClickUntil)return; const square = event.target.closest('[data-square]'); if (square) squareClicked(square.dataset.square); });
$('move-list').addEventListener('click', event => { const button = event.target.closest('[data-index]'); if (button) navigate(Number(button.dataset.index)); });
$('move-list').addEventListener('scroll',rememberMoveListScroll,{passive:true});
$('review-content').addEventListener('click', event => { const button = event.target.closest('[data-review-index]'); if (button) navigate(Number(button.dataset.reviewIndex)); });
$('pv-lines').addEventListener('click', event => { const button = event.target.closest('[data-pv]'); if (button) startPv(Number(button.dataset.pv)); });
$('insight-content').addEventListener('click',event=>{const button=event.target.closest('[data-insight-play]');if(button)startInsight(button.dataset.insightPlay,button.dataset.insightScope);});
$('study-review').onclick=()=>{const index=state.line?.reviewIndex;if(index!=null)navigate(index);};
$('promotion-options').addEventListener('click', event => { const button = event.target.closest('[data-promote]'); if (button && pendingPromotion) { const { from,to } = pendingPromotion; pendingPromotion = null; $('promotion-dialog').close(); playMove(from+to+button.dataset.promote); } });
$('promotion-cancel').onclick = () => { pendingPromotion = null; $('promotion-dialog').close(); };
$('first').onclick = () => state.line ? seekLine(0) : navigate(0);
$('prev').onclick = () => stepBoard(-1);
$('next').onclick = () => stepBoard(1);
$('last').onclick = () => state.line ? seekLine(state.line.steps.length) : navigate(state.game.moves.length);
$('flip').onclick = () => { stepNavigation.cancel(); state.flipped = !state.flipped; renderAll(); };
$('show-arrow').onchange = renderArrow;
$('variation-return').onclick = () => navigate(state.index);
$('analyze-position').onclick = () => analyzeCurrent(true);
$('analyze-game').onclick = () => {
  const restart = state.mode !== 'full' && [...state.results.values()].filter(isCached).length === state.game.positions.length;
  analyzeGame(restart);
};
$('restart-game').onclick = () => analyzeGame(true);
$('depth').onchange = () => { stopJob(); state.results.clear(); state.line?.results.clear(); renderResults(); persist(); scheduleAnalysis(!state.line); };
$('engine-settings-open').onclick = () => {
  $('engine-choice').value = selectedEngine;
  $('settings-depth').value = $('depth').value;
  $('settings-time').value = performanceOptions.movetime;
  $('settings-review').value = performanceOptions.reviewMode;
  $('settings-lines').value = performanceOptions.multipv;
  $('settings-hash').value = performanceOptions.hash;
  $('settings-threads').value = performanceOptions.threads;
  for (const option of $('settings-threads').options) option.disabled = Number(option.value) > maxThreads;
  $('threads-note').textContent = maxThreads > 1 ? `이 기기에서 최대 ${maxThreads}개 사용 가능` : '이 브라우저 환경에서는 1개 스레드를 사용할 수 있습니다.';
  $('engine-settings-dialog').showModal();
};
$('engine-settings-close').onclick = () => $('engine-settings-dialog').close();
$('engine-settings-cancel').onclick = () => $('engine-settings-dialog').close();
$('engine-settings-form').onsubmit = event => {
  event.preventDefault();
  const nextEngine = engineId($('engine-choice').value);
  const nextDepth = Number($('settings-depth').value);
  const nextPerformance = normalizePerformance({reviewMode:$('settings-review').value,movetime:Number($('settings-time').value),multipv:Number($('settings-lines').value),hash:Number($('settings-hash').value),threads:Number($('settings-threads').value)}, maxThreads);
  const changed = configKey() !== analysisKey(nextEngine,nextDepth,nextPerformance) || nextPerformance.reviewMode !== performanceOptions.reviewMode;
  $('engine-settings-dialog').close();
  if (!changed) return;
  pausePlayback(); stopJob();
  selectedEngine=nextEngine;performanceOptions=nextPerformance;$('depth').value=nextDepth;
  state.results.clear();state.line?.results.clear();state.error=null;
  renderResults();persist();scheduleAnalysis();
  toast('설정을 적용했습니다. 현재 국면을 새로 분석합니다.');
};
function chartNavigate(index,options) { if (state.editor) return; if (state.chartMode==='line' && state.line) seekLine(index,false,options); else navigate(index,options); }
for(const mode of ['game','line']) $('chart-'+mode).onclick=()=>{if(mode==='line'&&!state.line)return;state.chartMode=mode;renderChart();};
let chartDrag=null, chartDragFrame=0;
function scrubChart(clientX) {
  const box=$('eval-chart').getBoundingClientRect();
  if(!box.width)return;
  const branch=state.chartMode==='line' && state.line;
  const length=branch?branch.steps.length:state.game.moves.length;
  const index=Math.max(0,Math.min(length,Math.round((clientX-box.left)/box.width*length)));
  if(index!==(branch?branch.cursor:state.index))chartNavigate(index,{analyze:false});
}
$('eval-chart').addEventListener('pointerdown',event=>{
  if(event.button!==0 || !event.isPrimary || state.editor || chartDrag)return;
  event.preventDefault();
  pausePlayback();if(state.mode!=='full')stopJob();
  chartDrag={pointerId:event.pointerId,clientX:event.clientX};
  $('eval-chart').setPointerCapture(event.pointerId);
  $('eval-chart').classList.add('scrubbing');
  $('eval-chart').focus({preventScroll:true});
  scrubChart(event.clientX);
});
$('eval-chart').addEventListener('pointermove',event=>{
  if(event.pointerId!==chartDrag?.pointerId)return;
  chartDrag.clientX=event.clientX;
  if(!chartDragFrame)chartDragFrame=requestAnimationFrame(()=>{
    chartDragFrame=0;if(chartDrag)scrubChart(chartDrag.clientX);
  });
});
function finishChartDrag(event) {
  if(event.pointerId!==chartDrag?.pointerId)return;
  cancelAnimationFrame(chartDragFrame);chartDragFrame=0;
  if(event.type==='pointerup')scrubChart(event.clientX);
  chartDrag=null;
  $('eval-chart').classList.remove('scrubbing');
  if($('eval-chart').hasPointerCapture(event.pointerId))$('eval-chart').releasePointerCapture(event.pointerId);
  scheduleAnalysis();
}
for(const type of ['pointerup','pointercancel','lostpointercapture'])$('eval-chart').addEventListener(type,finishChartDrag);
$('eval-chart').addEventListener('keydown',event=>{ if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return; event.preventDefault();event.stopPropagation();const branch=state.chartMode==='line'&&state.line;const length=branch?branch.steps.length:state.game.moves.length;if(event.key==='Home'||event.key==='End')chartNavigate(event.key==='Home'?0:length);else stepBoard(event.key==='ArrowLeft'?-1:1,branch); });
$('edit-start').onclick=startEditor;
$('editor-turn').onchange=()=>{if(state.editor){state.editor.turn=$('editor-turn').value;renderBoard();}};
for(const id of ['editor-tools','editor-palette']) $(id).addEventListener('click',event=>{const tool=event.target.closest('[data-editor-tool]');if(tool&&state.editor){state.editor.tool=tool.dataset.editorTool;state.selected=null;renderEditorTools();renderBoard();}});
$('editor-cancel').onclick=()=>{state.editor=null;state.selected=null;renderAll();scheduleAnalysis();};
$('editor-apply').onclick=()=>{
  try {
    const chess=editedPosition(state.editor.board,state.editor.turn);
    state.line=new AnalysisLine(chess); state.line.kind='edited'; state.editor=null; state.selected=null; state.tab='study';
    state.chartMode='line'; renderAll(); scheduleAnalysis();
  }catch(error){$('editor-error').textContent=error.message;$('editor-error').hidden=false;}
};
$('study-first').onclick=()=>seekLine(0);
$('study-prev').onclick=()=>stepBoard(-1);
$('study-next').onclick=()=>stepBoard(1);
$('study-last').onclick=()=>seekLine(state.line.steps.length);
$('study-play').onclick=$('mobile-study-play').onclick=togglePlayback;
$('mobile-study-prev').onclick=()=>stepBoard(-1);
$('mobile-study-next').onclick=()=>stepBoard(1);
$('playback-speed').onchange=()=>{if(state.playing){playback.hold();schedulePlayback();}else renderStudy();};
$('study-steps').addEventListener('click',event=>{const button=event.target.closest('[data-step]');if(button)seekLine(Number(button.dataset.step));});
$('board').addEventListener('dragstart',event=>{
  const source=event.target.closest('[data-square]');
  const square=source?.dataset.square;
  const piece=state.editor?state.editor.board.get(square):currentChess().get(square);
  if(!piece||(!state.editor&&piece.color!==currentChess().turn())){event.preventDefault();return;}
  pausePlayback();renderStudy();draggedSquare=square;state.selected=square;
  event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',square);
  // Snapshot only the piece, excluding the square, coordinates and move markers.
  const rect=source.getBoundingClientRect(), ghost=document.createElement('div');
  ghost.className='piece-drag-image';ghost.setAttribute('aria-hidden','true');
  Object.assign(ghost.style,{left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`});
  ghost.innerHTML=pieceSvg(piece.type,piece.color);
  document.body.append(ghost);
  event.dataTransfer.setDragImage(ghost,event.clientX-rect.left,event.clientY-rect.top);
  requestAnimationFrame(()=>ghost.remove());
  if(state.editor){state.editor.tool='move';renderEditorTools();}
  else for(const move of currentChess().moves({square,verbose:true})) {
    const cell=$('board').querySelector(`[data-square="${move.to}"]`);
    if(!cell.querySelector('.legal-dot')){const dot=document.createElement('span');dot.className=`legal-dot ${currentChess().get(move.to)?'capture':''}`;cell.append(dot);}
  }
  renderArrow();
});
$('board').addEventListener('dragover',event=>{if(draggedSquare)event.preventDefault();});
$('board').addEventListener('drop',event=>{event.preventDefault();const square=event.target.closest('[data-square]')?.dataset.square;const from=draggedSquare;draggedSquare=null;suppressClickUntil=Date.now()+300;if(square&&from){state.selected=from;squareClicked(square);}});
$('board').addEventListener('dragend',()=>{draggedSquare=null;renderBoard();});

for (const tab of ['moves','study','review']) $(`${tab}-tab`).onclick = () => {
  if (tab === 'study' && !state.line) { startExploration(); return; }
  pausePlayback(); state.tab = tab; renderStudy();
  if (tab === 'moves') renderMoves();
  if (tab === 'study') revealStudyMove();
};
$('import-open').onclick = () => { pausePlayback();renderStudy(); $('import-error').hidden = true; $('import-dialog').showModal(); };
$('import-close').onclick = () => $('import-dialog').close();
$('import-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const kind = /^[rnbqkpRNBQKP1-8/]+\s+[wb]\s/.test($('import-text').value.trim()) ? 'fen' : document.querySelector('input[name="import-type"]:checked').value;
    const game = parseGame($('import-text').value,kind);
    setGame(game); $('import-dialog').close(); toast(kind === 'fen' ? 'FEN 국면을 불러왔습니다.' : `${game.moves.length}번 이동의 대국을 불러왔습니다.`);
  } catch(error) { $('import-error').textContent = error.message; $('import-error').hidden = false; }
});
$('import-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 250000) { $('import-error').textContent = '250KB 이하의 단일 대국 파일을 선택해 주세요.'; $('import-error').hidden = false; return; }
  try {
    const text = (await file.text()).replace(/^\uFEFF/,'');
    $('import-text').value = text;
    const kind = file.name.toLowerCase().endsWith('.fen') || /^[rnbqkpRNBQKP1-8/]+\s+[wb]\s/.test(text.trim()) ? 'fen' : 'pgn';
    document.querySelector(`input[name="import-type"][value="${kind}"]`).checked = true;
    $('import-error').hidden = true;
  } catch { $('import-error').textContent = '파일을 읽지 못했습니다.'; $('import-error').hidden = false; }
  event.target.value = '';
});
$('load-sample').onclick = () => { setGame(parseGame(SAMPLE_PGN)); $('import-dialog').close(); toast('제공한 shinjjong 대 imgubi 대국을 불러왔습니다.'); };
$('nav-guide').onclick = () => {pausePlayback();renderStudy();$('guide-dialog').showModal();};
$('guide-close').onclick = () => $('guide-dialog').close();
$('copy-fen').onclick = async () => {
  try { await navigator.clipboard.writeText(currentChess().fen()); toast('현재 국면의 FEN을 복사했습니다.'); }
  catch { $('import-text').value = currentChess().fen(); document.querySelector('input[name="import-type"][value="fen"]').checked = true; $('import-dialog').showModal(); $('import-text').select(); toast('자동 복사가 제한되어 FEN을 선택했습니다. Ctrl+C로 복사하세요.'); }
};
function openPgn(text, title='원본 대국 PGN', filename='chess-review.pgn') {
  pausePlayback();renderStudy();
  exportFilename=filename;$('pgn-title').textContent=title;$('pgn-content').value=text;$('pgn-dialog').showModal();
}
$('export').onclick=()=>openPgn(exportPgn(state.game,state.results));
$('export-line').onclick=()=>{if(state.line)openPgn(exportLine(state.line,state.game.headers),'탐색 수순 PGN','chess-variation.pgn');};
$('copy-line').onclick=async()=>{
  if(!state.line)return;
  const text=state.line.steps.map(step=>`${step.before.split(' ')[5]}${step.color==='w'?'.':'...'} ${step.san}`).join(' ');
  try{await navigator.clipboard.writeText(text);toast('탐색 수순을 복사했습니다.');}
  catch{openPgn(exportLine(state.line,state.game.headers),'탐색 수순 PGN','chess-variation.pgn');toast('클립보드 접근이 제한되어 복사할 수순을 열었습니다.');}
};
$('pgn-close').onclick=()=>$('pgn-dialog').close();
$('pgn-copy').onclick=async()=>{
  try{await navigator.clipboard.writeText($('pgn-content').value);toast('PGN을 복사했습니다.');}
  catch{$('pgn-content').focus();$('pgn-content').select();toast('Ctrl+C로 선택된 PGN을 복사하세요.');}
};
$('pgn-download').onclick=()=>{
  const url=URL.createObjectURL(new Blob([$ ('pgn-content').value],{type:'application/x-chess-pgn;charset=utf-8'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download=exportFilename;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
};

function readLibrary() {
  const data=JSON.parse(localStorage.getItem(LIBRARY)||'[]');
  if(!Array.isArray(data))throw new Error('저장된 기보 목록을 읽을 수 없습니다.');
  return data;
}
function renderLibrary() {
  try {
    const games=readLibrary();
    $('library-list').innerHTML=games.map(game=>`<div class="library-item"><div><strong>${escape(game.name)}</strong><small>${escape(new Date(game.savedAt).toLocaleDateString('ko-KR'))} · ${Array.isArray(game.snapshot?.results)?game.snapshot.results.length:0}개 국면 분석</small></div><button data-library-open="${escape(game.id)}">열기</button><button data-library-delete="${escape(game.id)}" aria-label="${escape(game.name)} 삭제">삭제</button></div>`).join('')||'<p class="empty-text">저장한 기보가 없습니다.</p>';
    $('library-undo').hidden=!removedGame;
  }catch(error){$('library-message').textContent=error.message;}
}
$('library-open').onclick=()=>{pausePlayback();renderStudy();$('library-message').textContent='';$('library-name').value=`${state.game.headers.White||'백'} - ${state.game.headers.Black||'흑'}${state.game.headers.Date?' · '+state.game.headers.Date:''}`;renderLibrary();$('library-dialog').showModal();};
$('library-close').onclick=()=>$('library-dialog').close();
$('library-save-form').addEventListener('submit',event=>{
  event.preventDefault();
  try {
    const games=readLibrary(), snapshot=snapshotCurrent();
    const existing=games.findIndex(item=>item.snapshot?.input===snapshot.input&&item.snapshot?.kind===snapshot.kind);
    if(existing<0&&games.length>=50)throw new Error('최대 50개까지 저장할 수 있습니다. 기존 기보를 PGN으로 백업한 후 정리하세요.');
    const game={id:existing<0?crypto.randomUUID():games[existing].id,name:$('library-name').value.trim()||'이름 없는 대국',savedAt:new Date().toISOString(),snapshot};
    if(existing>=0)games.splice(existing,1);games.unshift(game);
    localStorage.setItem(LIBRARY,JSON.stringify(games));$('library-message').textContent='대국과 현재까지의 분석을 저장했습니다.';renderLibrary();
  }catch(error){$('library-message').textContent=error.name==='QuotaExceededError'?'브라우저 저장 공간이 부족합니다. PGN으로 저장해 주세요.':error.message;}
});
$('library-list').addEventListener('click',event=>{
  const open=event.target.closest('[data-library-open]'),remove=event.target.closest('[data-library-delete]');
  try {
    if(open){const game=readLibrary().find(item=>item.id===open.dataset.libraryOpen);if(game){const parsed=parseGame(game.snapshot.input,game.snapshot.kind);setGame(parsed,game.snapshot);$('library-dialog').close();}}
    if(remove){const games=readLibrary();const index=games.findIndex(item=>item.id===remove.dataset.libraryDelete);if(index>=0){const [removed]=games.splice(index,1);localStorage.setItem(LIBRARY,JSON.stringify(games));removedGame={index,game:removed};$('library-message').textContent='기보를 삭제했습니다. 아래에서 취소할 수 있습니다.';renderLibrary();}}
  }catch(error){$('library-message').textContent=error.message;}
});
$('library-undo').onclick=()=>{try{if(!removedGame)return;const games=readLibrary();if(games.length>=50)throw new Error('저장 공간이 가득 찼습니다.');if(!games.some(item=>item.id===removedGame.game.id))games.splice(removedGame.index,0,removedGame.game);localStorage.setItem(LIBRARY,JSON.stringify(games));removedGame=null;$('library-message').textContent='삭제를 취소했습니다.';renderLibrary();}catch(error){$('library-message').textContent=error.message;}};
for(const id of ['move-filter','move-side'])$(id).onchange=()=>renderMoves();
function nextMistake(direction) {
  if(state.editor)return;
  const side=$('move-side').value;
  const candidates=state.game.moves.flatMap((move,i)=>{const grade=gradeAt(i+1);return grade?.severity>=2&&(side==='all'||side===move.color)?[i+1]:[];});
  if(!candidates.length){toast('분석된 수 중 해당 색의 실수가 없습니다.');return;}
  const index=direction>0?(candidates.find(i=>i>state.index)??candidates[0]):([...candidates].reverse().find(i=>i<state.index)??candidates.at(-1));
  $('move-filter').value='100';navigate(index);
}
$('prev-mistake').onclick=()=>nextMistake(-1);
$('next-mistake').onclick=()=>nextMistake(1);

document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]') || ['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)) return;
  if(event.code==='Space'&&state.line&&!['BUTTON','A'].includes(event.target.tagName)){event.preventDefault();togglePlayback();return;}
  const action = {ArrowLeft:'prev',ArrowRight:'next',Home:'first',End:'last',f:'flip',F:'flip'}[event.key];
  if (action) { event.preventDefault(); $(action).click(); }
});
window.addEventListener('pagehide', () => { pausePlayback();persist(); engine?.dispose(); });
document.addEventListener('visibilitychange',()=>{if(document.hidden){pausePlayback();renderStudy();}});

// Reserve the move list itself, in addition to the chart and playback controls.
const notationColumn = document.querySelector('.analysis-column');
const boardColumn = document.querySelector('.board-column');
let notationFrame = 0;
function sizeNotation() {
  cancelAnimationFrame(notationFrame);
  notationFrame = requestAnimationFrame(() => {
    const mobile = matchMedia('(max-width:700px)').matches;
    const top = Math.max(16,notationColumn.getBoundingClientRect().top);
    const fixedHeight = [...notationColumn.firstElementChild.children].filter(element=>!['moves-content','study-panel','review-content'].includes(element.id)).reduce((height,element)=>height+element.offsetHeight,0);
    let panelHeight = state.tab === 'review' ? 540 : 240;
    if (state.tab === 'study') {
      const panel = $('study-panel'), style = getComputedStyle(panel);
      const controlsHeight = [...panel.children].filter(element=>element.id !== 'study-steps' && !element.hidden).reduce((height,element)=>{
        const css = getComputedStyle(element);
        return height+element.offsetHeight+parseFloat(css.marginTop)+parseFloat(css.marginBottom);
      },0);
      panelHeight = controlsHeight+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)+parseFloat(getComputedStyle($('study-steps')).minHeight);
    }
    const minimum = Math.max(540,fixedHeight+panelHeight+2);
    // The explanation is in normal flow below the workspace; never shrink notation for it.
    const available = innerHeight - top - 16;
    notationColumn.classList.toggle('scroll-with-page',mobile || minimum > innerHeight-32);
    notationColumn.style.height = `${mobile ? Math.max(1060,minimum) : Math.max(minimum,Math.min(boardColumn.offsetHeight,available))}px`;
    if(restoreMoveListScroll && !$('moves-content').hidden){
      $('move-list').scrollTop=moveListScroll;
      restoreMoveListScroll=false;
    }
  });
}
window.addEventListener('resize',sizeNotation);
window.addEventListener('scroll',sizeNotation,{passive:true});
const notationResize = new ResizeObserver(sizeNotation);
for (const element of [boardColumn,$('chart-dock'),document.querySelector('.engine-card'),$('study-panel')]) notationResize.observe(element);
const onlineGameId=new URL(location.href).searchParams.get('onlineGame');
let onlineLoaded=false;
if(onlineGameId&&/^[a-f0-9]{32}$/.test(onlineGameId)){
  try{
    const response=await fetch('/api/play/games/'+onlineGameId,{cache:'no-store'}),data=await response.json();
    if(!response.ok)throw new Error(data.error||'경기 기록을 불러오지 못했습니다.');
    if(data.game.status!=='finished'||!data.game.pgn)throw new Error('끝난 대국만 분석할 수 있습니다.');
    setGame(parseGame(data.game.pgn));onlineLoaded=true;toast('경기 기록을 불러왔습니다. 분석을 시작합니다.');
  }catch(error){toast(error.message,true);}
}
if(!onlineLoaded){renderGame();renderMoves(true);scheduleAnalysis(true);}
