import { Chess } from 'chess.js';
import { state, getCurrentFen, escapeHtml, formatCount, showToast } from '../state.js';
import { fetchCloudEval } from '../api/lichess.js';
import { renderArrows } from '../board/board.js';
import {
  parseUciInfoLine,
  normalizePv,
  renderEngineLines,
  updateEvalBarFromState,
} from './uci.js';
import { createUciSession } from './uciSession.js';

const STOCKFISH_MT_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-19-lite.js`;
const STOCKFISH_ST_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-19-lite-single.js`;

let wasmSession = null;
let wsSession = null;
let mtInitTimer = null;

// A multi-threaded build can load but stall while spawning its pthread
// workers (seen in Safari). If `uciok` has not arrived by then, retry with
// the single-threaded build instead of showing "Loading" forever.
export const MT_INIT_TIMEOUT_MS = 5000;

function canUseMultiThreadedWasm() {
  return (
    typeof crossOriginIsolated !== 'undefined' &&
    crossOriginIsolated === true &&
    typeof SharedArrayBuffer !== 'undefined'
  );
}

function getDesiredThreads() {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  return Math.min(4, Math.max(1, cores - 1));
}

function getWasmBadgeLabel() {
  return state.sf.multiThreaded && state.sf.threads > 1
    ? `SF 19 Lite MT (${state.sf.threads}T)`
    : 'SF 19 Lite';
}

function handleSfInfoLine(line, infoFen, expectedMode) {
  if (state.sf.mode !== expectedMode) return;
  if (!state.sf.running) return;
  if (infoFen !== state.sf.currentFen || infoFen !== getCurrentFen()) return;
  if (!line.includes(' pv ') || !line.includes(' score ')) return;

  const parsed = parseUciInfoLine(line);
  if (!parsed || parsed.multipv > state.sf.multiPv) return;

  parsed.pv = normalizePv(infoFen, parsed.pv);
  if (!parsed.pv.length) return;

  state.sf.lines[parsed.multipv] = parsed;
  renderSfUI();
}

/**
 * Change how many lines Stockfish shows (1–5) and how deep the in-browser
 * engine searches (0 = until stopped). Saved for next time; re-runs analysis.
 */
export function setSfOptions({ multiPv, depth } = {}) {
  if (Number.isInteger(multiPv) && multiPv >= 1 && multiPv <= 5) state.sf.multiPv = multiPv;
  if (Number.isInteger(depth) && depth >= 0 && depth <= 60) state.sf.depth = depth;
  try {
    localStorage.setItem('tichess_sf_opts', JSON.stringify({ multiPv: state.sf.multiPv, depth: state.sf.depth }));
  } catch (_) {
    /* ignore */
  }
  stopLocalSf();
  const cmd = `setoption name MultiPV value ${state.sf.multiPv}`;
  if (state.sf.worker && state.sf.ready) state.sf.worker.postMessage(cmd);
  if (state.sf.ws?.readyState === WebSocket.OPEN) state.sf.ws.send(cmd);
  triggerSfAnalysis();
}

export function initStockfish({ forceSingleThread = false } = {}) {
  if (wasmSession) {
    wasmSession.reset();
    wasmSession = null;
  }
  if (state.sf.worker) {
    try {
      state.sf.worker.terminate();
    } catch (_) {}
    state.sf.worker = null;
  }

  clearTimeout(mtInitTimer);
  mtInitTimer = null;

  const useMt = !forceSingleThread && canUseMultiThreadedWasm();
  const threads = useMt ? getDesiredThreads() : 1;
  const workerUrl = useMt ? STOCKFISH_MT_URL : STOCKFISH_ST_URL;

  state.sf.ready = false;
  state.sf.mode = 'init';
  state.sf.multiThreaded = useMt && threads > 1;
  state.sf.threads = threads;

  const badge = document.getElementById('sfModeBadge');
  if (badge) badge.textContent = useMt ? 'Loading SF 19 Lite MT...' : 'Loading SF 19 Lite...';

  try {
    const w = new Worker(workerUrl);
    state.sf.worker = w;

    const session = createUciSession((cmd) => {
      if (state.sf.worker === w) w.postMessage(cmd);
    });
    session.onInfo((line, infoFen) => handleSfInfoLine(line, infoFen, 'wasm'));
    wasmSession = session;

    w.onerror = (err) => {
      if (state.sf.mode === 'ws') return;
      if (useMt && !state.sf.ready) {
        // Multi-threaded worker failed to initialize; fall back cleanly to single-threaded build
        initStockfish({ forceSingleThread: true });
        return;
      }
      state.sf.mode = 'error';
      state.sf.ready = false;
      renderSfError(`Stockfish WASM failed to load${err?.message ? ': ' + err.message : ''}.`);
    };

    w.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : '';
      if (!line) return;

      if (line === 'uciok') {
        clearTimeout(mtInitTimer);
        mtInitTimer = null;
        if (state.sf.mode !== 'ws') {
          state.sf.mode = 'wasm';
          state.sf.ready = true;
        }
        if (useMt && threads > 1) {
          w.postMessage(`setoption name Threads value ${threads}`);
          w.postMessage('setoption name Hash value 32');
        }
        w.postMessage(`setoption name MultiPV value ${state.sf.multiPv}`);
        w.postMessage('isready');
        triggerSfAnalysis();
        return;
      }

      session.onLine(line);
    };

    w.postMessage('uci');

    if (useMt) {
      mtInitTimer = setTimeout(() => {
        mtInitTimer = null;
        if (state.sf.worker !== w || state.sf.ready || state.sf.mode === 'ws') return;
        console.warn('[stockfish] Multi-threaded build did not respond; falling back to single-threaded.');
        initStockfish({ forceSingleThread: true });
      }, MT_INIT_TIMEOUT_MS);
    }
  } catch (err) {
    if (useMt) {
      initStockfish({ forceSingleThread: true });
      return;
    }
    state.sf.mode = 'error';
    state.sf.ready = false;
    renderSfError(`Stockfish WASM unavailable: ${err?.message || 'Web Worker error'}.`);
  }
}

function renderSfError(message) {
  const badge = document.getElementById('sfModeBadge');
  const list = document.getElementById('sfLinesList');
  if (badge) badge.textContent = 'WASM Unavailable';
  if (list && !Object.keys(state.sf.lines).length) {
    list.innerHTML = `<div class="p-2.5 text-ro font-sans text-[11px] leading-relaxed">${escapeHtml(message)} Lichess Cloud Eval or a Local UCI Bridge can still be used.</div>`;
  }
}

let cloudAbortCtrl = null;

export function stopLocalSf() {
  if (cloudAbortCtrl) {
    cloudAbortCtrl.abort();
    cloudAbortCtrl = null;
  }
  if (wsSession) {
    wsSession.stop();
  }
  if (wasmSession) {
    wasmSession.stop();
  }
}

export async function triggerSfAnalysis() {
  const fen = getCurrentFen();
  const reqId = ++state.sf.cloudReqId;
  state.sf.currentFen = fen;
  state.sf.lines = {};
  state.sf.topArrowUci = null;
  renderArrows();

  const linesEl = document.getElementById('sfLinesList');

  if (!state.sf.running) {
    stopLocalSf();
    if (linesEl) linesEl.innerHTML = `<div class="p-2 text-txtMuted">Paused</div>`;
    return;
  }

  let isOver;
  try {
    isOver = new Chess(fen).isGameOver();
  } catch (_) {
    stopLocalSf();
    if (linesEl) linesEl.innerHTML = `<div class="p-2 text-txtMuted">Invalid Position</div>`;
    return;
  }

  if (isOver) {
    stopLocalSf();
    if (linesEl) linesEl.innerHTML = `<div class="p-2 text-txtMuted">Game Over</div>`;
    return;
  }

  // Stop any previous search / cloud fetch immediately so old info lines cannot leak
  stopLocalSf();

  // 1. Try Lichess Cloud Eval first if enabled (and not overridden by local UCI bridge)
  if (state.sf.cloudEnabled && state.sf.mode !== 'ws') {
    const ctrl = new AbortController();
    cloudAbortCtrl = ctrl;
    try {
      const data = await fetchCloudEval(fen, state.sf.multiPv, { signal: ctrl.signal });
      if (reqId !== state.sf.cloudReqId || fen !== getCurrentFen()) return;
      if (data?.pvs?.length) {
        if (wsSession) wsSession.stop();
        if (wasmSession) wasmSession.stop();
        const flip = fen.split(' ')[1] === 'b' ? -1 : 1;
        const nodes = typeof data.knodes === 'number' ? data.knodes * 1000 : null;
        data.pvs.slice(0, state.sf.multiPv).forEach((pvObj, idx) => {
          const isMate = typeof pvObj.mate === 'number';
          const rawPv = (pvObj.moves || '').trim().split(/\s+/).filter(Boolean);
          const normPv = normalizePv(fen, rawPv);
          if (!normPv.length) return;
          state.sf.lines[idx + 1] = {
            multipv: idx + 1,
            depth: typeof data.depth === 'number' ? data.depth : null,
            nps: null,
            nodes,
            scoreType: isMate ? 'mate' : 'cp',
            scoreVal: (isMate ? pvObj.mate : pvObj.cp || 0) * flip,
            pv: normPv,
          };
        });
        if (Object.keys(state.sf.lines).length) {
          const badge = document.getElementById('sfModeBadge');
          if (badge) badge.textContent = 'Lichess Cloud';
          renderSfUI();
          return;
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError' || reqId !== state.sf.cloudReqId || fen !== getCurrentFen()) {
        return;
      }
      // Fall through to local Stockfish 19 WASM (including on RateLimitError)
    } finally {
      if (cloudAbortCtrl === ctrl) cloudAbortCtrl = null;
    }
  }

  if (reqId !== state.sf.cloudReqId || fen !== getCurrentFen()) return;

  // 2. Local WebSocket UCI Bridge
  if (state.sf.mode === 'ws' && state.sf.ws?.readyState === WebSocket.OPEN && wsSession) {
    const badge = document.getElementById('sfModeBadge');
    if (badge) badge.textContent = 'SF Local UCI';
    wsSession.analyze(fen, 'go infinite');
    return;
  }

  // 3. Real Stockfish 19 WASM in Web Worker
  if (state.sf.ready && state.sf.worker && state.sf.mode === 'wasm' && wasmSession) {
    const badge = document.getElementById('sfModeBadge');
    if (badge) badge.textContent = getWasmBadgeLabel();
    wasmSession.analyze(fen, state.sf.depth > 0 ? `go depth ${state.sf.depth}` : 'go infinite');
    return;
  }

  if (state.sf.mode === 'error') {
    renderSfError('Local Stockfish WASM is not loaded.');
  }
}

export function renderSfUI() {
  const fen = state.sf.currentFen;
  const flip = fen.split(' ')[1] === 'b' ? -1 : 1;
  const top = state.sf.lines[1];

  if (top) {
    const depthEl = document.getElementById('sfDepth');
    const npsEl = document.getElementById('sfNps');
    const mainEvalEl = document.getElementById('sfMainEval');

    if (depthEl) {
      depthEl.textContent = typeof top.depth === 'number' ? `Depth: ${top.depth}` : 'Depth: —';
    }
    if (npsEl) {
      if (top.nps) {
        npsEl.textContent = `${Math.round(top.nps / 1000)} kn/s`;
      } else if (top.nodes) {
        npsEl.textContent = `${formatCount(top.nodes)} nodes`;
      } else {
        npsEl.textContent = '';
      }
    }

    const wVal = top.scoreVal * flip;
    const lbl =
      top.scoreType === 'mate'
        ? `${wVal > 0 ? '+M' : '-M'}${Math.abs(wVal)}`
        : `${wVal >= 0 ? '+' : ''}${(wVal / 100).toFixed(2)}`;
    state.sf.evalWhiteCp = top.scoreType === 'mate' ? (wVal > 0 ? 9999 : -9999) : wVal;
    state.sf.evalLabel = lbl;
    if (mainEvalEl) mainEvalEl.textContent = lbl;

    if (top.pv?.[0]) {
      state.sf.topArrowUci = top.pv[0];
      renderArrows();
    }
    if (state.evalBarSource === 'sf' || (state.evalBarSource === 'lc0' && state.lc0.mode !== 'ws')) {
      updateEvalBarFromState();
    }
  }

  renderEngineLines('sfLinesList', state.sf.lines, fen, flip);
}

export function connectSfWs(url) {
  if (wsSession) {
    wsSession.reset();
    wsSession = null;
  }
  if (state.sf.ws) {
    try {
      state.sf.ws.close();
    } catch (_) {}
    state.sf.ws = null;
  }

  try {
    const ws = new WebSocket(url);
    const session = createUciSession((cmd) => {
      if (state.sf.ws === ws && ws.readyState === WebSocket.OPEN) {
        ws.send(cmd);
      }
    });
    session.onInfo((line, infoFen) => handleSfInfoLine(line, infoFen, 'ws'));

    ws.onopen = () => {
      stopLocalSf();
      state.sf.ws = ws;
      wsSession = session;
      state.sf.mode = 'ws';
      state.sf.wsUrl = url;
      localStorage.setItem('cms_sf_ws', url);
      ws.send('uci');
      ws.send(`setoption name MultiPV value ${state.sf.multiPv}`);
      ws.send('isready');
      const badge = document.getElementById('sfModeBadge');
      if (badge) badge.textContent = 'SF Local UCI';
      updateBridgeStatusBadge();
      showToast('Connected to Local Stockfish UCI Bridge');
      triggerSfAnalysis();
    };
    ws.onmessage = (ev) => {
      session.onLine(String(ev.data || ''));
    };
    ws.onclose = () => {
      if (state.sf.ws === ws) {
        session.reset();
        wsSession = null;
        state.sf.ws = null;
        state.sf.mode = state.sf.ready ? 'wasm' : 'error';
        updateBridgeStatusBadge();
        triggerSfAnalysis();
      }
    };
    ws.onerror = () => showToast(`Could not connect to ${url}`, true);
  } catch (_) {
    showToast('Invalid WebSocket URL', true);
  }
}

export function disconnectSfWs() {
  if (wsSession) {
    wsSession.reset();
    wsSession = null;
  }
  if (state.sf.ws) {
    try {
      state.sf.ws.close();
    } catch (_) {}
    state.sf.ws = null;
  }
  state.sf.mode = state.sf.ready ? 'wasm' : 'error';
  updateBridgeStatusBadge();
  triggerSfAnalysis();
  showToast('Disconnected Local Stockfish Bridge');
}

export function updateBridgeStatusBadge() {
  const el = document.getElementById('bridgeStatusBadge');
  if (!el) return;
  const parts = [];
  if (state.lc0.mode === 'ws') parts.push('Lc0');
  if (state.sf.mode === 'ws') parts.push('SF');
  el.textContent = parts.length ? `${parts.join(' + ')} Connected` : 'No Bridge Connected';
}
