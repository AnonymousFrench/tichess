/**
 * Insights page controller: accounts, syncing, filters, tabs and actions.
 */
import { Chess } from 'chess.js';
import { filterGames, PERIODS, previousPeriodGames } from './stats.js';
import { TC_LABEL, TIME_CONTROLS, parsePgnGames, guessPgnOwner, normalizePgnGame, TERM_LABEL } from './normalize.js';
import {
  loadAllGames,
  putGames,
  deleteAccountGames,
  loadAccounts,
  saveAccounts,
  loadAllAnalyses,
  putAnalyses,
  deleteAnalyses,
} from './store.js';
import { syncLichess, syncChessCom, RateLimitError } from './sync.js';
import { esc, fmtInt } from './charts.js';
import {
  renderOverview,
  renderGames,
  renderOpenings,
  renderOpponents,
  renderProgress,
  filterGamesTab,
  replay,
  relTime,
  movesText,
} from './views.js';
import { renderCoach } from './coachView.js';
import { buildLichessGameAnalysis, compareRepertoireToGames } from './coach.js';
import { scanGamesWithStockfish } from './scanner.js';
import { fetchPeerBenchmark, clearBenchmarkCache } from './benchmark.js';
import { loadDrillProgress, saveDrillProgress, recordDrillOutcome, checkDrillAttempt } from './drills.js';
import { loadRepertoire } from '../repertoire/storage.js';
import { encodeMoveLine } from '../chess/shareUrl.js';
import { initCloudSync, onCloudSyncState, getCloudSyncState, getLoginUrl } from '../sync/cloudSync.js';
import { mountAccount } from '../shared/account.js';
import {
  pullInsightsFromServer,
  addCloudInsightsSource,
  removeCloudInsightsSource,
  uploadGamesToCloud,
  runBackgroundInsightsSync,
} from './cloudInsights.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PREFS_KEY = 'tichess_insights_ui_v1';
const AUTO_SYNC_AFTER_MS = 10 * 60_000;

const TABS = [
  ['overview', 'Overview'],
  ['coach', 'Coach'],
  ['openings', 'Openings'],
  ['games', 'Games'],
  ['opponents', 'Opponents'],
  ['progress', 'Progress'],
];
// Views that were merged: old saved tabs and links land on their new home.
const TAB_ALIAS = { explorer: 'openings', rating: 'progress', activity: 'progress' };
const AUTO_ADDED_KEY = 'tichess_insights_auto_added_v1';

const $ = (id) => document.getElementById(id);

const DEFAULT_UI = {
  tab: 'overview',
  filters: { tc: 'all', color: 'all', period: '12m', rated: 'all', opp: 'all', account: 'all' },
  games: { outcome: 'all', term: 'all', sort: 'new', search: '', limit: 50, day: '', prefix: '', pcolor: '' },
  explorer: { color: 'w', path: [], fullPath: [], flipped: null },
  openings: { sort: 'played', group: 'family', min: 5 },
  activity: { years: 3 },
  rating: { tc: '', range: '365' },
  coach: { sub: 'plan', scanCount: 25, phase: '', benchIdx: 0, drillTag: 'all', excluded: [] },
};

function loadUi() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    const ui = structuredClone(DEFAULT_UI);
    for (const k of Object.keys(ui)) {
      if (raw[k] && typeof ui[k] === 'object') Object.assign(ui[k], raw[k]);
      else if (raw[k] !== undefined) ui[k] = raw[k];
    }
    ui.games.limit = 50;
    ui.tab = TAB_ALIAS[ui.tab] || ui.tab;
    if (!TABS.some(([id]) => id === ui.tab)) ui.tab = 'overview';
    return ui;
  } catch (_) {
    return structuredClone(DEFAULT_UI);
  }
}

const INSIGHTS_PIN_KEY = 'tichess_insights_pin_board_v1';
function loadInsightsPin() {
  try {
    const v = localStorage.getItem(INSIGHTS_PIN_KEY);
    if (v === '0' || v === 'false') return false;
  } catch (_) {}
  return true;
}

const S = {
  games: new Map(), // id → record
  analyses: new Map(), // id → cached engine analysis
  list: [],
  accounts: [],
  ui: loadUi(),
  takeaways: [],
  sync: null, // { label, fetched, total, unit, startedAt }
  syncCtrl: null,
  lastSyncError: '',
  version: 0,
  filteredKey: '',
  filtered: [],
  prev: null,
  moreOpen: false,
  exSel: null,
  exPinned: loadInsightsPin(),
  repertoire: null,
  repDiffKey: '',
  repertoireDiff: null,
  scan: null,
  scanCtrl: null,
  coachData: null,
  coachDeck: null,
  benchmark: null,
  benchCtrl: null,
  drillProgress: loadDrillProgress(),
  drill: { cardId: '', selected: null, status: 'playing', hint: false, lastBad: null, solvedFen: '', nextBox: 0, failedOnce: false },
};

function saveUi() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(S.ui));
  } catch (_) {
    /* private mode */
  }
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

let toastTimer = 0;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `fixed bottom-3 left-1/2 -translate-x-1/2 z-50 px-3 py-2 rounded-lg bg-panel border shadow-2xl text-[12px] font-medium transition-all duration-200 ${
    isError ? 'border-ro/60 text-ro' : 'border-em/50 text-txt'
  }`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className += ' opacity-0 pointer-events-none translate-y-3';
  }, isError ? 5500 : 3200);
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

function ingestLichessEvals(records) {
  const fresh = [];
  for (const r of records) {
    if (!r?.evals?.length || S.analyses.has(r.id)) continue;
    const analysis = buildLichessGameAnalysis(r);
    if (analysis) {
      S.analyses.set(r.id, analysis);
      fresh.push(analysis);
    }
  }
  if (fresh.length) putAnalyses(fresh).catch(() => {});
}

function addRecords(records) {
  for (const r of records) S.games.set(r.id, r);
  S.list = [...S.games.values()];
  S.version++;
  ingestLichessEvals(records);
}

const accountKey = (a) => `${a.src}:${a.name.toLowerCase()}`;

function accountGamesCount(a) {
  const key = a.name.toLowerCase();
  let n = 0;
  for (const g of S.list) if (g.src === a.src && g.acct === key) n++;
  return n;
}

function filterSpec() {
  const f = S.ui.filters;
  return {
    tc: f.tc === 'all' ? [] : [f.tc],
    color: f.color,
    period: f.period,
    rated: f.rated,
    opp: f.opp,
    accounts: f.account === 'all' ? [] : [f.account],
  };
}

function currentFiltered() {
  const f = S.ui.filters;
  const key = `${S.version}|${JSON.stringify(f)}`;
  if (key !== S.filteredKey) {
    S.filtered = filterGames(S.list, filterSpec());
    S.prev = previousPeriodGames(S.list, filterSpec());
    S.filteredKey = key;
  }
  return S.filtered;
}

const SECONDARY_FILTERS = ['opp', 'rated', 'account'];

/* ------------------------------------------------------------------ */
/* Header: accounts and sync status                                   */
/* ------------------------------------------------------------------ */

function renderHeader() {
  const right = $('hdrRight');
  const banner = $('syncBanner');
  if (!S.accounts.length) {
    right.innerHTML = '';
    if (banner) {
      banner.hidden = true;
      banner.innerHTML = '';
    }
    $('syncBar').hidden = true;
    return;
  }
  let status;
  if (S.sync) {
    const { fetched, total, unit } = S.sync;
    const elapsed = (Date.now() - S.sync.startedAt) / 1000;
    let eta = '';
    if (total && fetched > 50 && unit !== 'months') {
      const rate = fetched / Math.max(1, elapsed);
      const left = Math.max(0, total - fetched) / Math.max(1, rate);
      eta = left > 90 ? ` · ~${Math.round(left / 60)} min left` : left > 5 ? ` · ${Math.round(left)} s left` : '';
    }
    const amount = total
      ? `${fmtInt(fetched)} / ${fmtInt(total)}${unit === 'months' ? ' months' : ''}`
      : fetched
        ? `${fmtInt(fetched)} games`
        : 'Connecting…';
    status = `<span class="hidden sm:flex items-center gap-1.5 text-[11px] text-txtMuted min-w-0"><span class="w-2 h-2 rounded-full bg-em animate-pulse shrink-0"></span><span>${esc(S.sync.label)}</span> <span class="font-mono truncate">${amount}${eta}</span></span>
      <button data-act="stop-sync" class="hidden sm:inline-flex px-2 py-1 rounded-lg bg-surface hover:bg-surfaceHover border border-borderSubtle text-[11px]">Stop</button>`;
    if (banner) {
      banner.hidden = false;
      banner.innerHTML = `<span class="flex items-center gap-1.5 text-txtMuted min-w-0"><span class="w-2 h-2 rounded-full bg-em animate-pulse shrink-0"></span><span class="truncate">${esc(S.sync.label)}</span> <span class="font-mono shrink-0 text-txt">${amount}</span></span>
        <button data-act="stop-sync" class="px-2 py-0.5 rounded-md bg-surface hover:bg-surfaceHover border border-borderSubtle text-[10.5px] font-semibold shrink-0">Stop</button>`;
    }
  } else {
    const last = Math.max(0, ...S.accounts.map((a) => a.lastSync || 0));
    status = `<span class="hidden sm:inline text-[11px] text-txtMuted">${last ? `Updated ${esc(relTime(last))}` : 'Not synced yet'}</span>
      <button data-act="sync" class="px-2 py-1 sm:px-2.5 rounded-lg bg-surface hover:bg-surfaceHover border border-borderSubtle text-[11px] font-semibold whitespace-nowrap" title="Download new games" aria-label="Sync">↻<span class="hidden sm:inline"> Sync</span></button>`;
    if (banner) {
      banner.hidden = true;
      banner.innerHTML = '';
    }
  }
  // What is being analyzed (games and where they come from), not who is signed in:
  // the account itself is the shared control next to this.
  const names = S.accounts.map((a) => a.name);
  const n = S.list.length;
  const short = n >= 10_000 ? `${Math.round(n / 1000)}k` : fmtInt(n);
  right.innerHTML = `${status}
    <button data-act="accounts" class="flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-lg bg-surface hover:bg-surfaceHover border border-borderSubtle text-[11.5px] font-semibold min-w-0 shrink-0" aria-haspopup="dialog" aria-label="Game sources: ${esc(names.join(', '))}" title="Games from ${esc(names.join(', '))}. Add or remove accounts and files.">
      <svg class="w-3.5 h-3.5 shrink-0 text-txtMuted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>
      <span class="font-mono">${short}</span><span class="hidden sm:inline">games</span><span class="text-txtMuted text-[10px]">▾</span>
    </button>`;
  const bar = $('syncBar');
  if (S.sync && S.sync.total) {
    bar.hidden = false;
    $('syncBarFill').style.width = `${Math.min(100, (S.sync.fetched / S.sync.total) * 100).toFixed(1)}%`;
  } else {
    bar.hidden = true;
  }
}

/* ------------------------------------------------------------------ */
/* Toolbar: tabs + filters                                            */
/* ------------------------------------------------------------------ */

function segmented(key, items, value, label) {
  return `<div class="inline-flex p-0.5 rounded-lg bg-surface border border-borderSubtle text-[11px] shrink-0" role="group" aria-label="${label}">${items
    .map(
      ([v, l]) =>
        `<button data-act="set-filter" data-k="${key}" data-v="${esc(v)}" aria-pressed="${value === v}" class="px-2 py-0.5 rounded-md font-semibold whitespace-nowrap ${value === v ? 'bg-txt text-bg' : 'text-txtMuted hover:text-txt'}">${esc(l)}</button>`
    )
    .join('')}</div>`;
}

function renderToolbar() {
  const tb = $('toolbar');
  if (!S.accounts.length) {
    tb.hidden = true;
    return;
  }
  tb.hidden = false;
  const tcsPresent = TIME_CONTROLS.filter((tc) => S.list.some((g) => g.tc === tc));
  const f = S.ui.filters;
  const moreCount = SECONDARY_FILTERS.filter((k) => f[k] !== 'all').length;
  const anyFilter = Object.entries(f).some(([k, v]) => v !== DEFAULT_UI.filters[k]);
  tb.innerHTML = `<div class="max-w-[1400px] mx-auto px-3 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
    <nav class="flex items-center gap-0.5 overflow-x-auto -mx-1 px-1 max-w-full" aria-label="Insights views">${TABS.map(
      ([id, label]) =>
        `<button data-act="tab" data-v="${id}" class="px-2 sm:px-2.5 py-1 rounded-lg text-[12px] font-semibold whitespace-nowrap ${
          S.ui.tab === id ? 'bg-surface text-txt border border-borderBright' : 'text-txtMuted hover:text-txt border border-transparent'
        }" ${S.ui.tab === id ? 'aria-current="page"' : ''}>${label}</button>`
    ).join('')}</nav>
    <div class="flex items-center gap-1.5 overflow-x-auto max-w-full -mx-1 px-1 lg:mx-0 lg:px-0 lg:ml-auto">
      ${tcsPresent.length > 1 ? segmented('tc', [['all', 'All'], ...tcsPresent.map((t) => [t, TC_LABEL[t]])], f.tc, 'Time control') : ''}
      ${segmented('color', [['all', 'Both'], ['w', 'White'], ['b', 'Black']], f.color, 'Color')}
      <label class="sr-only" for="flt-period">Period</label>
      <select id="flt-period" data-act="filter" data-k="period" class="shrink-0 px-2 py-1 rounded-lg border text-[11.5px] font-medium focus:outline-none focus:border-em bg-surface border-borderSubtle text-txt">${Object.entries(PERIODS)
        .map(([k, v]) => `<option value="${k}"${k === f.period ? ' selected' : ''}>${esc(v.label)}</option>`)
        .join('')}</select>
      <button id="btnMoreFilters" data-act="more-filters" aria-haspopup="dialog" class="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg border text-[11.5px] font-medium ${
        moreCount ? 'bg-em/15 border-em/40 text-em' : 'bg-surface border-borderSubtle text-txt hover:bg-surfaceHover'
      }">Filters${moreCount ? ` <span class="font-mono">${moreCount}</span>` : ''}</button>
      ${anyFilter ? '<button data-act="clear-filters" class="shrink-0 text-[11px] text-txtMuted hover:text-txt underline">Reset</button>' : ''}
    </div>
  </div>`;
}

function openMoreFilters() {
  const f = S.ui.filters;
  const btn = $('btnMoreFilters');
  const r = btn?.getBoundingClientRect();
  const sel = (k, opts, label) =>
    `<label class="grid gap-1 text-[11px] text-txtMuted">${label}<select id="flt-${k}" data-act="filter" data-k="${k}" class="px-2 py-1.5 rounded-lg border text-[12px] focus:outline-none focus:border-em ${
      f[k] !== 'all' ? 'bg-em/15 border-em/40 text-em' : 'bg-surface border-borderSubtle text-txt'
    }">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === f[k] ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  const right = r ? Math.max(12, window.innerWidth - r.right) : 12;
  const top = r ? r.bottom + 6 : 100;
  $('popover').innerHTML = `<div class="fixed inset-0 z-40" data-act="close-popover"></div>
    <div class="fixed z-50 w-[min(280px,calc(100vw-24px))] bg-panel border border-borderBright rounded-xl shadow-2xl p-3 grid gap-2.5" style="top:${top}px;right:${right}px" role="dialog" aria-label="More filters">
      ${sel('opp', [['all', 'Any opponent'], ['higher', 'Stronger (50+ above you)'], ['similar', 'Similar rating'], ['lower', 'Weaker (50+ below you)']], 'Opponent strength')}
      ${sel('rated', [['all', 'Rated and casual'], ['rated', 'Rated only'], ['casual', 'Casual only']], 'Rated')}
      ${S.accounts.length > 1 ? sel('account', [['all', 'All accounts'], ...S.accounts.map((a) => [accountKey(a), a.name])], 'Account') : ''}
    </div>`;
  S.moreOpen = true;
}

/* ------------------------------------------------------------------ */
/* Main view                                                           */
/* ------------------------------------------------------------------ */

function renderOnboarding(prefill = '') {
  const auth = getCloudSyncState();
  const signedIn = Boolean(auth.authenticated && auth.user);
  const quick = signedIn
    ? `<button data-act="add-lichess" data-name="${esc(auth.user.username)}" class="w-full px-4 py-2.5 rounded-lg bg-em hover:brightness-110 text-[#04130d] font-bold text-[13.5px]">Analyze my Lichess games (${esc(auth.user.username)})</button>
       <div class="text-center text-[11px] text-txtMuted my-2.5">or another account</div>`
    : auth.configured
      ? `<a href="${esc(getLoginUrl())}" class="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg bg-txt hover:bg-white text-bg font-bold text-[13.5px]"><span aria-hidden="true">♞</span>Sign in with Lichess</a>
         <p class="text-[11px] text-txtMuted text-center mt-1.5">One sign-in for Insights, the Studio and your repertoire.</p>
         <div class="text-center text-[11px] text-txtMuted my-2.5">or type any username</div>`
      : '';
  $('view').innerHTML = `<div class="max-w-[560px] mx-auto mt-6 sm:mt-14">
    <div class="bg-panel border border-borderSubtle rounded-2xl p-5 sm:p-6">
      <div class="text-[11px] font-semibold uppercase tracking-wider text-em mb-1">Insights</div>
      <h1 class="text-[22px] font-bold leading-tight mb-1.5">See how you really play</h1>
      <p class="text-[12.5px] text-txtMuted mb-4">Your strongest and weakest openings, how you do against stronger players, when you play best, and where your rating is heading.</p>
      ${quick}
      <form data-act="add-account-form" class="grid gap-2">
        <div class="flex flex-wrap gap-2">
          <select name="src" class="px-2.5 py-2 rounded-lg bg-surface border border-borderSubtle text-[16px] sm:text-[12.5px] focus:outline-none focus:border-em" aria-label="Site">
            <option value="lichess">Lichess</option><option value="chesscom">Chess.com</option>
          </select>
          <input name="name" required value="${esc(signedIn ? '' : prefill)}" placeholder="Username" autocomplete="username" autocapitalize="off" spellcheck="false" class="flex-1 min-w-[140px] px-3 py-2 rounded-lg bg-surface border border-borderSubtle text-[16px] sm:text-[13px] focus:outline-none focus:border-em" aria-label="Username">
          <button class="w-full sm:w-auto px-4 py-2 rounded-lg ${signedIn || auth.configured ? 'bg-surface hover:bg-surfaceHover border border-borderSubtle text-txt' : 'bg-em hover:brightness-110 text-[#04130d]'} font-bold text-[13px]">Analyze</button>
        </div>
      </form>
      <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-txtMuted">
        <span>Games are stored only in this browser.</span>
        <button data-act="import-pgn" class="text-cy hover:underline">Or import a PGN file</button>
      </div>
    </div>
    <p class="text-[11px] text-txtMuted text-center mt-3">Large accounts take a few minutes the first time. Results fill in as games arrive, and later syncs only fetch new games.</p>
  </div>`;
}

function syncStatusText(sync) {
  if (!sync) return '';
  if (sync.total) {
    return `${fmtInt(sync.fetched)} / ${fmtInt(sync.total)}${sync.unit === 'months' ? ' months' : ' games'}`;
  }
  return sync.fetched ? `${fmtInt(sync.fetched)} ${sync.unit === 'months' ? 'months' : 'games'}` : 'Connecting…';
}

function updateEmptySyncProgress() {
  const countEl = $('syncViewCount');
  if (countEl && S.sync) countEl.textContent = syncStatusText(S.sync);
  const barEl = $('syncViewBar');
  if (barEl && S.sync?.total) {
    barEl.style.width = `${Math.min(100, (S.sync.fetched / S.sync.total) * 100).toFixed(1)}%`;
  }
}

function render() {
  renderHeader();
  renderToolbar();
  if (!S.accounts.length) {
    if (!$('view').querySelector('[data-act="add-account-form"]')) renderOnboarding('');
    return;
  }
  const games = currentFiltered();
  if (!S.list.length) {
    if (S.sync) {
      const pct = S.sync.total ? Math.min(100, (S.sync.fetched / S.sync.total) * 100).toFixed(1) : '8';
      $('view').innerHTML = `<div class="max-w-[440px] mx-auto my-12 bg-panel border border-borderSubtle rounded-2xl p-5 text-center grid gap-3">
        <div class="inline-flex items-center justify-center gap-2 text-[13px] font-semibold text-txt">
          <span class="w-2.5 h-2.5 rounded-full bg-em animate-pulse"></span>
          <span>Downloading ${esc(S.sync.label)}</span>
        </div>
        <div id="syncViewCount" class="font-mono text-[12px] text-txtMuted">${esc(syncStatusText(S.sync))}</div>
        <div class="h-1.5 rounded-full bg-surface overflow-hidden"><div id="syncViewBar" class="h-full bg-em transition-all duration-200" style="width:${pct}%"></div></div>
        <p class="text-[11px] text-txtMuted">Results appear as soon as the first games arrive.</p>
      </div>`;
    } else {
      $('view').innerHTML = `<div class="max-w-[460px] mx-auto my-12 bg-panel border border-borderSubtle rounded-2xl p-5 text-center grid gap-3">
        <div class="text-[13px] font-semibold text-txt">No games downloaded yet</div>
        ${
          S.lastSyncError
            ? `<p class="text-[12px] text-ro bg-ro/10 border border-ro/30 rounded-lg px-3 py-2">${esc(S.lastSyncError)}</p>`
            : '<p class="text-[12px] text-txtMuted">Press Sync to download games for your linked accounts.</p>'
        }
        <div class="flex items-center justify-center gap-2 pt-1">
          <button data-act="sync" class="px-4 py-1.5 rounded-lg bg-em hover:brightness-110 text-[#04130d] font-bold text-[12px]">↻ Sync now</button>
          <button data-act="import-pgn" class="px-3 py-1.5 rounded-lg bg-surface hover:bg-surfaceHover border border-borderSubtle text-[12px] text-txtMuted hover:text-txt">Import PGN</button>
        </div>
      </div>`;
    }
    return;
  }
  document.body.classList.toggle('insights-board-pinned', S.exPinned);
  if (S.ui.tab === 'coach' && S.repertoire && S.repDiffKey !== S.filteredKey) {
    S.repertoireDiff = compareRepertoireToGames(S.repertoire, games);
    S.repDiffKey = S.filteredKey;
  }
  const ctx = {
    games,
    prevGames: S.prev,
    all: S.list,
    now: Date.now(),
    ui: S.ui,
    exSel: S.exSel,
    exPinned: S.exPinned,
    profiles: S.accounts.map((a) => ({ name: a.name, src: a.src, perfs: a.perfs })),
    analyses: S.analyses,
    analysesCount: S.analyses.size,
    repertoireDiff: S.repertoireDiff,
    scan: S.scan,
    benchmark: S.benchmark,
    drill: S.drill,
    drillProgress: S.drillProgress,
    setTakeaways: (t) => {
      S.takeaways = t;
    },
    setCoachData: (d) => {
      S.coachData = d;
    },
    setCoachDeck: (deck) => {
      S.coachDeck = deck;
    },
  };
  const renderers = {
    overview: renderOverview,
    coach: renderCoach,
    openings: renderOpenings,
    games: renderGames,
    opponents: renderOpponents,
    progress: renderProgress,
  };
  const scrollY = window.scrollY;
  const active = document.activeElement;
  const keepSearch = active?.dataset?.act === 'games-search' ? active.selectionStart : null;
  $('view').innerHTML = (renderers[S.ui.tab] || renderOverview)(ctx);
  if (keepSearch !== null) {
    const input = $('view').querySelector('[data-act="games-search"]');
    if (input) {
      input.focus();
      input.setSelectionRange(keepSearch, keepSearch);
    }
  }
  window.scrollTo(0, scrollY);
  if (S.ui.tab === 'coach' && S.ui.coach.sub === 'drills') {
    ensureBenchmarkLoaded();
  }
}

let renderQueued = false;
let lastSyncRender = 0;
function scheduleRender({ throttle = false } = {}) {
  if (throttle) {
    const now = Date.now();
    if (now - lastSyncRender < 1500) {
      renderHeader();
      return;
    }
    lastSyncRender = now;
  }
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

/* ------------------------------------------------------------------ */
/* Accounts and sync                                                   */
/* ------------------------------------------------------------------ */

async function persistAccounts() {
  await saveAccounts(S.accounts.map((a) => ({ ...a })));
}

function isCloudAuthenticated() {
  return Boolean(getCloudSyncState().authenticated);
}

function applyServerSources(mergedAccounts) {
  if (!Array.isArray(mergedAccounts)) return;
  S.accounts = mergedAccounts;
  renderHeader();
}

function applyPulledBatch(records) {
  if (!records?.length) return;
  const wasEmpty = S.list.length === 0;
  addRecords(records);
  if (wasEmpty && S.list.length > 0) {
    lastSyncRender = Date.now();
    scheduleRender({ throttle: false });
  } else {
    scheduleRender({ throttle: true });
  }
}

async function addAccount(src, name) {
  name = name.trim();
  if (!name) return;
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(name)) {
    toast('Usernames use only letters, numbers, - and _.', true);
    return;
  }
  if (S.accounts.some((a) => a.src === src && a.name.toLowerCase() === name.toLowerCase())) {
    toast('That account is already added.');
    return;
  }
  S.lastSyncError = '';
  S.accounts.push({ src, name, addedAt: Date.now() });
  await persistAccounts();
  closePopover();

  if (isCloudAuthenticated()) {
    const added = await addCloudInsightsSource(src, name).catch(() => ({ ok: false }));
    if (added?.ok && added.source?.cachedCount > 0) {
      toast(`Loading ${fmtInt(added.source.cachedCount)} cached games for ${name}…`);
    }
    runSync({ force: true, source: { src, name } });
    return;
  }
  runSync();
}

async function removeAccount(key) {
  const a = S.accounts.find((x) => accountKey(x) === key);
  if (!a) return;
  const scopeMsg = isCloudAuthenticated()
    ? `Remove ${a.name} from your Insights sources?`
    : `Remove ${a.name} and delete its ${fmtInt(accountGamesCount(a))} downloaded games from this browser?`;
  if (!window.confirm(scopeMsg)) return;
  if (S.sync) stopSync();
  if (S.scan) stopCoachScan();
  S.accounts = S.accounts.filter((x) => x !== a);
  await persistAccounts();
  await deleteAccountGames(a.src, a.name.toLowerCase());
  if (isCloudAuthenticated()) {
    await removeCloudInsightsSource(a.src, a.name).catch(() => {});
  }
  const removedIds = [];
  for (const [id, g] of S.games) {
    if (g.src === a.src && g.acct === a.name.toLowerCase()) {
      S.games.delete(id);
      S.analyses.delete(id);
      removedIds.push(id);
    }
  }
  if (removedIds.length) deleteAnalyses(removedIds).catch(() => {});
  S.list = [...S.games.values()];
  S.version++;
  if (S.ui.filters.account === key) S.ui.filters.account = 'all';
  closePopover();
  render();
}

/* ------------------------------------------------------------------ */
/* Coach: Stockfish batch scan, +100 Elo benchmark, blunder drills     */
/* ------------------------------------------------------------------ */

function stopCoachScan() {
  S.scanCtrl?.abort();
}

async function startCoachScan() {
  if (S.scan) return;
  const filtered = currentFiltered();
  const limit = Number(S.ui.coach.scanCount) || 25;
  const queue = [...filtered]
    .sort((a, b) => b.t - a.t)
    .filter((g) => g.moves && !S.analyses.has(g.id))
    .slice(0, limit);
  if (!queue.length) {
    toast('All recent games in this selection are already analyzed.');
    return;
  }
  const ctrl = new AbortController();
  S.scanCtrl = ctrl;
  S.scan = { gameIdx: 0, totalGames: queue.length, plyIdx: 0, totalPlies: 1, opp: queue[0].op };
  render();
  let scanned = 0;
  try {
    const res = await scanGamesWithStockfish(queue, {
      depth: 10,
      signal: ctrl.signal,
      onProgress: (p) => {
        S.scan = p;
        scheduleRender();
      },
      onGameDone: async (analysis) => {
        S.analyses.set(analysis.id, analysis);
        await putAnalyses([analysis]).catch(() => {});
        scanned++;
        scheduleRender();
      },
    });
    scanned = res.scanned;
    if (!ctrl.signal.aborted) {
      toast(`Analyzed ${fmtInt(scanned)} game${scanned === 1 ? '' : 's'} with Stockfish`);
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      toast(`Scan stopped (${fmtInt(scanned)} analyzed).`);
    } else {
      toast(`Stockfish scan failed: ${err?.message || err}`, true);
    }
  } finally {
    S.scan = null;
    S.scanCtrl = null;
    render();
  }
}

async function ensureBenchmarkLoaded(force = false) {
  const cliffs = S.coachData?.cliffs;
  if (!cliffs?.length) return;
  const idx = Math.min(cliffs.length - 1, Math.max(0, S.ui.coach.benchIdx || 0));
  const cliff = cliffs[idx];
  const rating = S.coachData?.plan?.currentRating || 1500;
  const tc = S.ui.filters.tc || 'all';
  const key = `${cliff.fen}|${rating}|${tc}|${cliff.color}`;
  if (!force && S.benchmark?.key === key) return;

  S.benchCtrl?.abort();
  const ctrl = new AbortController();
  S.benchCtrl = ctrl;
  S.benchmark = { key, loading: true };
  if (force) {
    clearBenchmarkCache();
    render();
  }
  try {
    const result = await fetchPeerBenchmark(cliff.fen, { rating, tc, color: cliff.color, signal: ctrl.signal });
    if (ctrl.signal.aborted || S.benchCtrl !== ctrl) return;
    S.benchmark = { key, loading: false, ...result };
    if (S.ui.tab === 'coach' && S.ui.coach.sub === 'drills') render();
  } catch (err) {
    if (err?.name !== 'AbortError') {
      S.benchmark = { key, loading: false, status: 'error', message: err?.message || 'Explorer failed.' };
      if (S.ui.tab === 'coach' && S.ui.coach.sub === 'drills') render();
    }
  }
}

function resetDrill(cardId = '') {
  S.drill = {
    cardId,
    selected: null,
    status: 'playing',
    hint: false,
    lastBad: null,
    solvedFen: '',
    nextBox: 0,
    failedOnce: false,
  };
}

function activeDrillCard() {
  const cards = S.coachDeck?.cards || [];
  if (!cards.length) return null;
  return cards.find((c) => c.id === S.drill.cardId) || cards[0];
}

function handleDrillSquare(sq) {
  const card = activeDrillCard();
  if (!card || S.drill.status === 'solved') return;
  let chess;
  try {
    chess = new Chess(card.fenBefore);
  } catch (_) {
    return;
  }
  const turn = chess.turn();
  const piece = chess.get(sq);
  const isOwnPiece = Boolean(piece && piece.color === turn);

  if (!S.drill.selected) {
    if (isOwnPiece) {
      S.drill.selected = sq;
      S.drill.status = 'playing';
      S.drill.lastBad = null;
      render();
    }
    return;
  }
  if (S.drill.selected === sq) {
    S.drill.selected = null;
    render();
    return;
  }
  if (isOwnPiece) {
    S.drill.selected = sq;
    S.drill.status = 'playing';
    S.drill.lastBad = null;
    render();
    return;
  }

  const res = checkDrillAttempt(card, S.drill.selected, sq);
  if (!res.legal) {
    S.drill.selected = null;
    render();
    return;
  }

  if (res.correct) {
    const cleanSolve = !S.drill.failedOnce && !S.drill.hint;
    S.drillProgress = recordDrillOutcome(S.drillProgress, card.id, cleanSolve);
    saveDrillProgress(S.drillProgress);
    S.drill = {
      ...S.drill,
      cardId: card.id,
      selected: null,
      status: 'solved',
      solvedFen: res.fenAfter,
      nextBox: S.drillProgress[card.id]?.box || 0,
      lastBad: null,
    };
  } else {
    if (!S.drill.failedOnce) {
      S.drillProgress = recordDrillOutcome(S.drillProgress, card.id, false);
      saveDrillProgress(S.drillProgress);
    }
    S.drill = {
      ...S.drill,
      cardId: card.id,
      selected: null,
      status: 'wrong',
      lastBad: sq,
      failedOnce: true,
    };
  }
  render();
}

function stopSync() {
  S.syncCtrl?.abort();
}

async function runSync({ force = false, source = null } = {}) {
  if (S.sync) return;
  const targets = S.accounts.filter((a) => a.src === 'lichess' || a.src === 'chesscom');
  if (!targets.length) return;
  const ctrl = new AbortController();
  S.syncCtrl = ctrl;
  S.lastSyncError = '';
  const before = S.games.size;

  // When signed in (Lichess OAuth or manual Lichess token), run resumable server-side
  // Neon sync slices so games are saved to Postgres and shared across devices/users.
  if (isCloudAuthenticated()) {
    let fellBack = false;
    try {
      const first = source || targets[0];
      S.sync = {
        label: `${first.src === 'lichess' ? 'Lichess' : 'Chess.com'} · ${first.name}`,
        fetched: 0,
        total: first.total || 0,
        unit: 'games',
        startedAt: Date.now(),
      };
      if (!S.list.length) render();
      else renderHeader();

      const res = await runBackgroundInsightsSync({
        force,
        source,
        foreground: true,
        maxSlices: 16,
        signal: ctrl.signal,
        onSources: (merged) => applyServerSources(merged),
        onBatch: (recs) => applyPulledBatch(recs),
        onProgress: (p) => {
          if (!S.sync) return;
          Object.assign(S.sync, {
            label: p.label || S.sync.label,
            fetched: p.fetched ?? S.sync.fetched,
            total: p.total ?? S.sync.total,
            unit: 'games',
          });
          renderHeader();
          if (!S.list.length) updateEmptySyncProgress();
        },
      });

      if (res.status === 503 || res.status === 401 || res.status === 404) {
        fellBack = true;
      } else if (res.aborted) {
        toast('Sync paused. Background sync continues where it stopped.');
      } else if (res.error) {
        S.lastSyncError = res.error;
        toast(res.error, true);
      } else {
        const added = S.games.size - before;
        toast(added ? `${fmtInt(added)} new game${added === 1 ? '' : 's'} synced` : 'You are up to date');
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        toast('Sync paused. Background sync continues where it stopped.');
      } else {
        fellBack = true;
      }
    } finally {
      if (!fellBack) {
        S.sync = null;
        S.syncCtrl = null;
        await persistAccounts().catch(() => {});
        render();
      }
    }
    if (!fellBack) return;
  }

  try {
    for (const acct of targets) {
      S.sync = { label: `${acct.src === 'lichess' ? 'Lichess' : 'Chess.com'} · ${acct.name}`, fetched: 0, total: 0, unit: 'games', startedAt: Date.now() };
      if (!S.list.length) render();
      else renderHeader();
      const save = async (records) => {
        const wasEmpty = S.list.length === 0;
        await putGames(records);
        addRecords(records);
        if (wasEmpty && S.list.length > 0) {
          lastSyncRender = Date.now();
          scheduleRender({ throttle: false });
        } else {
          scheduleRender({ throttle: true });
        }
      };
      const onProgress = (p) => {
        Object.assign(S.sync, p);
        renderHeader();
        if (!S.list.length) updateEmptySyncProgress();
      };
      const opts = { signal: ctrl.signal, save, saveMeta: persistAccounts, onProgress };
      if (acct.src === 'lichess') await syncLichess(acct, opts);
      else await syncChessCom(acct, opts);
    }
    const added = S.games.size - before;
    toast(added ? `${fmtInt(added)} new game${added === 1 ? '' : 's'} added` : 'You are up to date');
  } catch (err) {
    if (err?.name === 'AbortError') {
      toast('Sync paused. It continues where it stopped next time.');
    } else if (err instanceof RateLimitError) {
      S.lastSyncError = err.message;
      toast(err.message, true);
    } else if (err?.status === 404) {
      S.lastSyncError = 'Player not found. Check the username.';
      toast(S.lastSyncError, true);
    } else {
      S.lastSyncError = `Sync stopped: ${err?.message || err}`;
      toast(S.lastSyncError, true);
    }
  } finally {
    S.sync = null;
    S.syncCtrl = null;
    await persistAccounts().catch(() => {});
    render();
  }
}

/* ------------------------------------------------------------------ */
/* Popovers                                                            */
/* ------------------------------------------------------------------ */

function closePopover() {
  $('popover').innerHTML = '';
}

function openAccounts() {
  const rows = S.accounts
    .map((a) => {
      const n = accountGamesCount(a);
      const cloud = isCloudAuthenticated();
      const state =
        a.src === 'pgn'
          ? cloud
            ? 'Imported · cloud saved'
            : 'Imported file'
          : a.complete
            ? `${cloud ? 'Cloud synced' : 'Synced'} ${a.lastSync ? relTime(a.lastSync) : ''}`
            : cloud
              ? 'Syncing in background'
              : 'Partly downloaded';
      return `<div class="flex items-center gap-2 py-2 border-t border-borderSubtle/60 first:border-0">
        <span class="px-1.5 py-0.5 rounded text-[9.5px] font-bold ${a.src === 'lichess' ? 'bg-txt/10 text-txt' : a.src === 'chesscom' ? 'bg-em/15 text-em' : 'bg-cy/15 text-cy'}">${a.src === 'lichess' ? 'LICHESS' : a.src === 'chesscom' ? 'CHESS.COM' : 'PGN'}</span>
        <div class="min-w-0 flex-1"><div class="text-[12.5px] font-semibold truncate">${a.title ? `<span class="text-am mr-1">${esc(a.title)}</span>` : ''}${esc(a.name)}</div><div class="text-[10.5px] text-txtMuted">${fmtInt(n)} games · ${esc(state)}</div></div>
        <button data-act="remove-account" data-key="${esc(accountKey(a))}" class="px-2 py-1 rounded-lg text-[11px] text-txtMuted hover:text-ro hover:bg-ro/10" aria-label="Remove ${esc(a.name)}">Remove</button>
      </div>`;
    })
    .join('');
  $('popover').innerHTML = `<div class="fixed inset-0 z-40" data-act="close-popover"></div>
    <div class="fixed z-50 right-3 top-[52px] w-[min(380px,calc(100vw-24px))] bg-panel border border-borderBright rounded-xl shadow-2xl p-3" role="dialog" aria-label="Accounts">
      <div class="text-[10.5px] font-semibold uppercase tracking-wider text-txtMuted mb-1">Game sources</div>
      <div>${rows}</div>
      <form data-act="add-account-form" class="flex gap-1.5 mt-3">
        <select name="src" class="px-2 py-1.5 rounded-lg bg-surface border border-borderSubtle text-[11.5px]" aria-label="Site"><option value="lichess">Lichess</option><option value="chesscom">Chess.com</option></select>
        <input name="name" required placeholder="Add username" autocapitalize="off" spellcheck="false" class="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-surface border border-borderSubtle text-[16px] sm:text-[12px] focus:outline-none focus:border-em" aria-label="Username">
        <button class="px-3 py-1.5 rounded-lg bg-em text-[#04130d] font-bold text-[11.5px]">Add</button>
      </form>
      <button data-act="import-pgn" class="mt-2 text-[11.5px] text-cy hover:underline">Import games from a PGN file</button>
    </div>`;
}

function askPgnOwner(games) {
  const counts = new Map();
  for (const g of games) for (const n of [g.headers.White, g.headers.Black]) if (n && n !== '?') counts.set(n, (counts.get(n) || 0) + 1);
  const options = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const guess = guessPgnOwner(games);
  return new Promise((resolve) => {
    $('popover').innerHTML = `<div class="fixed inset-0 z-40 bg-black/50" data-act="pgn-cancel"></div>
      <form data-act="pgn-owner" class="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(400px,calc(100vw-24px))] bg-panel border border-borderBright rounded-xl shadow-2xl p-4">
        <div class="text-[14px] font-bold mb-1">Which player are you?</div>
        <p class="text-[11.5px] text-txtMuted mb-3">${fmtInt(games.length)} games found. Only games with this player are imported.</p>
        <select name="owner" class="w-full px-2.5 py-2 rounded-lg bg-surface border border-borderSubtle text-[12.5px] mb-3">${options
          .map(([n, c]) => `<option value="${esc(n)}"${n === guess ? ' selected' : ''}>${esc(n)} (${fmtInt(c)} games)</option>`)
          .join('')}</select>
        <div class="flex justify-end gap-2"><button type="button" data-act="pgn-cancel" class="px-3 py-1.5 rounded-lg bg-surface border border-borderSubtle text-[12px]">Cancel</button><button class="px-3 py-1.5 rounded-lg bg-em text-[#04130d] font-bold text-[12px]">Import</button></div>
      </form>`;
    S.pgnResolve = resolve;
  });
}

async function importPgnFile(file) {
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch (_) {
    toast('Could not read that file.', true);
    return;
  }
  const parsed = parsePgnGames(text);
  if (!parsed.length) {
    toast('No games found in that file.', true);
    return;
  }
  const owner = await askPgnOwner(parsed);
  closePopover();
  if (!owner) return;
  const records = parsed.map((g) => normalizePgnGame(g, owner)).filter(Boolean);
  if (!records.length) {
    toast(`No finished standard games for ${owner} in that file.`, true);
    return;
  }
  await putGames(records);
  addRecords(records);
  if (!S.accounts.some((a) => a.src === 'pgn' && a.name.toLowerCase() === owner.toLowerCase())) {
    S.accounts.push({ src: 'pgn', name: owner, addedAt: Date.now(), complete: true, lastSync: Date.now() });
    await persistAccounts();
  }
  toast(`${fmtInt(records.length)} games imported`);
  render();
  if (isCloudAuthenticated()) {
    void uploadGamesToCloud('pgn', owner, records, { linkToUser: true }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Studio hand-off and export                                          */
/* ------------------------------------------------------------------ */

function openInStudio(sans, { flipped = false, title = '' } = {}) {
  const { ucis } = replay(sans);
  const url = `./${encodeMoveLine(START_FEN, ucis, { flipped, title })}`;
  const w = window.open(url, '_blank');
  if (w) w.opener = null;
  else window.location.href = url;
}

function displayName(g) {
  const a = S.accounts.find((x) => x.src === g.src && x.name.toLowerCase() === g.acct);
  return a ? a.name : g.acct;
}

function gamePgn(g) {
  const me = displayName(g);
  const white = g.color === 'w' ? me : g.op;
  const black = g.color === 'w' ? g.op : me;
  const result = g.res === 0.5 ? '1/2-1/2' : (g.res === 1) === (g.color === 'w') ? '1-0' : '0-1';
  const d = new Date(g.t);
  const date = `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`;
  const site = g.src === 'lichess' ? 'Lichess' : g.src === 'chesscom' ? 'Chess.com' : 'Imported';
  const q = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const tags = [
    ['Event', `${site} ${TC_LABEL[g.tc] || ''}${g.rated ? ' rated' : ''}`.trim()],
    ['Site', g.url || site],
    ['Date', date],
    ['White', white],
    ['Black', black],
    ['Result', result],
  ];
  if (g.color === 'w' ? g.me : g.opR) tags.push(['WhiteElo', g.color === 'w' ? g.me : g.opR]);
  if (g.color === 'w' ? g.opR : g.me) tags.push(['BlackElo', g.color === 'w' ? g.opR : g.me]);
  if (g.clock) tags.push(['TimeControl', g.clock]);
  if (g.eco) tags.push(['ECO', g.eco]);
  if (g.opening) tags.push(['Opening', g.opening]);
  tags.push(['Termination', TERM_LABEL[g.term] || 'Normal']);
  const head = tags.map(([k, v]) => `[${k} "${q(v)}"]`).join('\n');
  const moves = movesText(g.moves ? g.moves.split(' ') : []);
  return `${head}\n\n${moves} ${result}\n`;
}

function exportPgn() {
  const rows = filterGamesTab(currentFiltered(), S.ui.games);
  if (!rows.length) return;
  const blob = new Blob([rows.map(gamePgn).join('\n')], { type: 'application/x-chess-pgn' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tichess-games-${new Date().toISOString().slice(0, 10)}.pgn`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  toast(`${fmtInt(rows.length)} games downloaded`);
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

function setTab(tab) {
  S.ui.tab = TAB_ALIAS[tab] || tab;
  saveUi();
  render();
  window.scrollTo(0, 0);
}

function goExplore(color, prefix) {
  const path = prefix ? prefix.split(' ').filter(Boolean) : [];
  S.ui.explorer = { color: color === 'b' ? 'b' : 'w', path, fullPath: [...path], flipped: null };
  setTab('openings');
}

/** Jump to the Games tab with a drill-down applied (keeps the global filters). */
function showGames(patch) {
  S.ui.games = { ...DEFAULT_UI.games, sort: S.ui.games.sort, ...patch, limit: 50 };
  setTab('games');
}

function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const ui = S.ui;
  switch (act) {
    case 'tab':
      setTab(el.dataset.v);
      break;
    case 'set-filter':
      ui.filters[el.dataset.k] = ui.filters[el.dataset.k] === el.dataset.v && el.dataset.k !== 'color' ? 'all' : el.dataset.v;
      ui.games.limit = 50;
      saveUi();
      render();
      break;
    case 'clear-filters':
      ui.filters = { ...DEFAULT_UI.filters };
      saveUi();
      render();
      break;
    case 'more-filters':
      openMoreFilters();
      break;
    case 'add-lichess':
      addAccount('lichess', el.dataset.name || '');
      break;
    case 'sync':
      runSync({ force: true });
      break;
    case 'stop-sync':
      stopSync();
      break;
    case 'accounts':
      openAccounts();
      break;
    case 'close-popover':
      closePopover();
      S.moreOpen = false;
      break;
    case 'remove-account':
      removeAccount(el.dataset.key);
      break;
    case 'import-pgn':
      $('pgnInput').click();
      break;
    case 'pgn-cancel':
      S.pgnResolve?.(null);
      S.pgnResolve = null;
      closePopover();
      break;
    case 'takeaway': {
      const t = S.takeaways[Number(el.dataset.i)];
      if (!t?.link) break;
      if (t.link.tab === 'explorer') goExplore(t.link.color, t.link.prefix);
      else if (t.link.tab === 'games') showGames({ outcome: t.link.outcome || 'all', term: t.link.term || 'all' });
      else setTab(t.link.tab);
      break;
    }
    case 'takeaway-games': {
      const t = S.takeaways[Number(el.dataset.i)];
      if (t?.link?.prefix !== undefined) showGames({ prefix: t.link.prefix, pcolor: t.link.color || '' });
      break;
    }
    case 'explore':
      goExplore(el.dataset.color, el.dataset.prefix || '');
      break;
    case 'op-pick': {
      const path = (el.dataset.prefix || '').split(' ').filter(Boolean);
      ui.explorer = { color: el.dataset.color === 'b' ? 'b' : 'w', path, fullPath: [...path], flipped: null };
      saveUi();
      render();
      if (window.innerWidth < 1024) document.getElementById('insExplorer')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }
    case 'ex-games':
      showGames({ prefix: ui.explorer.path.join(' '), pcolor: ui.explorer.color });
      break;
    case 'term-games':
      showGames({ outcome: el.dataset.outcome || 'all', term: el.dataset.term || 'all' });
      break;
    case 'day-games':
      showGames({ day: el.dataset.day || '' });
      break;
    case 'games-clear':
      ui.games[el.dataset.k] = '';
      if (el.dataset.k === 'prefix') ui.games.pcolor = '';
      ui.games.limit = 50;
      saveUi();
      render();
      break;
    case 'ex-move': {
      S.exSel = null;
      const next = [...ui.explorer.path, el.dataset.san];
      const fp = Array.isArray(ui.explorer.fullPath) ? ui.explorer.fullPath : [];
      const matchesFp = fp.length >= next.length && next.every((s, i) => fp[i] === s);
      ui.explorer.path = next;
      if (!matchesFp) ui.explorer.fullPath = [...next];
      saveUi();
      render();
      break;
    }
    case 'ex-sq': {
      const sq = el.dataset.sq;
      if (!sq) break;
      const { chess } = replay(ui.explorer.path);
      if (S.exSel && S.exSel !== sq) {
        try {
          const mv = chess.move({ from: S.exSel, to: sq, promotion: 'q' });
          if (mv) {
            S.exSel = null;
            const next = [...ui.explorer.path, mv.san];
            const fp = Array.isArray(ui.explorer.fullPath) ? ui.explorer.fullPath : [];
            const matchesFp = fp.length >= next.length && next.every((s, i) => fp[i] === s);
            ui.explorer.path = next;
            if (!matchesFp) ui.explorer.fullPath = [...next];
            saveUi();
            render();
            break;
          }
        } catch (_) {
          /* not a legal destination from S.exSel */
        }
      }
      if (S.exSel === sq) {
        S.exSel = null;
      } else {
        const legal = chess.moves({ square: sq, verbose: true });
        S.exSel = legal.length ? sq : null;
      }
      render();
      break;
    }
    case 'ex-pin':
      S.exPinned = !S.exPinned;
      try {
        localStorage.setItem(INSIGHTS_PIN_KEY, S.exPinned ? '1' : '0');
      } catch (_) {}
      render();
      break;
    case 'ex-back': {
      S.exSel = null;
      const fp = Array.isArray(ui.explorer.fullPath) ? ui.explorer.fullPath : [];
      if (fp.length < ui.explorer.path.length) ui.explorer.fullPath = [...ui.explorer.path];
      ui.explorer.path = ui.explorer.path.slice(0, -1);
      saveUi();
      render();
      break;
    }
    case 'ex-fwd': {
      S.exSel = null;
      const fp = Array.isArray(ui.explorer.fullPath) ? ui.explorer.fullPath : [];
      const hasFullFwd = fp.length > ui.explorer.path.length && ui.explorer.path.every((s, i) => fp[i] === s);
      if (hasFullFwd) {
        ui.explorer.path = fp.slice(0, ui.explorer.path.length + 1);
      } else if (el.dataset.top) {
        ui.explorer.path = [...ui.explorer.path, el.dataset.top];
        ui.explorer.fullPath = [...ui.explorer.path];
      }
      saveUi();
      render();
      break;
    }
    case 'ex-last': {
      S.exSel = null;
      const fp = Array.isArray(ui.explorer.fullPath) ? ui.explorer.fullPath : [];
      const hasFullFwd = fp.length > ui.explorer.path.length && ui.explorer.path.every((s, i) => fp[i] === s);
      if (hasFullFwd) {
        ui.explorer.path = [...fp];
        saveUi();
        render();
      }
      break;
    }
    case 'ex-goto': {
      S.exSel = null;
      const fp = Array.isArray(ui.explorer.fullPath) ? ui.explorer.fullPath : [];
      if (fp.length < ui.explorer.path.length) ui.explorer.fullPath = [...ui.explorer.path];
      ui.explorer.path = ui.explorer.path.slice(0, Number(el.dataset.i));
      saveUi();
      render();
      break;
    }
    case 'ex-flip':
      ui.explorer.flipped = !(ui.explorer.flipped ?? (ui.explorer.color === 'b'));
      saveUi();
      render();
      break;
    case 'ex-color':
      S.exSel = null;
      ui.explorer.color = el.dataset.v;
      ui.explorer.flipped = null;
      saveUi();
      render();
      break;
    case 'ex-studio':
      openInStudio(ui.explorer.path, {
        flipped: ui.explorer.flipped ?? (ui.explorer.color === 'b'),
        title: 'My games',
      });
      break;
    case 'open-game': {
      const g = S.games.get(el.dataset.id);
      if (g) openInStudio(g.moves ? g.moves.split(' ') : [], { flipped: g.color === 'b', title: `vs ${g.op}` });
      break;
    }
    case 'games-more':
      ui.games.limit += 100;
      render();
      break;
    case 'export-pgn':
      exportPgn();
      break;
    case 'opp-games':
      showGames({ search: el.dataset.name });
      break;
    case 'op-sort':
      ui.openings.sort = el.dataset.v;
      saveUi();
      render();
      break;
    case 'op-group':
      ui.openings.group = el.dataset.v;
      saveUi();
      render();
      break;
    case 'act-more':
      ui.activity.years += 3;
      render();
      break;
    case 'rt-tc':
      ui.rating.tc = el.dataset.v;
      saveUi();
      render();
      break;
    case 'rt-range':
      ui.rating.range = el.dataset.v;
      saveUi();
      render();
      break;
    case 'coach-sub':
      ui.coach.sub = el.dataset.v || 'plan';
      saveUi();
      render();
      break;
    case 'coach-scan':
      startCoachScan();
      break;
    case 'coach-scan-stop':
      stopCoachScan();
      break;
    case 'coach-phase':
      ui.coach.phase = el.dataset.v || '';
      saveUi();
      render();
      break;
    case 'coach-bench-idx':
      ui.coach.benchIdx = Number(el.dataset.i) || 0;
      saveUi();
      render();
      break;
    case 'coach-bench-jump': {
      const cliffs = S.coachData?.cliffs || [];
      const idx = cliffs.findIndex((c) => c.childPrefix === el.dataset.prefix);
      ui.coach.benchIdx = idx >= 0 ? idx : 0;
      ui.coach.sub = 'drills';
      saveUi();
      render();
      break;
    }
    case 'coach-bench-retry':
      ensureBenchmarkLoaded(true);
      break;
    case 'coach-bench-studio': {
      const cliff = S.coachData?.cliffs?.[Number(el.dataset.i) || 0];
      if (cliff) openInStudio(cliff.path, { flipped: cliff.color === 'b', title: cliff.opening || 'Opening benchmark' });
      break;
    }
    case 'coach-drill-open':
      ui.coach.drillTag = 'all';
      ui.coach.sub = 'drills';
      resetDrill(el.dataset.id || '');
      saveUi();
      render();
      break;
    case 'coach-drill-tag':
      ui.coach.drillTag = el.dataset.tag || 'all';
      ui.coach.sub = 'drills';
      resetDrill('');
      saveUi();
      render();
      break;
    case 'coach-drill-hint': {
      const card = activeDrillCard();
      if (card) {
        S.drill.cardId = card.id;
        S.drill.hint = true;
        render();
      }
      break;
    }
    case 'coach-drill-solve': {
      const card = activeDrillCard();
      if (card && card.bestUci?.length >= 4) {
        const res = checkDrillAttempt(card, card.bestUci.slice(0, 2), card.bestUci.slice(2, 4));
        S.drillProgress = recordDrillOutcome(S.drillProgress, card.id, false);
        saveDrillProgress(S.drillProgress);
        S.drill = {
          cardId: card.id,
          selected: null,
          status: 'solved',
          hint: true,
          lastBad: null,
          solvedFen: res.fenAfter || card.fenBefore,
          nextBox: 0,
          failedOnce: true,
        };
        render();
      }
      break;
    }
    case 'coach-drill-next': {
      const cards = S.coachDeck?.cards || [];
      if (cards.length > 1) {
        const cur = activeDrillCard();
        const i = cur ? cards.findIndex((c) => c.id === cur.id) : 0;
        const next = cards[(i + 1) % cards.length];
        resetDrill(next.id);
        render();
      }
      break;
    }
    case 'drill-sq':
      handleDrillSquare(el.dataset.sq);
      break;
    default:
      break;
  }
}

function onChange(e) {
  const el = e.target;
  const act = el.dataset?.act;
  if (act === 'filter') {
    S.ui.filters[el.dataset.k] = el.value;
    S.ui.games.limit = 50;
    saveUi();
    render();
  } else if (act === 'games-ui') {
    S.ui.games[el.dataset.k] = el.value;
    S.ui.games.limit = 50;
    saveUi();
    render();
  } else if (act === 'op-min') {
    S.ui.openings.min = Number(el.value) || 1;
    saveUi();
    render();
  } else if (act === 'coach-scan-count') {
    S.ui.coach.scanCount = Number(el.value) || 25;
    saveUi();
    render();
  } else if (act === 'coach-toggle-item') {
    const id = el.dataset.id;
    const set = new Set(S.ui.coach.excluded || []);
    if (el.checked) set.delete(id);
    else set.add(id);
    S.ui.coach.excluded = [...set];
    saveUi();
    render();
  } else if (act === 'coach-drill-filter') {
    S.ui.coach.drillTag = el.value || 'all';
    resetDrill('');
    saveUi();
    render();
  } else if (el.id === 'pgnInput') {
    const file = el.files[0];
    el.value = '';
    importPgnFile(file);
  }
}

let searchTimer = 0;
function onInput(e) {
  const el = e.target;
  if (el.dataset?.act !== 'games-search') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    S.ui.games.search = el.value;
    S.ui.games.limit = 50;
    saveUi();
    render();
  }, 200);
}

function onSubmit(e) {
  const form = e.target;
  if (form.dataset?.act === 'add-account-form') {
    e.preventDefault();
    const data = new FormData(form);
    addAccount(String(data.get('src')), String(data.get('name') || ''));
  } else if (form.dataset?.act === 'pgn-owner') {
    e.preventDefault();
    const owner = String(new FormData(form).get('owner') || '');
    S.pgnResolve?.(owner);
    S.pgnResolve = null;
  }
}

function onKey(e) {
  if (e.key === 'Escape') {
    closePopover();
    S.moreOpen = false;
  }
  if (S.ui.tab !== 'openings') return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft' && S.ui.explorer.path.length) {
    e.preventDefault();
    S.ui.explorer.path = S.ui.explorer.path.slice(0, -1);
    saveUi();
    render();
  } else if (e.key === 'Home') {
    S.ui.explorer.path = [];
    saveUi();
    render();
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

/**
 * Signed in with Lichess (on any tichess page): add that account once, so
 * Insights is ready without typing a username. Removing it later sticks.
 */
async function autoAddSignedInAccount(snap) {
  if (!(snap.authenticated && snap.user?.username)) return false;
  const name = String(snap.user.username);
  let done = '';
  try {
    done = localStorage.getItem(AUTO_ADDED_KEY) || '';
  } catch (_) {
    /* private mode */
  }
  if (done.toLowerCase() === name.toLowerCase()) return false;
  try {
    localStorage.setItem(AUTO_ADDED_KEY, name);
  } catch (_) {
    /* private mode */
  }
  if (S.accounts.some((a) => a.src === 'lichess' && a.name.toLowerCase() === name.toLowerCase())) return false;
  await addAccount('lichess', name);
  return true;
}

export async function startInsights() {
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('keydown', onKey);
  mountAccount();

  try {
    const [accounts, games, analyses, savedRep] = await Promise.all([
      loadAccounts(),
      loadAllGames(),
      loadAllAnalyses().catch(() => []),
      loadRepertoire().catch(() => null),
    ]);
    S.accounts = accounts;
    for (const a of analyses || []) if (a?.id) S.analyses.set(a.id, a);
    if (savedRep?.repertoire) S.repertoire = savedRep.repertoire;
    addRecords(games);
  } catch (err) {
    console.error(err);
    toast('This browser blocked local storage, so games cannot be saved (private window?).', true);
  }
  render();
  let bootReady = false;
  onCloudSyncState((snap) => {
    if (!S.accounts.length && $('view').querySelector('[data-act="add-account-form"]')) renderOnboarding('');
    if (!bootReady || !snap.authenticated) return;
    void autoAddSignedInAccount(snap);
  });
  const snap = await initCloudSync();
  if (snap.authenticated) {
    const pulled = await pullInsightsFromServer({
      onSources: (merged) => {
        S.accounts = merged;
      },
      onBatch: (recs) => applyPulledBatch(recs),
    }).catch(() => ({ ok: false }));
    if (pulled.ok && S.accounts.length) {
      render();
    }
  }
  bootReady = true;
  if (await autoAddSignedInAccount(snap)) return;
  if (!S.accounts.length) {
    renderOnboarding('');
    return;
  }
  const stale = S.accounts.some((a) => a.src !== 'pgn' && (!a.complete || Date.now() - (a.lastSync || 0) > AUTO_SYNC_AFTER_MS));
  if (stale) runSync();
}
