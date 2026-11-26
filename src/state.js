export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function safeGetStorage(key, fallback = '') {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) || fallback : fallback;
  } catch (_) {
    return fallback;
  }
}

export const state = {
  tabs: [],
  activeTabId: '',
  flipped: false,
  showCoords: true,
  showEngineArrows: true,
  showEvalBar: true,
  evalBarSource: 'sf', // 'sf' | 'lc0'

  selectedSq: null,
  legalTargets: [],
  pendingPromotion: null,
  userHighlights: new Map(),
  userArrows: [],
  hoverArrowUci: null,

  // Top-Right Hub
  activeHub: 'live', // 'live' | 'masters' | 'scouted'
  liveAutoPoll: true,
  liveCountdown: 15,
  featuredTour: null, // Full Lichess broadcast tournament object { tour, rounds }
  liveRoundId: null,
  liveRoundName: '',
  liveRoundGames: [],
  userPinnedRound: false,
  lastTourRefreshAt: 0,
  allBroadcasts: [],
  mastersGamesCache: [],

  // Middle-Left Reference Explorer
  refSource: 'masters',
  refReqId: 0,

  // Middle-Right Player Scout
  collections: [],
  activeScoutId: '',
  scoutColor: 'both',

  // Engines
  lc0: {
    running: true,
    contempt: 0,
    mode: 'disconnected', // 'disconnected' | 'ws'
    wsUrl: safeGetStorage('cms_lc0_ws', 'ws://localhost:8080'),
    ws: null,
    lines: {},
    topArrowUci: null,
    evalWhiteCp: 0,
    evalLabel: '—',
    currentFen: '',
  },
  sf: {
    running: true,
    cloudEnabled: true,
    mode: 'init', // 'init' | 'wasm' | 'ws' | 'error'
    wsUrl: safeGetStorage('cms_sf_ws', 'ws://localhost:8081'),
    ws: null,
    worker: null,
    ready: false,
    lines: {},
    topArrowUci: null,
    evalWhiteCp: 0,
    evalLabel: '—',
    currentFen: '',
    cloudReqId: 0,
  },

  lichessToken: safeGetStorage('cms_lichess_token', ''),
};

// Event bus for position changes to avoid circular imports between modules
const positionListeners = new Set();
export function onPositionChange(fn) {
  positionListeners.add(fn);
}
export function emitPositionChanged() {
  for (const fn of positionListeners) {
    fn();
  }
}

export const getActiveTab = () => state.tabs.find((t) => t.id === state.activeTabId) || state.tabs[0];
export const getCurrentFen = () => getActiveTab()?.current.fen || START_FEN;
export const normalizeFen = (fen) => fen.split(' ').slice(0, 4).join(' ');

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

export function debounce(fn, waitMs = 250) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return debounced;
}

let toastTimer = null;
export function showToast(msg, isError = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('border-ro/60', isError);
  el.classList.toggle('border-em/50', !isError);
  el.classList.remove('translate-y-12', 'opacity-0');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('translate-y-12', 'opacity-0'), 2400);
}

export async function copyText(text, label = 'Copied to clipboard') {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      showToast(label);
      return;
    }
  } catch (_) {
    // Fallback below
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast(label);
  } catch (_) {
    showToast('Copy failed', true);
  }
  document.body.removeChild(ta);
}
