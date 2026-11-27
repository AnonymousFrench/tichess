import { Chess } from 'chess.js';
import {
  state,
  START_FEN,
  getActiveTab,
  getCurrentFen,
  normalizeFen,
  escapeHtml,
  formatCount,
  showToast,
} from '../state.js';
import { fetchExplorer, fetchExplorerGamePgn } from '../api/lichess.js';
import { getCloudSyncState, getLoginUrl } from '../sync/cloudSync.js';
import { playMoveOnTree, renderArrows } from '../board/board.js';
import { addBoardTab } from '../board/tabs.js';
import { fetchMineExplorer, invalidateMyGamesCache } from './mineSource.js';
import { pullInsightsFromServer } from '../insights/cloudInsights.js';
import { extractPathToNode } from '../repertoire/pgnImport.js';
import { openFlawRepertoireModal } from '../repertoire/flawModal.js';
import { initStudioRepertoire } from '../repertoire/studioPanel.js';
import { stopLocalSf, triggerSfAnalysis } from '../engines/stockfish.js';

/** Sources that show the user's own games (results read from their side). */
const isPersonal = () => state.refSource === 'player' || state.refSource === 'mine';

export function renderWdbBar(w, d, b) {
  const tot = w + d + b || 1;
  const wp = Math.round((w / tot) * 100);
  const dp = Math.round((d / tot) * 100);
  const bp = Math.max(0, 100 - wp - dp);
  return `<div class="stat-bar w-full" title="W ${wp}% · D ${dp}% · B ${bp}%">${
    wp ? `<div class="sb-w" style="width:${wp}%">${wp >= 15 ? wp + '%' : ''}</div>` : ''
  }${dp ? `<div class="sb-d" style="width:${dp}%">${dp >= 15 ? dp + '%' : ''}</div>` : ''}${
    bp ? `<div class="sb-b" style="width:${bp}%">${bp >= 15 ? bp + '%' : ''}</div>` : ''
  }</div>`;
}

function setOpeningPill(eco, name) {
  const ecoEl = document.getElementById('openingEco');
  const nameEl = document.getElementById('openingName');
  if (ecoEl) ecoEl.textContent = eco || '—';
  if (nameEl) nameEl.textContent = name || '—';
  // Nothing to say (unknown position, explorer offline): hide the pill instead of showing dashes.
  const known = (eco && eco !== '—') || (name && name !== '—');
  document.getElementById('openingPill')?.classList.toggle('invisible', !known);
}

function getFallbackOpeningForCurrentPosition(fen) {
  if (normalizeFen(fen) === normalizeFen(START_FEN)) {
    return { eco: '—', name: 'Starting Position' };
  }
  const tab = getActiveTab();
  if (tab?.meta && (tab.meta.eco || tab.meta.opening)) {
    return {
      eco: tab.meta.eco || '—',
      name: tab.meta.opening || '—',
    };
  }
  return { eco: '—', name: '—' };
}

export function classifyPlayerMovePerformance(move, playerColor = 'white') {
  const w = Number(move?.white) || 0;
  const d = Number(move?.draws) || 0;
  const b = Number(move?.black) || 0;
  const total = w + d + b;
  const wins = playerColor === 'black' ? b : w;
  const losses = playerColor === 'black' ? w : b;
  const scorePct = total ? Math.round(((wins + 0.5 * d) / total) * 100) : 0;
  const badge = total >= 3 ? (scorePct < 40 ? 'flaw' : scorePct >= 65 ? 'strong' : null) : null;
  return { total, wins, draws: d, losses, scorePct, badge };
}

const SINCE_LABELS = {
  '': 'all time',
  '1m': 'last 1m',
  '3m': 'last 3m',
  '6m': 'last 6m',
  '12m': 'last 12m',
};

let explorerAbortCtrl = null;

export async function refreshReferenceExplorer() {
  const reqId = ++state.refReqId;
  const fen = getCurrentFen();
  const authNote = document.getElementById('refAuthNote');
  if (authNote) authNote.classList.add('hidden');
  const summaryEl = document.getElementById('refPlayerSummary');

  if (explorerAbortCtrl) {
    explorerAbortCtrl.abort();
  }
  const ctrl = new AbortController();
  explorerAbortCtrl = ctrl;

  if (normalizeFen(fen) === normalizeFen(START_FEN)) {
    setOpeningPill('—', 'Starting Position');
  }

  const sync = getCloudSyncState();
  const tbodyEl = document.getElementById('refTableBody');
  const activeColor = state.refPlayerColor || 'white';
  const activeSince = state.refPlayerSince || '';
  const activeMax = state.refPlayerMax || '200';

  if (state.refSource === 'player' && tbodyEl) {
    if (summaryEl) summaryEl.textContent = 'Loading…';
    tbodyEl.innerHTML = `<tr><td colspan="3" class="py-5 text-center font-sans text-txtMuted">Loading ${escapeHtml(sync.user?.username || 'your')} ${activeColor === 'black' ? 'Black' : 'White'} games…</td></tr>`;

    // 1. Prefer our synced Insights database (IndexedDB hydrated from Neon) — instant, works offline,
    //    includes both Lichess and Chess.com games, and never stalls on Lichess rate limits.
    try {
      let dbData = await fetchMineExplorer(getActiveTab()?.current, {
        color: activeColor,
        sinceKey: activeSince,
        maxGames: activeMax,
      });
      if (reqId !== state.refReqId) return;

      if (!dbData.unsupported && dbData.totalInDb === 0 && sync.authenticated) {
        const pulled = await pullInsightsFromServer({ syncLocalOnly: false, signal: ctrl.signal }).catch(() => ({
          ok: false,
          pulledCount: 0,
        }));
        if (reqId !== state.refReqId) return;
        if (pulled.ok && pulled.pulledCount > 0) {
          invalidateMyGamesCache();
          dbData = await fetchMineExplorer(getActiveTab()?.current, {
            color: activeColor,
            sinceKey: activeSince,
            maxGames: activeMax,
          });
          if (reqId !== state.refReqId) return;
        }
      }

      if (!dbData.unsupported && dbData.totalInDb > 0) {
        renderRefTable(dbData.moves, {
          sinceKey: activeSince,
          maxGames: activeMax,
          sampledGames: dbData.sampledGames,
          posTotals: { white: dbData.white, draws: dbData.draws, black: dbData.black },
        });
        const fb = getFallbackOpeningForCurrentPosition(fen);
        setOpeningPill(fb.eco, fb.name);
        state.mastersGamesCache = dbData.recentGames;
        renderMasterGamesTable();
        return;
      }
    } catch (_) {
      if (reqId !== state.refReqId) return;
      // Fall through to live Lichess explorer fallback if local DB read fails
    }
  }

  if (state.refSource === 'mine' && tbodyEl) {
    try {
      const data = await fetchMineExplorer(getActiveTab()?.current, {
        color: activeColor,
        sinceKey: activeSince,
        maxGames: activeMax,
      });
      if (reqId !== state.refReqId) return;
      if (data.unsupported) {
        tbodyEl.innerHTML = `<tr><td colspan="3" class="py-5 text-center font-sans text-txtMuted">Your games are matched by moves from the starting position. This tab starts from a custom position.</td></tr>`;
        document.getElementById('refTotalGames').textContent = '—';
        if (summaryEl) summaryEl.textContent = '';
        return;
      }
      renderRefTable(data.moves, {
        sinceKey: activeSince,
        maxGames: activeMax,
        sampledGames: data.sampledGames,
        posTotals: { white: data.white, draws: data.draws, black: data.black },
      });
      const fb = getFallbackOpeningForCurrentPosition(fen);
      setOpeningPill(fb.eco, fb.name);
      state.mastersGamesCache = data.recentGames;
      renderMasterGamesTable();
    } catch (_) {
      if (reqId !== state.refReqId) return;
      tbodyEl.innerHTML = `<tr><td colspan="3" class="py-5 text-center font-sans text-txtMuted">Could not read your games from this browser.</td></tr>`;
    }
    return;
  }

  try {
    const data = await fetchExplorer(state.refSource, fen, {
      signal: ctrl.signal,
      player: sync.user?.username || '',
      color: state.refPlayerColor || 'white',
      sinceKey: state.refPlayerSince || '',
      maxGames: state.refPlayerMax || '200',
      authenticated: sync.authenticated,
    });
    if (reqId !== state.refReqId) return;

    if (data.opening && (data.opening.eco || data.opening.name)) {
      setOpeningPill(data.opening.eco || '—', data.opening.name || '—');
    } else {
      const fb = getFallbackOpeningForCurrentPosition(fen);
      setOpeningPill(fb.eco, fb.name);
    }

    renderRefTable(data.moves || [], {
      fallbackLocal: Boolean(data.fallbackLocal),
      reauthNeeded: Boolean(data.reauthNeeded),
      sampledGames: data.sampledGames || 0,
      sinceKey: data.sinceKey ?? state.refPlayerSince ?? '',
      maxGames: data.maxGames ?? state.refPlayerMax ?? '200',
      posTotals: {
        white: Number(data.white) || 0,
        draws: Number(data.draws) || 0,
        black: Number(data.black) || 0,
      },
    });
    const games = [...(data.topGames || []), ...(data.recentGames || [])];
    state.mastersGamesCache = Array.from(new Map(games.map((g) => [g.id, g])).values());
    renderMasterGamesTable();
  } catch (err) {
    if (err.name === 'AbortError' || reqId !== state.refReqId) return;
    const fb = getFallbackOpeningForCurrentPosition(fen);
    setOpeningPill(fb.eco, fb.name);
    if (err.authRequired && !err.reauthNeeded && !state.lichessToken && err.name !== 'RateLimitError') {
      if (authNote) authNote.classList.remove('hidden');
    }
    state.mastersGamesCache = [];
    document.getElementById('refTotalGames').textContent = '—';
    if (summaryEl) summaryEl.textContent = '';

    const tbody = document.getElementById('refTableBody');
    if (err.reauthNeeded && tbody) {
      tbody.innerHTML = `<tr><td colspan="3" class="py-4 text-center font-sans text-txtMuted">
        <div class="mb-1.5">Sign in with Lichess once more to load your personal game explorer.</div>
        <a href="${escapeHtml(getLoginUrl('/'))}" class="inline-block px-2.5 py-1 rounded bg-vi/20 hover:bg-vi/30 text-vi border border-vi/40 font-semibold text-[11px]">Refresh Lichess Sign-in →</a>
      </td></tr>`;
    } else if (tbody) {
      const msg =
        err.name === 'RateLimitError'
          ? 'Rate limited — retrying in 60s'
          : err.authRequired
            ? state.refSource === 'player'
              ? 'Sign in with Lichess to browse your own games.'
              : 'Lichess Explorer requires signing in with Lichess or adding a free token in Settings.'
            : 'Unable to reach Lichess Explorer API.';
      tbody.innerHTML = `<tr><td colspan="3" class="py-5 text-center font-sans text-txtMuted">${escapeHtml(msg)}</td></tr>`;
    }
    renderMasterGamesTable();
  }
}

export function renderRefTable(moves, meta = {}) {
  const tbody = document.getElementById('refTableBody');
  if (!tbody) return;

  const total = moves.reduce((s, m) => s + m.white + m.draws + m.black, 0);
  document.getElementById('refTotalGames').textContent = `${total.toLocaleString()} games`;

  const summaryEl = document.getElementById('refPlayerSummary');
  if (summaryEl) {
    if (isPersonal()) {
      const posW = meta.posTotals?.white ?? moves.reduce((s, m) => s + m.white, 0);
      const posD = meta.posTotals?.draws ?? moves.reduce((s, m) => s + m.draws, 0);
      const posB = meta.posTotals?.black ?? moves.reduce((s, m) => s + m.black, 0);
      const perf = classifyPlayerMovePerformance(
        { white: posW, draws: posD, black: posB },
        state.refPlayerColor || 'white'
      );
      if (perf.total > 0) {
        const wp = Math.round((perf.wins / perf.total) * 100);
        const dp = Math.round((perf.draws / perf.total) * 100);
        const lp = Math.max(0, 100 - wp - dp);
        const scoreTone =
          perf.scorePct < 42 ? 'text-ro' : perf.scorePct >= 58 ? 'text-em' : 'text-txt';
        summaryEl.innerHTML = `<span class="${scoreTone} font-bold">${perf.scorePct}%</span> <span class="text-txtMuted">(${wp}W·${dp}D·${lp}L)</span>`;
      } else {
        summaryEl.textContent = '0 games in filter';
      }
    } else {
      summaryEl.textContent = '';
    }
  }

  const sinceLabel = SINCE_LABELS[meta.sinceKey ?? state.refPlayerSince ?? ''] || 'all time';
  const footerRow =
    state.refSource === 'player' && meta.fallbackLocal
      ? `<tr><td colspan="3" class="py-1.5 px-2 text-center font-sans text-[10px] text-txtMuted bg-surface/40">Indexed ${meta.sampledGames || 0} games (${escapeHtml(sinceLabel)})${
          meta.reauthNeeded
            ? ` · <a href="${escapeHtml(getLoginUrl('/'))}" class="text-vi hover:underline font-semibold">Refresh sign-in for full history →</a>`
            : ''
        }</td></tr>`
      : '';

  if (!moves.length) {
    const emptyMsg = isPersonal()
      ? `None of your ${state.refPlayerColor === 'black' ? 'Black' : 'White'} games reached this position (${sinceLabel}).`
      : 'No database games here.';
    tbody.innerHTML = `<tr><td colspan="3" class="py-5 text-center font-sans text-txtMuted">${escapeHtml(emptyMsg)}</td></tr>${footerRow}`;
    return;
  }

  const isPlayerMode = isPersonal();
  const pCol = state.refPlayerColor || 'white';
  const curFen = getCurrentFen();
  const fenTurn = curFen.split(' ')[1] === 'b' ? 'black' : 'white';
  const isMyTurn = fenTurn === pCol;
  const flawMetaByIdx = new Map();

  tbody.innerHTML =
    moves
      .map((m, idx) => {
        const cnt = m.white + m.draws + m.black;
        let badgeHtml = '';
        if (isPlayerMode) {
          const perf = classifyPlayerMovePerformance(m, pCol);
          if (perf.badge === 'flaw') {
            badgeHtml = `<span class="ml-1 px-1 py-[0.5px] rounded bg-ro/20 text-ro border border-ro/35 font-sans text-[8.5px] font-bold uppercase tracking-wide" title="Low score (${perf.scorePct}% across ${perf.total} games)">Flaw</span>`;
            flawMetaByIdx.set(idx, { move: m, perf, isMyTurn });
            const tip = isMyTurn
              ? `Diagnose ${m.san} (weak move vs. weak follow-up) and generate a repertoire`
              : `Generate a repertoire response against opponent's ${m.san}`;
            badgeHtml += `<button type="button" class="flaw-fix-btn ml-1 px-1.5 py-[0.5px] rounded bg-em/15 hover:bg-em/25 text-em border border-em/40 font-sans text-[8.5px] font-bold uppercase tracking-wide" data-flaw-idx="${idx}" title="${escapeHtml(tip)}">Fix →</button>`;
          } else if (perf.badge === 'strong') {
            badgeHtml = `<span class="ml-1 px-1 py-[0.5px] rounded bg-em/15 text-em border border-em/35 font-sans text-[8.5px] font-bold uppercase tracking-wide" title="Strong score (${perf.scorePct}% across ${perf.total} games)">Strong</span>`;
          }
        }
        return `<tr class="db-mv cursor-pointer" data-uci="${escapeHtml(m.uci)}" data-san="${escapeHtml(m.san)}"><td class="font-bold text-txt whitespace-nowrap">${escapeHtml(m.san)}${badgeHtml}</td><td class="text-txtMuted">${formatCount(cnt)}</td><td>${renderWdbBar(m.white, m.draws, m.black)}</td></tr>`;
      })
      .join('') + footerRow;

  tbody.querySelectorAll('.flaw-fix-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const entry = flawMetaByIdx.get(Number(btn.dataset.flawIdx));
      if (!entry) return;
      const tab = getActiveTab();
      const { startFen, moves: prefixMoves } = extractPathToNode(tab?.current);
      const openingName = document.getElementById('openingName')?.textContent || '';
      const baseFen = getCurrentFen();

      const handleBusyChange = (busy) => {
        if (busy) {
          stopLocalSf();
        } else if (state.sfEnabled) {
          triggerSfAnalysis();
        }
      };

      if (entry.isMyTurn) {
        openFlawRepertoireModal({
          prefixMoves,
          startFen,
          fen: baseFen,
          color: pCol === 'black' ? 'b' : 'w',
          flawedUci: entry.move.uci,
          flawedSan: entry.move.san,
          flawedStats: entry.perf,
          triggerType: 'user_move',
          openingName,
          personalGames: state.mastersGamesCache || [],
          onBusyChange: handleBusyChange,
          notify: (msg, isErr) => showToast(msg, Boolean(isErr)),
          onSaved: async () => {
            try {
              await initStudioRepertoire();
            } catch (_) {}
          },
        });
        return;
      }

      // Opponent's move is flagged as a flaw (e.g. Black's 6...e5 beats White):
      // advance virtually by that opponent move so the modal generates White's reply repertoire.
      let oppMv = null;
      let fenAfterOpp = '';
      try {
        const chess = new Chess(baseFen);
        const uci = String(entry.move.uci || '');
        oppMv =
          uci.length >= 4
            ? chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined })
            : chess.move(entry.move.san);
        if (oppMv) fenAfterOpp = chess.fen();
      } catch (_) {}

      if (!oppMv || !fenAfterOpp) {
        showToast('Could not build line from this position.', true);
        return;
      }

      const oppUci = oppMv.from + oppMv.to + (oppMv.promotion || '');
      const extendedPrefix = [
        ...prefixMoves,
        {
          san: oppMv.san,
          uci: oppUci,
          fen: fenAfterOpp,
          color: oppMv.color,
        },
      ];

      openFlawRepertoireModal({
        prefixMoves: extendedPrefix,
        startFen,
        fen: fenAfterOpp,
        color: pCol === 'black' ? 'b' : 'w',
        flawedUci: '',
        flawedSan: oppMv.san,
        flawedStats: entry.perf,
        triggerType: 'opponent_reply',
        oppMove: { uci: oppUci, san: oppMv.san, ply: prefixMoves.length },
        openingName,
        personalGames: state.mastersGamesCache || [],
        onBusyChange: handleBusyChange,
        notify: (msg, isErr) => showToast(msg, Boolean(isErr)),
        onSaved: async () => {
          try {
            await initStudioRepertoire();
          } catch (_) {}
        },
      });
    };
  });

  tbody.querySelectorAll('.db-mv').forEach((r) => {
    r.onclick = () => playMoveOnTree(r.dataset.uci || r.dataset.san);
    r.onmouseenter = () => {
      state.hoverArrowUci = r.dataset.uci;
      renderArrows();
    };
    r.onmouseleave = () => {
      state.hoverArrowUci = null;
      renderArrows();
    };
  });
}

export function renderMasterGamesTable() {
  const tbody = document.getElementById('masterGamesBody');
  if (!tbody) return;

  if (!state.mastersGamesCache.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="py-5 text-center text-txtMuted">${state.refSource === 'mine' ? 'None of your games reached this position.' : 'No games for this position from Lichess Explorer.'}</td></tr>`;
    return;
  }

  const sync = getCloudSyncState();
  const list = state.mastersGamesCache.map((g) => ({
    id: g.id,
    pgn: g.pgn || '',
    white: g.white?.name || 'White',
    whiteElo: g.white?.rating || '',
    black: g.black?.name || 'Black',
    blackElo: g.black?.rating || '',
    result: g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : '1/2-1/2',
    event:
      state.refSource === 'masters'
        ? 'Masters OTB'
        : state.refSource === 'player'
          ? `${sync.user?.username || 'My'} Lichess`
          : state.refSource === 'mine'
            ? 'My games'
            : 'Lichess',
    date: g.year || g.month || '',
    snippet: 'Click to load PGN',
  }));

  tbody.innerHTML = list
    .map(
      (g, idx) => `
      <tr class="mg-row cursor-pointer" data-idx="${idx}">
        <td><span class="px-1.5 py-[1px] rounded font-mono text-[10px] font-bold ${
          g.result === '1-0'
            ? 'bg-em/20 text-em'
            : g.result === '0-1'
              ? 'bg-ro/20 text-ro'
              : 'bg-surface text-txtMuted'
        }">${escapeHtml(g.result)}</span></td>
        <td class="font-medium max-w-[130px] truncate">${escapeHtml(g.white)}</td>
        <td class="text-right font-mono text-txtMuted">${escapeHtml(g.whiteElo)}</td>
        <td class="font-medium max-w-[130px] truncate">${escapeHtml(g.black)}</td>
        <td class="text-right font-mono text-txtMuted">${escapeHtml(g.blackElo)}</td>
        <td class="text-txtMuted max-w-[140px] truncate">${escapeHtml(g.event)}</td>
        <td class="font-mono text-txtMuted text-[10px]">${escapeHtml(g.date)}</td>
        <td class="font-mono text-txtMuted text-[10px] max-w-[150px] truncate">${escapeHtml(g.snippet)}</td>
      </tr>
    `
    )
    .join('');

  tbody.querySelectorAll('.mg-row').forEach((tr) => {
    tr.onclick = async () => {
      const g = list[parseInt(tr.dataset.idx, 10)];
      if (!g) return;
      if (g.pgn) {
        addBoardTab(`${g.white.split(',')[0]} - ${g.black.split(',')[0]}`, g.pgn, g);
        return;
      }
      showToast('Fetching game PGN...');
      try {
        const pgn = await fetchExplorerGamePgn(state.refSource, g.id);
        addBoardTab(`${g.white.split(',')[0]} - ${g.black.split(',')[0]}`, pgn, g);
      } catch (_) {
        showToast('Failed to fetch PGN', true);
      }
    };
  });
}
