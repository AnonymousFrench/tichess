import { state, showToast, emitPositionChanged } from '../state.js';
import {
  fetchTopBroadcasts,
  searchBroadcasts,
  fetchBroadcastTournament,
  fetchBroadcastRoundById,
  fetchBroadcastRoundPgn,
} from '../api/lichess.js';
import { createTreeFromPgn, mergeMainline } from '../chess/tree.js';
import { renderPlayerClockBars } from '../board/board.js';
import { addBoardTab, renderVariationTree } from '../board/tabs.js';
import {
  parseBroadcastItem,
  mergeBroadcastLists,
  selectFeaturedBroadcast,
  computeRoundTransition,
  parseBroadcastRoundPgn,
  parseBroadcastInput,
  buildEventSections,
  looksLikeBroadcastRef,
  pickRound,
} from './broadcastParser.js';
import { updateLiveIndicators, renderEventsList, renderEventView, showLiveView } from './liveRenderer.js';

export {
  parseBroadcastItem,
  mergeBroadcastLists,
  selectFeaturedBroadcast,
  computeRoundTransition,
  parseBroadcastRoundPgn,
  parseBroadcastInput,
  buildEventSections,
  looksLikeBroadcastRef,
  pickRound,
};

const TOUR_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
const EVENTS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const POLL_SECONDS = 15;

/** Finished rounds never change, so their games are kept for instant round switching. */
const finishedRoundGames = new Map();

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** Auto-refresh controls only while something on screen can still change. */
function syncPollControls() {
  const auto = document.getElementById('liveAutoWrap');
  if (!auto) return;
  const show = state.activeHub === 'live' && state.liveView === 'event' && roundsToPoll().length > 0;
  auto.classList.toggle('hidden', !show);
  auto.classList.toggle('inline-flex', show);
}

export function renderLiveHub() {
  showLiveView();
  syncPollControls();
  if (state.liveView === 'event') {
    renderEventView({
      onBack: backToEvents,
      onSelectRound: selectRound,
      onOpenGame: openBroadcastGameTab,
    });
  } else {
    renderEventsList({ onOpenEvent: openEvent });
  }
  updateLiveIndicators();
}

function getSelectedRound() {
  const rounds = state.featuredTour?.rounds || [];
  return rounds.find((r) => r.id === state.liveRoundId) || null;
}

function roundIsFinal(round, games) {
  return Boolean(round && round.finished === true && round.ongoing !== true && !games.some((g) => g.result === '*'));
}

/* ------------------------------------------------------------------ */
/* Events list                                                         */
/* ------------------------------------------------------------------ */

export async function discoverAndSyncLiveBroadcasts() {
  if (!state.lastEventsRefreshAt) state.liveStatus = 'loading';
  renderLiveHub();
  try {
    const [topRes, searchRes] = await Promise.allSettled([fetchTopBroadcasts(), searchBroadcasts('World Championship')]);
    const topData = topRes.status === 'fulfilled' ? topRes.value : null;
    const searchData = searchRes.status === 'fulfilled' ? searchRes.value : null;
    if (!topData && !searchData) throw new Error('unreachable');
    state.liveSections = buildEventSections(topData, searchData);
    state.allBroadcasts = mergeBroadcastLists(topData, searchData);
    state.liveStatus = 'ok';
    state.lastEventsRefreshAt = Date.now();
  } catch (_) {
    state.liveStatus = state.lastEventsRefreshAt ? 'ok' : 'error';
  }
  renderLiveHub();
}

let searchTimer = 0;
let searchSeq = 0;

/** Filter the list as you type; after a pause, also search all of Lichess (past events included). */
export function onLiveSearchInput() {
  const q = (document.getElementById('customBroadcastInput')?.value || '').trim();
  clearTimeout(searchTimer);
  renderLiveHub();
  if (q.length < 3 || looksLikeBroadcastRef(q)) return;
  searchTimer = setTimeout(() => runRemoteSearch(q), 450);
}

async function runRemoteSearch(q) {
  const seq = ++searchSeq;
  state.liveSearch = { q: q.toLowerCase(), results: [], loading: true };
  renderLiveHub();
  try {
    const data = await searchBroadcasts(q);
    if (seq !== searchSeq) return;
    const seen = new Set();
    const results = [];
    for (const it of data?.currentPageResults || []) {
      const b = parseBroadcastItem(it);
      if (!b.tourId || seen.has(b.tourId)) continue;
      seen.add(b.tourId);
      results.push({ ...b, info: b.tour?.info || null, tier: b.tour?.tier || 0, dates: b.tour?.dates || null });
    }
    state.liveSearch = { q: q.toLowerCase(), results, loading: false };
  } catch (_) {
    if (seq === searchSeq) state.liveSearch = { q: q.toLowerCase(), results: [], loading: false };
  }
  if (seq === searchSeq) renderLiveHub();
}

/** Enter in the search box: open a pasted link or id, otherwise search now. */
export async function loadCustomBroadcastFromInput() {
  const input = document.getElementById('customBroadcastInput');
  const raw = (input?.value || '').trim();
  if (!raw) return;
  if (!looksLikeBroadcastRef(raw)) {
    clearTimeout(searchTimer);
    await runRemoteSearch(raw);
    return;
  }
  const parsed = parseBroadcastInput(raw);
  if (!parsed) return;
  if (parsed.type === 'tour') {
    await openEvent(parsed.id, null);
    return;
  }
  try {
    const info = await fetchBroadcastRoundById(parsed.id);
    if (info?.tour?.id) {
      await openEvent(info.tour.id, parsed.id, { pinned: true });
      return;
    }
  } catch (_) {
    /* fall through */
  }
  showToast('Could not find that broadcast. Check the link.', true);
}

/* ------------------------------------------------------------------ */
/* One event                                                           */
/* ------------------------------------------------------------------ */

export async function openEvent(tourId, preferredRoundId = null, { pinned = false } = {}) {
  if (!tourId) return;
  const sameEvent = state.featuredTour?.tour?.id === tourId;
  state.liveView = 'event';
  if (!sameEvent) {
    state.featuredTour = null;
    state.liveRoundId = null;
    state.liveRoundGames = [];
    state.liveStatus = 'loading';
  }
  renderLiveHub();
  try {
    const full = await fetchBroadcastTournament(tourId);
    state.featuredTour = full;
    state.lastTourRefreshAt = Date.now();
    state.liveStatus = 'ok';
    const chosen = sameEvent && !preferredRoundId ? getSelectedRound() || pickRound(full) : pickRound(full, preferredRoundId);
    state.userPinnedRound = Boolean(pinned && preferredRoundId);
    if (chosen?.id) await selectRound(chosen.id, { pin: state.userPinnedRound });
    else renderLiveHub();
  } catch (_) {
    state.liveStatus = 'error';
    renderLiveHub();
    showToast('Could not load that event from Lichess', true);
  }
}

function backToEvents() {
  state.liveView = 'events';
  renderLiveHub();
}

/** Show one round's games. Picking a round by hand pins it (no auto-advance). */
export async function selectRound(roundId, { pin = true } = {}) {
  const round = (state.featuredTour?.rounds || []).find((r) => r.id === roundId);
  state.liveRoundId = roundId;
  state.liveRoundName = `${state.featuredTour?.tour?.name || 'Broadcast'} · ${round?.name || ''}`;
  if (pin) state.userPinnedRound = true;
  const cached = finishedRoundGames.get(roundId);
  state.liveRoundGames = cached || [];
  state.liveRoundLoading = !cached;
  state.liveCountdown = POLL_SECONDS;
  renderLiveHub();
  if (!cached) await pollActiveRoundPgn();
}

export async function refreshFeaturedTournament({ silent = true } = {}) {
  const tourId = state.featuredTour?.tour?.id;
  if (!tourId) return;
  try {
    const full = await fetchBroadcastTournament(tourId);
    state.featuredTour = full;
    state.lastTourRefreshAt = Date.now();
    const transition = computeRoundTransition({
      currentRoundId: state.liveRoundId,
      currentRoundName: state.liveRoundName,
      userPinnedRound: state.userPinnedRound,
      tourData: full,
    });
    if (transition.nextRoundId && transition.nextRoundId !== state.liveRoundId) {
      if (transition.advanced && transition.round?.name) showToast(`Now live: ${transition.round.name}`);
      await selectRound(transition.nextRoundId, { pin: false });
      return;
    }
    renderLiveHub();
  } catch (_) {
    if (!silent) showToast('Could not refresh the event', true);
  }
}

/* ------------------------------------------------------------------ */
/* Polling: the round on screen and every open live game              */
/* ------------------------------------------------------------------ */

function roundsToPoll() {
  const ids = new Set();
  const viewed = getSelectedRound();
  if (state.liveView === 'event' && state.liveRoundId && !finishedRoundGames.has(state.liveRoundId)) {
    const notYet =
      viewed && viewed.ongoing !== true && viewed.finished !== true && viewed.startsAt && viewed.startsAt - Date.now() > 10 * 60_000;
    if (!notYet) ids.add(state.liveRoundId);
  }
  for (const t of state.tabs) {
    if (t.liveMeta?.roundId && (t.liveMeta.lastResult ?? '*') === '*') ids.add(t.liveMeta.roundId);
  }
  return [...ids];
}

function updateLiveTabs(roundId, games) {
  let positionChanged = false;
  let clocksChanged = false;
  for (const tab of state.tabs) {
    if (!tab.liveMeta || tab.liveMeta.roundId !== roundId) continue;
    const matched =
      games.find((g) => g.white === tab.liveMeta.white && g.black === tab.liveMeta.black) || games[tab.liveMeta.gameIdx];
    if (!matched?.pgn) continue;
    const { root: freshRoot, meta: freshMeta, invalidFen } = createTreeFromPgn(matched.pgn);
    if (invalidFen) continue;
    const { added, clockChanged, lastNode } = mergeMainline(tab.root, freshRoot);
    const prevResult = tab.liveMeta.lastResult ?? tab.meta?.result ?? '*';
    const resultChanged = matched.result !== prevResult;
    tab.liveMeta.lastResult = matched.result;
    const prevClocks = tab.liveClocks || { white: '', black: '' };
    const liveClocksChanged = prevClocks.white !== matched.whiteClk || prevClocks.black !== matched.blackClk;
    tab.meta = freshMeta ? { ...(tab.meta || {}), ...freshMeta } : tab.meta;
    tab.liveClocks = { white: matched.whiteClk, black: matched.blackClk };
    if (added > 0 && tab.autoFollow) tab.current = lastNode;
    if (tab.id === state.activeTabId) {
      if (added > 0 || resultChanged) positionChanged = true;
      else if (clockChanged || liveClocksChanged) clocksChanged = true;
    }
  }
  return { positionChanged, clocksChanged };
}

async function pollRound(roundId) {
  const pgnText = await fetchBroadcastRoundPgn(roundId);
  const round = (state.featuredTour?.rounds || []).find((r) => r.id === roundId);
  const games = parseBroadcastRoundPgn(pgnText, round?.name || 'Live Broadcast');
  if (roundIsFinal(round, games)) finishedRoundGames.set(roundId, games);
  return games;
}

/** Fetch the viewed round and the rounds of open live games; update the list and those tabs. */
export async function pollActiveRoundPgn() {
  const ids = roundsToPoll();
  if (!ids.length) {
    state.liveRoundLoading = false;
    renderLiveHub();
    return;
  }
  let positionChanged = false;
  let clocksChanged = false;
  let viewedFinishedNow = false;
  await Promise.all(
    ids.map(async (rid) => {
      try {
        const games = await pollRound(rid);
        if (rid === state.liveRoundId) {
          const hadLive = state.liveRoundGames.some((g) => g.result === '*');
          state.liveRoundGames = games;
          state.liveRoundLoading = false;
          if (hadLive && games.length && games.every((g) => g.result !== '*')) viewedFinishedNow = true;
        }
        const r = updateLiveTabs(rid, games);
        positionChanged ||= r.positionChanged;
        clocksChanged ||= r.clocksChanged;
      } catch (err) {
        if (rid === state.liveRoundId) state.liveRoundLoading = false;
        if (err?.name === 'RateLimitError') {
          state.liveCountdown = Math.max(60, Math.ceil((err.retryAfterMs || 60_000) / 1000));
          showToast('Lichess rate limit: retrying in a minute', true);
        }
      }
    })
  );
  renderLiveHub();
  if (positionChanged) emitPositionChanged();
  else if (clocksChanged) {
    renderPlayerClockBars();
    renderVariationTree();
  }
  if (viewedFinishedNow) refreshFeaturedTournament({ silent: true });
}

export function openBroadcastGameTab(g, roundId) {
  const existing = state.tabs.find(
    (t) => t.liveMeta && t.liveMeta.roundId === roundId && t.liveMeta.white === g.white && t.liveMeta.black === g.black
  );
  if (existing) {
    state.activeTabId = existing.id;
    emitPositionChanged();
    return;
  }
  const tab = addBoardTab(
    `${g.white.split(',')[0]} - ${g.black.split(',')[0]}`,
    g.pgn,
    {
      white: g.white,
      whiteElo: g.whiteElo,
      black: g.black,
      blackElo: g.blackElo,
      event: g.event,
      result: g.result,
      eco: g.eco || '',
      opening: g.opening || '',
    },
    {
      jumpEnd: true,
      liveMeta: { roundId, white: g.white, black: g.black, gameIdx: g.idx, lastResult: g.result },
    }
  );
  if (!tab) return;
  tab.liveClocks = { white: g.whiteClk, black: g.blackClk };
  renderPlayerClockBars();
  showToast(g.result === '*' ? `Watching live: ${g.white} vs ${g.black}` : `${g.white} vs ${g.black}`);
}

/** Header pill: straight to the event that is live now, or to the list. */
export function openLiveFromHeader() {
  const pick = state.liveSections.live[0] || selectFeaturedBroadcast(state.allBroadcasts);
  if (pick?.tourId && pick.status === 'live') {
    openEvent(pick.tourId, state.featuredTour?.tour?.id === pick.tourId ? null : pick.roundId || null);
  } else {
    backToEvents();
  }
}

/** Refresh button: whatever is on screen. */
export function refreshLiveNow() {
  if (state.liveView === 'event') {
    state.liveCountdown = POLL_SECONDS;
    refreshFeaturedTournament({ silent: false });
    pollActiveRoundPgn();
  } else {
    discoverAndSyncLiveBroadcasts();
  }
}

export function startLivePollTimer() {
  const badge = (text) => {
    const el = document.getElementById('liveCountdownBadge');
    if (el) el.textContent = text;
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (Date.now() - state.lastEventsRefreshAt >= EVENTS_REFRESH_INTERVAL_MS) discoverAndSyncLiveBroadcasts();
      if (state.featuredTour?.tour?.id && Date.now() - state.lastTourRefreshAt >= 30_000) {
        refreshFeaturedTournament({ silent: true });
      }
      if (state.liveAutoPoll && roundsToPoll().length) {
        state.liveCountdown = POLL_SECONDS;
        pollActiveRoundPgn();
      }
    });
  }

  setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (state.lastEventsRefreshAt && Date.now() - state.lastEventsRefreshAt >= EVENTS_REFRESH_INTERVAL_MS) {
      discoverAndSyncLiveBroadcasts();
    }
    if (state.liveView === 'event' && state.featuredTour?.tour?.id && Date.now() - state.lastTourRefreshAt >= TOUR_REFRESH_INTERVAL_MS) {
      refreshFeaturedTournament({ silent: true });
    }
    syncPollControls();
    if (!roundsToPoll().length) return;
    if (!state.liveAutoPoll) {
      badge('Paused');
      return;
    }
    state.liveCountdown--;
    if (state.liveCountdown <= 0) {
      state.liveCountdown = POLL_SECONDS;
      pollActiveRoundPgn();
    }
    badge(`${state.liveCountdown}s`);
  }, 1000);
}
