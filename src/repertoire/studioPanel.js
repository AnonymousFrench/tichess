import {
  state,
  getActiveTab,
  getCurrentFen,
  normalizeFen,
  escapeHtml,
  showToast,
} from '../state.js';
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
import { playMoveOnTree, renderArrows } from '../board/board.js';
import { addBoardTab } from '../board/tabs.js';

let loadedRep = null; // { repertoire, name }
let loadedProg = {};
let fenIndex = new Map();
let activeDrawer = null; // null | 'pgn' | 'addLine' | 'prep'
let addLineDraft = null; // optional { color, sectionName, lineName }
let prepState = {
  colId: '',
  userColor: 'both',
  loading: false,
  result: null,
  reqId: 0,
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
  try {
    await saveRepertoire(repertoire, name);
  } catch (_) {
    showToast('Browser blocked saving repertoire to IndexedDB', true);
    return false;
  }
  await initStudioRepertoire();
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

  const drawerHtml =
    activeDrawer === 'pgn'
      ? renderPgnDrawer(true)
      : activeDrawer === 'addLine'
        ? renderAddLineDrawer(sections)
        : activeDrawer === 'prep'
          ? renderPrepDrawer()
          : '';

  const movesHtml = hit?.moves?.length
    ? `
      <div class="flex flex-col gap-1">
        <div class="flex items-center justify-between text-[10.5px]">
          <span class="font-semibold text-em">Prepared moves at this position${hit.openingName ? ` · <span class="text-txt">${escapeHtml(hit.openingName)}</span>` : ''}</span>
          <span class="text-txtMuted">Click a move to play</span>
        </div>
        <div class="divide-y divide-borderSubtle/50 rounded border border-borderSubtle overflow-hidden bg-[#0c121e]">
          ${hit.moves
            .map(
              (m) => `
            <button class="rep-pos-move w-full text-left px-2.5 py-1.5 hover:bg-surface flex items-start justify-between gap-2 text-[11px] transition-colors" data-uci="${escapeHtml(m.uci)}">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <span class="font-mono font-bold ${m.mine ? 'text-em' : 'text-txt'}">${escapeHtml(m.san)}</span>
                  <span class="px-1 py-[0.5px] rounded text-[9.5px] font-mono ${m.mine ? 'bg-em/15 text-em' : 'bg-surface text-txtMuted'}">${m.mine ? 'Your move' : 'Opponent'}</span>
                  ${m.isAlt ? '<span class="px-1 py-[0.5px] rounded bg-vi/20 text-vi text-[9.5px] font-mono">Alt</span>' : ''}
                  ${statusPill(m.status)}
                </div>
                ${m.note ? `<div class="text-[10.5px] text-txtMuted mt-0.5 leading-snug">${escapeHtml(m.note)}</div>` : ''}
                ${m.warning ? `<div class="text-[10.5px] text-ro mt-0.5 leading-snug">⚠ ${escapeHtml(m.warning)}</div>` : ''}
              </div>
              <span class="font-mono text-[10px] text-cy shrink-0 mt-0.5">Play →</span>
            </button>
          `
            )
            .join('')}
        </div>
        ${
          hit.lines.length
            ? `<div class="flex items-center gap-1 flex-wrap pt-0.5">
                <span class="text-[10px] text-txtMuted">Lines:</span>
                ${hit.lines
                  .slice(0, 8)
                  .map(
                    (ln, idx) =>
                      `<button class="rep-line-chip px-1.5 py-0.5 rounded bg-surface hover:bg-surfaceHover border border-borderSubtle text-[10px] font-mono text-txt/90" data-lidx="${idx}">${escapeHtml(ln.id)} ${escapeHtml(ln.name)}</button>`
                  )
                  .join('')}
              </div>`
            : ''
        }
      </div>
    `
    : `<div class="px-2.5 py-1.5 rounded bg-surface/40 border border-borderSubtle text-[11px] text-txtMuted">Current board position is outside your repertoire. Click <b>+ Add Line</b> to save this line, or load an opening below.</div>`;

  const sectionsHtml = sections
    .map((s) => {
      const pct = s.counts.total ? Math.round((s.counts.mastered / s.counts.total) * 100) : 0;
      return `
        <div class="px-2.5 py-1.5 rounded bg-surface/50 border border-borderSubtle flex items-center justify-between gap-2 text-[11px]">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="text-[11px]">${s.color === 'w' ? '♙' : '♟'}</span>
              <span class="font-semibold text-txt truncate">${escapeHtml(s.name)}</span>
              ${s.counts.due > 0 ? `<span class="px-1 rounded bg-ro/20 text-ro font-mono text-[9.5px] font-bold">${s.counts.due} due</span>` : ''}
            </div>
            <div class="flex items-center gap-2 mt-1">
              <div class="flex-1 h-1 rounded-full bg-panel overflow-hidden">
                <div class="h-full bg-em" style="width:${pct}%"></div>
              </div>
              <span class="font-mono text-[9.5px] text-txtMuted shrink-0">${s.counts.mastered}/${s.counts.total}</span>
            </div>
          </div>
          ${
            s.firstLineIdx !== null
              ? `<button class="rep-sec-load px-2 py-0.5 rounded bg-cy/15 hover:bg-cy/25 text-cy border border-cy/35 font-mono text-[10px] shrink-0" data-lidx="${s.firstLineIdx}">Load</button>`
              : ''
          }
        </div>
      `;
    })
    .join('');

  host.innerHTML = `
    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-[#0e1522] border border-borderSubtle text-[11px]">
        <div class="flex items-center gap-2 flex-wrap min-w-0">
          <span class="font-bold text-txt truncate">${escapeHtml(loadedRep.name || 'My Repertoire')}</span>
          <span class="font-mono text-[10px] text-txtMuted">
            <span class="${total.due > 0 ? 'text-ro font-bold' : ''}">${total.due} due</span> ·
            <span class="text-em">${total.mastered} mastered</span> / ${total.total} moves
          </span>
        </div>
        <div class="flex items-center gap-1 flex-wrap shrink-0">
          <a href="repertoire.html" class="px-2 py-0.5 rounded bg-em hover:bg-emerald-400 text-[#041f15] font-bold text-[10.5px]">Train ↗</a>
          <button id="btnStudioRepPrepToggle" class="px-2 py-0.5 rounded bg-am/15 hover:bg-am/25 text-am border border-am/35 font-semibold text-[10.5px]" title="Cross-check scouted opponent against your repertoire">🎯 Prep</button>
          <button id="btnStudioRepAddLine" class="px-2 py-0.5 rounded bg-em/15 hover:bg-em/25 text-em border border-em/35 font-semibold text-[10.5px]">+ Add Line</button>
          <button id="btnStudioRepPgnToggle" class="px-2 py-0.5 rounded bg-cy/15 hover:bg-cy/25 text-cy border border-cy/35 font-semibold text-[10.5px]">+ PGN</button>
          <label class="px-2 py-0.5 rounded bg-surface hover:bg-surfaceHover border border-borderSubtle text-txtMuted hover:text-txt text-[10.5px] cursor-pointer">
            JSON
            <input id="studioRepFileInput" type="file" accept=".json,.pgn,application/json,text/plain" class="hidden" />
          </label>
          <button id="btnStudioRepBackup" class="px-2 py-0.5 rounded bg-surface hover:bg-surfaceHover border border-borderSubtle text-txtMuted hover:text-txt text-[10.5px]">Back up</button>
        </div>
      </div>

      ${drawerHtml}

      ${movesHtml}

      <div class="flex flex-col gap-1">
        <div class="text-[10px] font-semibold uppercase tracking-wider text-txtMuted">Openings (${sections.length})</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">${sectionsHtml}</div>
      </div>
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

  if (hit?.lines?.length) {
    host.querySelectorAll('.rep-line-chip').forEach((btn) => {
      btn.onclick = () => {
        const ln = hit.lines[parseInt(btn.dataset.lidx, 10)];
        if (!ln) return;
        addBoardTab(`${ln.id} ${ln.name}`, lineToPgn(ln), null, { jumpEnd: true });
      };
    });
  }

  host.querySelectorAll('.rep-sec-load').forEach((btn) => {
    btn.onclick = () => {
      const ln = rep.lines?.[parseInt(btn.dataset.lidx, 10)];
      if (!ln) return;
      addBoardTab(`${ln.id} ${ln.name}`, lineToPgn(ln), null, { jumpEnd: true });
    };
  });
}
