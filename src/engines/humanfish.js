import { Chess } from 'chess.js';
import {
  state,
  getActiveTab,
  getCurrentFen,
  escapeHtml,
} from '../state.js';
import { playMoveOnTree, renderArrows } from '../board/board.js';
import { updateEvalBarFromState } from './uci.js';
import {
  TC_PRESETS,
  extractGameContextFromTab,
  resolveHumanfishEndpoint,
  buildHumanfishCacheKey,
  getActiveHumanOutcome,
  computeDangerLevel,
  computeDivergenceInfo,
  formatShortClock,
  formatSignedPp,
} from './humanfishMath.js';
import { triggerMaia2Analysis, renderMaiaUI } from './maia2.js';

const MAX_CACHE_ENTRIES = 120;
const resultCache = new Map();

let hfAbortCtrl = null;
let openSettingsModalCb = null;

export function setHumanfishSettingsHandler(fn) {
  openSettingsModalCb = fn;
}

function cacheGet(key) {
  if (!resultCache.has(key)) return null;
  const val = resultCache.get(key);
  // Refresh LRU recency
  resultCache.delete(key);
  resultCache.set(key, val);
  return val;
}

function cacheSet(key, value) {
  if (resultCache.has(key)) resultCache.delete(key);
  resultCache.set(key, value);
  if (resultCache.size > MAX_CACHE_ENTRIES) {
    const oldest = resultCache.keys().next().value;
    resultCache.delete(oldest);
  }
}

export function stopHumanfish() {
  if (hfAbortCtrl) {
    hfAbortCtrl.abort();
    hfAbortCtrl = null;
  }
  state.hf.loading = false;
}

/**
 * Resolve the effective HumanFish request parameters for the active tab,
 * applying any active What-If override on top of the game's FEN/ply.
 */
export function getEffectiveHumanfishParams() {
  const ctx = extractGameContextFromTab(getActiveTab());
  if (!state.hf.whatIfOverride) return ctx;
  return {
    ...ctx,
    ...state.hf.whatIfOverride,
    fen: ctx.fen,
    ply: ctx.ply,
  };
}

/**
 * Switch the Engine panel between Stockfish ('sf'), Maia 2 ('maia'), and HumanFish ('hf').
 */
export function setEngineTab(tabName) {
  const next = tabName === 'hf' ? 'hf' : tabName === 'maia' ? 'maia' : 'sf';
  state.engineTab = next;

  const btnSfTab = document.getElementById('btnEngineTabSf');
  const btnMaiaTab = document.getElementById('btnEngineTabMaia');
  const btnHfTab = document.getElementById('btnEngineTabHf');
  const sfControls = document.getElementById('sfHeaderControls');
  const maiaControls = document.getElementById('maiaHeaderControls');
  const hfControls = document.getElementById('hfHeaderControls');
  const sfView = document.getElementById('sfEngineView');
  const maiaView = document.getElementById('maiaEngineView');
  const hfView = document.getElementById('hfEngineView');
  const sfBadge = document.getElementById('sfModeBadge');
  const maiaBadge = document.getElementById('maiaModeBadge');
  const hfBadge = document.getElementById('hfModeBadge');
  const toggleBtn = document.getElementById('btnSfToggle');

  const inactiveCls =
    'px-1.5 py-0.5 rounded text-txtMuted hover:text-txt font-semibold text-[11px] transition-colors';
  if (btnSfTab) {
    btnSfTab.setAttribute('aria-selected', String(next === 'sf'));
    btnSfTab.className =
      next === 'sf'
        ? 'px-1.5 py-0.5 rounded bg-cy/20 text-cy border border-cy/40 font-bold text-[11px] transition-colors'
        : inactiveCls;
  }
  if (btnMaiaTab) {
    btnMaiaTab.setAttribute('aria-selected', String(next === 'maia'));
    btnMaiaTab.className =
      next === 'maia'
        ? 'px-1.5 py-0.5 rounded bg-vi/20 text-vi border border-vi/40 font-bold text-[11px] transition-colors'
        : inactiveCls;
  }
  if (btnHfTab) {
    btnHfTab.setAttribute('aria-selected', String(next === 'hf'));
    btnHfTab.className =
      next === 'hf'
        ? 'px-1.5 py-0.5 rounded bg-em/20 text-em border border-em/40 font-bold text-[11px] transition-colors'
        : inactiveCls;
  }

  sfControls?.classList.toggle('hidden', next !== 'sf');
  maiaControls?.classList.toggle('hidden', next !== 'maia');
  hfControls?.classList.toggle('hidden', next !== 'hf');
  sfView?.classList.toggle('hidden', next !== 'sf');
  maiaView?.classList.toggle('hidden', next !== 'maia');
  hfView?.classList.toggle('hidden', next !== 'hf');
  sfBadge?.classList.toggle('hidden', next !== 'sf');
  maiaBadge?.classList.toggle('hidden', next !== 'maia');
  hfBadge?.classList.toggle('hidden', next !== 'hf');

  if (toggleBtn) {
    const running =
      next === 'hf' ? state.hf.running : next === 'maia' ? state.maia.running : state.sf.running;
    toggleBtn.textContent = running ? '⏸' : '▶';
    toggleBtn.title =
      next === 'hf'
        ? 'Start / Stop HumanFish'
        : next === 'maia'
          ? 'Start / Stop Maia 2'
          : 'Start / Stop Stockfish';
  }

  if (next === 'hf') {
    const firstEnable = !state.hf.enabled;
    state.hf.enabled = true;
    state.maia.hoverCandidateUci = null;
    if (firstEnable) state.evalBarSource = 'hf';
    triggerHumanfishAnalysis();
  } else if (next === 'maia') {
    const firstEnable = !state.maia.enabled;
    state.maia.enabled = true;
    state.hf.hoverCandidateUci = null;
    if (firstEnable) state.evalBarSource = 'maia';
    triggerMaia2Analysis();
  } else {
    state.hf.hoverCandidateUci = null;
    state.maia.hoverCandidateUci = null;
    if (state.evalBarSource === 'hf' || state.evalBarSource === 'maia') {
      state.evalBarSource = 'sf';
    }
  }

  renderArrows();
  updateEvalBarFromState();
  renderHumanfishUI();
  renderMaiaUI();
}

export function setHumanfishUseClocks(useClocks) {
  state.hf.useClocks = Boolean(useClocks);
  renderHumanfishHeaderControls();
  renderHumanfishUI();
  updateEvalBarFromState();
}

export function toggleHumanfishArrows() {
  state.hf.showArrows = !state.hf.showArrows;
  renderHumanfishHeaderControls();
  renderArrows();
}

export function toggleHumanfishWhatIf() {
  state.hf.showWhatIf = !state.hf.showWhatIf;
  renderHumanfishHeaderControls();
  renderHumanfishUI();
}

export function setHumanfishServerUrl(url) {
  const cleaned = String(url || '').trim().replace(/\/+$/, '');
  state.hf.serverUrl = cleaned;
  try {
    if (cleaned) localStorage.setItem('tichess_hf_api_url', cleaned);
    else localStorage.removeItem('tichess_hf_api_url');
  } catch (_) {}
  updateHumanfishServerBadge();
  if (state.hf.enabled) {
    triggerHumanfishAnalysis({ force: true });
  }
}

export function updateHumanfishServerBadge() {
  const badge = document.getElementById('hfServerStatusBadge');
  if (!badge) return;
  if (state.hf.serverUrl) {
    const short = state.hf.serverUrl.replace(/^https?:\/\//, '');
    badge.textContent = `Custom: ${short}`;
    badge.className = 'font-mono text-[10px] px-1.5 py-0.5 rounded bg-panel text-em';
  } else {
    badge.textContent = 'Built-in API';
    badge.className = 'font-mono text-[10px] px-1.5 py-0.5 rounded bg-panel text-txtMuted';
  }
}

function renderHumanfishHeaderControls() {
  const clockBtn = document.getElementById('btnHfClockMode');
  const arrowsBtn = document.getElementById('btnHfArrows');
  const whatIfBtn = document.getElementById('btnHfWhatIf');

  if (clockBtn) {
    clockBtn.textContent = state.hf.useClocks ? '⏱ Time' : '▦ Board';
    clockBtn.title = state.hf.useClocks
      ? 'Mode: With Time (click to switch to Board Only)'
      : 'Mode: Board Only (click to switch to With Time)';
    clockBtn.className = state.hf.useClocks
      ? 'px-1.5 py-0.5 rounded bg-em/20 text-em border border-em/40 text-[10px] font-medium'
      : 'px-1.5 py-0.5 rounded bg-surface text-txtMuted border border-borderSubtle text-[10px] font-medium';
  }
  if (arrowsBtn) {
    arrowsBtn.className = state.hf.showArrows
      ? 'px-1.5 py-0.5 rounded bg-em/20 text-em border border-em/40 text-[10px] font-medium'
      : 'px-1.5 py-0.5 rounded bg-surface text-txtMuted border border-borderSubtle text-[10px] font-medium';
  }
  if (whatIfBtn) {
    const active = state.hf.showWhatIf || Boolean(state.hf.whatIfOverride);
    whatIfBtn.className = active
      ? 'px-1.5 py-0.5 rounded bg-am/20 text-am border border-am/40 text-[10px] font-medium'
      : 'px-1.5 py-0.5 rounded bg-surface text-txtMuted border border-borderSubtle text-[10px] font-medium';
  }
}

export async function triggerHumanfishAnalysis({ force = false } = {}) {
  const fen = getCurrentFen();
  state.hf.currentFen = fen;
  state.hf.hoverCandidateUci = null;

  if (!state.hf.enabled) return;

  if (!state.hf.running) {
    stopHumanfish();
    renderHumanfishUI();
    return;
  }

  let isOver;
  try {
    isOver = new Chess(fen).isGameOver();
  } catch (_) {
    stopHumanfish();
    state.hf.error = 'Invalid position';
    state.hf.result = null;
    renderHumanfishUI();
    renderArrows();
    return;
  }

  if (isOver) {
    stopHumanfish();
    state.hf.error = '';
    state.hf.result = null;
    renderHumanfishUI();
    renderArrows();
    return;
  }

  const params = getEffectiveHumanfishParams();
  const endpoint = resolveHumanfishEndpoint(state.hf.serverUrl);
  const cacheKey = buildHumanfishCacheKey(params, endpoint);

  if (!force) {
    const cached = cacheGet(cacheKey);
    if (cached) {
      stopHumanfish();
      state.hf.result = cached;
      state.hf.error = '';
      state.hf.loading = false;
      renderHumanfishUI();
      renderArrows();
      updateEvalBarFromState();
      return;
    }
  }

  stopHumanfish();
  const reqId = ++state.hf.reqId;
  const ctrl = new AbortController();
  hfAbortCtrl = ctrl;
  state.hf.loading = true;
  state.hf.error = '';
  renderHumanfishUI();

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        fen: params.fen,
        white_elo: params.white_elo,
        black_elo: params.black_elo,
        clk_white_s: params.clk_white_s,
        clk_black_s: params.clk_black_s,
        tc_category: params.tc_category,
        tc_initial_s: params.tc_initial_s,
        tc_increment_s: params.tc_increment_s,
        has_move40: params.has_move40,
        ply: params.ply,
      }),
      signal: ctrl.signal,
    });

    if (reqId !== state.hf.reqId || fen !== getCurrentFen()) return;

    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const msg = data?.error || data?.detail || `HumanFish server error (${resp.status})`;
      throw new Error(msg);
    }
    if (!data || !data.human) {
      throw new Error('Unexpected response from HumanFish server');
    }

    cacheSet(cacheKey, data);
    state.hf.result = data;
    state.hf.error = '';
    state.hf.loading = false;
    renderHumanfishUI();
    renderArrows();
    updateEvalBarFromState();
  } catch (err) {
    if (err?.name === 'AbortError' || reqId !== state.hf.reqId) return;
    state.hf.loading = false;
    state.hf.error = err?.message || 'Could not reach HumanFish server';
    renderHumanfishUI();
  } finally {
    if (hfAbortCtrl === ctrl) hfAbortCtrl = null;
  }
}

function fmtCpWhite(cp) {
  const v = (Number(cp) || 0) / 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
}

function playStepSequence(steps, upToIdx) {
  for (let i = 0; i <= upToIdx && i < steps.length; i++) {
    const step = steps[i];
    if (!step?.uci) break;
    if (!playMoveOnTree(step.uci)) break;
  }
}

function renderWaterfallHtml(wf, useClocks) {
  if (!wf) return '';
  const finalExp = useClocks ? wf.with_time_exp : wf.actual_elo_board_exp;
  const eloDelta = useClocks ? wf.elo_delta : wf.elo_delta_board_only;
  const rows = [
    { label: 'SF 19 baseline', kind: 'base', val: wf.sf_exp },
    { label: 'Board practicality', kind: 'delta', val: wf.board_delta },
    { label: 'Rating gap (Elo)', kind: 'delta', val: eloDelta },
    { label: 'Clock pressure', kind: 'delta', val: useClocks ? wf.clock_delta : 0, muted: !useClocks },
    { label: useClocks ? 'HumanFish (Time)' : 'HumanFish (Board)', kind: 'total', val: finalExp },
  ];

  return rows
    .map((r) => {
      let barHtml;
      let valText;
      if (r.kind === 'base' || r.kind === 'total') {
        const pct = Math.max(0, Math.min(100, Math.round((Number(r.val) || 0.5) * 100)));
        valText = `${pct}%`;
        barHtml = `<div class="hf-wf-bar"><div class="hf-wf-fill ${r.kind === 'total' ? 'total' : 'base'}" style="width:${pct}%"></div></div>`;
      } else {
        const pp = (Number(r.val) || 0) * 100;
        const mag = Math.min(50, Math.abs(pp) * 1.4);
        valText = r.muted ? 'off' : formatSignedPp(r.val);
        const cls = pp >= 0 ? 'pos' : 'neg';
        barHtml = `<div class="hf-wf-bar"><div class="hf-wf-zero"></div>${
          !r.muted && mag > 0.3 ? `<div class="hf-wf-fill ${cls}" style="width:${mag.toFixed(1)}%"></div>` : ''
        }</div>`;
      }
      return `<div class="hf-wf-row ${r.kind === 'total' ? 'is-total' : ''} ${r.muted ? 'is-muted' : ''}">
        <span class="truncate">${escapeHtml(r.label)}</span>
        ${barHtml}
        <span class="text-right font-mono font-semibold">${escapeHtml(valText)}</span>
      </div>`;
    })
    .join('');
}

function renderWhatIfHtml(params) {
  if (!state.hf.showWhatIf) return '';
  const isCustom = Boolean(state.hf.whatIfOverride);
  const clkW = Math.round(params.clk_white_s);
  const clkB = Math.round(params.clk_black_s);
  const eloW = Math.round(params.white_elo);
  const eloB = Math.round(params.black_elo);
  const tc = params.tc_category || 'classical';

  return `
    <div id="hfWhatIfDrawer" class="px-2 py-2 border-b border-borderSubtle bg-bg/55 flex flex-col gap-2">
      <div class="flex items-center justify-between gap-2 text-[10px]">
        <span class="font-semibold uppercase tracking-wider text-am">What-If Context ${isCustom ? '· Custom' : '· Auto'}</span>
        <div class="flex items-center gap-1">
          <select id="hfWhatIfTc" aria-label="Time control preset" class="px-1 py-0.5 rounded bg-surface border border-borderSubtle font-mono text-[9.5px] text-txt">
            <option value="classical" ${tc === 'classical' ? 'selected' : ''}>Classical 90+30</option>
            <option value="rapid" ${tc === 'rapid' ? 'selected' : ''}>Rapid 15+10</option>
            <option value="blitz" ${tc === 'blitz' ? 'selected' : ''}>Blitz 3+2</option>
          </select>
          ${isCustom ? '<button id="btnHfWhatIfReset" class="px-1.5 py-0.5 rounded bg-surface hover:bg-surfaceHover border border-borderSubtle text-txtMuted text-[9.5px]">Reset</button>' : ''}
          <button id="btnHfWhatIfApply" class="px-2 py-0.5 rounded bg-em text-[#041f15] font-semibold text-[9.5px]">Recalc</button>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
        <label class="flex flex-col gap-0.5 ${!state.hf.useClocks ? 'opacity-45' : ''}">
          <span class="flex justify-between text-txtMuted"><span>White Clock</span><span id="hfWiClkWVal" class="font-mono text-txt">${escapeHtml(formatShortClock(clkW))}</span></span>
          <input id="hfWiClkW" type="range" min="10" max="5400" step="10" value="${Math.min(5400, Math.max(10, clkW))}" class="accent-em h-1.5" ${!state.hf.useClocks ? 'disabled' : ''} />
        </label>
        <label class="flex flex-col gap-0.5 ${!state.hf.useClocks ? 'opacity-45' : ''}">
          <span class="flex justify-between text-txtMuted"><span>Black Clock</span><span id="hfWiClkBVal" class="font-mono text-txt">${escapeHtml(formatShortClock(clkB))}</span></span>
          <input id="hfWiClkB" type="range" min="10" max="5400" step="10" value="${Math.min(5400, Math.max(10, clkB))}" class="accent-em h-1.5" ${!state.hf.useClocks ? 'disabled' : ''} />
        </label>
        <label class="flex flex-col gap-0.5">
          <span class="flex justify-between text-txtMuted"><span>White Elo</span><span id="hfWiEloWVal" class="font-mono text-txt">${eloW}</span></span>
          <input id="hfWiEloW" type="range" min="2400" max="2900" step="10" value="${Math.min(2900, Math.max(2400, eloW))}" class="accent-em h-1.5" />
        </label>
        <label class="flex flex-col gap-0.5">
          <span class="flex justify-between text-txtMuted"><span>Black Elo</span><span id="hfWiEloBVal" class="font-mono text-txt">${eloB}</span></span>
          <input id="hfWiEloB" type="range" min="2400" max="2900" step="10" value="${Math.min(2900, Math.max(2400, eloB))}" class="accent-em h-1.5" />
        </label>
      </div>
    </div>
  `;
}

function bindWhatIfEvents(baseParams) {
  const clkW = document.getElementById('hfWiClkW');
  const clkB = document.getElementById('hfWiClkB');
  const eloW = document.getElementById('hfWiEloW');
  const eloB = document.getElementById('hfWiEloB');
  const tcSel = document.getElementById('hfWhatIfTc');
  const applyBtn = document.getElementById('btnHfWhatIfApply');
  const resetBtn = document.getElementById('btnHfWhatIfReset');

  if (clkW) {
    clkW.oninput = () => {
      const lbl = document.getElementById('hfWiClkWVal');
      if (lbl) lbl.textContent = formatShortClock(Number(clkW.value));
    };
  }
  if (clkB) {
    clkB.oninput = () => {
      const lbl = document.getElementById('hfWiClkBVal');
      if (lbl) lbl.textContent = formatShortClock(Number(clkB.value));
    };
  }
  if (eloW) {
    eloW.oninput = () => {
      const lbl = document.getElementById('hfWiEloWVal');
      if (lbl) lbl.textContent = eloW.value;
    };
  }
  if (eloB) {
    eloB.oninput = () => {
      const lbl = document.getElementById('hfWiEloBVal');
      if (lbl) lbl.textContent = eloB.value;
    };
  }
  if (tcSel) {
    tcSel.onchange = () => {
      const preset = TC_PRESETS[tcSel.value] || TC_PRESETS.classical;
      if (clkW) {
        const v = Math.min(5400, preset.tc_initial_s);
        clkW.value = String(v);
        const lbl = document.getElementById('hfWiClkWVal');
        if (lbl) lbl.textContent = formatShortClock(v);
      }
      if (clkB) {
        const v = Math.min(5400, preset.tc_initial_s);
        clkB.value = String(v);
        const lbl = document.getElementById('hfWiClkBVal');
        if (lbl) lbl.textContent = formatShortClock(v);
      }
    };
  }
  if (applyBtn) {
    applyBtn.onclick = () => {
      const preset = TC_PRESETS[tcSel?.value] || TC_PRESETS[baseParams.tc_category] || TC_PRESETS.classical;
      state.hf.whatIfOverride = {
        white_elo: Number(eloW?.value || baseParams.white_elo),
        black_elo: Number(eloB?.value || baseParams.black_elo),
        clk_white_s: Number(clkW?.value || baseParams.clk_white_s),
        clk_black_s: Number(clkB?.value || baseParams.clk_black_s),
        ...preset,
      };
      triggerHumanfishAnalysis({ force: true });
    };
  }
  if (resetBtn) {
    resetBtn.onclick = () => {
      state.hf.whatIfOverride = null;
      triggerHumanfishAnalysis({ force: true });
    };
  }
}

function updateInlineSfSummaryChip() {
  const chip = document.getElementById('sfHfSummaryChip');
  if (!chip) return;
  const res = state.hf.result;
  if (!state.hf.enabled || !res || res.fen !== getCurrentFen()) {
    chip.classList.add('hidden');
    return;
  }
  const hum = getActiveHumanOutcome(res, state.hf.useClocks);
  if (!hum) {
    chip.classList.add('hidden');
    return;
  }
  const wPct = Math.round((hum.white || 0) * 100);
  const dPct = Math.round((hum.draw || 0) * 100);
  const bPct = Math.max(0, 100 - wPct - dPct);
  const expPct = Math.round((hum.expected_score || 0.5) * 100);
  chip.textContent = `HF ${wPct}/${dPct}/${bPct} (${expPct}%)`;
  chip.classList.remove('hidden');
}

export function renderHumanfishUI() {
  renderHumanfishHeaderControls();
  updateInlineSfSummaryChip();

  const badge = document.getElementById('hfModeBadge');
  const strip = document.getElementById('hfSummaryStrip');
  const body = document.getElementById('hfContentBody');
  if (!body) return;

  const params = getEffectiveHumanfishParams();
  const res = state.hf.result && state.hf.result.fen === getCurrentFen() ? state.hf.result : null;

  if (badge) {
    if (!state.hf.running) badge.textContent = 'Paused';
    else if (state.hf.loading) badge.textContent = 'Analyzing…';
    else if (state.hf.error) badge.textContent = 'Unavailable';
    else badge.textContent = state.hf.useClocks ? 'With Time' : 'Board Only';
  }

  if (!state.hf.running) {
    if (strip) strip.innerHTML = `<span class="text-txtMuted">HumanFish paused</span>`;
    body.innerHTML = `${renderWhatIfHtml(params)}<div class="p-2.5 text-txtMuted text-[11px]">Paused. Click ▶ to resume HumanFish W/D/L evaluation.</div>`;
    bindWhatIfEvents(params);
    return;
  }

  let isOver = false;
  try {
    isOver = new Chess(getCurrentFen()).isGameOver();
  } catch (_) {}
  if (isOver) {
    if (strip) strip.innerHTML = `<span class="text-txtMuted">Game Over</span>`;
    body.innerHTML = `<div class="p-2.5 text-txtMuted text-[11px]">Game Over</div>`;
    return;
  }

  if (state.hf.error && !res) {
    if (strip) strip.innerHTML = `<span class="text-ro">HumanFish unreachable</span>`;
    body.innerHTML = `${renderWhatIfHtml(params)}
      <div class="p-2.5 flex flex-col items-start gap-2 font-sans text-[11px] text-txtMuted">
        <div class="text-ro leading-relaxed">${escapeHtml(state.hf.error)}</div>
        <div class="flex items-center gap-1.5 flex-wrap">
          <button id="btnHfRetryInline" class="px-2 py-1 rounded bg-em/20 hover:bg-em/30 text-em border border-em/40 font-semibold text-[10.5px]">↻ Retry</button>
          <button id="btnHfOpenSettingsInline" class="px-2 py-1 rounded bg-surface hover:bg-surfaceHover text-txt border border-borderSubtle text-[10.5px]">⚙ Local Server Settings</button>
        </div>
      </div>`;
    bindWhatIfEvents(params);
    const retryBtn = document.getElementById('btnHfRetryInline');
    if (retryBtn) retryBtn.onclick = () => triggerHumanfishAnalysis({ force: true });
    const setBtn = document.getElementById('btnHfOpenSettingsInline');
    if (setBtn && openSettingsModalCb) setBtn.onclick = () => openSettingsModalCb();
    return;
  }

  if (state.hf.loading && !res) {
    if (strip) {
      strip.innerHTML = `<span class="text-em font-semibold">Running DSC-150M + SF19…</span><span class="text-txtMuted text-[10px]">${params.white_elo} vs ${params.black_elo} · ${escapeHtml(formatShortClock(params.clk_white_s))}/${escapeHtml(formatShortClock(params.clk_black_s))}</span>`;
    }
    body.innerHTML = `${renderWhatIfHtml(params)}<div class="p-2.5 text-txtMuted text-[11px]">Evaluating human W/D/L odds, Shapley attribution, and calibrated move probabilities…</div>`;
    bindWhatIfEvents(params);
    return;
  }

  if (!res) {
    if (strip) strip.innerHTML = `<span class="text-txtMuted">Ready</span>`;
    body.innerHTML = `${renderWhatIfHtml(params)}<div class="p-2.5 text-txtMuted text-[11px]">Select HumanFish to evaluate this position.</div>`;
    bindWhatIfEvents(params);
    return;
  }

  const hum = getActiveHumanOutcome(res, state.hf.useClocks);
  const wPct = Math.round((hum?.white || 0) * 100);
  const dPct = Math.round((hum?.draw || 0) * 100);
  const bPct = Math.max(0, 100 - wPct - dPct);
  const expPct = Math.round((hum?.expected_score || 0.5) * 100);
  const danger = computeDangerLevel(res);
  const div = computeDivergenceInfo(res, state.hf.useClocks);
  const exp = res.explanation || {};
  const cands = exp.candidates || [];
  const lines = exp.lines || {};

  const dangerCls =
    danger.level === 'high'
      ? 'bg-ro/20 text-ro border-ro/40'
      : danger.level === 'med'
        ? 'bg-am/20 text-am border-am/40'
        : 'bg-em/15 text-em border-em/35';

  if (strip) {
    const sfExpPct = Math.round((res.stockfish?.expected_score ?? 0.5) * 100);
    const sfCp = fmtCpWhite(res.stockfish?.cp_white);
    strip.innerHTML = `
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="px-1.5 py-[1px] rounded bg-em/20 text-em font-bold min-w-[38px] text-center" title="HumanFish expected score for White">${expPct}%</span>
        <div class="wdl-bar border border-borderSubtle flex-1 max-w-[130px]" title="White ${wPct}% / Draw ${dPct}% / Black ${bPct}%">
          ${wPct ? `<div class="sb-w" style="width:${wPct}%">${wPct >= 18 ? wPct : ''}</div>` : ''}
          ${dPct ? `<div class="sb-d" style="width:${dPct}%">${dPct >= 18 ? dPct : ''}</div>` : ''}
          ${bPct ? `<div class="sb-b" style="width:${bPct}%">${bPct >= 18 ? bPct : ''}</div>` : ''}
        </div>
        <span class="text-txtMuted text-[10px] hidden sm:inline">SF ${escapeHtml(sfCp)} (${sfExpPct}%)</span>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        ${state.hf.loading ? '<span class="text-[9.5px] text-txtMuted">Updating…</span>' : ''}
        <span class="px-1.5 py-[1px] rounded border text-[9.5px] font-semibold ${dangerCls}">${escapeHtml(danger.label)}</span>
      </div>
    `;
  }

  const matBanner = hum?.materialAdjusted
    ? `<div class="px-2 py-1 rounded bg-surface/70 border border-borderSubtle text-[10px] text-txtMuted">Adjusted for chess rules: ${escapeHtml(hum.materialReason || 'Insufficient mating material')} (impossible win odds moved to draw)</div>`
    : '';

  const divBanner = div.significant
    ? `<div class="px-2 py-1 rounded text-[10.5px] font-medium border ${
        div.flippedFavorite
          ? 'bg-ro/15 border-ro/40 text-ro'
          : 'bg-am/15 border-am/40 text-am'
      }">${escapeHtml(div.summary)}</div>`
    : '';

  const candRowsHtml = cands
    .map((c, idx) => {
      const probPct = Math.round((Number(c.prob) || 0) * 100);
      const rawPct = Math.round((Number(c.raw_dsc_prob) || 0) * 100);
      const dropPp = Math.round((Number(c.drop_mover) || 0) * 100);
      const grade = c.grade === 'blunder' ? 'blunder' : c.grade === 'inaccuracy' ? 'inaccuracy' : 'best';
      const dotCls = grade === 'blunder' ? 'bg-ro' : grade === 'inaccuracy' ? 'bg-am' : 'bg-em';
      const barCls = grade === 'blunder' ? 'bg-ro' : grade === 'inaccuracy' ? 'bg-am' : 'bg-em';
      const dropCls = grade === 'blunder' ? 'text-ro' : grade === 'inaccuracy' ? 'text-am' : 'text-em';
      const dropLabel = c.is_sf_best ? 'Best' : dropPp <= 1 ? 'OK' : `-${dropPp}pp`;
      const hasRefute = grade !== 'best' && Array.isArray(c.refutation) && c.refutation.length > 0;
      return `
        <div class="hf-cand-row px-1.5 py-1 rounded hover:bg-surfaceHover cursor-pointer" data-hf-uci="${escapeHtml(c.uci)}" data-hf-cand-idx="${idx}" title="Calibrated GM prob: ${probPct}% (1-ply DSC-150M: ${rawPct}%)">
          <div class="flex items-center gap-1 font-mono font-bold text-[11px] min-w-0">
            <span class="w-2 h-2 rounded-full shrink-0 ${dotCls}"></span>
            <span class="truncate">${escapeHtml(c.san || c.uci)}</span>
            ${c.is_sf_best ? '<span class="px-1 rounded bg-cy/15 text-cy text-[8.5px] font-semibold">SF</span>' : ''}
          </div>
          <div class="h-1.5 rounded bg-surface overflow-hidden">
            <div class="h-full ${barCls}" style="width:${Math.max(3, Math.min(100, probPct))}%"></div>
          </div>
          <span class="font-mono text-[10.5px] text-right text-txt">${probPct}%</span>
          <span class="font-mono text-[10px] text-right text-txtMuted">${escapeHtml(fmtCpWhite(c.cp_white))}</span>
          <span class="font-mono text-[10px] font-bold text-right ${dropCls}">${escapeHtml(dropLabel)}</span>
          ${
            hasRefute
              ? `<button type="button" data-hf-refute="${idx}" class="px-1 py-[1px] rounded bg-ro/15 hover:bg-ro/30 text-ro border border-ro/35 text-[9px] font-semibold text-center" title="Play move and refutation on board">Refute</button>`
              : '<span></span>'
          }
        </div>
      `;
    })
    .join('');

  const lineBlocks = [
    lines.sf_pv?.steps?.length ? { key: 'sf_pv', trap: false, ...lines.sf_pv } : null,
    lines.human_line?.steps?.length
      ? {
          key: 'human_line',
          trap: /tempting/i.test(lines.human_line.label || ''),
          ...lines.human_line,
        }
      : null,
  ].filter(Boolean);

  const linesHtml = lineBlocks
    .map(
      (ln) => `
      <div class="px-2 py-1.5 rounded bg-bg/45 border border-borderSubtle/80 flex flex-col gap-1">
        <div class="flex items-center justify-between gap-2 text-[10px]">
          <span class="text-txtMuted font-semibold truncate">${escapeHtml(ln.label || '')}</span>
          <span class="font-mono font-bold text-txt shrink-0">${escapeHtml(fmtCpWhite(ln.cp_white))}</span>
        </div>
        <div class="flex flex-wrap gap-1">
          ${ln.steps
            .map(
              (st, si) =>
                `<button type="button" data-hf-line="${ln.key}" data-hf-step="${si}" data-hf-step-uci="${escapeHtml(st.uci)}" class="px-1.5 py-[1px] rounded border font-mono text-[10.5px] font-semibold transition-colors ${
                  ln.trap && si === 0
                    ? 'bg-ro/15 border-ro/45 text-ro hover:bg-ro hover:text-white'
                    : 'bg-surface border-borderSubtle text-txt hover:bg-em/20 hover:border-em/45 hover:text-em'
                }">${escapeHtml(st.san || st.uci)}</button>`
            )
            .join('')}
        </div>
      </div>`
    )
    .join('');

  const wfHtml = renderWaterfallHtml(exp.waterfall, state.hf.useClocks);
  const ctxSummary = `${params.white_elo} vs ${params.black_elo} · ${formatShortClock(params.clk_white_s)} / ${formatShortClock(params.clk_black_s)} · ${params.tc_category}`;

  body.innerHTML = `
    ${renderWhatIfHtml(params)}
    <div class="p-2 flex flex-col gap-2 text-[11px]">
      <div class="grid grid-cols-3 gap-1.5 font-mono">
        <div class="px-2 py-1 rounded bg-bg/50 border border-borderSubtle">
          <div class="text-[9.5px] text-txtMuted">White Win</div>
          <div class="text-[13px] font-bold text-txt">${wPct}%</div>
        </div>
        <div class="px-2 py-1 rounded bg-bg/50 border border-borderSubtle">
          <div class="text-[9.5px] text-txtMuted">Draw</div>
          <div class="text-[13px] font-bold text-txtMuted">${dPct}%</div>
        </div>
        <div class="px-2 py-1 rounded bg-bg/50 border border-borderSubtle">
          <div class="text-[9.5px] text-txtMuted">Black Win</div>
          <div class="text-[13px] font-bold text-txt">${bPct}%</div>
        </div>
      </div>

      ${matBanner}
      ${divBanner}

      ${
        cands.length
          ? `<div class="flex flex-col gap-1">
              <div class="flex items-center justify-between text-[9.5px] uppercase tracking-wider text-txtMuted font-semibold">
                <span>GM Candidates (System 1+2)</span>
                <span class="font-mono normal-case font-normal">${escapeHtml(ctxSummary)}</span>
              </div>
              <div class="flex flex-col gap-0.5">${candRowsHtml}</div>
            </div>`
          : ''
      }

      ${
        linesHtml
          ? `<div class="flex flex-col gap-1">
              <div class="text-[9.5px] uppercase tracking-wider text-txtMuted font-semibold">Lines on the Board</div>
              ${linesHtml}
            </div>`
          : ''
      }

      ${
        wfHtml
          ? `<div class="flex flex-col gap-1 pt-1 border-t border-borderSubtle/70">
              <div class="flex items-center justify-between gap-1.5">
                <span class="text-[9.5px] uppercase tracking-wider text-txtMuted font-semibold">Shapley Attribution</span>
                <span class="px-1.5 py-[1px] rounded bg-surface border border-borderSubtle text-[9.5px] font-semibold text-txt">${escapeHtml(exp.driver_tag || 'Aligned')}</span>
              </div>
              ${exp.driver_summary ? `<div class="text-[10.5px] text-txtMuted leading-snug">${escapeHtml(exp.driver_summary)}</div>` : ''}
              <div class="flex flex-col gap-1 mt-0.5">${wfHtml}</div>
            </div>`
          : ''
      }
    </div>
  `;

  bindWhatIfEvents(params);

  // Candidate row hover & click bindings
  body.querySelectorAll('.hf-cand-row').forEach((row) => {
    const uci = row.dataset.hfUci;
    row.onclick = (e) => {
      if (e.target.closest('[data-hf-refute]')) return;
      if (uci) playMoveOnTree(uci);
    };
    row.onmouseenter = () => {
      state.hf.hoverCandidateUci = uci || null;
      renderArrows();
    };
    row.onmouseleave = () => {
      state.hf.hoverCandidateUci = null;
      renderArrows();
    };
  });

  // Refutation click bindings: plays the candidate blunder + its refutation PV
  body.querySelectorAll('[data-hf-refute]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.hfRefute);
      const cand = cands[idx];
      if (!cand?.uci) return;
      const seq = [{ uci: cand.uci }, ...(cand.refutation || [])];
      playStepSequence(seq, seq.length - 1);
    };
  });

  // Concrete line chip bindings
  body.querySelectorAll('[data-hf-line]').forEach((btn) => {
    const lineKey = btn.dataset.hfLine;
    const stepIdx = Number(btn.dataset.hfStep);
    const stepUci = btn.dataset.hfStepUci;
    const steps = lines[lineKey]?.steps || [];
    btn.onclick = () => playStepSequence(steps, stepIdx);
    if (stepIdx === 0 && stepUci) {
      btn.onmouseenter = () => {
        state.hf.hoverCandidateUci = stepUci;
        renderArrows();
      };
      btn.onmouseleave = () => {
        state.hf.hoverCandidateUci = null;
        renderArrows();
      };
    }
  });
}

export function initHumanfish() {
  updateHumanfishServerBadge();
  setEngineTab('sf');
}
