import { Chess } from 'chess.js';
import {
  state,
  START_FEN,
  getActiveTab,
  getCurrentFen,
  normalizeFen,
  escapeHtml,
  showToast,
  emitPositionChanged,
} from '../state.js';
import { createNode } from '../chess/tree.js';
import {
  parseRepertoireFile,
  mergeProgress,
  buildExportFile,
  cardStatus,
} from './model.js';
import {
  buildRepertoireFromPgn,
  mergeRepertoires,
  extractPathToNode,
  appendBoardLineToRepertoire,
} from './pgnImport.js';
import {
  loadRepertoire,
  saveRepertoire,
  loadProgress,
  saveProgress,
} from './storage.js';
import {
  PREP_DRILL_STORAGE_KEY,
  collectRepertoireOpponentFens,
  analyzeOpponentAgainstRepertoire,
} from './opponentPrep.js';
import { dbLookupPositionsBatch } from '../db/indexedDb.js';
import { findOpponentWeakSpots, sanPathLabel, plyMoveLabel } from './opponentWeakSpots.js';
import { openFlawRepertoireModal } from './flawModal.js';
import { pushRepertoireToCloud } from '../sync/cloudSync.js';
import { playMoveOnTree, renderArrows } from '../board/board.js';
import { addBoardTab } from '../board/tabs.js';

let loadedRep = null; // { repertoire, name }
let loadedProg = {};
let fenIndex = new Map();
let activeDrawer = null; // null | 'pgn' | 'addLine' | 'prep'
let addLineDraft = null; // optional { color, sectionName, lineName }
let sectionToggles = new Map(); // section id → expanded (explicit user choice; otherwise sections follow the board)
let lastScrolledKey = ''; // board path the tree last scrolled to, so re-renders do not fight the user's scrolling
let treeViewMode = (() => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('tichess_rep_view') === 'merged'
      ? 'merged'
      : 'grouped';
  } catch (_) {
    return 'grouped';
  }
})();
let mergedColorFilter = 'both'; // 'both' | 'w' | 'b'
let prepState = {
  colId: '',
  userColor: 'both',
  loading: false,
  result: null,
  reqId: 0,
  weakSpots: null, // null = not computed yet; [] = none found
  weakLoading: false,
};

export function getLoadedRepertoireState() {
  return {
    loadedRep,
    loadedProg,
    fenIndex,
  };
}

/**
 * Index `repertoire.pos` by normalized 4-field FEN for O(1) board lookups.
 */
export function buildRepertoireFenIndex(repertoire) {
  const idx = new Map();
  if (!repertoire?.pos) return idx;
  for (let i = 0; i < repertoire.pos.length; i++) {
    const f = repertoire.pos[i]?.f;
    if (typeof f !== 'string') continue;
    const key = normalizeFen(f);
    let arr = idx.get(key);
    if (!arr) {
      arr = [];
      idx.set(key, arr);
    }
    arr.push(i);
  }
  return idx;
}

/**
 * Look up prepared repertoire moves, notes, warnings, and lines for a FEN.
 */
export function lookupRepertoirePosition(index, repertoire, progress, fen, now = Date.now()) {
  if (!index || !repertoire || !fen) return null;
  const posIndices = index.get(normalizeFen(fen));
  if (!posIndices || !posIndices.length) return null;

  const moveMap = new Map();
  const lineIdSet = new Set();
  const warnings = [];
  let openingName = '';

  for (const pi of posIndices) {
    const node = repertoire.pos[pi];
    if (!node) continue;
    const th = node.t !== undefined && node.t !== null ? repertoire.theory?.[node.t] : null;
    if (!openingName && th?.name) openingName = th.name;

    for (const e of node.e || []) {
      const [uci, san, , flags, lineIds, cardId] = e;
      const mine = Boolean(flags & 1);
      const isAlt = Boolean(flags & 2);
      const card = cardId ? repertoire.cards?.[cardId] : null;
      const status = cardId ? cardStatus(progress?.[cardId], now) : null;
      const warning = repertoire.warn?.[`${pi}|${uci}`] || '';
      if (warning && !warnings.includes(warning)) warnings.push(warning);

      for (const li of lineIds || []) lineIdSet.add(li);

      const prev = moveMap.get(uci);
      if (!prev || (!prev.mine && mine)) {
        moveMap.set(uci, {
          uci,
          san,
          mine,
          isAlt,
          cardId: cardId || null,
          note: card?.n || '',
          status,
          warning,
        });
      }
    }
  }

  const moves = [...moveMap.values()].sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    if (a.isAlt !== b.isAlt) return a.isAlt ? 1 : -1;
    return a.san.localeCompare(b.san);
  });

  const lines = [...lineIdSet]
    .map((li) => repertoire.lines?.[li])
    .filter(Boolean);

  return { openingName, moves, warnings, lines };
}

/**
 * Summarize overall and per-section progress counts.
 */
export function summarizeRepertoire(repertoire, progress, now = Date.now()) {
  const countsOf = (cardIds) => {
    const out = { total: cardIds.length, mastered: 0, learning: 0, due: 0, newCount: 0 };
    for (const id of cardIds) {
      const st = cardStatus(progress?.[id], now);
      if (st === 'mastered') out.mastered++;
      else if (st === 'learning') out.learning++;
      else if (st === 'due') out.due++;
      else out.newCount++;
    }
    return out;
  };

  const allCardIds = Object.keys(repertoire?.cards || {});
  const total = countsOf(allCardIds);

  const sections = (repertoire?.secs || []).map((sec) => {
    const secCardSet = new Set();
    for (const li of sec.lines || []) {
      const ln = repertoire.lines?.[li];
      if (!ln) continue;
      for (let p = 0; p < ln.uci.length; p++) {
        const node = repertoire.pos?.[ln.pos[p]];
        const edge = node?.e?.find((e) => e[0] === ln.uci[p]);
        if (edge && edge[5]) secCardSet.add(edge[5]);
      }
    }
    return {
      id: sec.id,
      name: sec.name,
      group: sec.group || '',
      color: sec.color,
      firstLineIdx: sec.lines?.[0] ?? null,
      counts: countsOf([...secCardSet]),
    };
  });

  return { total, sections };
}

function lineToPgn(line) {
  if (!line?.san?.length) return '';
  const moves = line.san
    .map((s, idx) => (idx % 2 === 0 ? `${Math.floor(idx / 2) + 1}. ${s}` : s))
    .join(' ');
  return `[Event "${(line.name || 'Repertoire').replace(/"/g, '')}"]\n[Result "*"]\n\n${moves} *`;
}

function statusPill(st) {
  if (st === 'mastered') {
    return '<span class="px-1.5 py-[1px] rounded bg-em/20 text-em font-mono text-[9.5px] font-bold">Mastered</span>';
  }
  if (st === 'due') {
    return '<span class="px-1.5 py-[1px] rounded bg-ro/20 text-ro font-mono text-[9.5px] font-bold">Due</span>';
  }
  if (st === 'learning') {
    return '<span class="px-1.5 py-[1px] rounded bg-cy/20 text-cy font-mono text-[9.5px] font-bold">Learning</span>';
  }
  if (st === 'new') {
    return '<span class="px-1.5 py-[1px] rounded bg-surface text-txtMuted font-mono text-[9.5px]">New</span>';
  }
  return '';
}

function updateRepertoireBadge() {
  const badge = document.getElementById('repDueBadge');
  if (!badge) return;
  if (!loadedRep?.repertoire) {
    badge.classList.add('hidden');
    return;
  }
  const { total } = summarizeRepertoire(loadedRep.repertoire, loadedProg);
  if (total.due > 0) {
    badge.textContent = String(total.due);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

async function persistRepertoire(repertoire, name) {
  const updatedAt = Date.now();
  try {
    await saveRepertoire(repertoire, name, updatedAt);
  } catch (_) {
    showToast('Browser blocked saving repertoire to IndexedDB', true);
    return false;
  }
  await initStudioRepertoire();
  pushRepertoireToCloud(repertoire, name, updatedAt, loadProgress());
  return true;
}

export async function handleStudioRepertoireImport(file, { color = 'w', merge = true } = {}) {
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch (_) {
    showToast('Could not read repertoire file', true);
    return;
  }

  const trimmed = text.trim();
  const looksJson = file.name?.toLowerCase().endsWith('.json') || trimmed.startsWith('{');

  if (looksJson) {
    const parsed = parseRepertoireFile(text);
    if (!parsed.ok) {
      showToast(parsed.error || 'Invalid repertoire JSON file', true);
      return;
    }
    const mergedProg = mergeProgress(loadProgress(), parsed.progress);
    if (!saveProgress(mergedProg)) {
      showToast('Browser blocked saving repertoire progress', true);
      return;
    }
    if (await persistRepertoire(parsed.repertoire, parsed.name)) {
      activeDrawer = null;
      showToast(`Imported repertoire${parsed.name ? `: ${parsed.name}` : ''}`);
    }
    return;
  }

  await importPgnTextIntoStudio(text, {
    color,
    merge,
    name: file.name ? file.name.replace(/\.pgn$/i, '') : '',
  });
}

export async function importPgnTextIntoStudio(pgnText, { color = 'w', merge = true, name = '' } = {}) {
  const built = buildRepertoireFromPgn(pgnText, { color, name });
  if (!built.ok) {
    showToast(built.error || 'Could not parse PGN', true);
    return false;
  }

  const shouldMerge = Boolean(merge && loadedRep?.repertoire);
  const nextRep = shouldMerge
    ? mergeRepertoires(loadedRep.repertoire, built.repertoire)
    : built.repertoire;
  const nextName = shouldMerge ? loadedRep.name || built.name : built.name;

  if (await persistRepertoire(nextRep, nextName)) {
    activeDrawer = null;
    showToast(
      `${shouldMerge ? 'Merged' : 'Imported'} ${built.stats.lines} line${built.stats.lines === 1 ? '' : 's'} (${built.stats.cards} move cards)`
    );
    return true;
  }
  return false;
}

export async function saveCurrentBoardLineToRepertoire({ color, sectionName, lineName, note }) {
  const tab = getActiveTab();
  if (!tab) return false;
  const { startFen, moves } = extractPathToNode(tab.current);
  const res = appendBoardLineToRepertoire(loadedRep?.repertoire || null, {
    startFen,
    moves,
    color,
    sectionName,
    lineName,
    note,
  });
  if (!res.ok) {
    showToast(res.error || 'Could not save line', true);
    return false;
  }
  const repName = loadedRep?.name || res.sectionName || 'My Repertoire';
  if (await persistRepertoire(res.repertoire, repName)) {
    activeDrawer = null;
    showToast(`Saved "${res.lineName}" to ${res.sectionName}`);
    return true;
  }
  return false;
}

function exportStudioRepertoireBackup() {
  if (!loadedRep?.repertoire) return;
  const now = Date.now();
  const blob = new Blob(
    [buildExportFile(loadedRep.repertoire, loadProgress(), loadedRep.name, now)],
    { type: 'application/json' }
  );
  const d = new Date(now);
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tichess-repertoire-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast('Exported repertoire backup');
}

export async function initStudioRepertoire() {
  loadedRep = await loadRepertoire();
  loadedProg = loadProgress();
  fenIndex = loadedRep?.repertoire ? buildRepertoireFenIndex(loadedRep.repertoire) : new Map();
  updateRepertoireBadge();
  renderStudioRepertoirePanel();
}

export function bindStudioRepertoireSync() {
  if (typeof window === 'undefined') return;
  window.addEventListener('storage', (e) => {
    if (e.key === 'tichess-rep-progress') {
      loadedProg = loadProgress();
      updateRepertoireBadge();
      renderStudioRepertoirePanel();
    }
  });
  window.addEventListener('focus', () => {
    initStudioRepertoire();
  });
}

function renderPgnDrawer(hasExisting) {
  return `
    <div id="studioRepPgnDrawer" class="p-2.5 rounded-lg bg-[#0d1422] border border-cy/35 flex flex-col gap-2 text-[11px]">
      <div class="flex items-center justify-between gap-2">
        <span class="font-bold text-cy">Import PGN / Lichess Study</span>
        <button id="btnCloseRepDrawer" class="text-txtMuted hover:text-txt text-xs">✕</button>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <label class="inline-flex items-center gap-1 text-[10.5px] text-txtMuted">
          Play as:
          <select id="repPgnColor" class="px-1.5 py-0.5 rounded bg-surface border border-borderSubtle text-txt text-[10.5px]">
            <option value="w">White</option>
            <option value="b">Black</option>
          </select>
        </label>
        <input id="repPgnName" type="text" placeholder="Repertoire / Study name (optional)" class="flex-1 min-w-[140px] px-2 py-0.5 rounded bg-surface border border-borderSubtle text-[10.5px] focus:outline-none focus:border-cy" />
        <label class="px-2 py-0.5 rounded bg-surface hover:bg-surfaceHover border border-borderSubtle text-[10.5px] cursor-pointer text-txt">
          Choose .pgn
          <input id="repPgnFileInput" type="file" accept=".pgn,text/plain" class="hidden" />
        </label>
      </div>
      <textarea id="repPgnTextarea" rows="4" placeholder="Paste PGN or Lichess Study export (multi-chapter, variations &amp; comments supported)..." class="w-full p-2 rounded bg-surface border border-borderSubtle font-mono text-[10.5px] focus:outline-none focus:border-cy"></textarea>
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <label class="${hasExisting ? 'inline-flex' : 'hidden'} items-center gap-1.5 text-[10.5px] text-txtMuted cursor-pointer">
          <input id="repPgnMerge" type="checkbox" class="accent-em" checked />
          <span>Merge into current repertoire (keeps SRS progress)</span>
        </label>
        <button id="btnConfirmRepPgn" class="ml-auto px-2.5 py-1 rounded bg-em hover:bg-emerald-400 text-[#041f15] font-bold text-[10.5px]">
          ${hasExisting ? 'Import &amp; Merge PGN' : 'Create Repertoire from PGN'}
        </button>
      </div>
    </div>
  `;
}

function renderAddLineDrawer(sections) {
  const tab = getActiveTab();
  const { moves } = tab ? extractPathToNode(tab.current) : { moves: [] };
  const preview = moves.length
    ? moves
        .map((m, i) => (i % 2 === 0 ? `${Math.floor(i / 2) + 1}.${m.san}` : m.san))
        .join(' ')
    : 'Play moves on the board first';
  const defaultColor = addLineDraft?.color || (state.flipped ? 'b' : 'w');
  const defaultSec = addLineDraft?.sectionName ?? sections?.[0]?.name ?? '';
  const defaultLine = addLineDraft?.lineName || '';
  const datalistOpts = (sections || [])
    .map((s) => `<option value="${escapeHtml(s.name)}"></option>`)
    .join('');

  return `
    <div id="studioRepAddLineDrawer" class="p-2.5 rounded-lg bg-[#0d1422] border border-em/40 flex flex-col gap-2 text-[11px]">
      <div class="flex items-center justify-between gap-2">
        <span class="font-bold text-em">Add Current Board Line to Repertoire</span>
        <button id="btnCloseRepDrawer" class="text-txtMuted hover:text-txt text-xs">✕</button>
      </div>
      <div class="px-2 py-1 rounded bg-surface/70 border border-borderSubtle font-mono text-[10.5px] text-txt/90 truncate" title="${escapeHtml(preview)}">
        ${escapeHtml(preview)}
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
        <select id="repAddColor" class="px-2 py-1 rounded bg-surface border border-borderSubtle text-[10.5px]">
          <option value="w"${defaultColor === 'w' ? ' selected' : ''}>Play as White</option>
          <option value="b"${defaultColor === 'b' ? ' selected' : ''}>Play as Black</option>
        </select>
        <input id="repAddSection" list="repExistingSections" type="text" placeholder="Opening (e.g. Sicilian)" value="${escapeHtml(defaultSec)}" class="px-2 py-1 rounded bg-surface border border-borderSubtle text-[10.5px] focus:outline-none focus:border-em" />
        <datalist id="repExistingSections">${datalistOpts}</datalist>
        <input id="repAddLineName" type="text" placeholder="Line name (optional)" value="${escapeHtml(defaultLine)}" class="px-2 py-1 rounded bg-surface border border-borderSubtle text-[10.5px] focus:outline-none focus:border-em" />
      </div>
      <div class="flex items-center gap-1.5">
        <input id="repAddNote" type="text" placeholder="Idea / plan note (optional; move comments are also saved)" class="flex-1 px-2 py-1 rounded bg-surface border border-borderSubtle text-[10.5px] focus:outline-none focus:border-em" />
        <button id="btnConfirmAddLine" class="px-2.5 py-1 rounded bg-em hover:bg-emerald-400 text-[#041f15] font-bold text-[10.5px] shrink-0" ${moves.length ? '' : 'disabled'}>Save Line</button>
      </div>
    </div>
  `;
}

export async function runOpponentPrepCheck({ colId = null, userColor = null } = {}) {
  if (!loadedRep?.repertoire) return;
  const targetColId =
    colId ||
    (state.collections.some((c) => c.id === prepState.colId)
      ? prepState.colId
      : state.activeScoutId || state.collections[0]?.id || '');
  const targetColor = userColor || prepState.userColor || 'both';
  prepState.colId = targetColId;
  prepState.userColor = targetColor;

  if (!targetColId) {
    prepState.loading = false;
    prepState.result = null;
    renderStudioRepertoirePanel();
    return;
  }

  const reqId = ++prepState.reqId;
  prepState.loading = true;
  prepState.weakLoading = true;
  prepState.weakSpots = null;
  renderStudioRepertoirePanel();

  const fens = collectRepertoireOpponentFens(loadedRep.repertoire, targetColor);
  const scoutPosMap = await dbLookupPositionsBatch(targetColId, fens);
  if (reqId !== prepState.reqId) return;

  prepState.loading = false;
  prepState.result = analyzeOpponentAgainstRepertoire({
    repertoire: loadedRep.repertoire,
    scoutPosMap,
    userColor: targetColor,
    progress: loadedProg,
  });
  renderStudioRepertoirePanel();

  // Their weak spots: opening moves they keep choosing and score badly with.
  let spots;
  try {
    spots = await findOpponentWeakSpots({
      lookupBatch: (keys) => dbLookupPositionsBatch(targetColId, keys),
      normalize: normalizeFen,
      maxSpots: 12,
    });
  } catch (_) {
    spots = [];
  }
  if (reqId !== prepState.reqId) return;
  prepState.weakLoading = false;
  prepState.weakSpots = targetColor === 'both' ? spots : spots.filter((sp) => sp.myColor === targetColor);
  renderStudioRepertoirePanel();
}

/** Open Opponent Prep from elsewhere (e.g. Insights → Today). */
export function openOpponentPrepDrawer() {
  if (!loadedRep?.repertoire) {
    showToast('Load your repertoire first to prep against an opponent.', true);
    return;
  }
  activeDrawer = 'prep';
  runOpponentPrepCheck();
}

function renderWeakSpotsHtml(colName) {
  if (prepState.weakLoading) {
    return `<div class="py-1 text-txtMuted font-mono text-[10px]">Looking for ${escapeHtml(colName)}'s weak spots...</div>`;
  }
  const spots = prepState.weakSpots;
  if (!spots) return '';
  if (!spots.length) {
    return `<div class="text-[10.5px] text-txtMuted">No clear weak spots yet: no opening move they chose 3+ times scores 40% or less.</div>`;
  }
  return `<div class="flex flex-col gap-1">
      <div class="text-[10px] font-semibold uppercase tracking-wider text-ro">Their weak spots (${spots.length})</div>
      <div class="divide-y divide-borderSubtle/50 rounded border border-borderSubtle bg-[#0b101b] max-h-[160px] overflow-y-auto">
        ${spots
          .map(
            (sp, i) => `
          <div class="px-2 py-1.5 flex items-center justify-between gap-2 text-[10.5px]">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 flex-wrap font-mono">
                <span class="px-1 py-[0.5px] rounded bg-ro/20 text-ro font-bold">${escapeHtml(plyMoveLabel(sp.ply, sp.moveSan))}</span>
                <span class="text-txtMuted text-[10px] truncate">after ${escapeHtml(sanPathLabel(sp.pathSans))}</span>
              </div>
              <div class="text-[9.5px] text-txtMuted font-mono mt-0.5">
                ${sp.games} games · they score ${sp.scorePct}% · you play ${sp.myColor === 'w' ? 'White' : 'Black'}
              </div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <button class="rep-weak-board px-2 py-0.5 rounded bg-surface hover:bg-surfaceHover text-txt border border-borderSubtle font-semibold text-[10px]" data-widx="${i}">Board</button>
              <button class="rep-weak-prep px-2 py-0.5 rounded bg-ro/15 hover:bg-ro/25 text-ro border border-ro/35 font-semibold text-[10px]" data-widx="${i}">Build prep</button>
            </div>
          </div>`
          )
          .join('')}
      </div>
    </div>`;
}

function weakSpotPgn(spot) {
  const sans = [...spot.pathSans, spot.moveSan];
  const movetext = sans.map((m, idx) => (idx % 2 === 0 ? `${Math.floor(idx / 2) + 1}. ${m}` : m)).join(' ');
  return `[Event "Opponent prep"]\n[Result "*"]\n\n${movetext} *`;
}

function renderPrepDrawer() {
  const cols = state.collections || [];
  if (!cols.length) {
    return `
      <div id="studioRepPrepDrawer" class="p-2.5 rounded-lg bg-[#0d1422] border border-am/40 flex flex-col gap-2 text-[11px]">
        <div class="flex items-center justify-between gap-2">
          <span class="font-bold text-am">🎯 Opponent Prep (Scout × Repertoire)</span>
          <button id="btnCloseRepDrawer" class="text-txtMuted hover:text-txt text-xs">✕</button>
        </div>
        <div class="text-txtMuted text-[11px]">
          No scouted opponent database yet. Click <b>+ Scout</b> in the Player Scout panel to sync a Lichess/Chess.com opponent or PGN, then cross-check their replies against your repertoire.
        </div>
      </div>
    `;
  }

  const activeColId = cols.some((c) => c.id === prepState.colId)
    ? prepState.colId
    : state.activeScoutId || cols[0].id;
  const activeCol = cols.find((c) => c.id === activeColId) || cols[0];
  const res = prepState.result;

  const colOpts = cols
    .map(
      (c) =>
        `<option value="${escapeHtml(c.id)}"${c.id === activeColId ? ' selected' : ''}>${escapeHtml(c.name)} (${c.gameCount})</option>`
    )
    .join('');

  let bodyHtml;
  if (prepState.loading) {
    bodyHtml = `<div class="py-3 text-center text-txtMuted font-mono text-[10.5px]">Cross-checking ${escapeHtml(activeCol.name)} against your repertoire...</div>`;
  } else if (!res || res.totalOpponentDecisions === 0) {
    bodyHtml = `<div class="py-2 text-txtMuted text-[10.5px]">No overlapping opening positions found between your repertoire and <b>${escapeHtml(activeCol.name)}</b> for this color filter.</div>`;
  } else {
    const covColor =
      res.coveragePct >= 75 ? 'text-em' : res.coveragePct >= 45 ? 'text-am' : 'text-ro';
    const drillBtn = res.drillCardIds.length
      ? `<button id="btnRepPrepDrill" class="px-2 py-0.5 rounded bg-em hover:bg-emerald-400 text-[#041f15] font-bold text-[10px]">🎯 Drill ${res.drillCardIds.length} Likely Moves ↗</button>`
      : '';

    const gapsHtml = res.gaps.length
      ? `<div class="flex flex-col gap-1">
          <div class="text-[10px] font-semibold uppercase tracking-wider text-am">Unprepared Opponent Replies (${res.gaps.length})</div>
          <div class="divide-y divide-borderSubtle/50 rounded border border-borderSubtle bg-[#0b101b] max-h-[140px] overflow-y-auto">
            ${res.gaps
              .slice(0, 10)
              .map(
                (g, i) => `
              <div class="px-2 py-1.5 flex items-center justify-between gap-2 text-[10.5px]">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5 flex-wrap font-mono">
                    <span class="px-1 py-[0.5px] rounded bg-am/20 text-am font-bold">${escapeHtml(g.moveLabel)}</span>
                    <span class="text-txtMuted text-[10px] truncate">after ${escapeHtml(g.prefixLabel)}</span>
                  </div>
                  <div class="text-[9.5px] text-txtMuted font-mono mt-0.5">
                    ${g.games} game${g.games === 1 ? '' : 's'} · Opp W${g.oppWins}/D${g.oppDraws}/L${g.oppLosses} · ${escapeHtml(g.sectionName)}
                  </div>
                </div>
                <button class="rep-prep-gap px-2 py-0.5 rounded bg-am/15 hover:bg-am/25 text-am border border-am/35 font-semibold text-[10px] shrink-0" data-gidx="${i}">Prep →</button>
              </div>
            `
              )
              .join('')}
          </div>
        </div>`
      : `<div class="px-2 py-1 rounded bg-em/10 border border-em/30 text-em text-[10.5px]">All scouted opponent replies at your repertoire positions are covered!</div>`;

    const overlapsHtml = res.overlaps.length
      ? `<div class="flex flex-col gap-1">
          <div class="text-[10px] font-semibold uppercase tracking-wider text-em">Likely Battlegrounds (${res.overlaps.length})</div>
          <div class="divide-y divide-borderSubtle/50 rounded border border-borderSubtle bg-[#0b101b] max-h-[120px] overflow-y-auto">
            ${res.overlaps
              .slice(0, 8)
              .map(
                (ov, i) => `
              <div class="px-2 py-1 flex items-center justify-between gap-2 text-[10.5px]">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <span class="font-mono font-bold text-txt">${escapeHtml(ov.line.id)}</span>
                    <span class="text-txt/90 truncate">${escapeHtml(ov.line.name)}</span>
                    ${ov.dueOrNewCards > 0 ? `<span class="px-1 rounded bg-ro/20 text-ro font-mono text-[9.5px] font-bold">${ov.dueOrNewCards} due/new</span>` : '<span class="px-1 rounded bg-em/15 text-em font-mono text-[9.5px]">Ready</span>'}
                  </div>
                  <div class="text-[9.5px] text-txtMuted font-mono">
                    ${ov.games} game${ov.games === 1 ? '' : 's'} via ${escapeHtml(ov.triggerMove)} · Opp W${ov.oppWins}/D${ov.oppDraws}/L${ov.oppLosses}
                  </div>
                </div>
                <button class="rep-prep-ov px-2 py-0.5 rounded bg-cy/15 hover:bg-cy/25 text-cy border border-cy/35 font-mono text-[10px] shrink-0" data-oidx="${i}">Load</button>
              </div>
            `
              )
              .join('')}
          </div>
        </div>`
      : '';

    bodyHtml = `
      <div class="flex flex-wrap items-center justify-between gap-2 px-2 py-1 rounded bg-surface/60 border border-borderSubtle font-mono text-[10px]">
        <div class="flex items-center gap-2 flex-wrap">
          <span>Coverage: <b class="${covColor}">${res.coveragePct}%</b> (${res.coveredDecisions}/${res.totalOpponentDecisions})</span>
          <span class="text-borderSubtle">|</span>
          <span class="text-am font-bold">${res.gaps.length} gap${res.gaps.length === 1 ? '' : 's'}</span>
          <span class="text-borderSubtle">|</span>
          <span class="text-em">${res.overlaps.length} matched line${res.overlaps.length === 1 ? '' : 's'}</span>
        </div>
        ${drillBtn}
      </div>
      ${gapsHtml}
      ${overlapsHtml}
    `;
  }

  return `
    <div id="studioRepPrepDrawer" class="p-2.5 rounded-lg bg-[#0d1422] border border-am/40 flex flex-col gap-2 text-[11px]">
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <span class="font-bold text-am">🎯 Opponent Prep (Scout × Repertoire)</span>
        <div class="flex items-center gap-1.5 flex-wrap">
          <select id="repPrepColSelect" class="max-w-[160px] px-1.5 py-0.5 rounded bg-surface border border-borderSubtle text-[10.5px] font-semibold text-em">
            ${colOpts}
          </select>
          <select id="repPrepColorSelect" class="px-1.5 py-0.5 rounded bg-surface border border-borderSubtle text-[10.5px] text-txt">
            <option value="both"${prepState.userColor === 'both' ? ' selected' : ''}>Both sides</option>
            <option value="w"${prepState.userColor === 'w' ? ' selected' : ''}>My White rep</option>
            <option value="b"${prepState.userColor === 'b' ? ' selected' : ''}>My Black rep</option>
          </select>
          <button id="btnCloseRepDrawer" class="text-txtMuted hover:text-txt text-xs">✕</button>
        </div>
      </div>
      ${bodyHtml}
      ${renderWeakSpotsHtml(activeCol.name)}
    </div>
  `;
}

function bindDrawerEvents(host) {
  const closeBtn = host.querySelector('#btnCloseRepDrawer');
  if (closeBtn) {
    closeBtn.onclick = () => {
      activeDrawer = null;
      addLineDraft = null;
      renderStudioRepertoirePanel();
    };
  }

  const pgnFile = host.querySelector('#repPgnFileInput');
  if (pgnFile) {
    pgnFile.onchange = async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        const txt = await f.text();
        const ta = host.querySelector('#repPgnTextarea');
        if (ta) ta.value = txt;
        const nameEl = host.querySelector('#repPgnName');
        if (nameEl && !nameEl.value.trim()) {
          nameEl.value = f.name.replace(/\.pgn$/i, '');
        }
      } catch (_) {
        showToast('Could not read PGN file', true);
      }
      e.target.value = '';
    };
  }

  const confirmPgn = host.querySelector('#btnConfirmRepPgn');
  if (confirmPgn) {
    confirmPgn.onclick = () => {
      const txt = host.querySelector('#repPgnTextarea')?.value || '';
      const color = host.querySelector('#repPgnColor')?.value || 'w';
      const name = host.querySelector('#repPgnName')?.value?.trim() || '';
      const merge = host.querySelector('#repPgnMerge')?.checked ?? true;
      importPgnTextIntoStudio(txt, { color, merge, name });
    };
  }

  const confirmAdd = host.querySelector('#btnConfirmAddLine');
  if (confirmAdd) {
    confirmAdd.onclick = () => {
      const color = host.querySelector('#repAddColor')?.value || 'w';
      const sectionName = host.querySelector('#repAddSection')?.value?.trim() || 'Custom Lines';
      const lineName = host.querySelector('#repAddLineName')?.value?.trim() || '';
      const note = host.querySelector('#repAddNote')?.value?.trim() || '';
      addLineDraft = null;
      saveCurrentBoardLineToRepertoire({ color, sectionName, lineName, note });
    };
  }

  const prepColSel = host.querySelector('#repPrepColSelect');
  if (prepColSel) {
    prepColSel.onchange = (e) => runOpponentPrepCheck({ colId: e.target.value });
  }
  const prepColorSel = host.querySelector('#repPrepColorSelect');
  if (prepColorSel) {
    prepColorSel.onchange = (e) => runOpponentPrepCheck({ userColor: e.target.value });
  }

  const drillBtn = host.querySelector('#btnRepPrepDrill');
  if (drillBtn && prepState.result?.drillCardIds?.length) {
    drillBtn.onclick = () => {
      const col = state.collections.find((c) => c.id === prepState.colId);
      try {
        localStorage.setItem(
          PREP_DRILL_STORAGE_KEY,
          JSON.stringify({
            opponentName: col?.name || 'Opponent',
            cardIds: prepState.result.drillCardIds,
            createdAt: Date.now(),
          })
        );
      } catch (_) {}
      window.location.href = 'repertoire.html?prep=1';
    };
  }

  if (prepState.weakSpots?.length) {
    host.querySelectorAll('.rep-weak-board').forEach((btn) => {
      btn.onclick = () => {
        const sp = prepState.weakSpots[parseInt(btn.dataset.widx, 10)];
        if (!sp) return;
        addBoardTab(`Prep vs ${plyMoveLabel(sp.ply, sp.moveSan)}`, weakSpotPgn(sp), null, { jumpEnd: true });
        showToast(`Loaded ${plyMoveLabel(sp.ply, sp.moveSan)} — their weak move`);
      };
    });
    host.querySelectorAll('.rep-weak-prep').forEach((btn) => {
      btn.onclick = () => {
        const sp = prepState.weakSpots[parseInt(btn.dataset.widx, 10)];
        if (!sp) return;
        const col = state.collections.find((c) => c.id === prepState.colId);
        openFlawRepertoireModal({
          pathSans: [...sp.pathSans, sp.moveSan],
          color: sp.myColor,
          flawedUci: '',
          flawedSan: sp.moveSan,
          flawedStats: { total: sp.games, scorePct: sp.scorePct },
          triggerType: 'opponent_reply',
          oppMove: { uci: sp.moveUci, san: sp.moveSan, ply: sp.pathSans.length },
          openingName: col ? `Prep vs ${col.name}` : 'Opponent prep',
          notify: (msg, isErr) => showToast(msg, Boolean(isErr)),
          onSaved: async () => {
            try {
              await initStudioRepertoire();
            } catch (_) {}
          },
        });
      };
    });
  }

  if (prepState.result?.gaps?.length) {
    host.querySelectorAll('.rep-prep-gap').forEach((btn) => {
      btn.onclick = () => {
        const gap = prepState.result.gaps[parseInt(btn.dataset.gidx, 10)];
        if (!gap) return;
        addLineDraft = {
          color: gap.userColor,
          sectionName: gap.sectionName,
          lineName: `vs ${gap.moveLabel}`,
        };
        activeDrawer = 'addLine';
        addBoardTab(`Prep vs ${gap.moveLabel}`, gap.pgn, null, { jumpEnd: true });
        showToast(`Loaded gap ${gap.moveLabel} — play your reply & click Save Line`);
      };
    });
  }

  if (prepState.result?.overlaps?.length) {
    host.querySelectorAll('.rep-prep-ov').forEach((btn) => {
      btn.onclick = () => {
        const ov = prepState.result.overlaps[parseInt(btn.dataset.oidx, 10)];
        if (!ov) return;
        addBoardTab(`${ov.line.id} ${ov.line.name}`, ov.pgn, null, { jumpEnd: true });
      };
    });
  }
}

/**
 * Build an acyclic move trie for one opening section (`sec`) so the entire opening
 * can be rendered as a slim, clickable chess tree.
 */
export function buildSectionMoveTree(repertoire, sec, progress = {}, now = Date.now()) {
  const firstLn = repertoire?.lines?.[sec?.lines?.[0]];
  const startFen = repertoire?.pos?.[firstLn?.pos?.[0]]?.f || START_FEN;
  const root = {
    fen: startFen,
    normFen: normalizeFen(startFen),
    pathUci: [],
    children: [],
  };

  for (const li of sec?.lines || []) {
    const ln = repertoire.lines?.[li];
    if (!ln?.uci?.length) continue;
    let cur = root;
    const pathUci = [];
    for (let p = 0; p < ln.uci.length; p++) {
      const uci = ln.uci[p];
      const san = ln.san[p];
      pathUci.push(uci);
      let child = cur.children.find((c) => c.uci === uci);
      if (!child) {
        const fromPi = ln.pos[p];
        const toPi = ln.pos[p + 1];
        const edge = repertoire.pos?.[fromPi]?.e?.find((e) => e[0] === uci);
        const flags = edge ? edge[3] : 0;
        const cardId = edge?.[5] || null;
        const card = cardId ? repertoire.cards?.[cardId] : null;
        const toFen = repertoire.pos?.[toPi]?.f || '';
        const fromFen = repertoire.pos?.[fromPi]?.f || '';
        const parts = fromFen.split(' ');
        const moveNum = parseInt(parts[5] || '1', 10) || Math.floor(p / 2) + 1;
        const turn = parts[1] === 'b' ? 'b' : 'w';
        child = {
          uci,
          san,
          moveNum,
          color: turn,
          fen: toFen,
          normFen: toFen ? normalizeFen(toFen) : '',
          mine: Boolean(flags & 1),
          isAlt: Boolean(flags & 2),
          status: cardId ? cardStatus(progress?.[cardId], now) : null,
          note: card?.n || '',
          warning: repertoire.warn?.[`${fromPi}|${uci}`] || '',
          pathUci: [...pathUci],
          children: [],
        };
        cur.children.push(child);
      }
      cur = child;
    }
  }
  return root;
}

/**
 * Merge ALL openings/lines in the repertoire into a single unified chess tree
 * (optionally filtered by user repertoire color `'w' | 'b' | 'both'`).
 */
export function buildMergedRepertoireTree(
  repertoire,
  { colorFilter = 'both', progress = {}, now = Date.now() } = {}
) {
  const secNameById = new Map((repertoire?.secs || []).map((s) => [s.id, s.name]));
  const root = {
    fen: START_FEN,
    normFen: normalizeFen(START_FEN),
    pathUci: [],
    children: [],
  };

  for (const ln of repertoire?.lines || []) {
    if (!ln?.uci?.length) continue;
    if (colorFilter !== 'both' && ln.color !== colorFilter) continue;
    const startFen = repertoire.pos?.[ln.pos[0]]?.f || START_FEN;
    if (normalizeFen(startFen) !== root.normFen) continue;

    const secName = secNameById.get(ln.sec) || ln.name || '';
    let cur = root;
    const pathUci = [];
    for (let p = 0; p < ln.uci.length; p++) {
      const uci = ln.uci[p];
      const san = ln.san[p];
      pathUci.push(uci);
      let child = cur.children.find((c) => c.uci === uci);
      const fromPi = ln.pos[p];
      const toPi = ln.pos[p + 1];
      const edge = repertoire.pos?.[fromPi]?.e?.find((e) => e[0] === uci);
      const flags = edge ? edge[3] : 0;
      const mine = Boolean(flags & 1);
      const isAlt = Boolean(flags & 2);
      const cardId = edge?.[5] || null;
      const card = cardId ? repertoire.cards?.[cardId] : null;
      if (!child) {
        const toFen = repertoire.pos?.[toPi]?.f || '';
        const fromFen = repertoire.pos?.[fromPi]?.f || '';
        const parts = fromFen.split(' ');
        const moveNum = parseInt(parts[5] || '1', 10) || Math.floor(p / 2) + 1;
        const turn = parts[1] === 'b' ? 'b' : 'w';
        child = {
          uci,
          san,
          moveNum,
          color: turn,
          fen: toFen,
          normFen: toFen ? normalizeFen(toFen) : '',
          mine,
          isAlt,
          status: cardId ? cardStatus(progress?.[cardId], now) : null,
          note: card?.n || '',
          warning: repertoire.warn?.[`${fromPi}|${uci}`] || '',
          pathUci: [...pathUci],
          secNames: secName ? [secName] : [],
          children: [],
        };
        cur.children.push(child);
      } else {
        if (mine && !child.mine) {
          child.mine = true;
          child.isAlt = isAlt;
          if (cardId) child.status = cardStatus(progress?.[cardId], now);
          if (card?.n && !child.note) child.note = card.n;
        }
        if (secName && !child.secNames.includes(secName)) {
          child.secNames.push(secName);
        }
      }
      cur = child;
    }
  }

  return root;
}

/**
 * Sync ALL prepared repertoire move arrows onto the main board when Repertoire tab is active.
 */
export function syncRepertoireBoardArrows() {
  if (state.activeHub !== 'repertoire' || !loadedRep?.repertoire) {
    if (state.repertoireArrows.length) {
      state.repertoireArrows = [];
      renderArrows();
    }
    return;
  }
  const hit = lookupRepertoirePosition(fenIndex, loadedRep.repertoire, loadedProg, getCurrentFen());
  const next = (hit?.moves || []).map((m) => ({
    uci: m.uci,
    mine: m.mine,
    isAlt: m.isAlt,
  }));
  state.repertoireArrows = next;
  renderArrows();
}

function navigateBoardToRepertoirePath(startFen, pathUcis) {
  const tab = getActiveTab();
  if (!tab) return;
  const baseFen = startFen || START_FEN;
  if (normalizeFen(tab.root.fen) !== normalizeFen(baseFen)) {
    tab.root = createNode({ fen: baseFen });
  }
  let cur = tab.root;
  const chess = new Chess(cur.fen);
  for (const uci of pathUcis) {
    if (!uci || uci.length < 4) break;
    const existing = cur.children.find((c) => c.uci === uci);
    if (existing) {
      cur = existing;
      chess.load(cur.fen);
      continue;
    }
    let m;
    try {
      m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
    } catch (_) {
      break;
    }
    if (!m) break;
    const node = createNode({
      fen: chess.fen(),
      san: m.san,
      uci: m.from + m.to + (m.promotion || ''),
      from: m.from,
      to: m.to,
      promotion: m.promotion || '',
      color: m.color,
      moveNum: cur.color === 'w' ? cur.moveNum : cur.moveNum + 1,
      parent: cur,
    });
    cur.children.push(node);
    cur = node;
  }
  tab.current = cur;
  state.selectedSq = null;
  state.legalTargets = [];
  state.hoverArrowUci = null;
  emitPositionChanged();
}

function statusDotHtml(st) {
  if (st === 'mastered') return '<span class="inline-block w-1.5 h-1.5 rounded-full bg-em ml-0.5 align-middle" title="Mastered"></span>';
  if (st === 'due') return '<span class="inline-block w-1.5 h-1.5 rounded-full bg-ro ml-0.5 align-middle" title="Due for review"></span>';
  if (st === 'learning') return '<span class="inline-block w-1.5 h-1.5 rounded-full bg-cy ml-0.5 align-middle" title="Learning"></span>';
  return '';
}

/**
 * Where the board is, in tree terms: the UCI path from the board's root and the
 * current position, so the tree can light up the exact line being looked at.
 */
function boardTreeContext() {
  const tab = getActiveTab();
  const ucis = [];
  let n = tab?.current;
  while (n && n.parent) {
    ucis.unshift(n.uci);
    n = n.parent;
  }
  const fen = getCurrentFen();
  return {
    activeNormFen: normalizeFen(fen),
    rootNormFen: tab?.root?.fen ? normalizeFen(tab.root.fen) : normalizeFen(START_FEN),
    path: ucis.join(' '),
  };
}

/** 'active' (the board position), 'path' (a move leading to it) or '' for a tree node. */
function nodeBoardState(node, treeRootNorm, ctx) {
  if (treeRootNorm === ctx.rootNormFen) {
    const p = node.pathUci.join(' ');
    if (p === ctx.path) return 'active';
    if (ctx.path.startsWith(`${p} `)) return 'path';
  }
  // Same position reached by another move order (a transposition).
  return node.normFen && node.normFen === ctx.activeNormFen ? 'active' : '';
}

/**
 * How far the board has travelled into this tree: the ply of the deepest node
 * that is the board position or on the line to it. 0 when the board is at the
 * tree's starting position, -1 when the tree is not on the board's line at all.
 */
function boardDepthInTree(root, ctx) {
  let best = root.normFen === ctx.activeNormFen ? 0 : -1;
  const stack = [...root.children];
  while (stack.length) {
    const n = stack.pop();
    if (nodeBoardState(n, root.normFen, ctx)) best = Math.max(best, n.pathUci.length);
    stack.push(...n.children);
  }
  return best;
}

function renderMoveTreeNodeHtml(node, { treeRootNorm, ctx, startFen, showNum }) {
  const where = nodeBoardState(node, treeRootNorm, ctx);
  const num = node.color === 'w' ? `${node.moveNum}.` : showNum ? `${node.moveNum}...` : '';
  const tipParts = [];
  if (node.note) tipParts.push(node.note);
  if (node.warning) tipParts.push(`⚠ ${node.warning}`);
  const titleAttr = tipParts.length ? ` title="${escapeHtml(tipParts.join(' — '))}"` : '';

  const tone =
    where === 'active'
      ? 'rep-tree-active bg-em text-[#041f15] font-bold shadow-[0_0_0_2px_rgba(16,185,129,0.35)]'
      : where === 'path'
        ? 'bg-em/15 text-txt font-semibold'
        : node.mine
          ? 'text-em/95 hover:bg-em/15 font-semibold'
          : 'text-txtMuted hover:text-txt hover:bg-surface';

  const noteDot = node.note ? `<span class="text-[8px] ${where === 'active' ? 'text-[#041f15]' : 'text-cy/80'} ml-0.5">•</span>` : '';
  return `<button class="rep-tree-move inline-flex items-center px-1 py-[1px] rounded font-mono text-[10.5px] leading-tight transition-colors ${tone}"${
    where === 'active' ? ' data-active="1" aria-current="true"' : ''
  } data-start-fen="${escapeHtml(startFen)}" data-path="${escapeHtml(node.pathUci.join(' '))}" data-uci="${escapeHtml(node.uci)}"${titleAttr}>${
    num ? `<span class="opacity-60 mr-[1px]">${num}</span>` : ''
  }${escapeHtml(node.san)}${statusDotHtml(node.status)}${noteDot}</button>`;
}

function renderSectionTreeHtml(treeRoot, ctx) {
  const startFen = treeRoot.fen;
  const treeRootNorm = treeRoot.normFen;

  function renderRun(startNode, depth, prefixGlyph) {
    const chain = [];
    let cur = startNode;
    while (cur) {
      chain.push(cur);
      if (cur.children.length === 1) {
        cur = cur.children[0];
      } else {
        break;
      }
    }

    const movesHtml = chain
      .map((n, idx) =>
        renderMoveTreeNodeHtml(n, {
          treeRootNorm,
          ctx,
          startFen,
          showNum: idx === 0 || n.color === 'w',
        })
      )
      .join(' ');

    const tail = chain[chain.length - 1];
    let subHtml = '';
    if (tail.children.length > 1) {
      const nextDepth = Math.min(depth + 1, 5);
      subHtml = tail.children
        .map((ch, idx) =>
          renderRun(ch, nextDepth, idx === tail.children.length - 1 ? '└' : '├')
        )
        .join('');
    }

    const padPx = depth * 12;
    const glyph = prefixGlyph
      ? `<span class="text-borderBright font-mono text-[10px] mr-1 select-none">${prefixGlyph}</span>`
      : '';
    return `<div style="padding-left:${padPx}px" class="py-[1.5px] flex flex-wrap items-center gap-x-0.5 gap-y-0.5">${glyph}${movesHtml}</div>${subHtml}`;
  }

  if (!treeRoot.children.length) {
    return '<div class="text-[10px] text-txtMuted px-2 py-1">No moves</div>';
  }
  if (treeRoot.children.length === 1) {
    return renderRun(treeRoot.children[0], 0, '');
  }
  return treeRoot.children
    .map((ch, idx) => renderRun(ch, 0, idx === treeRoot.children.length - 1 ? '└' : '├'))
    .join('');
}

/**
 * In or out of book along the board line: the last position on the board's path
 * that is in the repertoire, the move that left it, and what the repertoire has there.
 */
export function bookStatus(index, repertoire, progress, boardNodes) {
  if (!index || !repertoire || !boardNodes?.length) return null;
  const inBook = (n) => index.has(normalizeFen(n.fen));
  const cur = boardNodes[boardNodes.length - 1];
  if (inBook(cur)) {
    return { inBook: true, ply: boardNodes.length - 1 };
  }
  for (let i = boardNodes.length - 2; i >= 0; i--) {
    if (!inBook(boardNodes[i])) continue;
    const hit = lookupRepertoirePosition(index, repertoire, progress, boardNodes[i].fen);
    if (!hit?.moves?.length) return null; // the line simply ended; nothing was expected
    const played = boardNodes[i + 1];
    return {
      inBook: false,
      lastBookIndex: i,
      played,
      expected: hit.moves,
      yours: hit.moves.some((m) => m.mine),
    };
  }
  return null;
}

const moveLabel = (n) => (n?.san ? `${n.moveNum}${n.color === 'w' ? '.' : '...'}${n.san}` : '');

/** Keep the highlighted move visible inside the panel when the board moves. */
function scrollActiveIntoView(host, key) {
  const el = host.querySelector('.rep-tree-move[data-active]');
  if (!el || key === lastScrolledKey) return;
  lastScrolledKey = key;
  let box = el.parentElement;
  while (box && box !== document.body) {
    const oy = getComputedStyle(box).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && box.scrollHeight > box.clientHeight) break;
    box = box.parentElement;
  }
  if (!box || box === document.body) return;
  const er = el.getBoundingClientRect();
  const br = box.getBoundingClientRect();
  if (er.top >= br.top + 8 && er.bottom <= br.bottom - 8) return;
  box.scrollTop += er.top - br.top - box.clientHeight / 2 + er.height / 2;
}

export function renderStudioRepertoirePanel() {
  const host = document.getElementById('hub-repertoire');
  if (!host) return;

  if (!loadedRep?.repertoire) {
    const drawerHtml =
      activeDrawer === 'pgn'
        ? renderPgnDrawer(false)
        : activeDrawer === 'addLine'
          ? renderAddLineDrawer([])
          : '';

    host.innerHTML = `
      <div class="flex flex-col gap-2">
        <div class="p-3 rounded-lg bg-surface/50 border border-borderSubtle flex flex-col gap-2.5 text-[11.5px]">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <div class="font-bold text-txt text-xs">Your Opening Repertoire</div>
              <p class="text-txtMuted text-[11px] mt-0.5">
                Import a <code class="font-mono text-txt/90">tichess-repertoire</code> JSON, a <b>PGN / Lichess Study</b>, or save lines directly from the board.
              </p>
            </div>
            <div class="flex items-center gap-1.5 flex-wrap shrink-0">
              <button id="btnStudioRepPgnToggle" class="px-2.5 py-1 rounded bg-em hover:bg-emerald-400 text-[#041f15] font-semibold text-[11px]">
                + Import PGN / Study
              </button>
              <button id="btnStudioRepAddLine" class="px-2.5 py-1 rounded bg-cy/15 hover:bg-cy/25 text-cy border border-cy/35 font-semibold text-[11px]">
                + Save Board Line
              </button>
              <label class="px-2.5 py-1 rounded bg-surface hover:bg-surfaceHover border border-borderSubtle text-txt font-semibold text-[11px] cursor-pointer">
                Import JSON
                <input id="studioRepFileInput" type="file" accept=".json,.pgn,application/json,text/plain" class="hidden" />
              </label>
              <a href="repertoire.html" class="px-2 py-1 rounded bg-surface hover:bg-surfaceHover border border-borderSubtle text-txtMuted hover:text-txt text-[11px]">
                Trainer ↗
              </a>
            </div>
          </div>
        </div>
        ${drawerHtml}
      </div>
    `;

    const inp = host.querySelector('#studioRepFileInput');
    if (inp) {
      inp.onchange = (e) => {
        if (e.target.files?.[0]) {
          handleStudioRepertoireImport(e.target.files[0]);
          e.target.value = '';
        }
      };
    }
    const pgnBtn = host.querySelector('#btnStudioRepPgnToggle');
    if (pgnBtn) {
      pgnBtn.onclick = () => {
        activeDrawer = activeDrawer === 'pgn' ? null : 'pgn';
        renderStudioRepertoirePanel();
      };
    }
    const addBtn = host.querySelector('#btnStudioRepAddLine');
    if (addBtn) {
      addBtn.onclick = () => {
        activeDrawer = activeDrawer === 'addLine' ? null : 'addLine';
        renderStudioRepertoirePanel();
      };
    }
    bindDrawerEvents(host);
    return;
  }

  const rep = loadedRep.repertoire;
  const fen = getCurrentFen();
  const { total, sections } = summarizeRepertoire(rep, loadedProg);
  const hit = lookupRepertoirePosition(fenIndex, rep, loadedProg, fen);
  const ctx = boardTreeContext();
  const tab = getActiveTab();
  const boardNodes = [];
  for (let n = tab?.current; n; n = n.parent) boardNodes.unshift(n);
  const book = bookStatus(fenIndex, rep, loadedProg, boardNodes);
  syncRepertoireBoardArrows();

  const drawerHtml =
    activeDrawer === 'pgn'
      ? renderPgnDrawer(true)
      : activeDrawer === 'addLine'
        ? renderAddLineDrawer(sections)
        : activeDrawer === 'prep'
          ? renderPrepDrawer()
          : '';

  // Where the board stands in the repertoire, then the prepared moves from here.
  const firstNoteMove = hit?.moves?.find((m) => m.note || m.warning);
  let statusHtml = '';
  if (book && !book.inBook) {
    const expected = book.expected
      .slice(0, 3)
      .map((m) => `<b class="font-mono ${m.mine ? 'text-em' : 'text-txt'}">${escapeHtml(m.san)}</b>`)
      .join(', ');
    statusHtml = `<div class="rep-book-status flex items-center gap-2 flex-wrap px-2 py-1 rounded-md bg-am/10 border border-am/35 text-[11px]">
        <span class="w-2 h-2 rounded-full bg-am shrink-0"></span>
        <span class="text-txt">Out of your repertoire at <b class="font-mono">${escapeHtml(moveLabel(book.played))}</b>${
          expected ? ` <span class="text-txtMuted">· ${book.yours ? 'you prepared' : 'prepared replies'}: ${expected}</span>` : ''
        }</span>
        <button class="rep-back-to-book ml-auto px-1.5 py-[1px] rounded bg-surface hover:bg-surfaceHover border border-borderSubtle text-[10px] font-semibold" data-i="${book.lastBookIndex}">Back to book</button>
      </div>`;
  } else if (book?.inBook && book.ply > 0) {
    statusHtml = `<div class="rep-book-status flex items-center gap-2 px-2 py-1 rounded-md bg-em/10 border border-em/30 text-[11px]">
        <span class="w-2 h-2 rounded-full bg-em shrink-0"></span>
        <span class="text-txt min-w-0 truncate">In your repertoire${hit?.openingName ? ` · <span class="text-txtMuted">${escapeHtml(hit.openingName)}</span>` : ''}</span>
        <span class="ml-auto font-mono text-[10px] text-txtMuted shrink-0">${escapeHtml(moveLabel(boardNodes[boardNodes.length - 1]))}</span>
      </div>`;
  }
  const movesHtml = hit?.moves?.length
    ? `
      <div class="px-2 py-1 rounded-md bg-bg/70 border border-borderSubtle flex flex-col gap-1">
        <div class="flex items-center gap-1.5 flex-wrap text-[10.5px]">
          <span class="text-[10px] font-semibold uppercase tracking-wider text-txtMuted shrink-0">Next:</span>
          ${hit.moves
            .map(
              (m) => `
            <button class="rep-pos-move inline-flex items-center gap-1 px-1.5 py-[1px] rounded border text-[10.5px] font-mono transition-colors ${
              m.mine
                ? 'bg-em/15 hover:bg-em/25 text-em border-em/35 font-bold'
                : 'bg-surface hover:bg-surfaceHover text-txt border-borderSubtle'
            }" data-uci="${escapeHtml(m.uci)}" title="${escapeHtml(m.note || (m.mine ? 'Your prepared move' : 'Opponent reply'))}">
              <span>${escapeHtml(m.san)}</span>
              ${statusPill(m.status)}
            </button>
          `
            )
            .join('')}
        </div>
        ${
          firstNoteMove?.note
            ? `<div class="text-[10.5px] text-txtMuted leading-snug"><span class="font-mono font-semibold text-em">${escapeHtml(firstNoteMove.san)}:</span> ${escapeHtml(firstNoteMove.note)}</div>`
            : ''
        }
        ${
          firstNoteMove?.warning
            ? `<div class="text-[10px] text-ro leading-snug">⚠ ${escapeHtml(firstNoteMove.warning)}</div>`
            : ''
        }
      </div>
    `
    : '';

  const secById = new Map((rep.secs || []).map((s) => [s.id, s]));
  let treeBodyHtml;
  if (treeViewMode === 'merged') {
    const mergedRoot = buildMergedRepertoireTree(rep, {
      colorFilter: mergedColorFilter,
      progress: loadedProg,
    });
    const colBtn = (val, label) =>
      `<button class="rep-merged-col px-1.5 py-[1px] rounded font-mono text-[9.5px] ${
        mergedColorFilter === val
          ? 'bg-em/20 text-em font-bold'
          : 'text-txtMuted hover:text-txt'
      }" data-mcol="${val}">${label}</button>`;

    treeBodyHtml = `
      <div class="rounded-md border border-borderSubtle/80 bg-bg/60 overflow-hidden">
        <div class="flex items-center justify-between gap-2 px-2 py-1 border-b border-borderSubtle/60 bg-surface/40 text-[10px]">
          <span class="font-semibold text-txtMuted uppercase tracking-wider">Unified Prep Tree (${sections.length} openings merged)</span>
          <div class="flex items-center gap-0.5 bg-panel rounded border border-borderSubtle p-0.5">
            ${colBtn('both', 'All')}
            ${colBtn('w', '♙ White')}
            ${colBtn('b', '♟ Black')}
          </div>
        </div>
        <div class="px-2 py-1.5">${renderSectionTreeHtml(mergedRoot, ctx)}</div>
      </div>
    `;
  } else {
    // Sections follow the board: everything is open at the start, and as you play
    // only the openings that go deepest along the board's line stay open.
    const trees = new Map(
      sections.map((s) => {
        const secObj = secById.get(s.id);
        const root = secObj ? buildSectionMoveTree(rep, secObj, loadedProg) : null;
        return [s.id, { root, depth: root ? boardDepthInTree(root, ctx) : -1 }];
      })
    );
    const maxDepth = Math.max(-1, ...[...trees.values()].map((t) => t.depth));
    treeBodyHtml = `<div class="flex flex-col gap-1">${sections
      .map((s) => {
        const { root: treeRoot, depth } = trees.get(s.id);
        const follows = depth >= 0 && depth === maxDepth;
        // Sections open by themselves when the board enters them; a click overrides that.
        const isCollapsed = sectionToggles.has(s.id) ? !sectionToggles.get(s.id) : !follows;
        const treeBody = !isCollapsed && treeRoot
          ? `<div class="px-2 py-1 border-t border-borderSubtle/50 bg-bg/60">${renderSectionTreeHtml(treeRoot, ctx)}</div>`
          : '';

        return `
          <div class="rounded-md border ${follows ? 'border-em/45' : 'border-borderSubtle/80'} bg-surface/35 overflow-hidden">
            <div class="flex items-center justify-between gap-1.5 px-2 py-1 hover:bg-surface/70 text-[11px]">
              <button class="rep-sec-toggle flex items-center gap-1.5 min-w-0 flex-1 text-left" data-secid="${escapeHtml(s.id)}" data-open="${isCollapsed ? '0' : '1'}" aria-expanded="${!isCollapsed}">
                <span class="font-mono text-[10px] text-txtMuted w-3 shrink-0">${isCollapsed ? '▸' : '▾'}</span>
                <span class="text-[11px] shrink-0">${s.color === 'w' ? '♙' : '♟'}</span>
                <span class="font-semibold text-txt truncate">${escapeHtml(s.name)}</span>
                <span class="font-mono text-[9.5px] text-txtMuted shrink-0">${s.counts.mastered}/${s.counts.total}</span>
                ${s.counts.due > 0 ? `<span class="px-1 rounded bg-ro/20 text-ro font-mono text-[9px] font-bold shrink-0">${s.counts.due} due</span>` : ''}
              </button>
              ${
                s.firstLineIdx !== null
                  ? `<button class="rep-sec-load px-1.5 py-[1px] rounded bg-cy/10 hover:bg-cy/20 text-cy font-mono text-[9.5px] shrink-0" data-lidx="${s.firstLineIdx}" title="Open main line in a new tab">Tab ↗</button>`
                  : ''
              }
            </div>
            ${treeBody}
          </div>
        `;
      })
      .join('')}</div>`;
  }

  host.innerHTML = `
    <div class="flex flex-col gap-1.5">
      <div class="flex flex-wrap items-center justify-between gap-1.5 px-2 py-1 rounded-md bg-surface/50 border border-borderSubtle text-[11px]">
        <div class="flex items-center gap-2 flex-wrap min-w-0">
          <span class="font-bold text-txt truncate">${escapeHtml(loadedRep.name || 'My Repertoire')}</span>
          <span class="font-mono text-[10px] text-txtMuted">
            <span class="${total.due > 0 ? 'text-ro font-bold' : ''}">${total.due} due</span> ·
            <span class="text-em">${total.mastered}/${total.total}</span>
          </span>
          <div class="inline-flex items-center bg-panel rounded border border-borderSubtle p-0.5 text-[9.5px]">
            <button id="btnRepViewGrouped" class="px-1.5 py-[1px] rounded ${treeViewMode === 'grouped' ? 'bg-surfaceHover text-txt font-semibold' : 'text-txtMuted hover:text-txt'}">By Opening</button>
            <button id="btnRepViewMerged" class="px-1.5 py-[1px] rounded ${treeViewMode === 'merged' ? 'bg-em/20 text-em font-semibold' : 'text-txtMuted hover:text-txt'}">Merged</button>
          </div>
        </div>
        <div class="flex items-center gap-1 flex-wrap shrink-0">
          <a href="repertoire.html" class="px-2 py-0.5 rounded bg-em hover:bg-emerald-400 text-[#041f15] font-bold text-[10px]">Train ↗</a>
          <button id="btnStudioRepPrepToggle" class="px-1.5 py-0.5 rounded bg-am/15 hover:bg-am/25 text-am border border-am/35 font-semibold text-[10px]" title="Cross-check scouted opponent against your repertoire">🎯 Prep</button>
          <button id="btnStudioRepAddLine" class="px-1.5 py-0.5 rounded bg-em/15 hover:bg-em/25 text-em border border-em/35 font-semibold text-[10px]">+ Add Line</button>
          <button id="btnStudioRepPgnToggle" class="px-1.5 py-0.5 rounded bg-cy/15 hover:bg-cy/25 text-cy border border-cy/35 font-semibold text-[10px]">+ PGN</button>
          <label class="px-1.5 py-0.5 rounded bg-surface hover:bg-surfaceHover border border-borderSubtle text-txtMuted hover:text-txt text-[10px] cursor-pointer">
            JSON
            <input id="studioRepFileInput" type="file" accept=".json,.pgn,application/json,text/plain" class="hidden" />
          </label>
          <button id="btnStudioRepBackup" class="px-1.5 py-0.5 rounded bg-surface hover:bg-surfaceHover border border-borderSubtle text-txtMuted hover:text-txt text-[10px]">Back up</button>
        </div>
      </div>

      ${drawerHtml}

      ${statusHtml}

      ${movesHtml}

      ${treeBodyHtml}
    </div>
  `;
  scrollActiveIntoView(host, `${treeViewMode}|${ctx.rootNormFen}|${ctx.path}|${ctx.activeNormFen}`);

  const backBtn = host.querySelector('.rep-back-to-book');
  if (backBtn) {
    backBtn.onclick = () => {
      const target = boardNodes[Number(backBtn.dataset.i)];
      if (!target || !tab) return;
      tab.current = target;
      emitPositionChanged();
    };
  }

  const viewGroupedBtn = host.querySelector('#btnRepViewGrouped');
  if (viewGroupedBtn) {
    viewGroupedBtn.onclick = () => {
      treeViewMode = 'grouped';
      try {
        localStorage.setItem('tichess_rep_view', 'grouped');
      } catch (_) {}
      renderStudioRepertoirePanel();
    };
  }
  const viewMergedBtn = host.querySelector('#btnRepViewMerged');
  if (viewMergedBtn) {
    viewMergedBtn.onclick = () => {
      treeViewMode = 'merged';
      try {
        localStorage.setItem('tichess_rep_view', 'merged');
      } catch (_) {}
      renderStudioRepertoirePanel();
    };
  }
  host.querySelectorAll('.rep-merged-col').forEach((btn) => {
    btn.onclick = () => {
      mergedColorFilter = btn.dataset.mcol || 'both';
      renderStudioRepertoirePanel();
    };
  });

  const inp = host.querySelector('#studioRepFileInput');
  if (inp) {
    inp.onchange = (e) => {
      if (e.target.files?.[0]) {
        handleStudioRepertoireImport(e.target.files[0]);
        e.target.value = '';
      }
    };
  }
  const prepBtn = host.querySelector('#btnStudioRepPrepToggle');
  if (prepBtn) {
    prepBtn.onclick = () => {
      if (activeDrawer === 'prep') {
        activeDrawer = null;
        renderStudioRepertoirePanel();
      } else {
        activeDrawer = 'prep';
        runOpponentPrepCheck();
      }
    };
  }
  const pgnBtn = host.querySelector('#btnStudioRepPgnToggle');
  if (pgnBtn) {
    pgnBtn.onclick = () => {
      activeDrawer = activeDrawer === 'pgn' ? null : 'pgn';
      renderStudioRepertoirePanel();
    };
  }
  const addBtn = host.querySelector('#btnStudioRepAddLine');
  if (addBtn) {
    addBtn.onclick = () => {
      addLineDraft = null;
      activeDrawer = activeDrawer === 'addLine' ? null : 'addLine';
      renderStudioRepertoirePanel();
    };
  }
  const backupBtn = host.querySelector('#btnStudioRepBackup');
  if (backupBtn) backupBtn.onclick = exportStudioRepertoireBackup;

  bindDrawerEvents(host);

  host.querySelectorAll('.rep-pos-move').forEach((btn) => {
    btn.onclick = () => playMoveOnTree(btn.dataset.uci);
    btn.onmouseenter = () => {
      state.hoverArrowUci = btn.dataset.uci;
      renderArrows();
    };
    btn.onmouseleave = () => {
      state.hoverArrowUci = null;
      renderArrows();
    };
  });

  host.querySelectorAll('.rep-tree-move').forEach((btn) => {
    btn.onclick = () => {
      const pathUcis = (btn.dataset.path || '').split(/\s+/).filter(Boolean);
      navigateBoardToRepertoirePath(btn.dataset.startFen || START_FEN, pathUcis);
    };
    btn.onmouseenter = () => {
      state.hoverArrowUci = btn.dataset.uci;
      renderArrows();
    };
    btn.onmouseleave = () => {
      state.hoverArrowUci = null;
      renderArrows();
    };
  });

  host.querySelectorAll('.rep-sec-toggle').forEach((btn) => {
    btn.onclick = () => {
      const sid = btn.dataset.secid;
      sectionToggles.set(sid, btn.dataset.open !== '1');
      renderStudioRepertoirePanel();
    };
  });

  host.querySelectorAll('.rep-sec-load').forEach((btn) => {
    btn.onclick = () => {
      const ln = rep.lines?.[parseInt(btn.dataset.lidx, 10)];
      if (!ln) return;
      addBoardTab(`${ln.id} ${ln.name}`, lineToPgn(ln), null, { jumpEnd: true });
    };
  });
}
