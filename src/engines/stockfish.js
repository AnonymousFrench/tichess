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

const STOCKFISH_WORKER_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-19-lite-single.js`;

let wasmSession = null;
let wsSession = null;

function handleSfInfoLine(line, infoFen, expectedMode) {
  if (state.sf.mode !== expectedMode) return;
  if (!state.sf.running) return;
  if (infoFen !== state.sf.currentFen || infoFen !== getCurrentFen()) return;
  if (!line.includes(' pv ') || !line.includes(' score ')) return;

  const parsed = parseUciInfoLine(line);
  if (!parsed || parsed.multipv > 3) return;

  parsed.pv = normalizePv(infoFen, parsed.pv);
  if (!parsed.pv.length) return;

  state.sf.lines[parsed.multipv] = parsed;
  renderSfUI();
}

export function initStockfish() {
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

  state.sf.ready = false;
  state.sf.mode = 'init';
  const badge = document.getElementById('sfModeBadge');
  if (badge) badge.textContent = 'Loading SF 19 WASM...';

  try {
    const w = new Worker(STOCKFISH_WORKER_URL);
    state.sf.worker = w;

    const session = createUciSession((cmd) => {
      if (state.sf.worker === w) w.postMessage(cmd);
    });
    session.onInfo((line, infoFen) => handleSfInfoLine(line, infoFen, 'wasm'));
    wasmSession = session;

    w.onerror = (err) => {
      if (state.sf.mode === 'ws') return;
      state.sf.mode = 'error';
      state.sf.ready = false;
      renderSfError(`Stockfish WASM failed to load${err?.message ? ': ' + err.message : ''}.`);
    };

    w.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : '';
      if (!line) return;

      if (line === 'uciok') {
        if (state.sf.mode !== 'ws') {
          state.sf.mode = 'wasm';
          state.sf.ready = true;
        }
        w.postMessage('setoption name MultiPV value 3');
        w.postMessage('isready');
        triggerSfAnalysis();
        return;
      }

      session.onLine(line);
    };

    w.postMessage('uci');
  } catch (err) {
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

export function stopLocalSf() {
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

  let isOver = false;
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

  // Stop any previous search immediately so old info lines cannot leak during cloud fetch
  stopLocalSf();

  // 1. Try Lichess Cloud Eval first if enabled (and not overridden by local UCI bridge)
  if (state.sf.cloudEnabled && state.sf.mode !== 'ws') {
    try {
      const data = await fetchCloudEval(fen, 3);
      if (reqId !== state.sf.cloudReqId || fen !== getCurrentFen()) return;
      if (data?.pvs?.length) {
        stopLocalSf();
        const flip = fen.split(' ')[1] === 'b' ? -1 : 1;
        const nodes = typeof data.knodes === 'number' ? data.knodes * 1000 : null;
        data.pvs.slice(0, 3).forEach((pvObj, idx) => {
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
    } catch (_) {
      if (reqId !== state.sf.cloudReqId || fen !== getCurrentFen()) return;
      // Fall through to local Stockfish 19 WASM
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
    if (badge) badge.textContent = 'SF 19 WASM';
    wasmSession.analyze(fen, 'go depth 18');
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
    if (state.evalBarSource === 'sf' || state.lc0.mode !== 'ws') {
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
      ws.send('setoption name MultiPV value 3');
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
