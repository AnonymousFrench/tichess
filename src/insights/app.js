/**
 * Insights page controller: accounts, syncing, filters, tabs and actions.
 */
import { filterGames, PERIODS } from './stats.js';
import { TC_LABEL, TIME_CONTROLS, parsePgnGames, guessPgnOwner, normalizePgnGame, TERM_LABEL } from './normalize.js';
import { loadAllGames, putGames, deleteAccountGames, loadAccounts, saveAccounts } from './store.js';
import { syncLichess, syncChessCom, RateLimitError } from './sync.js';
import { esc, fmtInt } from './charts.js';
import {
  renderOverview,
  renderGames,
  renderExplorer,
  renderOpenings,
  renderOpponents,
  renderActivity,
  renderRating,
  filterGamesTab,
  replay,
  relTime,
  movesText,
} from './views.js';
import { encodeMoveLine } from '../chess/shareUrl.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PREFS_KEY = 'tichess_insights_ui_v1';
const AUTO_SYNC_AFTER_MS = 10 * 60_000;

const TABS = [
  ['overview', 'Overview'],
  ['games', 'Games'],
  ['explorer', 'Explorer'],
  ['openings', 'Openings'],
  ['opponents', 'Opponents'],
  ['activity', 'Activity'],
  ['rating', 'Rating'],
];

const $ = (id) => document.getElementById(id);

const DEFAULT_UI = {
  tab: 'overview',
  filters: { tc: 'all', color: 'all', period: 'all', rated: 'all', opp: 'all', account: 'all' },
  games: { outcome: 'all', term: 'all', sort: 'new', search: '', limit: 50 },
  explorer: { color: 'w', path: [] },
  openings: { sort: 'played', group: 'family', min: 5 },
  activity: { years: 3 },
  rating: { tc: '', range: '365' },
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
    return ui;
  } catch (_) {
    return structuredClone(DEFAULT_UI);
  }
}

const S = {
  games: new Map(), // id → record
  list: [],
  accounts: [],
  ui: loadUi(),
  takeaways: [],
  sync: null, // { label, fetched, total, unit, startedAt }
  syncCtrl: null,
  version: 0,
  filteredKey: '',
  filtered: [],
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
  }, 3200);
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

function addRecords(records) {
  for (const r of records) S.games.set(r.id, r);
  S.list = [...S.games.values()];
  S.version++;
}

const accountKey = (a) => `${a.src}:${a.name.toLowerCase()}`;

function accountGamesCount(a) {
  const key = a.name.toLowerCase();
  let n = 0;
  for (const g of S.list) if (g.src === a.src && g.acct === key) n++;
  return n;
}

function currentFiltered() {
  const f = S.ui.filters;
  const key = `${S.version}|${JSON.stringify(f)}`;
  if (key !== S.filteredKey) {
    S.filtered = filterGames(S.list, {
      tc: f.tc === 'all' ? [] : [f.tc],
      color: f.color,
      period: f.period,
      rated: f.rated,
      opp: f.opp,
      accounts: f.account === 'all' ? [] : [f.account],
    });
    S.filteredKey = key;
  }
  return S.filtered;
}

/* ------------------------------------------------------------------ */
/* Header: accounts and sync status                                   */
/* ------------------------------------------------------------------ */

function renderHeader() {
  const right = $('hdrRight');
  if (!S.accounts.length) {
    right.innerHTML = '';
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
    const amount = total ? `${fmtInt(fetched)} / ${fmtInt(total)}${unit === 'months' ? ' months' : ''}` : `${fmtInt(fetched)} games`;
    status = `<span class="flex items-center gap-1.5 text-[11px] text-txtMuted min-w-0"><span class="w-2 h-2 rounded-full bg-em animate-pulse shrink-0"></span><span class="hidden sm:inline">${esc(S.sync.label)}</span> <span class="font-mono truncate">${amount}<span class="hidden sm:inline">${eta}</span></span></span>
      <button data-act="stop-sync" class="px-2 py-1 rounded-lg bg-surface hover:bg-surfaceHover border border-borderSubtle text-[11px]">Stop</button>`;
  } else {
    const last = Math.max(0, ...S.accounts.map((a) => a.lastSync || 0));
    status = `<span class="hidden sm:inline text-[11px] text-txtMuted">${last ? `Updated ${esc(relTime(last))}` : 'Not synced yet'}</span>
      <button data-act="sync" class="px-2.5 py-1 rounded-lg bg-surface hover:bg-surfaceHover border border-borderSubtle text-[11px] font-semibold whitespace-nowrap" title="Download new games" aria-label="Sync">↻<span class="hidden sm:inline"> Sync</span></button>`;
  }
  const names = S.accounts.map((a) => a.name);
  right.innerHTML = `${status}
    <button data-act="accounts" class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface hover:bg-surfaceHover border border-borderSubtle text-[11.5px] font-semibold max-w-[110px] sm:max-w-[200px] min-w-0" aria-haspopup="dialog" aria-label="Accounts">
      <span class="truncate">${esc(names.slice(0, 2).join(', '))}${names.length > 2 ? ` +${names.length - 2}` : ''}</span><span class="text-txtMuted text-[10px]">▾</span>
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

function renderToolbar() {
  const tb = $('toolbar');
  if (!S.accounts.length) {
    tb.hidden = true;
    return;
  }
  tb.hidden = false;
  const tcsPresent = TIME_CONTROLS.filter((tc) => S.list.some((g) => g.tc === tc));
  const f = S.ui.filters;
  const sel = (k, opts, label) =>
    `<label class="sr-only" for="flt-${k}">${label}</label><select id="flt-${k}" data-act="filter" data-k="${k}" class="px-2 py-1 rounded-lg border text-[11.5px] font-medium focus:outline-none focus:border-em ${
      f[k] !== 'all' ? 'bg-em/15 border-em/40 text-em' : 'bg-surface border-borderSubtle text-txt'
    }">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === f[k] ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const colorSeg = `<div class="inline-flex p-0.5 rounded-lg bg-surface border border-borderSubtle text-[11px]" role="group" aria-label="Color">${[
    ['all', 'Both'],
    ['w', 'White'],
    ['b', 'Black'],
  ]
    .map(
      ([v, l]) =>
        `<button data-act="set-filter" data-k="color" data-v="${v}" class="px-2 py-0.5 rounded-md font-semibold ${f.color === v ? 'bg-txt text-bg' : 'text-txtMuted hover:text-txt'}">${l}</button>`
    )
    .join('')}</div>`;
  const acctOpts = S.accounts.length > 1 ? sel('account', [['all', 'All accounts'], ...S.accounts.map((a) => [accountKey(a), a.name])], 'Account') : '';
  const anyFilter = Object.entries(f).some(([, v]) => v !== 'all');
  tb.innerHTML = `<div class="max-w-[1400px] mx-auto px-3 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
    <nav class="flex items-center gap-0.5 overflow-x-auto -mx-1 px-1 max-w-full" aria-label="Insights views">${TABS.map(
      ([id, label]) =>
        `<button data-act="tab" data-v="${id}" class="px-2.5 py-1 rounded-lg text-[12px] font-semibold whitespace-nowrap ${
          S.ui.tab === id ? 'bg-surface text-txt border border-borderBright' : 'text-txtMuted hover:text-txt border border-transparent'
        }" ${S.ui.tab === id ? 'aria-current="page"' : ''}>${label}</button>`
    ).join('')}</nav>
    <div class="flex items-center gap-1.5 overflow-x-auto max-w-full -mx-1 px-1 lg:mx-0 lg:px-0 lg:flex-wrap lg:overflow-visible lg:ml-auto [&>*]:shrink-0">
      ${sel('tc', [['all', 'All time controls'], ...tcsPresent.map((t) => [t, TC_LABEL[t]])], 'Time control')}
      ${colorSeg}
      ${sel('period', Object.entries(PERIODS).map(([k, v]) => [k, v.label]), 'Period')}
      ${sel('opp', [['all', 'Any opponent'], ['higher', 'Stronger opponents'], ['similar', 'Similar rating'], ['lower', 'Weaker opponents']], 'Opponent')}
      ${sel('rated', [['all', 'Rated + casual'], ['rated', 'Rated only'], ['casual', 'Casual only']], 'Rated')}
      ${acctOpts}
      ${anyFilter ? '<button data-act="clear-filters" class="text-[11px] text-txtMuted hover:text-txt underline">Clear</button>' : ''}
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Main view                                                           */
/* ------------------------------------------------------------------ */

function renderOnboarding(prefill = '') {
  $('view').innerHTML = `<div class="max-w-[560px] mx-auto mt-6 sm:mt-14">
    <div class="bg-panel border border-borderSubtle rounded-2xl p-5 sm:p-6">
      <div class="text-[11px] font-semibold uppercase tracking-wider text-em mb-1">Insights</div>
      <h1 class="text-[22px] font-bold leading-tight mb-1.5">See how you really play</h1>
      <p class="text-[12.5px] text-txtMuted mb-4">Connect your Lichess or Chess.com account to see your strongest and weakest openings, how you do against stronger players, when you play best, and how your rating moves.</p>
      <form data-act="add-account-form" class="grid gap-2">
        <div class="flex flex-wrap gap-2">
          <select name="src" class="px-2.5 py-2 rounded-lg bg-surface border border-borderSubtle text-[16px] sm:text-[12.5px] focus:outline-none focus:border-em" aria-label="Site">
            <option value="lichess">Lichess</option><option value="chesscom">Chess.com</option>
          </select>
          <input name="name" required value="${esc(prefill)}" placeholder="Username" autocomplete="username" autocapitalize="off" spellcheck="false" class="flex-1 min-w-[140px] px-3 py-2 rounded-lg bg-surface border border-borderSubtle text-[16px] sm:text-[13px] focus:outline-none focus:border-em" aria-label="Username">
          <button class="w-full sm:w-auto px-4 py-2 rounded-lg bg-em hover:brightness-110 text-[#04130d] font-bold text-[13px]">Analyze</button>
        </div>
      </form>
      <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-txtMuted">
        <span>Your games are stored only in this browser.</span>
        <button data-act="import-pgn" class="text-cy hover:underline">Or import a PGN file</button>
      </div>
    </div>
    <p class="text-[11px] text-txtMuted text-center mt-3">Large accounts take a few minutes the first time. Results fill in as games arrive, and later syncs only fetch new games.</p>
  </div>`;
}

function render() {
  renderHeader();
  renderToolbar();
  if (!S.accounts.length) {
    if (!$('view').querySelector('[data-act="add-account-form"]')) renderOnboarding(S.prefillName || '');
    return;
  }
  const games = currentFiltered();
  if (!S.list.length) {
    $('view').innerHTML = `<div class="py-16 text-center text-txtMuted text-[12.5px]">${S.sync ? 'Downloading your games… the first results appear in a moment.' : 'No games yet. Press Sync to download them.'}</div>`;
    return;
  }
  const ctx = {
    games,
    all: S.list,
    now: Date.now(),
    ui: S.ui,
    profiles: S.accounts.map((a) => ({ name: a.name, src: a.src, perfs: a.perfs })),
    setTakeaways: (t) => {
      S.takeaways = t;
    },
  };
  const renderers = {
    overview: renderOverview,
    games: renderGames,
    explorer: renderExplorer,
    openings: renderOpenings,
    opponents: renderOpponents,
    activity: renderActivity,
    rating: renderRating,
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
  S.accounts.push({ src, name, addedAt: Date.now() });
  await persistAccounts();
  closePopover();
  render();
  runSync();
}

async function removeAccount(key) {
  const a = S.accounts.find((x) => accountKey(x) === key);
  if (!a) return;
  if (!window.confirm(`Remove ${a.name} and delete its ${fmtInt(accountGamesCount(a))} downloaded games from this browser?`)) return;
  if (S.sync) stopSync();
  S.accounts = S.accounts.filter((x) => x !== a);
  await persistAccounts();
  await deleteAccountGames(a.src, a.name.toLowerCase());
  for (const [id, g] of S.games) if (g.src === a.src && g.acct === a.name.toLowerCase()) S.games.delete(id);
  S.list = [...S.games.values()];
  S.version++;
  if (S.ui.filters.account === key) S.ui.filters.account = 'all';
  closePopover();
  render();
}

function stopSync() {
  S.syncCtrl?.abort();
}

async function runSync() {
  if (S.sync) return;
  const targets = S.accounts.filter((a) => a.src === 'lichess' || a.src === 'chesscom');
  if (!targets.length) return;
  const ctrl = new AbortController();
  S.syncCtrl = ctrl;
  const before = S.games.size;
  try {
    for (const acct of targets) {
      S.sync = { label: `${acct.src === 'lichess' ? 'Lichess' : 'Chess.com'} · ${acct.name}`, fetched: 0, total: 0, unit: 'games', startedAt: Date.now() };
      renderHeader();
      const save = async (records) => {
        await putGames(records);
        addRecords(records);
        scheduleRender({ throttle: true });
      };
      const onProgress = (p) => {
        Object.assign(S.sync, p);
        renderHeader();
      };
      const opts = { signal: ctrl.signal, save, saveMeta: persistAccounts, onProgress };
      if (acct.src === 'lichess') await syncLichess(acct, opts);
      else await syncChessCom(acct, opts);
    }
    const added = S.games.size - before;
    toast(added ? `${fmtInt(added)} new game${added === 1 ? '' : 's'} added` : 'You are up to date');
  } catch (err) {
    if (err?.name === 'AbortError') toast('Sync paused. It continues where it stopped next time.');
    else if (err instanceof RateLimitError) toast(err.message, true);
    else if (err?.status === 404) toast('Player not found. Check the username.', true);
    else toast(`Sync stopped: ${err?.message || err}`, true);
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
      const state = a.src === 'pgn' ? 'Imported file' : a.complete ? `Synced ${a.lastSync ? relTime(a.lastSync) : ''}` : 'Partly downloaded';
      return `<div class="flex items-center gap-2 py-2 border-t border-borderSubtle/60 first:border-0">
        <span class="px-1.5 py-0.5 rounded text-[9.5px] font-bold ${a.src === 'lichess' ? 'bg-txt/10 text-txt' : a.src === 'chesscom' ? 'bg-em/15 text-em' : 'bg-cy/15 text-cy'}">${a.src === 'lichess' ? 'LICHESS' : a.src === 'chesscom' ? 'CHESS.COM' : 'PGN'}</span>
        <div class="min-w-0 flex-1"><div class="text-[12.5px] font-semibold truncate">${a.title ? `<span class="text-am mr-1">${esc(a.title)}</span>` : ''}${esc(a.name)}</div><div class="text-[10.5px] text-txtMuted">${fmtInt(n)} games · ${esc(state)}</div></div>
        <button data-act="remove-account" data-key="${esc(accountKey(a))}" class="px-2 py-1 rounded-lg text-[11px] text-txtMuted hover:text-ro hover:bg-ro/10" aria-label="Remove ${esc(a.name)}">Remove</button>
      </div>`;
    })
    .join('');
  $('popover').innerHTML = `<div class="fixed inset-0 z-40" data-act="close-popover"></div>
    <div class="fixed z-50 right-3 top-[52px] w-[min(380px,calc(100vw-24px))] bg-panel border border-borderBright rounded-xl shadow-2xl p-3" role="dialog" aria-label="Accounts">
      <div class="text-[10.5px] font-semibold uppercase tracking-wider text-txtMuted mb-1">Accounts</div>
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
  S.ui.tab = tab;
  saveUi();
  render();
  window.scrollTo(0, 0);
}

function goExplore(color, prefix) {
  S.ui.explorer = { color: color === 'b' ? 'b' : 'w', path: prefix ? prefix.split(' ').filter(Boolean) : [] };
  setTab('explorer');
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
    case 'sync':
      runSync();
      break;
    case 'stop-sync':
      stopSync();
      break;
    case 'accounts':
      openAccounts();
      break;
    case 'close-popover':
      closePopover();
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
      else setTab(t.link.tab);
      break;
    }
    case 'explore':
      goExplore(el.dataset.color, el.dataset.prefix || '');
      break;
    case 'ex-move':
      ui.explorer.path = [...ui.explorer.path, el.dataset.san];
      saveUi();
      render();
      break;
    case 'ex-back':
      ui.explorer.path = ui.explorer.path.slice(0, -1);
      saveUi();
      render();
      break;
    case 'ex-goto':
      ui.explorer.path = ui.explorer.path.slice(0, Number(el.dataset.i));
      saveUi();
      render();
      break;
    case 'ex-color':
      ui.explorer.color = el.dataset.v;
      saveUi();
      render();
      break;
    case 'ex-studio':
      openInStudio(ui.explorer.path, { flipped: ui.explorer.color === 'b', title: 'My games' });
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
      ui.games = { ...ui.games, search: el.dataset.name, outcome: 'all', limit: 50 };
      setTab('games');
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
  if (e.key === 'Escape') closePopover();
  if (S.ui.tab !== 'explorer') return;
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

async function signedInLichessName() {
  try {
    const res = await fetch('/api/auth/me', { headers: { Accept: 'application/json' } });
    if (!res.ok) return '';
    const data = await res.json();
    return data?.authenticated && data.user?.username ? String(data.user.username) : '';
  } catch (_) {
    return '';
  }
}

export async function startInsights() {
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('keydown', onKey);

  try {
    S.accounts = await loadAccounts();
    addRecords(await loadAllGames());
  } catch (err) {
    console.error(err);
    toast('This browser blocked local storage, so games cannot be saved (private window?).', true);
  }
  if (!S.accounts.length) {
    render();
    S.prefillName = await signedInLichessName();
    if (S.prefillName) renderOnboarding(S.prefillName);
    return;
  }
  render();
  const stale = S.accounts.some((a) => a.src !== 'pgn' && (!a.complete || Date.now() - (a.lastSync || 0) > AUTO_SYNC_AFTER_MS));
  if (stale) runSync();
}
