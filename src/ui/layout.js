/**
 * Flexible Studio workspace: panels live in dock rows (one under the board,
 * three in the right column). Users can drag a panel's grip onto another
 * panel to swap them or onto a row's "+" strip to move it, resize the board
 * column and the right-column rows with splitters, pick a layout preset and
 * a board theme. Everything persists in localStorage.
 */
import { state, DEFAULT_PANELS } from '../state.js';

const LAYOUT_KEY = 'tichess_layout_v1';
export const PANEL_KEYS = ['hub', 'explorer', 'scout', 'sf', 'lc0', 'tree'];
const ROW_IDS = ['below', 'r1', 'r2', 'r3'];
const RIGHT_ROWS = ['r1', 'r2', 'r3'];
const MAX_PER_ROW = 3;
const MIN_LEFT = 300;
const MIN_RIGHT = 340;

export const PANEL_LABELS = {
  hub: 'Live & Games Hub',
  explorer: 'Opening Explorer',
  scout: 'Player Scout',
  sf: 'Stockfish',
  lc0: 'Lc0 Bridge',
  tree: 'Variation Tree',
};

export const DEFAULT_LAYOUT = {
  rows: { below: ['tree'], r1: ['hub'], r2: ['explorer', 'scout'], r3: ['lc0', 'sf'] },
  weights: { r1: 1.25, r2: 1, r3: 1 },
  leftW: null, // px; null = fit the board to the screen height
  boardTheme: 'slate',
};

export const PRESETS = {
  prep: {
    label: 'Prep',
    hint: 'Explorer, scout, engine and games',
    panels: { hub: true, explorer: true, scout: true, sf: true, lc0: false, tree: true },
    rows: { below: ['tree'], r1: ['hub'], r2: ['explorer', 'scout'], r3: ['lc0', 'sf'] },
    weights: { r1: 1.25, r2: 1, r3: 1 },
  },
  analysis: {
    label: 'Analysis',
    hint: 'Big engine, explorer and notation',
    panels: { hub: false, explorer: true, scout: false, sf: true, lc0: false, tree: true },
    rows: { below: ['tree'], r1: ['sf', 'lc0'], r2: ['explorer', 'scout'], r3: ['hub'] },
    weights: { r1: 1.3, r2: 1, r3: 1 },
  },
  broadcast: {
    label: 'Broadcast',
    hint: 'Live games first, engine alongside',
    panels: { hub: true, explorer: false, scout: false, sf: true, lc0: false, tree: true },
    rows: { below: ['tree'], r1: ['hub'], r2: ['sf', 'lc0'], r3: ['explorer', 'scout'] },
    weights: { r1: 1.6, r2: 1, r3: 1 },
  },
  focus: {
    label: 'Focus',
    hint: 'Just the board and your notes',
    panels: { hub: false, explorer: false, scout: false, sf: false, lc0: false, tree: true },
    rows: { below: ['tree'], r1: ['hub'], r2: ['explorer', 'scout'], r3: ['lc0', 'sf'] },
    weights: { r1: 1.25, r2: 1, r3: 1 },
  },
};

export const BOARD_THEMES = {
  slate: { label: 'Slate', light: '#dce3ea', dark: '#708499', lastLight: '#cadc88', lastDark: '#88a45c' },
  green: { label: 'Green', light: '#eeeed2', dark: '#769656', lastLight: '#f5f682', lastDark: '#b9ca43' },
  brown: { label: 'Wood', light: '#f0d9b5', dark: '#b58863', lastLight: '#cdd26a', lastDark: '#aaa23a' },
  blue: { label: 'Blue', light: '#dee3e6', dark: '#8ca2ad', lastLight: '#c3d887', lastDark: '#92b166' },
  graphite: { label: 'Graphite', light: '#c9ccd3', dark: '#5f6675', lastLight: '#b9c98a', lastDark: '#7f9554' },
};

/** Keep a stored layout valid: every panel exactly once, rows within limits. */
export function normalizeLayout(raw) {
  const out = structuredClone(DEFAULT_LAYOUT);
  if (!raw || typeof raw !== 'object') return out;
  const seen = new Set();
  const rows = {};
  for (const id of ROW_IDS) {
    const list = Array.isArray(raw.rows?.[id]) ? raw.rows[id] : [];
    rows[id] = [];
    for (const k of list) {
      if (PANEL_KEYS.includes(k) && !seen.has(k) && rows[id].length < MAX_PER_ROW) {
        rows[id].push(k);
        seen.add(k);
      }
    }
  }
  // Anything missing goes back to its default row (or the first row with room).
  for (const k of PANEL_KEYS) {
    if (seen.has(k)) continue;
    const home = ROW_IDS.find((id) => DEFAULT_LAYOUT.rows[id].includes(k));
    const target = rows[home].length < MAX_PER_ROW ? home : ROW_IDS.find((id) => rows[id].length < MAX_PER_ROW);
    rows[target].push(k);
  }
  out.rows = rows;
  for (const id of RIGHT_ROWS) {
    const w = Number(raw.weights?.[id]);
    if (Number.isFinite(w) && w > 0.05 && w < 20) out.weights[id] = w;
  }
  const lw = Number(raw.leftW);
  out.leftW = Number.isFinite(lw) && lw >= MIN_LEFT ? Math.round(lw) : null;
  if (BOARD_THEMES[raw.boardTheme]) out.boardTheme = raw.boardTheme;
  return out;
}

/** Swap two panels wherever they are; returns a new rows object. */
export function swapPanels(rows, a, b) {
  const next = structuredClone(rows);
  let pa = null;
  let pb = null;
  for (const id of ROW_IDS) {
    const ia = next[id].indexOf(a);
    const ib = next[id].indexOf(b);
    if (ia >= 0) pa = [id, ia];
    if (ib >= 0) pb = [id, ib];
  }
  if (!pa || !pb || a === b) return next;
  next[pa[0]][pa[1]] = b;
  next[pb[0]][pb[1]] = a;
  return next;
}

/** Move a panel to the end of a row (if the row has room). */
export function movePanelToRow(rows, key, rowId) {
  const next = structuredClone(rows);
  if (!ROW_IDS.includes(rowId)) return next;
  const from = ROW_IDS.find((id) => next[id].includes(key));
  if (!from || from === rowId || next[rowId].length >= MAX_PER_ROW) return next;
  next[from] = next[from].filter((k) => k !== key);
  next[rowId].push(key);
  return next;
}

function loadLayout() {
  try {
    return normalizeLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'));
  } catch (_) {
    return structuredClone(DEFAULT_LAYOUT);
  }
}

export const layout = loadLayout();

function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch (_) {
    /* ignore */
  }
}

const $ = (id) => document.getElementById(id);
const panelEl = (k) => document.querySelector(`[data-dock="${k}"]`);
const rowEl = (id) => document.querySelector(`[data-row="${id}"]`);
const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;

/** Place panels into their rows, hide empty rows, set row weights and splitters. */
export function applyDockLayout() {
  const p = state.panels;
  for (const id of ROW_IDS) {
    const row = rowEl(id);
    if (!row) continue;
    for (const k of layout.rows[id]) {
      const el = panelEl(k);
      if (el && el.parentElement !== row) row.appendChild(el);
      if (el) row.appendChild(el); // keep order
    }
    const visible = layout.rows[id].filter((k) => p[k]);
    row.classList.toggle('hidden', visible.length === 0);
    if (id !== 'below') row.style.setProperty('--w', String(layout.weights[id] || 1));
    ensureAppendStrip(row);
  }
  for (const k of PANEL_KEYS) panelEl(k)?.classList.toggle('hidden', !p[k]);

  // Row splitters between visible right rows.
  const right = $('rightWorkspaceCol');
  right?.querySelectorAll('.studio-splitter-h').forEach((s) => s.remove());
  const visRows = RIGHT_ROWS.map(rowEl).filter((r) => r && !r.classList.contains('hidden'));
  for (let i = 1; i < visRows.length; i++) {
    const sp = document.createElement('div');
    sp.className = 'studio-splitter-h';
    sp.setAttribute('role', 'separator');
    sp.setAttribute('aria-orientation', 'horizontal');
    sp.title = 'Drag to resize · double-click to even out';
    sp.dataset.above = visRows[i - 1].dataset.row;
    sp.dataset.below = visRows[i].dataset.row;
    visRows[i].before(sp);
  }

  const anyRight = visRows.length > 0;
  document.body.classList.toggle('studio-no-right', !anyRight);
  $('panelsEmptyNotice')?.classList.add('hidden');
  const belowVisible = !rowEl('below')?.classList.contains('hidden');
  document.body.classList.toggle('studio-no-below', !belowVisible);

  document.querySelectorAll('[data-panel-chk]').forEach((el) => {
    el.textContent = p[el.dataset.panelChk] ? '✓' : '';
  });
  ensureGrips();
  fitBoard();
}

function ensureAppendStrip(row) {
  if (row.querySelector(':scope > .dock-append')) {
    row.appendChild(row.querySelector(':scope > .dock-append'));
    return;
  }
  const strip = document.createElement('div');
  strip.className = 'dock-append';
  strip.dataset.appendRow = row.dataset.row;
  strip.title = 'Drop here to move the panel into this row';
  strip.textContent = '+';
  row.appendChild(strip);
}

function ensureGrips() {
  for (const k of PANEL_KEYS) {
    const el = panelEl(k);
    const header = el?.firstElementChild;
    if (!header || header.querySelector('.panel-grip')) continue;
    // Put the grip inside the header's left group so justified layouts stay intact.
    const head = header.children.length > 1 ? header.firstElementChild : header;
    const grip = document.createElement('span');
    grip.className = 'panel-grip';
    grip.draggable = true;
    grip.dataset.grip = k;
    grip.title = `Drag to move ${PANEL_LABELS[k]}`;
    grip.setAttribute('aria-hidden', 'true');
    grip.textContent = '⠿';
    head.prepend(grip);
  }
}

/* ------------------------------------------------------------------ */
/* Board fitting                                                       */
/* ------------------------------------------------------------------ */

/** Size the board to the space available and the board column to the board. */
export function fitBoard() {
  const left = $('leftCol');
  const wrap = document.querySelector('.studio-board-wrap');
  const boardPanel = wrap?.closest('.bg-panel');
  const main = $('studioMain');
  if (!left || !wrap || !boardPanel || !main) return;
  if (!isDesktop()) {
    left.style.removeProperty('--left-w');
    document.documentElement.style.removeProperty('--board-max-h');
    document.documentElement.style.removeProperty('--board-size');
    return;
  }
  const belowVisible = !document.body.classList.contains('studio-no-below');
  const nonBoard = boardPanel.offsetHeight - wrap.offsetHeight;
  const avail = Math.max(240, left.clientHeight - nonBoard - (belowVisible ? 156 : 0));
  document.documentElement.style.setProperty('--board-max-h', `${Math.floor(avail)}px`);

  const mainW = main.clientWidth;
  const noRight = document.body.classList.contains('studio-no-right');
  // Eval bar + gap + panel padding and borders around the board.
  const evalBar = $('evalBarContainer');
  const chrome = (evalBar && evalBar.offsetParent ? evalBar.offsetWidth + 6 : 0) + 22;
  let w;
  if (noRight) {
    w = mainW;
    left.style.setProperty('--left-w', '100%');
  } else {
    const fit = Math.min(mainW * 0.62, avail + chrome);
    const want = layout.leftW ?? fit;
    w = Math.max(MIN_LEFT, Math.min(want, mainW - MIN_RIGHT));
    left.style.setProperty('--left-w', `${Math.round(w)}px`);
  }
  const size = Math.floor(Math.max(200, Math.min(w - chrome, avail)));
  document.documentElement.style.setProperty('--board-size', `${size}px`);
}

/** Bigger/smaller board steps from the View menu or keyboard. */
export function nudgeBoard(deltaPx) {
  const left = $('leftCol');
  const board = $('chessboard');
  if (!left || !board) return true;
  const before = board.getBoundingClientRect().width;
  layout.leftW = Math.max(MIN_LEFT, Math.round(left.getBoundingClientRect().width + deltaPx));
  saveLayout();
  fitBoard();
  return board.getBoundingClientRect().width !== before;
}

export function fitBoardToScreen() {
  layout.leftW = null;
  saveLayout();
  fitBoard();
}

/* ------------------------------------------------------------------ */
/* Splitters                                                           */
/* ------------------------------------------------------------------ */

function startDrag(e, onMove, onEnd, cursor) {
  e.preventDefault();
  const target = e.currentTarget;
  target.classList.add('dragging');
  document.body.style.cursor = cursor;
  document.body.classList.add('studio-resizing');
  const move = (ev) => onMove(ev);
  const up = () => {
    target.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.classList.remove('studio-resizing');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    onEnd?.();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function initSplitters() {
  const col = $('colSplitter');
  col?.addEventListener('pointerdown', (e) => {
    const left = $('leftCol');
    const startX = e.clientX;
    const startW = left.getBoundingClientRect().width;
    startDrag(
      e,
      (ev) => {
        layout.leftW = Math.round(startW + ev.clientX - startX);
        fitBoard();
      },
      saveLayout,
      'col-resize'
    );
  });
  col?.addEventListener('dblclick', fitBoardToScreen);
  col?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      nudgeBoard(e.key === 'ArrowRight' ? 24 : -24);
    }
  });

  $('rightWorkspaceCol')?.addEventListener('pointerdown', (e) => {
    const sp = e.target.closest('.studio-splitter-h');
    if (!sp) return;
    const a = rowEl(sp.dataset.above);
    const b = rowEl(sp.dataset.below);
    const ha = a.getBoundingClientRect().height;
    const hb = b.getBoundingClientRect().height;
    const wa = layout.weights[sp.dataset.above];
    const wb = layout.weights[sp.dataset.below];
    const startY = e.clientY;
    const MIN = 90;
    Object.defineProperty(e, 'currentTarget', { value: sp });
    startDrag(
      e,
      (ev) => {
        const dy = Math.max(MIN - ha, Math.min(hb - MIN, ev.clientY - startY));
        const total = wa + wb;
        layout.weights[sp.dataset.above] = (total * (ha + dy)) / (ha + hb);
        layout.weights[sp.dataset.below] = (total * (hb - dy)) / (ha + hb);
        a.style.setProperty('--w', String(layout.weights[sp.dataset.above]));
        b.style.setProperty('--w', String(layout.weights[sp.dataset.below]));
      },
      saveLayout,
      'row-resize'
    );
  });
  $('rightWorkspaceCol')?.addEventListener('dblclick', (e) => {
    const sp = e.target.closest('.studio-splitter-h');
    if (!sp) return;
    const avg = (layout.weights[sp.dataset.above] + layout.weights[sp.dataset.below]) / 2;
    layout.weights[sp.dataset.above] = avg;
    layout.weights[sp.dataset.below] = avg;
    saveLayout();
    applyDockLayout();
  });

  let raf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(fitBoard);
  });
}

/* ------------------------------------------------------------------ */
/* Drag panels to rearrange                                            */
/* ------------------------------------------------------------------ */

function initPanelDrag(onChange) {
  let dragging = null;
  document.addEventListener('dragstart', (e) => {
    const grip = e.target.closest?.('[data-grip]');
    if (!grip) return;
    dragging = grip.dataset.grip;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragging);
    const panel = panelEl(dragging);
    if (panel) e.dataTransfer.setDragImage(panel, 20, 14);
    requestAnimationFrame(() => document.body.classList.add('dock-dragging'));
  });
  const clear = () => {
    document.querySelectorAll('.dock-drop-target, .dock-append.over').forEach((el) => el.classList.remove('dock-drop-target', 'over'));
  };
  document.addEventListener('dragend', () => {
    dragging = null;
    document.body.classList.remove('dock-dragging');
    clear();
  });
  document.addEventListener('dragover', (e) => {
    if (!dragging) return;
    const strip = e.target.closest?.('.dock-append');
    const panel = e.target.closest?.('[data-dock]');
    if (!strip && !panel) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clear();
    if (strip) strip.classList.add('over');
    else if (panel.dataset.dock !== dragging) panel.classList.add('dock-drop-target');
  });
  document.addEventListener('drop', (e) => {
    if (!dragging) return;
    const strip = e.target.closest?.('.dock-append');
    const panel = e.target.closest?.('[data-dock]');
    e.preventDefault();
    if (strip) layout.rows = movePanelToRow(layout.rows, dragging, strip.dataset.appendRow);
    else if (panel && panel.dataset.dock !== dragging) layout.rows = swapPanels(layout.rows, dragging, panel.dataset.dock);
    dragging = null;
    document.body.classList.remove('dock-dragging');
    clear();
    saveLayout();
    onChange();
  });
}

/* ------------------------------------------------------------------ */
/* Presets and themes                                                  */
/* ------------------------------------------------------------------ */

export function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  state.panels = { ...DEFAULT_PANELS, ...preset.panels };
  layout.rows = structuredClone(preset.rows);
  layout.weights = { ...preset.weights };
  layout.leftW = null;
  saveLayout();
}

export function resetLayout() {
  state.panels = { ...DEFAULT_PANELS };
  const theme = layout.boardTheme;
  Object.assign(layout, structuredClone(DEFAULT_LAYOUT), { boardTheme: theme });
  saveLayout();
}

export function setBoardTheme(name) {
  const t = BOARD_THEMES[name];
  if (!t) return;
  layout.boardTheme = name;
  const root = document.documentElement.style;
  root.setProperty('--sq-light', t.light);
  root.setProperty('--sq-dark', t.dark);
  root.setProperty('--sq-last-light', t.lastLight);
  root.setProperty('--sq-last-dark', t.lastDark);
  document.querySelectorAll('[data-theme-chk]').forEach((el) => {
    el.textContent = el.dataset.themeChk === name ? '✓' : '';
  });
  saveLayout();
}

/** Wire splitters, panel dragging and the initial theme. `onChange` re-applies the layout. */
export function initLayout(onChange) {
  initSplitters();
  initPanelDrag(onChange);
  setBoardTheme(layout.boardTheme);
  if (typeof ResizeObserver !== 'undefined') {
    let pending = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(fitBoard);
    });
    const left = $('leftCol');
    if (left) ro.observe(left);
  }
}
