import { Chess } from 'chess.js';
import {
  state,
  getActiveTab,
  getCurrentFen,
  escapeHtml,
} from '../state.js';
import { playMoveOnTree, renderArrows } from '../board/board.js';
import { parseUciInfoLine, normalizePv, updateEvalBarFromState } from './uci.js';
import { uciMoveToSan, formatReviewScore } from './evalMath.js';
import { gradeMaiaCandidates } from './maia2Math.js';

const MAIA_MODEL_URL = `${import.meta.env.BASE_URL}models/maia2-rapid-q8.onnx`;
const MAIA_WASM_PATHS = `${import.meta.env.BASE_URL}ort/`;
const SF_PROBE_WORKER_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-19-lite-single.js`;
const MAIA_OPTS_KEY = 'tichess_maia_opts_v1';
const MAX_CACHE = 160;
const SF_PROBE_DEPTH = 10;

let maiaWorker = null;
let sfProbeWorker = null;
let sfProbeReady = false;
let sfProbeBusy = false;
let sfProbeCancel = null;
const maiaCache = new Map();

function cacheGet(key) {
  if (!maiaCache.has(key)) return null;
  const v = maiaCache.get(key);
  maiaCache.delete(key);
  maiaCache.set(key, v);
  return v;
}

function cacheSet(key, value) {
  if (maiaCache.has(key)) maiaCache.delete(key);
  maiaCache.set(key, value);
  if (maiaCache.size > MAX_CACHE) {
    maiaCache.delete(maiaCache.keys().next().value);
  }
}

function persistMaiaOpts() {
  try {
    localStorage.setItem(
      MAIA_OPTS_KEY,
      JSON.stringify({
        eloWhite: state.maia.eloWhite,
        eloBlack: state.maia.eloBlack,
        syncElos: state.maia.syncElos,
      })
    );
  } catch (_) {}
}

function getMaiaCacheKey(fen, eloWhite, eloBlack) {
  return `${fen}|${eloWhite}|${eloBlack}`;
}

function ensureMaiaWorker() {
  if (maiaWorker) return maiaWorker;
  const w = new Worker(new URL('./maia2.worker.js', import.meta.url), { type: 'module' });
  w.onmessage = (e) => handleWorkerMessage(e.data || {});
  w.onerror = (err) => {
    state.maia.status = 'error';
    state.maia.error = err?.message || 'Maia 2 Web Worker failed';
    renderMaiaUI();
  };
  maiaWorker = w;
  return w;
}

function handleWorkerMessage(msg) {
  if (msg.type === 'status') {
    state.maia.status = msg.status;
    if (msg.status === 'ready') state.maia.error = '';
    renderMaiaUI();
    return;
  }

  if (msg.type === 'progress') {
    state.maia.status = 'downloading';
    state.maia.progressPct = Number(msg.pct) || 0;
    renderMaiaUI();
    return;
  }

  if (msg.type === 'error') {
    if (msg.reqId && msg.reqId !== state.maia.reqId) return;
    state.maia.status = 'error';
    state.maia.error = msg.error || 'Maia 2 inference failed';
    renderMaiaUI();
    return;
  }

  if (msg.type === 'result') {
    if (msg.reqId !== state.maia.reqId || msg.fen !== getCurrentFen()) return;
    state.maia.status = 'ready';
    state.maia.error = '';
    const baseResult = {
      fen: msg.fen,
      eloWhite: msg.eloWhite,
      eloBlack: msg.eloBlack,
      isBlack: msg.isBlack,
      whiteExp: msg.whiteExp,
      materialAdjusted: Boolean(msg.materialAdjusted),
      materialReason: msg.materialReason || '',
      rawCandidates: msg.candidates,
      graded: gradeMaiaCandidates({
        candidates: msg.candidates,
        isBlack: msg.isBlack,
        sfEvalMap: new Map(),
      }),
      sfGraded: false,
      bestSfUci: '',
      bestSfCpWhite: null,
      bestSfMate: null,
    };
    state.maia.result = baseResult;
    cacheSet(getMaiaCacheKey(msg.fen, msg.eloWhite, msg.eloBlack), baseResult);
    renderMaiaUI();
    renderArrows();
    updateEvalBarFromState();
    runStockfishGradingForMaia(baseResult, msg.reqId);
  }
}

/* -------------------------------------------------------------------------- */
/* Lightweight background Stockfish 19 Lite WASM grader for Maia candidates   */
/* -------------------------------------------------------------------------- */

function cancelSfProbe() {
  if (sfProbeCancel) {
    sfProbeCancel();
    sfProbeCancel = null;
  }
  if (sfProbeWorker && sfProbeBusy) {
    try {
      sfProbeWorker.postMessage('stop');
    } catch (_) {}
  }
}

function ensureSfProbeWorker() {
  if (sfProbeWorker && sfProbeReady) return Promise.resolve(sfProbeWorker);
  return new Promise((resolve, reject) => {
    try {
      const w = new Worker(SF_PROBE_WORKER_URL);
      const timer = setTimeout(() => {
        w.terminate();
        reject(new Error('Stockfish grader timeout'));
      }, 10000);
      w.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Stockfish grader failed'));
      };
      w.onmessage = (ev) => {
        if (ev.data === 'uciok') {
          clearTimeout(timer);
          w.postMessage('setoption name Hash value 16');
          w.postMessage('isready');
          sfProbeWorker = w;
          sfProbeReady = true;
          resolve(w);
        }
      };
      w.postMessage('uci');
    } catch (err) {
      reject(err);
    }
  });
}

function evalMoveWithProbe(worker, fen, rootMoveUci = null, depth = SF_PROBE_DEPTH) {
  return new Promise((resolve) => {
    const flip = fen.split(/\s+/)[1] === 'b' ? -1 : 1;
    let lastInfo = null;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      sfProbeBusy = false;
      sfProbeCancel = null;
      worker.onmessage = null;
      if (!lastInfo) {
        resolve(null);
        return;
      }
      const wVal = lastInfo.scoreVal * flip;
      const isMate = lastInfo.scoreType === 'mate';
      resolve({
        cpWhite: isMate ? (wVal > 0 ? 10000 : -10000) : wVal,
        mate: isMate ? wVal : null,
        pv: normalizePv(fen, lastInfo.pv || []),
      });
    };

    sfProbeCancel = finish;
    sfProbeBusy = true;

    worker.onmessage = (ev) => {
      const line = typeof ev.data === 'string' ? ev.data : '';
      if (line.includes(' score ') && line.includes(' pv ')) {
        const parsed = parseUciInfoLine(line);
        if (parsed && parsed.multipv === 1) lastInfo = parsed;
      } else if (line.startsWith('bestmove')) {
        finish();
      }
    };

    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(
      rootMoveUci ? `go depth ${depth} searchmoves ${rootMoveUci}` : `go depth ${depth}`
    );
  });
}

async function runStockfishGradingForMaia(resultObj, reqId) {
  cancelSfProbe();
  let worker;
  try {
    worker = await ensureSfProbeWorker();
  } catch (_) {
    return;
  }
  if (reqId !== state.maia.reqId || resultObj.fen !== getCurrentFen()) return;

  const evalMap = new Map();
  // 1. Evaluate best move objectively
  const best = await evalMoveWithProbe(worker, resultObj.fen, null, SF_PROBE_DEPTH);
  if (reqId !== state.maia.reqId || resultObj.fen !== getCurrentFen() || !best) return;

  const bestUci = best.pv?.[0] || '';
  if (bestUci) evalMap.set(bestUci, best);

  // 2. Evaluate top 5 Maia-2 human candidates not already evaluated
  const topCands = resultObj.rawCandidates.slice(0, 5);
  for (const c of topCands) {
    if (reqId !== state.maia.reqId || resultObj.fen !== getCurrentFen()) return;
    if (evalMap.has(c.uci)) continue;
    const res = await evalMoveWithProbe(worker, resultObj.fen, c.uci, SF_PROBE_DEPTH);
    if (reqId !== state.maia.reqId || resultObj.fen !== getCurrentFen()) return;
    if (res) evalMap.set(c.uci, res);
  }

  // If SF's best move isn't in Maia's top 5, include it as a reference row (hidden saving move!)
  const combined = [...topCands];
  if (bestUci && !combined.some((c) => c.uci === bestUci)) {
    const matchInAll = resultObj.rawCandidates.find((c) => c.uci === bestUci);
    combined.push({
      uci: bestUci,
      san: matchInAll?.san || uciMoveToSan(resultObj.fen, bestUci) || bestUci,
      prob: matchInAll?.prob || 0.01,
    });
  }

  resultObj.bestSfUci = bestUci;
  resultObj.bestSfCpWhite = best.cpWhite;
  resultObj.bestSfMate = best.mate;
  resultObj.graded = gradeMaiaCandidates({
    candidates: combined,
    isBlack: resultObj.isBlack,
    sfEvalMap: evalMap,
    bestSfUci: bestUci,
    bestSfCpWhite: best.cpWhite,
    bestSfMate: best.mate,
  });
  resultObj.sfGraded = true;

  if (state.maia.result === resultObj && resultObj.fen === getCurrentFen()) {
    renderMaiaUI();
    renderArrows();
  }
}

/* -------------------------------------------------------------------------- */
/* Public Maia-2 Engine Controls                                              */
/* -------------------------------------------------------------------------- */

export function stopMaia2() {
  cancelSfProbe();
}

export function setMaiaElos({ eloWhite, eloBlack, syncElos } = {}) {
  if (typeof syncElos === 'boolean') state.maia.syncElos = syncElos;
  if (Number.isFinite(Number(eloWhite))) {
    state.maia.eloWhite = Math.max(1000, Math.min(2200, Math.round(Number(eloWhite) / 50) * 50));
    if (state.maia.syncElos) state.maia.eloBlack = state.maia.eloWhite;
  }
  if (!state.maia.syncElos && Number.isFinite(Number(eloBlack))) {
    state.maia.eloBlack = Math.max(1000, Math.min(2200, Math.round(Number(eloBlack) / 50) * 50));
  }
  persistMaiaOpts();
  triggerMaia2Analysis();
}

export function applyGameElosToMaia() {
  const tab = getActiveTab();
  const w = parseInt(tab?.meta?.whiteElo || '', 10);
  const b = parseInt(tab?.meta?.blackElo || '', 10);
  if (Number.isFinite(w) && Number.isFinite(b) && w >= 800 && b >= 800) {
    state.maia.syncElos = w === b;
    state.maia.eloWhite = Math.max(1000, Math.min(2200, Math.round(w / 50) * 50));
    state.maia.eloBlack = Math.max(1000, Math.min(2200, Math.round(b / 50) * 50));
    persistMaiaOpts();
    triggerMaia2Analysis();
  }
}

export function toggleMaiaArrows() {
  state.maia.showArrows = !state.maia.showArrows;
  renderMaiaHeaderControls();
  renderArrows();
}

export function triggerMaia2Analysis() {
  const fen = getCurrentFen();
  state.maia.currentFen = fen;
  state.maia.hoverCandidateUci = null;

  if (!state.maia.enabled) return;

  if (!state.maia.running) {
    stopMaia2();
    renderMaiaUI();
    return;
  }

  let chess;
  try {
    chess = new Chess(fen);
  } catch (_) {
    stopMaia2();
    state.maia.error = 'Invalid position';
    state.maia.result = null;
    renderMaiaUI();
    renderArrows();
    return;
  }

  if (chess.isGameOver()) {
    stopMaia2();
    state.maia.error = '';
    state.maia.result = null;
    renderMaiaUI();
    renderArrows();
    return;
  }

  const eloWhite = state.maia.eloWhite;
  const eloBlack = state.maia.syncElos ? state.maia.eloWhite : state.maia.eloBlack;
  const cacheKey = getMaiaCacheKey(fen, eloWhite, eloBlack);
  const cached = cacheGet(cacheKey);
  if (cached) {
    state.maia.reqId++;
    state.maia.result = cached;
    state.maia.status = 'ready';
    state.maia.error = '';
    renderMaiaUI();
    renderArrows();
    updateEvalBarFromState();
    if (!cached.sfGraded) {
      runStockfishGradingForMaia(cached, state.maia.reqId);
    }
    return;
  }

  cancelSfProbe();
  const reqId = ++state.maia.reqId;
  const legalMoves = chess.moves({ verbose: true }).map((m) => ({
    uci: m.from + m.to + (m.promotion || ''),
    san: m.san,
  }));

  const worker = ensureMaiaWorker();
  if (state.maia.status === 'idle') {
    state.maia.status = 'downloading';
    state.maia.progressPct = 0;
  }
  renderMaiaUI();
  worker.postMessage({
    type: 'predict',
    reqId,
    fen,
    eloWhite,
    eloBlack,
    legalMoves,
    modelUrl: MAIA_MODEL_URL,
    wasmPaths: MAIA_WASM_PATHS,
  });
}

function renderMaiaHeaderControls() {
  const arrowsBtn = document.getElementById('btnMaiaArrows');
  if (arrowsBtn) {
    arrowsBtn.className = state.maia.showArrows
      ? 'px-1.5 py-0.5 rounded bg-vi/20 text-vi border border-vi/40 text-[10px] font-medium'
      : 'px-1.5 py-0.5 rounded bg-surface text-txtMuted border border-borderSubtle text-[10px] font-medium';
  }
}

function updateInlineMaiaChip() {
  const chip = document.getElementById('sfMaiaSummaryChip');
  if (!chip) return;
  const res = state.maia.result;
  if (!state.maia.enabled || !res || res.fen !== getCurrentFen()) {
    chip.classList.add('hidden');
    return;
  }
  const expPct = Math.round((res.whiteExp ?? 0.5) * 100);
  const top = res.graded?.candidates?.[0];
  const topStr = top ? ` · ${top.san} ${Math.round(top.prob * 100)}%` : '';
  chip.textContent = `M2@${res.eloWhite} ${expPct}%${topStr}`;
  chip.classList.remove('hidden');
}

function renderEloControlBar() {
  const ew = state.maia.eloWhite;
  const eb = state.maia.syncElos ? ew : state.maia.eloBlack;
  const tab = getActiveTab();
  const gameW = parseInt(tab?.meta?.whiteElo || '', 10);
  const gameB = parseInt(tab?.meta?.blackElo || '', 10);
  const hasGameElo = Number.isFinite(gameW) && Number.isFinite(gameB) && gameW >= 800 && gameB >= 800;

  return `
    <div class="px-2 py-1.5 border-b border-borderSubtle bg-bg/50 flex flex-col gap-1.5 text-[10.5px]">
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <div class="flex items-center gap-1.5">
          <span class="text-txtMuted font-semibold">Rating</span>
          <label class="inline-flex items-center gap-1 text-[10px] text-txtMuted cursor-pointer select-none">
            <input id="chkMaiaSyncElos" type="checkbox" class="accent-vi" ${state.maia.syncElos ? 'checked' : ''} />
            <span>Both</span>
          </label>
          ${
            hasGameElo
              ? `<button id="btnMaiaUseGameElo" type="button" class="px-1.5 py-[1px] rounded bg-surface hover:bg-surfaceHover border border-borderSubtle text-[9.5px] text-txtMuted hover:text-txt" title="Use game Elos (${gameW} / ${gameB})">From game</button>`
              : ''
          }
        </div>
        <span class="font-mono text-[10px] text-vi font-semibold">${
          state.maia.syncElos ? `${ew >= 2000 ? `${ew} (2000+)` : ew} Elo` : `W ${ew} · B ${eb}`
        }</span>
      </div>
      <div class="grid ${state.maia.syncElos ? 'grid-cols-1' : 'grid-cols-2'} gap-2">
        <label class="flex items-center gap-2">
          <span class="text-[9.5px] text-txtMuted shrink-0">${state.maia.syncElos ? 'Elo' : 'W'}</span>
          <input id="maiaEloWhiteSlider" type="range" min="1000" max="2200" step="50" value="${ew}" class="flex-1 accent-vi h-1.5" />
        </label>
        ${
          state.maia.syncElos
            ? ''
            : `<label class="flex items-center gap-2">
                <span class="text-[9.5px] text-txtMuted shrink-0">B</span>
                <input id="maiaEloBlackSlider" type="range" min="1000" max="2200" step="50" value="${eb}" class="flex-1 accent-vi h-1.5" />
              </label>`
        }
      </div>
    </div>
  `;
}

function bindEloControlEvents() {
  const syncChk = document.getElementById('chkMaiaSyncElos');
  const wSlider = document.getElementById('maiaEloWhiteSlider');
  const bSlider = document.getElementById('maiaEloBlackSlider');
  const gameBtn = document.getElementById('btnMaiaUseGameElo');

  if (syncChk) {
    syncChk.onchange = () => setMaiaElos({ syncElos: syncChk.checked, eloWhite: state.maia.eloWhite });
  }
  if (wSlider) {
    wSlider.oninput = () => setMaiaElos({ eloWhite: Number(wSlider.value) });
  }
  if (bSlider) {
    bSlider.oninput = () => setMaiaElos({ eloBlack: Number(bSlider.value) });
  }
  if (gameBtn) {
    gameBtn.onclick = () => applyGameElosToMaia();
  }
}

export function renderMaiaUI() {
  renderMaiaHeaderControls();
  updateInlineMaiaChip();

  const badge = document.getElementById('maiaModeBadge');
  const strip = document.getElementById('maiaSummaryStrip');
  const body = document.getElementById('maiaContentBody');
  if (!body) return;

  const res = state.maia.result && state.maia.result.fen === getCurrentFen() ? state.maia.result : null;

  if (badge) {
    if (!state.maia.running) badge.textContent = 'Paused';
    else if (state.maia.status === 'downloading') badge.textContent = `Model ${state.maia.progressPct}%`;
    else if (state.maia.status === 'initializing') badge.textContent = 'Starting WASM…';
    else if (state.maia.status === 'error') badge.textContent = 'Error';
    else badge.textContent = `Local ONNX · ${state.maia.eloWhite}`;
  }

  if (!state.maia.running) {
    if (strip) strip.innerHTML = `<span class="text-txtMuted">Maia 2 paused</span>`;
    body.innerHTML = `${renderEloControlBar()}<div class="p-2.5 text-txtMuted text-[11px]">Paused. Click ▶ to resume Maia 2 local inference.</div>`;
    bindEloControlEvents();
    return;
  }

  let isOver = false;
  try {
    isOver = new Chess(getCurrentFen()).isGameOver();
  } catch (_) {}
  if (isOver) {
    if (strip) strip.innerHTML = `<span class="text-txtMuted">Game Over</span>`;
    body.innerHTML = `${renderEloControlBar()}<div class="p-2.5 text-txtMuted text-[11px]">Game Over</div>`;
    bindEloControlEvents();
    return;
  }

  if (state.maia.status === 'error') {
    if (strip) strip.innerHTML = `<span class="text-ro">Maia 2 unavailable</span>`;
    body.innerHTML = `${renderEloControlBar()}
      <div class="p-2.5 flex flex-col items-start gap-2 font-sans text-[11px]">
        <div class="text-ro leading-relaxed">${escapeHtml(state.maia.error || 'Could not load Maia 2 model')}</div>
        <button id="btnMaiaRetry" type="button" class="px-2 py-1 rounded bg-vi/20 hover:bg-vi/30 text-vi border border-vi/40 font-semibold text-[10.5px]">↻ Retry</button>
      </div>`;
    bindEloControlEvents();
    const retryBtn = document.getElementById('btnMaiaRetry');
    if (retryBtn) {
      retryBtn.onclick = () => {
        state.maia.status = 'idle';
        state.maia.error = '';
        triggerMaia2Analysis();
      };
    }
    return;
  }

  if (!res && (state.maia.status === 'downloading' || state.maia.status === 'initializing')) {
    const pct = state.maia.progressPct || 0;
    const isInit = state.maia.status === 'initializing';
    if (strip) {
      strip.innerHTML = `<span class="text-vi font-semibold">${
        isInit ? 'Initializing Maia 2 WASM…' : `Downloading Maia 2 (${pct}%)`
      }</span><span class="text-[10px] text-txtMuted">Cached locally once</span>`;
    }
    body.innerHTML = `${renderEloControlBar()}
      <div class="p-2.5 flex flex-col gap-1.5 text-[11px] text-txtMuted">
        <div>${isInit ? 'Compiling local ONNX Runtime Web session…' : 'Downloading quantized Maia 2 model (~23 MB, cached in browser IndexedDB for offline reuse)…'}</div>
        <div class="w-full h-1.5 rounded-full bg-surface overflow-hidden">
          <div class="h-full bg-vi transition-all" style="width:${isInit ? 100 : Math.max(4, pct)}%"></div>
        </div>
      </div>`;
    bindEloControlEvents();
    return;
  }

  if (!res) {
    if (strip) strip.innerHTML = `<span class="text-txtMuted">Ready (1000–2200 Elo)</span>`;
    body.innerHTML = `${renderEloControlBar()}<div class="p-2.5 text-txtMuted text-[11px]">Running Maia 2 locally in browser…</div>`;
    bindEloControlEvents();
    return;
  }

  const expPct = Math.round((res.whiteExp ?? 0.5) * 100);
  const danger = res.graded?.danger || { level: 'low', label: 'Calm' };
  const dangerCls =
    danger.level === 'high'
      ? 'bg-ro/20 text-ro border-ro/40'
      : danger.level === 'med'
        ? 'bg-am/20 text-am border-am/40'
        : 'bg-em/15 text-em border-em/35';

  if (strip) {
    const sfTxt =
      res.sfGraded && res.bestSfCpWhite !== null
        ? `SF ${formatReviewScore(res.bestSfCpWhite, res.bestSfMate)}`
        : 'Grading…';
    strip.innerHTML = `
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="px-1.5 py-[1px] rounded bg-vi/20 text-vi font-bold min-w-[38px] text-center" title="Maia 2 expected score for White at ${res.eloWhite} Elo">${expPct}%</span>
        <div class="wdl-bar border border-borderSubtle flex-1 max-w-[110px]" title="White expected score ${expPct}% / Black ${100 - expPct}%">
          <div class="sb-w" style="width:${expPct}%">${expPct >= 22 ? expPct : ''}</div>
          <div class="sb-b" style="width:${100 - expPct}%">${100 - expPct >= 22 ? 100 - expPct : ''}</div>
        </div>
        <span class="text-txtMuted text-[10px] truncate">${escapeHtml(sfTxt)}</span>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <span class="px-1.5 py-[1px] rounded border text-[9.5px] font-semibold ${dangerCls}">${escapeHtml(danger.label)}</span>
      </div>
    `;
  }

  const cands = res.graded?.candidates || [];
  const candRowsHtml = cands
    .map((c, idx) => {
      const probPct = Math.round((Number(c.prob) || 0) * 100);
      const grade = c.grade || 'unknown';
      const dotCls =
        grade === 'blunder'
          ? 'bg-ro'
          : grade === 'inaccuracy'
            ? 'bg-am'
            : grade === 'best'
              ? 'bg-em'
              : 'bg-vi';
      const barCls =
        grade === 'blunder'
          ? 'bg-ro'
          : grade === 'inaccuracy'
            ? 'bg-am'
            : grade === 'best'
              ? 'bg-em'
              : 'bg-vi';
      const dropCls =
        grade === 'blunder'
          ? 'text-ro'
          : grade === 'inaccuracy'
            ? 'text-am'
            : grade === 'best'
              ? 'text-em'
              : 'text-txtMuted';
      const dropPp = c.drop_mover !== null && c.drop_mover !== undefined ? Math.round(c.drop_mover * 100) : null;
      const dropLabel = c.is_sf_best
        ? 'Best'
        : dropPp === null
          ? '…'
          : dropPp <= 2
            ? 'OK'
            : `-${dropPp}pp`;
      const cpLabel =
        c.cp_white !== null && c.cp_white !== undefined ? formatReviewScore(c.cp_white, c.mate) : '…';
      const hasRefute = grade !== 'best' && grade !== 'unknown' && c.refutation?.length > 0;
      return `
        <div class="hf-cand-row px-1.5 py-1 rounded hover:bg-surfaceHover cursor-pointer" data-maia-uci="${escapeHtml(c.uci)}" data-maia-idx="${idx}" title="Maia 2 move probability at ${res.eloWhite} Elo: ${probPct}%">
          <div class="flex items-center gap-1 font-mono font-bold text-[11px] min-w-0">
            <span class="w-2 h-2 rounded-full shrink-0 ${dotCls}"></span>
            <span class="truncate">${escapeHtml(c.san || c.uci)}</span>
            ${c.is_sf_best ? '<span class="px-1 rounded bg-cy/15 text-cy text-[8.5px] font-semibold">SF</span>' : ''}
          </div>
          <div class="h-1.5 rounded bg-surface overflow-hidden">
            <div class="h-full ${barCls}" style="width:${Math.max(3, Math.min(100, probPct))}%"></div>
          </div>
          <span class="font-mono text-[10.5px] text-right text-txt">${probPct}%</span>
          <span class="font-mono text-[10px] text-right text-txtMuted">${escapeHtml(cpLabel)}</span>
          <span class="font-mono text-[10px] font-bold text-right ${dropCls}">${escapeHtml(dropLabel)}</span>
          ${
            hasRefute
              ? `<button type="button" data-maia-refute="${idx}" class="px-1 py-[1px] rounded bg-ro/15 hover:bg-ro/30 text-ro border border-ro/35 text-[9px] font-semibold text-center" title="Play move and Stockfish refutation">Refute</button>`
              : '<span></span>'
          }
        </div>
      `;
    })
    .join('');

  const matNote = res.materialAdjusted
    ? `<div class="px-2 py-1 rounded bg-surface/70 border border-borderSubtle text-[10px] text-txtMuted">Adjusted for chess rules: ${escapeHtml(res.materialReason)}</div>`
    : '';

  const regretNote =
    res.sfGraded && res.graded.blunderProb >= 0.15
      ? `<div class="px-2 py-1 rounded bg-am/15 border border-am/35 text-[10.5px] text-am">At ${res.eloWhite} Elo, players blunder here ~${Math.round(res.graded.blunderProb * 100)}% of the time (expected drop ${(res.graded.expectedRegret * 100).toFixed(1)} pp).</div>`
      : '';

  body.innerHTML = `
    ${renderEloControlBar()}
    <div class="p-2 flex flex-col gap-1.5 text-[11px]">
      ${matNote}
      ${regretNote}
      <div class="flex items-center justify-between text-[9.5px] uppercase tracking-wider text-txtMuted font-semibold">
        <span>Human Candidates (Maia 2 × SF19)</span>
        <span class="font-mono normal-case font-normal">100% local WASM</span>
      </div>
      <div class="flex flex-col gap-0.5">${candRowsHtml}</div>
    </div>
  `;

  bindEloControlEvents();

  body.querySelectorAll('.hf-cand-row').forEach((row) => {
    const uci = row.dataset.maiaUci;
    row.onclick = (e) => {
      if (e.target.closest('[data-maia-refute]')) return;
      if (uci) playMoveOnTree(uci);
    };
    row.onmouseenter = () => {
      state.maia.hoverCandidateUci = uci || null;
      renderArrows();
    };
    row.onmouseleave = () => {
      state.maia.hoverCandidateUci = null;
      renderArrows();
    };
  });

  body.querySelectorAll('[data-maia-refute]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.maiaRefute);
      const cand = cands[idx];
      if (!cand?.uci) return;
      const seq = [cand.uci, ...(cand.refutation || [])];
      for (const mv of seq) {
        if (!playMoveOnTree(mv)) break;
      }
    };
  });
}
