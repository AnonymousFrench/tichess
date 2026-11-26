import { Chess } from 'chess.js';
import { state, getCurrentFen, showToast } from '../state.js';
import { renderArrows } from '../board/board.js';
import {
  parseUciInfoLine,
  normalizePv,
  renderEngineLines,
  updateEvalBarFromState,
} from './uci.js';
import { createUciSession } from './uciSession.js';
import { updateBridgeStatusBadge } from './stockfish.js';

let openSettingsModalCb = null;
let lc0Session = null;

export function setLc0SettingsHandler(fn) {
  openSettingsModalCb = fn;
}

export function initLc0() {
  state.lc0.mode = 'disconnected';
  renderLc0Disconnected();
}

export function renderLc0Disconnected() {
  const badge = document.getElementById('lc0ModeBadge');
  const mainEval = document.getElementById('lc0MainEval');
  const depth = document.getElementById('lc0Depth');
  const wdlBar = document.getElementById('lc0WdlBar');
  const list = document.getElementById('lc0LinesList');

  if (badge) badge.textContent = 'Not Connected';
  if (mainEval) mainEval.textContent = '—';
  if (depth) depth.textContent = 'D:—';
  if (wdlBar) {
    wdlBar.innerHTML = `<div class="w-full bg-surface text-txtMuted text-[8px] leading-[12px] text-center">No WDL</div>`;
  }
  if (list) {
    list.innerHTML = `
      <div class="p-3 flex flex-col items-start gap-2 font-sans text-[11px] text-txtMuted">
        <p class="leading-relaxed">
          Real <span class="text-vi font-semibold">Lc0</span> requires a local UCI WebSocket bridge running on your machine.
        </p>
        <button id="btnLc0ConnectInline" class="px-2.5 py-1 rounded bg-vi/20 hover:bg-vi/30 text-vi border border-vi/40 font-semibold text-[11px] transition-colors">
          🔌 Connect Local Lc0 Bridge
        </button>
      </div>
    `;
    const btn = document.getElementById('btnLc0ConnectInline');
    if (btn && openSettingsModalCb) {
      btn.onclick = () => openSettingsModalCb();
    }
  }
}

export function triggerLc0Analysis() {
  const fen = getCurrentFen();
  state.lc0.currentFen = fen;
  state.lc0.lines = {};
  state.lc0.topArrowUci = null;
  renderArrows();

  if (state.lc0.mode !== 'ws' || state.lc0.ws?.readyState !== WebSocket.OPEN || !lc0Session) {
    renderLc0Disconnected();
    return;
  }

  const linesEl = document.getElementById('lc0LinesList');
  if (!state.lc0.running) {
    lc0Session.stop();
    if (linesEl) linesEl.innerHTML = `<div class="p-2 text-txtMuted">Paused</div>`;
    return;
  }

  let isOver = false;
  try {
    isOver = new Chess(fen).isGameOver();
  } catch (_) {
    lc0Session.stop();
    if (linesEl) linesEl.innerHTML = `<div class="p-2 text-txtMuted">Invalid Position</div>`;
    return;
  }

  if (isOver) {
    lc0Session.stop();
    if (linesEl) linesEl.innerHTML = `<div class="p-2 text-txtMuted">Game Over</div>`;
    return;
  }

  lc0Session.analyze(fen, 'go infinite', [`setoption name Contempt value ${state.lc0.contempt}`]);
}

export function renderLc0UI() {
  const fen = state.lc0.currentFen;
  const side = fen.split(' ')[1];
  const flip = side === 'b' ? -1 : 1;
  const top = state.lc0.lines[1];

  if (top) {
    const depthEl = document.getElementById('lc0Depth');
    const mainEvalEl = document.getElementById('lc0MainEval');
    if (depthEl) depthEl.textContent = `D:${top.depth}`;
    const wVal = top.scoreVal * flip;
    const lbl =
      top.scoreType === 'mate'
        ? `${wVal > 0 ? '+M' : '-M'}${Math.abs(wVal)}`
        : `${wVal >= 0 ? '+' : ''}${(wVal / 100).toFixed(2)}`;
    state.lc0.evalWhiteCp = top.scoreType === 'mate' ? (wVal > 0 ? 9999 : -9999) : wVal;
    state.lc0.evalLabel = lbl;
    if (mainEvalEl) mainEvalEl.textContent = lbl;

    const wdlEl = document.getElementById('lc0WdlBar');
    if (top.wdl && wdlEl) {
      const [wR, dR, lR] = side === 'w' ? top.wdl : [top.wdl[2], top.wdl[1], top.wdl[0]];
      const wp = Math.round(wR / 10);
      const dp = Math.round(dR / 10);
      const bp = Math.max(0, 100 - wp - dp);
      wdlEl.innerHTML = `${wp ? `<div class="sb-w" style="width:${wp}%">${wp >= 18 ? wp : ''}</div>` : ''}${
        dp ? `<div class="sb-d" style="width:${dp}%">${dp >= 18 ? dp : ''}</div>` : ''
      }${bp ? `<div class="sb-b" style="width:${bp}%">${bp >= 18 ? bp : ''}</div>` : ''}`;
    }

    if (top.pv?.[0]) {
      state.lc0.topArrowUci = top.pv[0];
      renderArrows();
    }
    if (state.evalBarSource === 'lc0') {
      updateEvalBarFromState();
    }
  }

  renderEngineLines('lc0LinesList', state.lc0.lines, fen, flip);
}

export function connectLc0Ws(url) {
  if (lc0Session) {
    lc0Session.reset();
    lc0Session = null;
  }
  if (state.lc0.ws) {
    try {
      state.lc0.ws.close();
    } catch (_) {}
    state.lc0.ws = null;
  }

  try {
    const ws = new WebSocket(url);
    const session = createUciSession((cmd) => {
      if (state.lc0.ws === ws && ws.readyState === WebSocket.OPEN) {
        ws.send(cmd);
      }
    });
    session.onInfo((line, infoFen) => {
      if (state.lc0.mode !== 'ws' || !state.lc0.running) return;
      if (infoFen !== state.lc0.currentFen || infoFen !== getCurrentFen()) return;
      if (!line.includes(' pv ') || !line.includes(' score ')) return;
      const parsed = parseUciInfoLine(line);
      if (!parsed || parsed.multipv > 3) return;
      parsed.pv = normalizePv(infoFen, parsed.pv);
      if (!parsed.pv.length) return;
      state.lc0.lines[parsed.multipv] = parsed;
      renderLc0UI();
    });

    ws.onopen = () => {
      state.lc0.ws = ws;
      lc0Session = session;
      state.lc0.mode = 'ws';
      state.lc0.wsUrl = url;
      localStorage.setItem('cms_lc0_ws', url);
      ws.send('uci');
      ws.send('setoption name MultiPV value 3');
      ws.send('setoption name UCI_ShowWDL value true');
      ws.send('isready');
      const badge = document.getElementById('lc0ModeBadge');
      if (badge) badge.textContent = 'Lc0 Local UCI';
      updateBridgeStatusBadge();
      showToast('Connected to Local Lc0 UCI Bridge');
      triggerLc0Analysis();
    };
    ws.onmessage = (ev) => {
      session.onLine(String(ev.data || ''));
    };
    ws.onclose = () => {
      if (state.lc0.ws === ws) {
        session.reset();
        lc0Session = null;
        state.lc0.ws = null;
        state.lc0.mode = 'disconnected';
        state.lc0.lines = {};
        state.lc0.topArrowUci = null;
        renderArrows();
        renderLc0Disconnected();
        updateBridgeStatusBadge();
        updateEvalBarFromState();
      }
    };
    ws.onerror = () => showToast(`Could not connect to ${url}`, true);
  } catch (_) {
    showToast('Invalid WebSocket URL', true);
  }
}

export function disconnectLc0Ws() {
  if (lc0Session) {
    lc0Session.reset();
    lc0Session = null;
  }
  if (state.lc0.ws) {
    try {
      state.lc0.ws.close();
    } catch (_) {}
    state.lc0.ws = null;
  }
  state.lc0.mode = 'disconnected';
  state.lc0.lines = {};
  state.lc0.topArrowUci = null;
  renderArrows();
  renderLc0Disconnected();
  updateBridgeStatusBadge();
  updateEvalBarFromState();
  showToast('Disconnected Local Lc0 Bridge');
}
