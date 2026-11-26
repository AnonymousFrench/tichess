import {
  state,
  getCurrentFen,
  normalizeFen,
  escapeHtml,
  showToast,
} from '../state.js';
import {
  dbGetCollections,
  dbLookupPos,
  dbGetGamesByIds,
  indexGamesCollection,
} from '../db/indexedDb.js';
import { fetchChessComArchives, fetchChessComMonthGames } from '../api/chesscom.js';
import { playMoveOnTree, renderArrows } from '../board/board.js';
import { addBoardTab } from '../board/tabs.js';

function renderWdlBar(w, d, l) {
  const tot = w + d + l || 1;
  const wp = Math.round((w / tot) * 100);
  const dp = Math.round((d / tot) * 100);
  const lp = Math.max(0, 100 - wp - dp);
  return `<div class="stat-bar w-full" title="Win ${wp}% · Draw ${dp}% · Loss ${lp}%">${
    wp ? `<div class="sb-win" style="width:${wp}%">${wp >= 15 ? wp + '%' : ''}</div>` : ''
  }${dp ? `<div class="sb-draw" style="width:${dp}%">${dp >= 15 ? dp + '%' : ''}</div>` : ''}${
    lp ? `<div class="sb-loss" style="width:${lp}%">${lp >= 15 ? lp + '%' : ''}</div>` : ''
  }</div>`;
}

let scoutMovesReqId = 0;
let scoutGamesReqId = 0;

export async function refreshPlayerScout() {
  const reqId = ++scoutMovesReqId;
  const tbody = document.getElementById('scoutTableBody');
  if (!tbody) return;

  const col = state.collections.find((c) => c.id === state.activeScoutId);
  if (!col) {
    tbody.innerHTML = `<tr><td colspan="3" class="py-5 text-center font-sans text-txtMuted">Click <b>+ Scout</b> to sync Chess.com or import PGN.</td></tr>`;
    return;
  }

  const rec = await dbLookupPos(col.id, normalizeFen(getCurrentFen()));
  if (reqId !== scoutMovesReqId) return;
  if (!rec || !rec.entries?.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="py-5 text-center font-sans text-txtMuted">No games in ${escapeHtml(col.name)} reached this position.</td></tr>`;
    return;
  }

  const filtered = rec.entries.filter(
    (e) => state.scoutColor === 'both' || e.pColor === 'both' || e.pColor === state.scoutColor
  );
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="py-5 text-center font-sans text-txtMuted">No games for selected color filter.</td></tr>`;
    return;
  }

  const agg = new Map();
  for (const e of filtered) {
    let m = agg.get(e.uci);
    if (!m) {
      m = { uci: e.uci, san: e.san, w: 0, d: 0, l: 0 };
      agg.set(e.uci, m);
    }
    if (e.res === 'd') m.d++;
    else if ((e.pColor === 'black' && e.res === 'b') || (e.pColor !== 'black' && e.res === 'w')) m.w++;
    else m.l++;
  }

  const rows = Array.from(agg.values()).sort((a, b) => b.w + b.d + b.l - (a.w + a.d + a.l));
  tbody.innerHTML = rows
    .map(
      (m) =>
        `<tr class="sc-mv cursor-pointer" data-uci="${escapeHtml(m.uci)}" data-san="${escapeHtml(m.san)}"><td class="font-bold text-txt">${escapeHtml(m.san)}</td><td class="text-txtMuted">${m.w + m.d + m.l}</td><td>${renderWdlBar(m.w, m.d, m.l)}</td></tr>`
    )
    .join('');

  tbody.querySelectorAll('.sc-mv').forEach((r) => {
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

export async function renderScoutedGamesTable() {
  const reqId = ++scoutGamesReqId;
  const tbody = document.getElementById('scoutedGamesBody');
  if (!tbody) return;

  if (!state.activeScoutId) {
    tbody.innerHTML = `<tr><td colspan="8" class="py-5 text-center text-txtMuted">No scouted database selected. Click <b>+ Scout</b> to sync Chess.com or import PGN.</td></tr>`;
    return;
  }

  const rec = await dbLookupPos(state.activeScoutId, normalizeFen(getCurrentFen()));
  if (reqId !== scoutGamesReqId) return;
  if (!rec || !rec.entries?.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="py-5 text-center text-txtMuted">No scouted games match this exact position.</td></tr>`;
    return;
  }

  const gids = Array.from(new Set(rec.entries.map((e) => e.gid))).slice(0, 50);
  const games = await dbGetGamesByIds(gids);
  if (reqId !== scoutGamesReqId) return;
  tbody.innerHTML = games
    .map(
      (g, i) => `
      <tr class="sg-row cursor-pointer" data-idx="${i}">
        <td><span class="px-1.5 py-[1px] rounded font-mono text-[10px] font-bold bg-surface">${escapeHtml(g.result)}</span></td>
        <td class="font-medium max-w-[130px] truncate">${escapeHtml(g.white)}</td>
        <td class="text-right font-mono text-txtMuted">${g.whiteElo || ''}</td>
        <td class="font-medium max-w-[130px] truncate">${escapeHtml(g.black)}</td>
        <td class="text-right font-mono text-txtMuted">${g.blackElo || ''}</td>
        <td class="text-txtMuted max-w-[140px] truncate">${escapeHtml(g.event)}</td>
        <td class="font-mono text-txtMuted text-[10px]">${escapeHtml(g.date)}</td>
        <td class="font-mono text-txtMuted text-[10px] max-w-[150px] truncate">${escapeHtml(g.snippet || '')}</td>
      </tr>
    `
    )
    .join('');

  tbody.querySelectorAll('.sg-row').forEach((tr) => {
    tr.onclick = () => {
      const g = games[parseInt(tr.dataset.idx, 10)];
      if (g) addBoardTab(`${g.white.split(',')[0]} - ${g.black.split(',')[0]}`, g.pgn, g);
    };
  });
}

export async function reloadCollections(selectId = null) {
  state.collections = await dbGetCollections();
  const sel = document.getElementById('scoutCollectionSelect');
  if (sel) {
    if (!state.collections.length) {
      state.activeScoutId = '';
      sel.innerHTML = `<option value="">No DBs</option>`;
    } else {
      sel.innerHTML = state.collections
        .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${c.gameCount})</option>`)
        .join('');
      state.activeScoutId =
        selectId && state.collections.some((c) => c.id === selectId)
          ? selectId
          : state.collections.some((c) => c.id === state.activeScoutId)
            ? state.activeScoutId
            : state.collections[0].id;
      sel.value = state.activeScoutId;
    }
  }

  refreshPlayerScout();
  if (state.activeHub === 'scouted') renderScoutedGamesTable();

  const tot = state.collections.reduce((s, c) => s + (c.gameCount || 0), 0);
  const infoEl = document.getElementById('settingsDbInfo');
  if (infoEl) infoEl.textContent = `${state.collections.length} DB(s) · ${tot} games indexed.`;
}

export async function runChessComSync() {
  const user = document.getElementById('scChesscomUser').value.trim();
  const months = parseInt(document.getElementById('scChesscomMonths').value, 10);
  if (!user) {
    showToast('Enter a Chess.com username', true);
    return;
  }

  const wrap = document.getElementById('scProgressWrap');
  const setP = (pct, txt) => {
    wrap.classList.remove('hidden');
    document.getElementById('scProgressBar').style.width = `${pct}%`;
    document.getElementById('scProgressPct').textContent = `${Math.round(pct)}%`;
    document.getElementById('scProgressText').textContent = txt;
  };

  setP(10, `Fetching ${user}...`);
  try {
    const allArchives = await fetchChessComArchives(user);
    const archives = allArchives.slice(-months);
    const raw = [];
    for (let i = 0; i < archives.length; i++) {
      setP(15 + (i / Math.max(1, archives.length)) * 35, `Archive ${i + 1}/${archives.length}...`);
      const games = await fetchChessComMonthGames(archives[i]);
      for (const g of games) {
        if (g.rules !== 'chess' || !g.pgn) continue;
        raw.push({
          pgn: g.pgn,
          white: g.white?.username || 'White',
          whiteElo: g.white?.rating || 0,
          black: g.black?.username || 'Black',
          blackElo: g.black?.rating || 0,
          date: g.end_time ? new Date(g.end_time * 1000).toISOString().slice(0, 10) : '',
          event: `Chess.com ${g.time_class || ''}`,
        });
      }
    }
    if (!raw.length) throw new Error('No chess games found');
    raw.reverse();
    const cid = `cc:${user.toLowerCase()}`;
    await indexGamesCollection(
      { id: cid, name: `${user} (CC)`, type: 'chesscom', username: user.toLowerCase(), gameCount: 0 },
      raw,
      setP
    );
    wrap.classList.add('hidden');
    document.getElementById('scoutModal').classList.add('hidden');
    await reloadCollections(cid);
    showToast(`Synced ${raw.length} games for ${user}`);
  } catch (err) {
    wrap.classList.add('hidden');
    showToast(err.message || 'Sync failed', true);
  }
}

export async function handlePgnFileImport(file, playerFilter = '') {
  if (!file) return;
  showToast(`Importing ${file.name}...`);
  try {
    const chunks = (await file.text())
      .split(/\r?\n(?=\[Event\s+")/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!chunks.length) throw new Error('No games in PGN');
    const cid = `pgn:${file.name}`;
    await indexGamesCollection(
      {
        id: cid,
        name: playerFilter || file.name.replace(/\.pgn$/i, ''),
        type: 'pgn',
        username: playerFilter.toLowerCase(),
        gameCount: 0,
      },
      chunks.map((pgn) => ({ pgn }))
    );
    document.getElementById('scoutModal').classList.add('hidden');
    await reloadCollections(cid);
    showToast(`Imported ${chunks.length} games`);
  } catch (err) {
    showToast(err.message || 'PGN import failed', true);
  }
}
