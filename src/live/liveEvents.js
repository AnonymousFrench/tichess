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
} from './broadcastParser.js';
import {
  updateSpotlightBanner,
  renderTournamentRoundsTable as renderRoundsTableDom,
  renderLiveRoundGamesStrip as renderGamesStripDom,
  renderAllBroadcastsList as renderAllListDom,
} from './liveRenderer.js';

export {
  parseBroadcastItem,
  mergeBroadcastLists,
  selectFeaturedBroadcast,
  computeRoundTransition,
  parseBroadcastRoundPgn,
  parseBroadcastInput,
};

const TOUR_REFRESH_INTERVAL_MS = 3 * 60 * 1000;

function getSelectedRound() {
  const rounds = state.featuredTour?.rounds || [];
  return rounds.find((r) => r.id === state.liveRoundId) || null;
}

function isSelectedRoundFinished() {
  const round = getSelectedRound();
  if (!round) return false;
  if (round.finished === true && round.ongoing !== true) {
    return !state.liveRoundGames.some((g) => g.result === '*');
  }
  return false;
}

export function renderTournamentRoundsTable() {
  renderRoundsTableDom({
    onSelectRound: async (rid, rname) => {
      state.userPinnedRound = true;
      state.liveRoundId = rid;
      state.liveRoundName = `${state.featuredTour?.tour?.name || 'Broadcast'} · ${rname}`;
      renderTournamentRoundsTable();
      updateSpotlightBanner();
      await pollActiveRoundPgn();
    },
  });
}

export function renderLiveRoundGamesStrip() {
  renderGamesStripDom({
    onOpenGame: (g, roundId) => openBroadcastGameTab(g, roundId),
  });
}

export function renderAllBroadcastsList() {
  renderAllListDom({
    onSelectBroadcast: async (tid, rid, name) => {
      showToast(`Loading ${name}...`);
      if (tid) {
        await selectFeaturedTournament(tid, rid || null, { userPicked: false });
      } else if (rid) {
        state.userPinnedRound = true;
        state.liveRoundId = rid;
        state.liveRoundName = name;
        await pollActiveRoundPgn();
      }
    },
  });
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
      state.liveRoundId = transition.nextRoundId;
      state.liveRoundName = transition.nextRoundName;
      if (transition.advanced && transition.round?.name) {
        showToast(`Now live: ${transition.round.name}`);
      }
      renderTournamentRoundsTable();
      updateSpotlightBanner();
      await pollActiveRoundPgn();
      return;
    }

    renderTournamentRoundsTable();
    updateSpotlightBanner();
  } catch (_) {
    if (!silent) {
      showToast('Failed to refresh tournament status', true);
    }
  }
}

export async function selectFeaturedTournament(
  tourId,
  preferredRoundId = null,
  { userPicked = false } = {}
) {
  try {
    const full = await fetchBroadcastTournament(tourId);
    state.featuredTour = full;
    state.lastTourRefreshAt = Date.now();
    state.userPinnedRound = Boolean(userPicked && preferredRoundId);

    const rounds = full.rounds || [];
    const chosen =
      (preferredRoundId && rounds.find((r) => r.id === preferredRoundId)) ||
      rounds.find((r) => r.ongoing === true) ||
      (full.defaultRoundId && rounds.find((r) => r.id === full.defaultRoundId)) ||
      [...rounds].reverse().find((r) => r.finished === true) ||
      rounds[0];

    if (chosen?.id) {
      state.liveRoundId = chosen.id;
      state.liveRoundName = `${full.tour?.name || 'Broadcast'} · ${chosen.name || ''}`;
    }

    renderTournamentRoundsTable();
    updateSpotlightBanner();

    if (state.liveRoundId) {
      await pollActiveRoundPgn();
    }
  } catch (_) {
    renderTournamentRoundsTable();
    updateSpotlightBanner();
  }
}

export async function discoverAndSyncLiveBroadcasts() {
  const statusEl = document.getElementById('featuredStatus');
  if (statusEl) statusEl.textContent = 'Syncing Lichess...';

  try {
    const [topRes, searchRes] = await Promise.allSettled([
      fetchTopBroadcasts(),
      searchBroadcasts('World Championship'),
    ]);

    const topData = topRes.status === 'fulfilled' ? topRes.value : null;
    const searchData = searchRes.status === 'fulfilled' ? searchRes.value : null;
    const broadcasts = mergeBroadcastLists(topData, searchData);

    state.allBroadcasts = broadcasts;
    renderAllBroadcastsList();

    const picked = selectFeaturedBroadcast(broadcasts);

    if (picked?.tourId) {
      await selectFeaturedTournament(picked.tourId, picked.roundId || null, { userPicked: false });
    } else if (statusEl) {
      statusEl.textContent = 'No Active Broadcasts';
      updateSpotlightBanner();
    }
  } catch (_) {
    if (statusEl) statusEl.textContent = 'Lichess Unreachable';
    updateSpotlightBanner();
  }
}

export async function pollActiveRoundPgn() {
  if (!state.liveRoundId) return;
  try {
    const pgnText = await fetchBroadcastRoundPgn(state.liveRoundId);
    const games = parseBroadcastRoundPgn(pgnText, state.liveRoundName || 'Live Broadcast');
    const hadLiveGamesBefore = state.liveRoundGames.some((g) => g.result === '*');
    state.liveRoundGames = games;
    renderLiveRoundGamesStrip();
    updateSpotlightBanner();

    // Update any open LIVE board tabs matching this round non-destructively
    let activeChangedPosition = false;
    let activeChangedClocksOnly = false;
    for (const tab of state.tabs) {
      if (tab.liveMeta && tab.liveMeta.roundId === state.liveRoundId) {
        const matched =
          games.find((g) => g.white === tab.liveMeta.white && g.black === tab.liveMeta.black) ||
          games[tab.liveMeta.gameIdx];
        if (matched && matched.pgn) {
          const { root: freshRoot, meta: freshMeta, invalidFen } = createTreeFromPgn(matched.pgn);
          if (invalidFen) continue;

          const { added, clockChanged, lastNode } = mergeMainline(tab.root, freshRoot);
          const prevResult = tab.liveMeta.lastResult ?? tab.meta?.result ?? '*';
          const resultChanged = matched.result !== prevResult;
          tab.liveMeta.lastResult = matched.result;

          const prevClocks = tab.liveClocks || { white: '', black: '' };
          const liveClocksChanged =
            prevClocks.white !== matched.whiteClk || prevClocks.black !== matched.blackClk;

          tab.meta = freshMeta ? { ...(tab.meta || {}), ...freshMeta } : tab.meta;
          tab.liveClocks = { white: matched.whiteClk, black: matched.blackClk };

          if (added > 0 && tab.autoFollow) {
            tab.current = lastNode;
          }

          if (tab.id === state.activeTabId) {
            if (added > 0 || resultChanged) {
              activeChangedPosition = true;
            } else if (clockChanged || liveClocksChanged) {
              activeChangedClocksOnly = true;
            }
          }
        }
      }
    }

    if (activeChangedPosition) {
      emitPositionChanged();
    } else if (activeChangedClocksOnly) {
      renderPlayerClockBars();
      renderVariationTree();
    }

    const selectedRound = getSelectedRound();
    const allGamesFinished = games.length > 0 && games.every((g) => g.result !== '*');
    if (allGamesFinished && (hadLiveGamesBefore || selectedRound?.ongoing === true)) {
      refreshFeaturedTournament({ silent: true });
    }
  } catch (err) {
    if (err?.name === 'RateLimitError') {
      state.liveCountdown = Math.max(60, Math.ceil((err.retryAfterMs || 60_000) / 1000));
      const badge = document.getElementById('liveCountdownBadge');
      if (badge) badge.textContent = `${state.liveCountdown}s`;
      showToast('Lichess rate limit — retrying in 60s', true);
    }
  }
}

export function openBroadcastGameTab(g, roundId) {
  const existing = state.tabs.find(
    (t) =>
      t.liveMeta &&
      t.liveMeta.roundId === roundId &&
      t.liveMeta.white === g.white &&
      t.liveMeta.black === g.black
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
      liveMeta: {
        roundId,
        white: g.white,
        black: g.black,
        gameIdx: g.idx,
        lastResult: g.result,
      },
    }
  );
  if (!tab) return;
  tab.liveClocks = { white: g.whiteClk, black: g.blackClk };
  renderPlayerClockBars();
  showToast(`Watching: ${g.white} vs ${g.black}`);
}

export function openFeaturedLiveGame() {
  const ongoing = state.liveRoundGames.find((g) => g.result === '*') || state.liveRoundGames[0];
  if (ongoing) {
    openBroadcastGameTab(ongoing, state.liveRoundId);
  } else {
    showToast('No games available in the current broadcast round yet', true);
  }
}

export async function loadCustomBroadcastFromInput() {
  const input = document.getElementById('customBroadcastInput');
  const parsed = parseBroadcastInput(input?.value || '');
  if (!parsed) return;

  if (parsed.type === 'tour') {
    showToast(`Loading broadcast tournament ${parsed.id}...`);
    await selectFeaturedTournament(parsed.id, null, { userPicked: false });
    return;
  }

  const roundId = parsed.id;
  state.userPinnedRound = true;
  showToast(`Connecting to broadcast round ${roundId}...`);

  try {
    const info = await fetchBroadcastRoundById(roundId);
    if (info?.tour?.id) {
      await selectFeaturedTournament(info.tour.id, roundId, { userPicked: true });
      if (state.liveRoundGames.length) {
        showToast(`Loaded ${state.liveRoundGames.length} game(s)`);
      } else {
        showToast(`Loaded ${info.tour.name} (${info.round?.name || roundId})`);
      }
      return;
    }
    if (info?.tour || info?.round) {
      state.featuredTour = {
        tour: info.tour || { id: '', name: `Custom Broadcast (${roundId})` },
        rounds: info.round ? [info.round] : [],
      };
      state.lastTourRefreshAt = Date.now();
      state.liveRoundId = roundId;
      state.liveRoundName = `${info.tour?.name || 'Broadcast'} · ${info.round?.name || roundId}`;
      renderTournamentRoundsTable();
      updateSpotlightBanner();
    }
  } catch (_) {
    state.liveRoundId = roundId;
    state.liveRoundName = `Custom Broadcast (${roundId})`;
  }

  await pollActiveRoundPgn();
  if (state.liveRoundGames.length) {
    showToast(`Loaded ${state.liveRoundGames.length} game(s)`);
  } else {
    showToast('No games found for that Round ID (verify URL)', true);
  }
}

export function startLivePollTimer() {
  const updateBadge = (text) => {
    const badge = document.getElementById('liveCountdownBadge');
    if (badge) badge.textContent = text;
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (state.featuredTour?.tour?.id && Date.now() - state.lastTourRefreshAt >= 30_000) {
        refreshFeaturedTournament({ silent: true });
      }
      if (state.liveAutoPoll && state.liveRoundId && !isSelectedRoundFinished()) {
        state.liveCountdown = 15;
        updateBadge(`${state.liveCountdown}s`);
        pollActiveRoundPgn();
      }
    });
  }

  setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;

    if (
      state.featuredTour?.tour?.id &&
      Date.now() - state.lastTourRefreshAt >= TOUR_REFRESH_INTERVAL_MS
    ) {
      refreshFeaturedTournament({ silent: true });
    }

    if (isSelectedRoundFinished()) {
      updateBadge('Final');
      return;
    }

    if (!state.liveAutoPoll) {
      updateBadge('Paused');
      return;
    }

    state.liveCountdown--;
    if (state.liveCountdown <= 0) {
      state.liveCountdown = 15;
      pollActiveRoundPgn();
    }
    updateBadge(`${state.liveCountdown}s`);
  }, 1000);
}
