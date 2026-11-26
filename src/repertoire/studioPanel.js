import {
  state,
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
  loadRepertoire,
  saveRepertoire,
  loadProgress,
  saveProgress,
} from './storage.js';
import { playMoveOnTree, renderArrows } from '../board/board.js';
import { addBoardTab } from '../board/tabs.js';

let loadedRep = null; // { repertoire, name }
let loadedProg = {};
let fenIndex = new Map();

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

export async function handleStudioRepertoireImport(file) {
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch (_) {
    showToast('Could not read repertoire file', true);
    return;
  }
  const parsed = parseRepertoireFile(text);
  if (!parsed.ok) {
    showToast(parsed.error || 'Invalid repertoire file', true);
    return;
  }
  const merged = mergeProgress(loadProgress(), parsed.progress);
  if (!saveProgress(merged)) {
    showToast('Browser blocked saving repertoire progress', true);
    return;
  }
  try {
    await saveRepertoire(parsed.repertoire, parsed.name);
  } catch (_) {
    showToast('Browser blocked saving repertoire to IndexedDB', true);
    return;
  }
  await initStudioRepertoire();
  showToast(`Imported repertoire${parsed.name ? `: ${parsed.name}` : ''}`);
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

export function renderStudioRepertoirePanel() {
  const host = document.getElementById('hub-repertoire');
  if (!host) return;

  if (!loadedRep?.repertoire) {
    host.innerHTML = `
      <div class="p-3 rounded-lg bg-surface/50 border border-borderSubtle flex flex-col gap-2.5 text-[11.5px]">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <div class="font-bold text-txt text-xs">Your Opening Repertoire</div>
            <p class="text-txtMuted text-[11px] mt-0.5">
              Import your private <code class="font-mono text-txt/90">tichess-repertoire</code> JSON file to see prepared moves, notes, and lines live as you browse positions here — or train them with spaced repetition.
            </p>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <label class="px-2.5 py-1 rounded bg-em hover:bg-emerald-400 text-[#041f15] font-semibold text-[11px] cursor-pointer">
              Import Repertoire JSON
              <input id="studioRepFileInput" type="file" accept=".json,application/json" class="hidden" />
            </label>
            <a href="repertoire.html" class="px-2.5 py-1 rounded bg-cy/15 hover:bg-cy/25 text-cy border border-cy/35 font-semibold text-[11px]">
              Open Trainer ↗
            </a>
          </div>
        </div>
      </div>
    `;
    const inp = document.getElementById('studioRepFileInput');
    if (inp) {
      inp.onchange = (e) => {
        if (e.target.files?.[0]) {
          handleStudioRepertoireImport(e.target.files[0]);
          e.target.value = '';
        }
      };
    }
    return;
  }

  const rep = loadedRep.repertoire;
  const fen = getCurrentFen();
  const { total, sections } = summarizeRepertoire(rep, loadedProg);
  const hit = lookupRepertoirePosition(fenIndex, rep, loadedProg, fen);

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
    : `<div class="px-2.5 py-1.5 rounded bg-surface/40 border border-borderSubtle text-[11px] text-txtMuted">Current board position is outside your repertoire. Click any opening below to load a line, or navigate back to book.</div>`;

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
        <div class="flex items-center gap-1.5 shrink-0">
          <a href="repertoire.html" class="px-2 py-0.5 rounded bg-em hover:bg-emerald-400 text-[#041f15] font-bold text-[10.5px]">Train ↗</a>
          <label class="px-2 py-0.5 rounded bg-surface hover:bg-surfaceHover border border-borderSubtle text-txtMuted hover:text-txt text-[10.5px] cursor-pointer">
            Import
            <input id="studioRepFileInput" type="file" accept=".json,application/json" class="hidden" />
          </label>
          <button id="btnStudioRepBackup" class="px-2 py-0.5 rounded bg-surface hover:bg-surfaceHover border border-borderSubtle text-txtMuted hover:text-txt text-[10.5px]">Back up</button>
        </div>
      </div>

      ${movesHtml}

      <div class="flex flex-col gap-1">
        <div class="text-[10px] font-semibold uppercase tracking-wider text-txtMuted">Openings (${sections.length})</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">${sectionsHtml}</div>
      </div>
    </div>
  `;

  const inp = document.getElementById('studioRepFileInput');
  if (inp) {
    inp.onchange = (e) => {
      if (e.target.files?.[0]) {
        handleStudioRepertoireImport(e.target.files[0]);
        e.target.value = '';
      }
    };
  }
  const backupBtn = document.getElementById('btnStudioRepBackup');
  if (backupBtn) backupBtn.onclick = exportStudioRepertoireBackup;

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
