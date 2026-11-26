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

let explorerAbortCtrl = null;

export async function refreshReferenceExplorer() {
  const reqId = ++state.refReqId;
  const fen = getCurrentFen();
  const authNote = document.getElementById('refAuthNote');
  if (authNote) authNote.classList.add('hidden');

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
  if (state.refSource === 'player' && tbodyEl) {
    tbodyEl.innerHTML = `<tr><td colspan="3" class="py-5 text-center font-sans text-txtMuted">Loading ${escapeHtml(sync.user?.username || 'your')} ${state.refPlayerColor === 'black' ? 'Black' : 'White'} games…</td></tr>`;
  }

  try {
    const data = await fetchExplorer(state.refSource, fen, {
      signal: ctrl.signal,
      player: sync.user?.username || '',
      color: state.refPlayerColor || 'white',
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

  const footerRow =
    state.refSource === 'player' && meta.fallbackLocal
      ? `<tr><td colspan="3" class="py-1.5 px-2 text-center font-sans text-[10px] text-txtMuted bg-surface/40">Last ${meta.sampledGames || 0} Lichess games${
          meta.reauthNeeded
            ? ` · <a href="${escapeHtml(getLoginUrl('/'))}" class="text-vi hover:underline font-semibold">Refresh sign-in for full history →</a>`
            : ''
        }</td></tr>`
      : '';

  if (!moves.length) {
    const emptyMsg =
      state.refSource === 'player'
        ? `No ${state.refPlayerColor === 'black' ? 'Black' : 'White'} Lichess games reached this position.`
        : 'No database games here.';
    tbody.innerHTML = `<tr><td colspan="3" class="py-5 text-center font-sans text-txtMuted">${escapeHtml(emptyMsg)}</td></tr>${footerRow}`;
    return;
  }

  tbody.innerHTML =
    moves
      .map((m) => {
        const cnt = m.white + m.draws + m.black;
        return `<tr class="db-mv cursor-pointer" data-uci="${escapeHtml(m.uci)}" data-san="${escapeHtml(m.san)}"><td class="font-bold text-txt">${escapeHtml(m.san)}</td><td class="text-txtMuted">${formatCount(cnt)}</td><td>${renderWdbBar(m.white, m.draws, m.black)}</td></tr>`;
      })
      .join('') + footerRow;

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
    tbody.innerHTML = `<tr><td colspan="8" class="py-5 text-center text-txtMuted">No games for this position from Lichess Explorer.</td></tr>`;
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
