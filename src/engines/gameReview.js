import { Chess } from 'chess.js';
import {
  state,
  getActiveTab,
  escapeHtml,
  showToast,
  emitPositionChanged,
} from '../state.js';
import { parseUciInfoLine, normalizeCastlingUci } from './uci.js';
import { findNodeById } from '../chess/tree.js';
import { playMoveOnTree } from '../board/board.js';
import { renderVariationTree } from '../board/tabs.js';

import {
  MATE_CP,
  cpToWinPercent,
  moveAccuracyFromWinDrop,
  classifyReviewedMove,
  formatReviewScore,
  uciMoveToSan,
} from './evalMath.js';

export {
  cpToWinPercent,
  moveAccuracyFromWinDrop,
  classifyReviewedMove,
  formatReviewScore,
  uciMoveToSan,
};

const STOCKFISH_MT_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-19-lite.js`;
const STOCKFISH_ST_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-19-lite-single.js`;

const REVIEW_NAGS = new Set(['??', '?', '?!']);

/**
 * Collect the mainline nodes starting from `root` (index 0 = root, 1..N = mainline plies).
 */
export function collectMainlineNodes(root) {
  const nodes = [];
  let cur = root;
  while (cur) {
    nodes.push(cur);
    cur = cur.children?.[0] || null;
  }
  return nodes;
}

/**
 * Compute per-ply classifications and aggregate White/Black summaries from an array of
 * position evaluations along the mainline (`points[0]` is root, `points[i]` is after ply `i`).
 */
export function summarizeGameReview(points) {
  const enriched = [];
  const initSide = () => ({
    accSum: 0,
    cpLossSum: 0,
    moveCount: 0,
    blunders: 0,
    mistakes: 0,
    inaccuracies: 0,
  });
  const w = initSide();
  const b = initSide();

  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (i === 0) {
      enriched.push({
        ...pt,
        winPct: cpToWinPercent(pt.whiteCp, pt.mate),
        kind: 'start',
        nag: '',
        winDrop: 0,
        cpLoss: 0,
        accuracy: null,
        bestBeforeUci: pt.bestUci || '',
        bestBeforeSan: pt.bestSan || '',
      });
      continue;
    }

    const prev = points[i - 1];
    const cls = classifyReviewedMove(prev, pt, pt.color, pt.uci);
    const side = pt.color === 'w' ? w : b;
    side.moveCount += 1;
    side.accSum += cls.accuracy;
    side.cpLossSum += cls.cpLoss;
    if (cls.kind === 'blunder') side.blunders += 1;
    else if (cls.kind === 'mistake') side.mistakes += 1;
    else if (cls.kind === 'inaccuracy') side.inaccuracies += 1;

    enriched.push({
      ...pt,
      winPct: cpToWinPercent(pt.whiteCp, pt.mate),
      ...cls,
      bestBeforeUci: prev.bestUci || '',
      bestBeforeSan: prev.bestSan || '',
      evalBeforeLabel: formatReviewScore(prev.whiteCp, prev.mate),
      evalAfterLabel: formatReviewScore(pt.whiteCp, pt.mate),
    });
  }

  const finalize = (s) => ({
    accuracy: s.moveCount ? Number((s.accSum / s.moveCount).toFixed(1)) : null,
    acpl: s.moveCount ? Math.round(s.cpLossSum / s.moveCount) : null,
    moveCount: s.moveCount,
    blunders: s.blunders,
    mistakes: s.mistakes,
    inaccuracies: s.inaccuracies,
  });

  return {
    points: enriched,
    white: finalize(w),
    black: finalize(b),
  };
}

/**
 * Build an interactive inline SVG evaluation graph from enriched review points.
 */
export function buildEvalGraphSvg(points, activeNodeId = '', { width = 420, height = 64 } = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    return `<div class="h-14 flex items-center justify-center text-[10.5px] text-txtMuted">Evaluating game positions...</div>`;
  }

  const padX = 4;
  const padY = 4;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;
  const midY = padY + plotH / 2;
  const n = points.length;

  const coords = points.map((pt, idx) => {
    const x = padX + (n > 1 ? (idx / (n - 1)) * plotW : 0);
    const winPct = typeof pt.winPct === 'number' ? pt.winPct : cpToWinPercent(pt.whiteCp, pt.mate);
    const y = padY + (1 - Math.max(0, Math.min(100, winPct)) / 100) * plotH;
    return { x, y, pt, idx };
  });

  const linePath = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L${coords[coords.length - 1].x.toFixed(1)},${(padY + plotH).toFixed(1)} L${coords[0].x.toFixed(1)},${(padY + plotH).toFixed(1)} Z`;

  const markers = coords
    .filter((c) => c.pt.kind === 'blunder' || c.pt.kind === 'mistake' || c.pt.kind === 'inaccuracy')
    .map((c) => {
      const fill =
        c.pt.kind === 'blunder' ? '#fb7185' : c.pt.kind === 'mistake' ? '#f59e0b' : '#38bdf8';
      return `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="2.7" fill="${fill}" stroke="#090d16" stroke-width="0.9" pointer-events="none" />`;
    })
    .join('');

  const activeCoord = coords.find((c) => c.pt.nodeId === activeNodeId);
  const activeMarker = activeCoord
    ? `<line x1="${activeCoord.x.toFixed(1)}" y1="${padY}" x2="${activeCoord.x.toFixed(1)}" y2="${padY + plotH}" stroke="#10b981" stroke-width="1.3" stroke-dasharray="2 2" pointer-events="none" />
       <circle cx="${activeCoord.x.toFixed(1)}" cy="${activeCoord.y.toFixed(1)}" r="3.4" fill="#10b981" stroke="#041f15" stroke-width="1.1" pointer-events="none" />`
    : '';

  const stepW = plotW / Math.max(1, n - 1);
  const hitStrips = coords
    .map((c) => {
      const rx = Math.max(0, c.x - stepW / 2);
      const rw = Math.min(width - rx, stepW);
      const moveLabel =
        c.idx === 0
          ? 'Start'
          : `${c.pt.moveNum}${c.pt.color === 'w' ? '.' : '...'} ${c.pt.san}${c.pt.nag || ''}`;
      const scoreLbl = formatReviewScore(c.pt.whiteCp, c.pt.mate);
      const bestBit =
        c.pt.nag && c.pt.bestBeforeSan ? ` · Best: ${c.pt.bestBeforeSan}` : '';
      return `<rect class="review-graph-hit" data-nid="${escapeHtml(c.pt.nodeId)}" x="${rx.toFixed(1)}" y="0" width="${Math.max(4, rw).toFixed(1)}" height="${height}" fill="transparent" style="cursor:pointer"><title>${escapeHtml(`${moveLabel} (${scoreLbl})${bestBit}`)}</title></rect>`;
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="w-full h-[64px] block rounded bg-[#0a101c] border border-borderSubtle/80 select-none" role="img" aria-label="Game evaluation graph">
    <rect x="0" y="0" width="${width}" height="${midY.toFixed(1)}" fill="rgba(226,232,240,0.03)" />
    <path d="${areaPath}" fill="rgba(226,232,240,0.16)" />
    <line x1="${padX}" y1="${midY.toFixed(1)}" x2="${width - padX}" y2="${midY.toFixed(1)}" stroke="rgba(148,163,184,0.3)" stroke-width="0.9" stroke-dasharray="3 3" />
    <path d="${linePath}" fill="none" stroke="#e2e8f0" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
    ${markers}
    ${activeMarker}
    ${hitStrips}
  </svg>`;
}

// =========================================================================
// Dedicated background Stockfish worker for full-game review
// =========================================================================

let activeRun = null;

function canUseMt() {
  return (
    typeof crossOriginIsolated !== 'undefined' &&
    crossOriginIsolated === true &&
    typeof SharedArrayBuffer !== 'undefined'
  );
}

function bootReviewWorker(url, threads, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let uciOk = false;
    let w;
    const finish = (err, worker) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        if (w) {
          try {
            w.terminate();
          } catch (_) {}
        }
        reject(err);
      } else {
        resolve(worker);
      }
    };

    const timer = setTimeout(() => {
      finish(new Error('Stockfish review worker timed out'));
    }, timeoutMs);

    try {
      w = new Worker(url);
    } catch (err) {
      finish(err);
      return;
    }

    w.onerror = (e) => {
      finish(new Error(e?.message || 'Stockfish review worker error'));
    };

    w.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : '';
      if (!line) return;
      if (line === 'uciok' && !uciOk) {
        uciOk = true;
        if (threads > 1) {
          w.postMessage(`setoption name Threads value ${threads}`);
          w.postMessage('setoption name Hash value 16');
        }
        w.postMessage('setoption name MultiPV value 1');
        w.postMessage('isready');
        return;
      }
      if (line === 'readyok' && uciOk) {
        w.onmessage = null;
        w.onerror = null;
        finish(null, w);
      }
    };

    w.postMessage('uci');
  });
}

async function createReviewWorker() {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  const threads = canUseMt() ? Math.min(2, Math.max(1, cores - 1)) : 1;
  if (threads > 1) {
    try {
      return await bootReviewWorker(STOCKFISH_MT_URL, threads, 5000);
    } catch (_) {
      // Fall back cleanly to single-threaded build
    }
  }
  return bootReviewWorker(STOCKFISH_ST_URL, 1, 8000);
}

function evaluatePositionWithWorker(worker, fen, depth, signal) {
  let chess;
  try {
    chess = new Chess(fen);
  } catch (_) {
    return Promise.resolve({ whiteCp: 0, mate: null, bestUci: '', depth: 0 });
  }

  if (chess.isGameOver()) {
    if (chess.isCheckmate()) {
      const whiteWon = chess.turn() === 'b';
      return Promise.resolve({
        whiteCp: whiteWon ? MATE_CP : -MATE_CP,
        mate: 0,
        bestUci: '',
        depth: 0,
      });
    }
    return Promise.resolve({ whiteCp: 0, mate: null, bestUci: '', depth: 0 });
  }

  const flip = chess.turn() === 'b' ? -1 : 1;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    let lastEval = { whiteCp: 0, mate: null, bestUci: '', depth: 0 };
    let settled = false;

    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      try {
        worker.postMessage('stop');
      } catch (_) {}
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    worker.onerror = (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(e?.message || 'Worker crashed during review'));
    };

    worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : '';
      if (!line) return;
      if (line.startsWith('info ') && line.includes(' score ') && line.includes(' pv ')) {
        const parsed = parseUciInfoLine(line);
        if (parsed && parsed.multipv === 1) {
          const isMate = parsed.scoreType === 'mate';
          const signed = parsed.scoreVal * flip;
          const rawFirst = parsed.pv?.[0] || '';
          const bestUci = rawFirst ? normalizeCastlingUci(fen, rawFirst) : '';
          lastEval = {
            whiteCp: isMate ? (signed > 0 ? MATE_CP : -MATE_CP) : signed,
            mate: isMate ? signed : null,
            bestUci,
            depth: parsed.depth,
          };
        }
      } else if (line.startsWith('bestmove ')) {
        if (settled) return;
        settled = true;
        cleanup();
        const bm = line.split(/\s+/)[1];
        if (bm && bm !== '(none)' && !lastEval.bestUci) {
          lastEval.bestUci = normalizeCastlingUci(fen, bm);
        }
        resolve(lastEval);
      }
    };

    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go depth ${depth}`);
  });
}

function applyReviewNagsToMainline(tab, enrichedPoints) {
  for (let i = 1; i < enrichedPoints.length; i++) {
    const pt = enrichedPoints[i];
    const node = findNodeById(tab.root, pt.nodeId);
    if (!node) continue;
    const preserved = (node.nags || []).filter((g) => !REVIEW_NAGS.has(g));
    node.nags = pt.nag ? [...preserved, pt.nag] : preserved;
  }
}

export function isGameReviewRunning(tabId = null) {
  if (!activeRun) return false;
  return tabId ? activeRun.tabId === tabId : true;
}

export function cancelGameReview() {
  if (!activeRun) return;
  const run = activeRun;
  activeRun = null;
  run.ctrl.abort();
  if (run.worker) {
    try {
      run.worker.terminate();
    } catch (_) {}
  }
  const tab = state.tabs.find((t) => t.id === run.tabId);
  if (tab?.review && tab.review.status === 'running') {
    tab.review.status = tab.review.points.length >= 2 ? 'partial' : 'idle';
  }
  renderGameReviewPanel();
}

export function clearActiveTabReview() {
  const tab = getActiveTab();
  if (!tab) return;
  if (activeRun?.tabId === tab.id) cancelGameReview();
  // Remove auto-applied review NAGs on mainline
  const nodes = collectMainlineNodes(tab.root);
  for (let i = 1; i < nodes.length; i++) {
    nodes[i].nags = (nodes[i].nags || []).filter((g) => !REVIEW_NAGS.has(g));
  }
  tab.review = null;
  renderVariationTree();
  renderGameReviewPanel();
}

export async function startActiveTabReview({ depth = 12 } = {}) {
  const tab = getActiveTab();
  if (!tab) return;

  if (activeRun) {
    const sameTab = activeRun.tabId === tab.id;
    cancelGameReview();
    if (sameTab) {
      showToast('Game review stopped');
      return;
    }
  }

  const nodes = collectMainlineNodes(tab.root);
  if (nodes.length < 2) {
    showToast('Play or load at least one move to review', true);
    return;
  }

  const ctrl = new AbortController();
  const run = { tabId: tab.id, ctrl, worker: null };
  activeRun = run;

  const rawPoints = [];
  tab.review = {
    status: 'running',
    depth,
    done: 0,
    total: nodes.length,
    points: [],
    white: null,
    black: null,
    error: '',
  };
  renderGameReviewPanel();

  try {
    const worker = await createReviewWorker();
    if (activeRun !== run || ctrl.signal.aborted) {
      worker.terminate();
      return;
    }
    run.worker = worker;

    for (let i = 0; i < nodes.length; i++) {
      if (ctrl.signal.aborted || activeRun !== run) break;
      const node = nodes[i];
      const ev = await evaluatePositionWithWorker(worker, node.fen, depth, ctrl.signal);
      if (ctrl.signal.aborted || activeRun !== run) break;

      rawPoints.push({
        nodeId: node.id,
        ply: i,
        moveNum: node.moveNum,
        color: node.color,
        san: node.san,
        uci: node.uci,
        fen: node.fen,
        whiteCp: ev.whiteCp,
        mate: ev.mate,
        bestUci: ev.bestUci,
        bestSan: uciMoveToSan(node.fen, ev.bestUci),
        depth: ev.depth,
      });

      const summary = summarizeGameReview(rawPoints);
      tab.review = {
        status: i === nodes.length - 1 ? 'done' : 'running',
        depth,
        done: i + 1,
        total: nodes.length,
        points: summary.points,
        white: summary.white,
        black: summary.black,
        error: '',
      };

      if (i === nodes.length - 1 || i % 2 === 1) {
        if (i === nodes.length - 1) {
          applyReviewNagsToMainline(tab, summary.points);
          renderVariationTree();
        }
        renderGameReviewPanel();
      }
    }

    if (activeRun === run && !ctrl.signal.aborted) {
      showToast(`Game review complete (depth ${depth})`);
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      tab.review = {
        ...(tab.review || {}),
        status: 'error',
        error: err?.message || 'Stockfish review failed',
      };
      showToast(tab.review.error, true);
    }
  } finally {
    if (run.worker) {
      try {
        run.worker.terminate();
      } catch (_) {}
      run.worker = null;
    }
    if (activeRun === run) activeRun = null;
    renderGameReviewPanel();
  }
}

export function jumpToNextReviewIssue() {
  const tab = getActiveTab();
  const pts = tab?.review?.points;
  if (!pts?.length) return;
  const issueKinds = new Set(['blunder', 'mistake', 'inaccuracy']);
  const curIdx = pts.findIndex((p) => p.nodeId === tab.current?.id);
  let target = null;
  for (let offset = 1; offset <= pts.length; offset++) {
    const idx = (Math.max(0, curIdx) + offset) % pts.length;
    if (issueKinds.has(pts[idx].kind)) {
      target = pts[idx];
      break;
    }
  }
  if (!target) {
    showToast('No inaccuracies, mistakes, or blunders found');
    return;
  }
  const node = findNodeById(tab.root, target.nodeId);
  if (node) {
    tab.current = node;
    state.selectedSq = null;
    state.legalTargets = [];
    emitPositionChanged();
  }
}

export function renderGameReviewPanel() {
  const tab = getActiveTab();
  const btn = document.getElementById('btnGameReview');
  const panel = document.getElementById('gameReviewPanel');
  if (!btn || !panel) return;

  const runningHere = Boolean(tab && activeRun?.tabId === tab.id);
  btn.textContent = runningHere ? '⏹ Stop' : '⚡ Review';
  btn.className = runningHere
    ? 'px-2 py-0.5 rounded bg-ro/20 hover:bg-ro/30 text-ro border border-ro/40 font-semibold text-[10px]'
    : 'px-2 py-0.5 rounded bg-em/15 hover:bg-em/25 text-em border border-em/35 font-semibold text-[10px]';

  const rev = tab?.review;
  if (!rev || rev.status === 'idle') {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  panel.classList.remove('hidden');

  const pct = rev.total ? Math.round((rev.done / rev.total) * 100) : 0;
  const renderSide = (label, s) => {
    if (!s || !s.moveCount) return `<span class="text-txtMuted">${label}: —</span>`;
    const badges = [
      s.blunders ? `<span class="text-ro font-bold">${s.blunders}??</span>` : '',
      s.mistakes ? `<span class="text-am font-bold">${s.mistakes}?</span>` : '',
      s.inaccuracies ? `<span class="text-cy font-bold">${s.inaccuracies}?!</span>` : '',
    ]
      .filter(Boolean)
      .join(' ');
    return `<span class="inline-flex items-center gap-1"><span class="text-txtMuted">${label}</span><span class="font-bold text-txt">${s.accuracy}%</span><span class="text-[9.5px] text-txtMuted">(${s.acpl})</span>${badges ? ` ${badges}` : ''}</span>`;
  };

  const curPt = rev.points?.find((p) => p.nodeId === tab.current?.id);
  let calloutHtml = '';
  if (curPt && curPt.ply > 0) {
    const kindTone =
      curPt.kind === 'blunder'
        ? 'text-ro'
        : curPt.kind === 'mistake'
          ? 'text-am'
          : curPt.kind === 'inaccuracy'
            ? 'text-cy'
            : 'text-em';
    const kindWord =
      curPt.kind === 'blunder'
        ? 'Blunder'
        : curPt.kind === 'mistake'
          ? 'Mistake'
          : curPt.kind === 'inaccuracy'
            ? 'Inaccuracy'
            : curPt.kind === 'best'
              ? 'Best'
              : 'Good';
    const bestBtn =
      curPt.nag && curPt.bestBeforeUci && curPt.bestBeforeSan
        ? ` · <button id="btnReviewPlayBest" data-uci="${escapeHtml(curPt.bestBeforeUci)}" class="underline text-em hover:text-emerald-300 font-semibold">Best: ${escapeHtml(curPt.bestBeforeSan)}</button>`
        : '';
    calloutHtml = `<div id="reviewMoveCallout" class="flex items-center justify-between gap-2 text-[10px] font-mono pt-1 border-t border-borderSubtle/50">
      <span class="truncate"><span class="font-bold ${kindTone}">${curPt.moveNum}${curPt.color === 'w' ? '.' : '...'} ${escapeHtml(curPt.san)}${escapeHtml(curPt.nag || '')} ${kindWord}</span> <span class="text-txtMuted">(${escapeHtml(curPt.evalAfterLabel)})</span>${bestBtn}</span>
      <span class="text-txtMuted shrink-0">Acc ${curPt.accuracy}%</span>
    </div>`;
  }

  const headerRight =
    rev.status === 'running'
      ? `<span class="font-mono text-[10px] text-cy">Depth ${rev.depth} · ${rev.done}/${rev.total} (${pct}%)</span>`
      : `<div class="flex items-center gap-1 shrink-0">
          <button id="btnReviewNextIssue" class="px-1.5 py-[1px] rounded bg-surface hover:bg-surfaceHover border border-borderSubtle text-[9.5px] text-txt" title="Jump to next inaccuracy, mistake, or blunder">Next ?!</button>
          <button id="btnReviewClear" class="px-1.5 py-[1px] rounded bg-surface hover:bg-surfaceHover border border-borderSubtle text-[9.5px] text-txtMuted hover:text-ro" title="Clear game review">✕</button>
        </div>`;

  const errorHtml =
    rev.status === 'error'
      ? `<div class="text-[10.5px] text-ro">${escapeHtml(rev.error || 'Review failed')}</div>`
      : '';

  const progressBar =
    rev.status === 'running'
      ? `<div class="h-1 w-full rounded bg-surface overflow-hidden"><div class="h-full bg-em transition-all duration-150" style="width:${pct}%"></div></div>`
      : '';

  panel.innerHTML = `
    <div class="flex flex-col gap-1.5">
      <div class="flex flex-wrap items-center justify-between gap-1.5 text-[10px] font-mono">
        <div class="flex flex-wrap items-center gap-2">
          ${renderSide('W', rev.white)}
          <span class="text-borderSubtle">|</span>
          ${renderSide('B', rev.black)}
        </div>
        ${headerRight}
      </div>
      ${progressBar}
      ${errorHtml}
      <div id="evalGraphContainer">${buildEvalGraphSvg(rev.points, tab.current?.id || '')}</div>
      ${calloutHtml}
    </div>
  `;

  panel.querySelectorAll('.review-graph-hit').forEach((rect) => {
    rect.onclick = () => {
      const node = findNodeById(tab.root, rect.dataset.nid);
      if (node) {
        tab.current = node;
        state.selectedSq = null;
        state.legalTargets = [];
        emitPositionChanged();
      }
    };
  });

  const nextBtn = panel.querySelector('#btnReviewNextIssue');
  if (nextBtn) nextBtn.onclick = jumpToNextReviewIssue;

  const clearBtn = panel.querySelector('#btnReviewClear');
  if (clearBtn) clearBtn.onclick = clearActiveTabReview;

  const playBestBtn = panel.querySelector('#btnReviewPlayBest');
  if (playBestBtn) {
    playBestBtn.onclick = () => {
      const parent = tab.current?.parent;
      if (parent) {
        tab.current = parent;
        playMoveOnTree(playBestBtn.dataset.uci);
      }
    };
  }
}
