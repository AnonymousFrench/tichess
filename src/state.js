export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function safeGetStorage(key, fallback = '') {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) || fallback : fallback;
  } catch (_) {
    return fallback;
  }
}

function safeGetJsonStorage(key, fallback) {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch (_) {
    return fallback;
  }
}

export const DEFAULT_PANELS = {
  hub: true,
  explorer: true,
  scout: true,
  sf: true,
  lc0: false,
  tree: true,
};

export const state = {
  tabs: [],
  activeTabId: '',
  flipped: false,
  showCoords: true,
  showEngineArrows: true,
  showRepertoireArrows: true,
  showEvalBar: true,
  evalBarSource: 'sf', // 'sf' | 'maia' | 'hf' | 'lc0'
  engineTab: 'sf', // 'sf' | 'maia' | 'hf'

  // Configurable workspace panels
  panels: safeGetJsonStorage('tichess_panels_v1', DEFAULT_PANELS),

  selectedSq: null,
  legalTargets: [],
  pendingPromotion: null,
  userHighlights: new Map(),
  userArrows: [],
  repertoireArrows: [], // [{ uci, mine, isAlt }]
  hoverArrowUci: null,

  // Top-Right Hub
  activeHub: 'live', // 'live' | 'masters' | 'scouted' | 'repertoire'
  liveAutoPoll: true,
  liveCountdown: 15,
  liveView: 'events', // 'events' (list of events) | 'event' (one event: rounds and games)
  liveStatus: 'loading', // events list: 'loading' | 'ok' | 'error'
  liveSections: { live: [], ongoing: [], upcoming: [], recent: [] },
  liveSearch: { q: '', results: [], loading: false },
  lastEventsRefreshAt: 0,
  featuredTour: null, // The event being viewed: Lichess broadcast tournament { tour, rounds }
  liveRoundId: null,
  liveRoundName: '',
  liveRoundGames: [],
  liveRoundLoading: false,
  userPinnedRound: false,
  lastTourRefreshAt: 0,
  allBroadcasts: [],
  mastersGamesCache: [],

  // Middle-Left Reference Explorer
  refSource: 'masters',
  refPlayerColor: 'white',
  refPlayerSince: '3m', // '' | '1m' | '3m' | '6m' | '12m'
  refPlayerMax: '200', // '50' | '100' | '200' | '500' | 'all'
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
    // Lines shown (MultiPV) and in-browser search depth (0 = until stopped)
    multiPv: Math.min(5, Math.max(1, Number(safeGetJsonStorage('tichess_sf_opts', { multiPv: 3 }).multiPv) || 3)),
    depth: (() => {
      const d = Number(safeGetJsonStorage('tichess_sf_opts', { depth: 18 }).depth);
      return Number.isInteger(d) && d >= 0 && d <= 60 ? d : 18;
    })(),
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
  hf: {
    enabled: false,
    running: true,
    useClocks: true,
    showArrows: true,
    showWhatIf: false,
    serverUrl: safeGetStorage('tichess_hf_api_url', ''),
    loading: false,
    error: '',
    currentFen: '',
    result: null,
    hoverCandidateUci: null,
    whatIfOverride: null, // null = auto from active game, or { white_elo, black_elo, clk_white_s, clk_black_s, tc_category, tc_initial_s, tc_increment_s, has_move40 }
    reqId: 0,
  },
  maia: (() => {
    const saved = safeGetJsonStorage('tichess_maia_opts_v1', {
      eloWhite: 1500,
      eloBlack: 1500,
      syncElos: true,
    });
    const clampElo = (v) => Math.max(1000, Math.min(2200, Math.round((Number(v) || 1500) / 50) * 50));
    const ew = clampElo(saved.eloWhite);
    const eb = saved.syncElos !== false ? ew : clampElo(saved.eloBlack);
    return {
      enabled: false,
      running: true,
      status: 'idle', // 'idle' | 'downloading' | 'initializing' | 'ready' | 'error'
      progressPct: 0,
      eloWhite: ew,
      eloBlack: eb,
      syncElos: saved.syncElos !== false,
      showArrows: true,
      error: '',
      currentFen: '',
      result: null,
      hoverCandidateUci: null,
      reqId: 0,
    };
  })(),

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
