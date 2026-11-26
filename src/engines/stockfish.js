import { Chess } from 'chess.js';
import { state, getCurrentFen, showToast } from '../state.js';
import { fetchCloudEval } from '../api/lichess.js';
import { renderArrows } from '../board/board.js';
import { parseUciInfoLine, renderEngineLines, updateEvalBarFromState } from './uci.js';

const STOCKFISH_WORKER_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-19-lite-single.js`;

export function initStockfish() {
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

      if (
        line.startsWith('info ') &&
        line.includes(' pv ') &&
        line.includes(' score ') &&
        state.sf.mode === 'wasm'
      ) {
        const parsed = parseUciInfoLine(line);
        if (parsed && parsed.multipv <= 3) {
          state.sf.lines[parsed.multipv] = parsed;
          renderSfUI();
        }
      }
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
    list.innerHTML = `<div class="p-2.5 text-ro font-sans text-[11px] leading-relaxed">${message} Lichess Cloud Eval or a Local UCI Bridge can still be used.</div>`;
  }
}

export function stopLocalSf() {
  if (state.sf.ws?.readyState === WebSocket.OPEN) {
    state.sf.ws.send('stop');
  }
  if (state.sf.worker && state.sf.ready) {
    state.sf.worker.postMessage('stop');
  }
}

export async function triggerSfAnalysis() {
  const fen = getCurrentFen();
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

  if (new Chess(fen).isGameOver()) {
    stopLocalSf();
    if (linesEl) linesEl.innerHTML = `<div class="p-2 text-txtMuted">Game Over</div>`;
    return;
  }

  // 1. Try Lichess Cloud Eval first if enabled (and not overridden by local UCI bridge)
  if (state.sf.cloudEnabled && state.sf.mode !== 'ws') {
    const reqId = ++state.sf.cloudReqId;
    try {
      const data = await fetchCloudEval(fen, 3);
      if (reqId !== state.sf.cloudReqId) return;
      if (data?.pvs?.length) {
        stopLocalSf();
        const flip = fen.split(' ')[1] === 'b' ? -1 : 1;
        data.pvs.slice(0, 3).forEach((pvObj, idx) => {
          const isMate = typeof pvObj.mate === 'number';
          state.sf.lines[idx + 1] = {
            multipv: idx + 1,
            depth: typeof data.depth === 'number' ? data.depth : null,
            nps: (data.knodes || 0) * 1000,
            scoreType: isMate ? 'mate' : 'cp',
            scoreVal: (isMate ? pvObj.mate : pvObj.cp || 0) * flip,
            pv: (pvObj.moves || '').trim().split(/\s+/),
          };
        });
        document.getElementById('sfModeBadge').textContent = 'Lichess Cloud';
        renderSfUI();
        return;
      }
    } catch (_) {
      // Fall through to local Stockfish 19 WASM
    }
  }

  // 2. Local WebSocket UCI Bridge
  if (state.sf.mode === 'ws' && state.sf.ws?.readyState === WebSocket.OPEN) {
    document.getElementById('sfModeBadge').textContent = 'SF Local UCI';
    state.sf.ws.send('stop');
    state.sf.ws.send(`position fen ${fen}`);
    state.sf.ws.send('go infinite');
    return;
  }

  // 3. Real Stockfish 19 WASM in Web Worker
  if (state.sf.ready && state.sf.worker && state.sf.mode === 'wasm') {
    document.getElementById('sfModeBadge').textContent = 'SF 19 WASM';
    state.sf.worker.postMessage('stop');
    state.sf.worker.postMessage(`position fen ${fen}`);
    state.sf.worker.postMessage('go depth 18');
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
    document.getElementById('sfDepth').textContent =
      typeof top.depth === 'number' ? `Depth: ${top.depth}` : 'Depth: —';
    document.getElementById('sfNps').textContent = top.nps
      ? `${Math.round(top.nps / 1000)} kn/s`
      : '';
    const wVal = top.scoreVal * flip;
    const lbl =
      top.scoreType === 'mate'
        ? `${wVal > 0 ? '+M' : '-M'}${Math.abs(wVal)}`
        : `${wVal >= 0 ? '+' : ''}${(wVal / 100).toFixed(2)}`;
    state.sf.evalWhiteCp = top.scoreType === 'mate' ? (wVal > 0 ? 9999 : -9999) : wVal;
    state.sf.evalLabel = lbl;
    document.getElementById('sfMainEval').textContent = lbl;

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
  if (state.sf.ws) {
    try {
      state.sf.ws.close();
    } catch (_) {}
    state.sf.ws = null;
  }

  try {
    const ws = new WebSocket(url);
    ws.onopen = () => {
      stopLocalSf();
      state.sf.ws = ws;
      state.sf.mode = 'ws';
      state.sf.wsUrl = url;
      localStorage.setItem('cms_sf_ws', url);
      ws.send('uci');
      ws.send('setoption name MultiPV value 3');
      ws.send('isready');
      document.getElementById('sfModeBadge').textContent = 'SF Local UCI';
      updateBridgeStatusBadge();
      showToast('Connected to Local Stockfish UCI Bridge');
      triggerSfAnalysis();
    };
    ws.onmessage = (ev) => {
      const line = String(ev.data || '');
      if (line.startsWith('info ') && line.includes(' pv ') && line.includes(' score ')) {
        const parsed = parseUciInfoLine(line);
        if (parsed && parsed.multipv <= 3) {
          state.sf.lines[parsed.multipv] = parsed;
          renderSfUI();
        }
      }
    };
    ws.onclose = () => {
      if (state.sf.ws === ws) {
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
