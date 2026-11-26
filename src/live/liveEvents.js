import {
  state,
  escapeHtml,
  showToast,
  emitPositionChanged,
} from '../state.js';
import {
  fetchTopBroadcasts,
  searchBroadcasts,
  fetchBroadcastTournament,
  fetchBroadcastRoundPgn,
} from '../api/lichess.js';
import { createTreeFromPgn, mergeMainline, extractClocksFromPgn } from '../chess/tree.js';
import { renderPlayerClockBars } from '../board/board.js';
import { addBoardTab, renderVariationTree } from '../board/tabs.js';

const TOUR_REFRESH_INTERVAL_MS = 3 * 60 * 1000;

function formatRoundDate(startsAt) {
  if (!startsAt) return '—';
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' });
}

function formatRoundTime(startsAt) {
  if (!startsAt) return '';
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Normalize a `{ tour, round }` entry from `/api/broadcast/top` or
 * `/api/broadcast/search` into a consistent item with an honest status.
 */
export function parseBroadcastItem(item, now = Date.now()) {
  const tour = item?.tour || null;
  const round = item?.round || null;

  let status = 'unknown';
  if (round?.ongoing === true) {
    status = 'live';
  } else if (round?.finished === true) {
    status = 'finished';
  } else if (typeof round?.startsAt === 'number' && round.startsAt > now) {
    status = 'upcoming';
  }

  return {
    tourId: tour?.id || '',
    tourName: tour?.name || 'Tournament',
    roundId: round?.id || '',
    roundName: round?.name || '',
    status,
    tour,
    round,
  };
}

/**
 * Combine and deduplicate `/api/broadcast/top` and `/api/broadcast/search`
 * results by `tourId`, preferring live entries over non-live duplicates.
 */
export function mergeBroadcastLists(topData, searchData, now = Date.now()) {
  const raw = [];
  if (topData) {
    (topData.active || []).forEach((item) => raw.push(parseBroadcastItem(item, now)));
    (topData.upcoming || []).slice(0, 8).forEach((item) => raw.push(parseBroadcastItem(item, now)));
  }
  if (searchData) {
    (searchData.currentPageResults || []).forEach((item) => raw.push(parseBroadcastItem(item, now)));
  }

  const byTour = new Map();
  const anonymous = [];
  for (const b of raw) {
    if (!b.tourId) {
      if (b.roundId) anonymous.push(b);
      continue;
    }
    const prev = byTour.get(b.tourId);
    if (!prev || (prev.status !== 'live' && b.status === 'live')) {
      byTour.set(b.tourId, b);
    }
  }
  return [...byTour.values(), ...anonymous];
}

/**
 * Pick the featured broadcast: prefer a live World Championship, else first
 * genuinely live broadcast, else first available broadcast.
 */
export function selectFeaturedBroadcast(items) {
  if (!Array.isArray(items) || !items.length) return null;
  const wccLive = items.find((b) => {
    const hay = `${b.tourName} ${b.roundName}`;
    return b.status === 'live' && /world (chess )?championship/i.test(hay);
  });
  if (wccLive) return wccLive;
  const anyLive = items.find((b) => b.status === 'live' && b.tourId);
  if (anyLive) return anyLive;
  return items.find((b) => b.tourId) || items[0];
}

/**
 * Pure reducer for tournament refresh & auto-advancing to a newly live round.
 */
export function computeRoundTransition({ currentRoundId, userPinnedRound, tourData }) {
  const tour = tourData?.tour;
  const rounds = tourData?.rounds || [];
  const ongoingRound = rounds.find((r) => r.ongoing === true) || null;

  if (!userPinnedRound && ongoingRound && ongoingRound.id !== currentRoundId) {
    return {
      nextRoundId: ongoingRound.id,
      nextRoundName: `${tour?.name || 'Broadcast'} · ${ongoingRound.name || ''}`,
      advanced: Boolean(currentRoundId),
      round: ongoingRound,
    };
  }

  if (!currentRoundId) {
    const chosen =
      ongoingRound ||
      (tourData?.defaultRoundId && rounds.find((r) => r.id === tourData.defaultRoundId)) ||
      [...rounds].reverse().find((r) => r.finished === true) ||
      rounds[0] ||
      null;
    if (chosen) {
      return {
        nextRoundId: chosen.id,
        nextRoundName: `${tour?.name || 'Broadcast'} · ${chosen.name || ''}`,
        advanced: false,
        round: chosen,
      };
    }
  }

  const currentRound = rounds.find((r) => r.id === currentRoundId) || null;
  return {
    nextRoundId: currentRoundId,
    nextRoundName: currentRound
      ? `${tour?.name || 'Broadcast'} · ${currentRound.name || ''}`
      : state.liveRoundName,
    advanced: false,
    round: currentRound,
  };
}

/**
 * Parse multi-game PGN returned by Lichess Broadcast Round endpoint.
 */
export function parseBroadcastRoundPgn(pgnText) {
  if (!pgnText || !pgnText.trim()) return [];
  const chunks = pgnText
    .split(/\r?\n\r?\n(?=\[Event\s+")/)
    .map((s) => s.trim())
    .filter(Boolean);

  const games = [];
  chunks.forEach((raw, idx) => {
    const getH = (k) => {
      const m = raw.match(new RegExp(`\\[${k}\\s+"([^"]*)"\\]`));
      return m ? m[1] : '';
    };
    const white = getH('White') || 'White';
    const black = getH('Black') || 'Black';
    const whiteElo = getH('WhiteElo');
    const blackElo = getH('BlackElo');
    const result = getH('Result') || '*';
    const event = getH('Event') || state.liveRoundName || 'Live Broadcast';
    const eco = getH('ECO');
    const opening = getH('Opening');
    const clocks = extractClocksFromPgn(raw);
    let wClk = '';
    let bClk = '';
    for (let i = clocks.length - 1; i >= 0; i--) {
      if (clocks[i]) {
        if (i % 2 === 0 && !wClk) wClk = clocks[i];
        if (i % 2 === 1 && !bClk) bClk = clocks[i];
      }
    }
    games.push({
      idx,
      white,
      whiteElo,
      black,
      blackElo,
      result,
      event,
      eco,
      opening,
      pgn: raw,
      whiteClk: wClk,
      blackClk: bClk,
    });
  });
  return games;
}

function getSelectedRound() {
  const rounds = state.featuredTour?.rounds || [];
  return rounds.find((r) => r.id === state.liveRoundId) || null;
}

function updateLiveIndicators(isTourLive) {
  const anyLiveBroadcast =
    isTourLive || state.allBroadcasts.some((b) => b.status === 'live');
  const hubDot = document.getElementById('liveHubDot');
  if (hubDot) {
    hubDot.className = anyLiveBroadcast
      ? 'w-2 h-2 rounded-full bg-ro live-dot'
      : 'w-2 h-2 rounded-full bg-txtMuted/50';
  }
}

function updateSpotlightBanner() {
  const titleEl = document.getElementById('featuredEventTitle');
  const subEl = document.getElementById('featuredEventSubtitle');
  const badgeEl = document.getElementById('featuredEventBadge');
  const statusEl = document.getElementById('wccBroadcastStatus');
  const watchBtn = document.getElementById('btnWatchWccLive');
  const quickJumpBtn = document.getElementById('btnLiveQuickJump');
  const quickJumpText = document.getElementById('liveQuickJumpLabel');
  const quickJumpDot = document.getElementById('liveQuickJumpDot');

  const tour = state.featuredTour?.tour;
  const rounds = state.featuredTour?.rounds || [];
  const ongoingRound = rounds.find((r) => r.ongoing === true);
  const activeRound =
    rounds.find((r) => r.id === state.liveRoundId) ||
    ongoingRound ||
    rounds[rounds.length - 1];

  const isOngoing = Boolean(ongoingRound);
  updateLiveIndicators(isOngoing);

  if (!tour) {
    if (titleEl) titleEl.textContent = 'Live FIDE & Lichess Broadcasts';
    if (subEl) subEl.textContent = 'Select a tournament below or paste any Lichess broadcast URL.';
    if (badgeEl) {
      badgeEl.innerHTML = 'LICHESS BROADCASTS';
      badgeEl.className =
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-cy/15 text-cy border border-cy/35 font-mono text-[9.5px] font-bold';
    }
    if (quickJumpText) quickJumpText.textContent = 'Broadcasts';
    if (quickJumpDot) quickJumpDot.classList.add('hidden');
    if (watchBtn) {
      watchBtn.disabled = !state.liveRoundGames.length;
      watchBtn.textContent = state.liveRoundGames.length ? '▶ Watch Top Board' : 'No Live Board';
    }
    return;
  }

  if (titleEl) titleEl.textContent = tour.name || 'Live Broadcast';
  if (subEl) {
    const infoParts = [];
    if (tour.info?.location) infoParts.push(tour.info.location);
    if (tour.info?.tc) infoParts.push(tour.info.tc);
    if (activeRound?.name) infoParts.push(activeRound.name);
    subEl.textContent = infoParts.join(' · ') || tour.description || 'Official Lichess Broadcast';
  }

  if (badgeEl) {
    badgeEl.innerHTML = isOngoing
      ? `<span class="w-1.5 h-1.5 rounded-full bg-ro live-dot"></span> LIVE BROADCAST`
      : `FEATURED BROADCAST`;
    badgeEl.className = isOngoing
      ? 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-ro/20 text-ro border border-ro/40 font-mono text-[9.5px] font-bold'
      : 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-cy/15 text-cy border border-cy/35 font-mono text-[9.5px] font-bold';
  }

  if (quickJumpText) {
    quickJumpText.textContent = isOngoing ? `LIVE: ${tour.name}` : tour.name || 'Broadcasts';
  }
  if (quickJumpDot) {
    quickJumpDot.classList.toggle('hidden', !isOngoing);
  }
  if (quickJumpBtn) {
    quickJumpBtn.className = isOngoing
      ? 'flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-ro/15 hover:bg-ro/25 border border-ro/40 text-ro text-[11px] font-semibold transition-colors shrink-0 max-w-[240px]'
      : 'flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-surface hover:bg-surfaceHover border border-borderSubtle text-txtMuted text-[11px] font-semibold transition-colors shrink-0 max-w-[240px]';
  }

  if (statusEl) {
    if (state.liveRoundGames.length) {
      const liveCount = state.liveRoundGames.filter((g) => g.result === '*').length;
      statusEl.textContent =
        liveCount > 0 ? `● ${liveCount} Live Game(s)` : `${state.liveRoundGames.length} Game(s) Loaded`;
      statusEl.className =
        liveCount > 0
          ? 'font-mono text-[10px] px-2 py-0.5 rounded bg-em/15 border border-em/35 text-em'
          : 'font-mono text-[10px] px-2 py-0.5 rounded bg-surface border border-borderSubtle text-cy';
    } else {
      statusEl.textContent = isOngoing ? '● Round Live' : 'Connected';
      statusEl.className = isOngoing
        ? 'font-mono text-[10px] px-2 py-0.5 rounded bg-em/15 border border-em/35 text-em'
        : 'font-mono text-[10px] px-2 py-0.5 rounded bg-surface border border-borderSubtle text-cy';
    }
  }

  if (watchBtn) {
    const hasGames = state.liveRoundGames.length > 0;
    watchBtn.disabled = !hasGames;
    watchBtn.classList.toggle('opacity-50', !hasGames);
    watchBtn.classList.toggle('cursor-not-allowed', !hasGames);
    watchBtn.textContent = hasGames
      ? `▶ Watch ${activeRound?.name || 'Top Board'}`
      : 'No Games Yet';
  }
}

export function renderTournamentRoundsTable() {
  const tbody = document.getElementById('wccScheduleBody');
  if (!tbody) return;

  const rounds = state.featuredTour?.rounds || [];
  if (!rounds.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="py-5 text-center text-txtMuted">
          No tournament rounds loaded yet. Click <b>Sync Live</b> or choose a tournament in <b>All Live Broadcasts</b>.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rounds
    .map((r) => {
      const isSelected = r.id === state.liveRoundId;
      const isLive = r.ongoing === true;
      const isDone = r.finished === true;

      let statusHtml = `<span class="text-txtMuted font-mono text-[10px]">Upcoming</span>`;
      if (isLive) {
        statusHtml = `<span class="inline-flex items-center gap-1 px-1.5 py-[1px] rounded bg-ro/20 text-ro font-mono font-bold text-[10px]"><span class="w-1.5 h-1.5 rounded-full bg-ro live-dot"></span>LIVE</span>`;
      } else if (isDone) {
        statusHtml = `<span class="px-1.5 py-[1px] rounded bg-surface text-txtMuted font-mono text-[10px]">Finished</span>`;
      }

      const dateStr = formatRoundDate(r.startsAt);
      const timeStr = formatRoundTime(r.startsAt);

      return `
        <tr class="round-row cursor-pointer ${isSelected ? 'bg-em/10' : ''} ${isLive ? 'bg-ro/5' : ''}" data-rid="${escapeHtml(r.id)}" data-rname="${escapeHtml(r.name || 'Round')}">
          <td class="font-medium ${isLive ? 'text-ro font-semibold' : isSelected ? 'text-em font-semibold' : 'text-txt'}">${escapeHtml(r.name || 'Round')}</td>
          <td class="font-mono text-txtMuted">${escapeHtml(dateStr)}${timeStr ? ` <span class="opacity-65">${escapeHtml(timeStr)}</span>` : ''}</td>
          <td>${statusHtml}</td>
          <td class="text-right font-mono text-[10px] ${isSelected ? 'text-em' : 'text-cy'}">${isSelected ? 'Viewing' : 'Load →'}</td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('.round-row').forEach((tr) => {
    tr.onclick = async () => {
      const rid = tr.dataset.rid;
      const rname = tr.dataset.rname;
      if (!rid) return;
      state.userPinnedRound = true;
      state.liveRoundId = rid;
      state.liveRoundName = `${state.featuredTour?.tour?.name || 'Broadcast'} · ${rname}`;
      renderTournamentRoundsTable();
      updateSpotlightBanner();
      await pollActiveRoundPgn();
    };
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

export async function selectFeaturedTournament(tourId, preferredRoundId = null, { userPicked = false } = {}) {
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
  const statusEl = document.getElementById('wccBroadcastStatus');
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
    const games = parseBroadcastRoundPgn(pgnText);
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

    // If the round was live and all games just finished, refresh tournament metadata immediately
    const selectedRound = getSelectedRound();
    const allGamesFinished = games.length > 0 && games.every((g) => g.result !== '*');
    if (allGamesFinished && (hadLiveGamesBefore || selectedRound?.ongoing === true)) {
      refreshFeaturedTournament({ silent: true });
    }
  } catch (_) {
    // Silent retry on next poll
  }
}

export function renderLiveRoundGamesStrip() {
  const box = document.getElementById('liveRoundGamesBox');
  const list = document.getElementById('liveRoundGamesList');
  if (!box || !list) return;

  if (!state.liveRoundGames.length) {
    box.classList.add('hidden');
    return;
  }

  box.classList.remove('hidden');
  document.getElementById('liveRoundTitle').textContent =
    state.liveRoundName || `Round ${state.liveRoundId}`;

  list.innerHTML = state.liveRoundGames
    .slice(0, 8)
    .map(
      (g, i) => `
      <button class="live-game-card text-left px-2 py-1.5 rounded bg-[#0c121e] hover:bg-surface border border-borderSubtle flex items-center justify-between gap-2 text-[11px] transition-colors" data-gidx="${i}">
        <div class="min-w-0">
          <div class="truncate font-medium text-txt">${escapeHtml(g.white)} <span class="text-txtMuted font-mono text-[10px]">${escapeHtml(g.whiteClk || '')}</span></div>
          <div class="truncate font-medium text-txt">${escapeHtml(g.black)} <span class="text-txtMuted font-mono text-[10px]">${escapeHtml(g.blackClk || '')}</span></div>
        </div>
        <span class="px-1.5 py-0.5 rounded font-mono text-[10px] font-bold ${
          g.result === '*' ? 'bg-ro/20 text-ro' : 'bg-surface text-txtMuted'
        } shrink-0">${g.result === '*' ? 'LIVE' : escapeHtml(g.result)}</span>
      </button>
    `
    )
    .join('');

  list.querySelectorAll('.live-game-card').forEach((btn) => {
    btn.onclick = () => {
      const g = state.liveRoundGames[parseInt(btn.dataset.gidx, 10)];
      if (g) openBroadcastGameTab(g, state.liveRoundId);
    };
  });
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

function getStatusBadgeInfo(status) {
  if (status === 'live') return { label: 'LIVE', cls: 'bg-ro/20 text-ro' };
  if (status === 'upcoming') return { label: 'SOON', cls: 'bg-panel text-txtMuted' };
  if (status === 'finished') return { label: 'ENDED', cls: 'bg-panel text-txtMuted/75' };
  return { label: 'ACTIVE', cls: 'bg-panel text-cy' };
}

export function renderAllBroadcastsList() {
  const list = document.getElementById('allBroadcastsList');
  if (!list) return;
  const q = (document.getElementById('broadcastSearchInput')?.value || '').toLowerCase();
  const filtered = state.allBroadcasts.filter((b) =>
    `${b.tourName} ${b.roundName}`.toLowerCase().includes(q)
  );
  const countBadge = document.getElementById('broadcastCountBadge');
  if (countBadge) countBadge.textContent = `${filtered.length} events`;

  if (!filtered.length) {
    list.innerHTML = `<div class="col-span-full py-4 text-center text-txtMuted text-xs">No broadcasts matched. Paste any Lichess Broadcast URL above to load directly.</div>`;
    return;
  }

  list.innerHTML = filtered
    .slice(0, 16)
    .map((b) => {
      const badge = getStatusBadgeInfo(b.status);
      return `
      <button class="bc-item text-left px-2.5 py-2 rounded bg-surface/60 hover:bg-surfaceHover border border-borderSubtle flex items-center justify-between gap-2 text-[11px]" data-tid="${escapeHtml(b.tourId)}" data-rid="${escapeHtml(b.roundId)}" data-name="${escapeHtml(b.tourName + (b.roundName ? ' · ' + b.roundName : ''))}">
        <div class="min-w-0">
          <div class="font-semibold text-txt truncate">${escapeHtml(b.tourName)}</div>
          <div class="text-[10px] text-txtMuted truncate">${escapeHtml(b.roundName || 'Round')}</div>
        </div>
        <span class="px-1.5 py-0.5 rounded font-mono text-[9.5px] font-bold shrink-0 ${badge.cls}">${badge.label}</span>
      </button>
    `;
    })
    .join('');

  list.querySelectorAll('.bc-item').forEach((btn) => {
    btn.onclick = async () => {
      const tid = btn.dataset.tid;
      const rid = btn.dataset.rid;
      showToast(`Loading ${btn.dataset.name}...`);
      if (tid) {
        await selectFeaturedTournament(tid, rid || null, { userPicked: false });
      } else if (rid) {
        state.userPinnedRound = true;
        state.liveRoundId = rid;
        state.liveRoundName = btn.dataset.name;
        await pollActiveRoundPgn();
      }
    };
  });
}

export async function loadCustomBroadcastFromInput() {
  const input = document.getElementById('customBroadcastInput');
  const raw = (input?.value || '').trim();
  if (!raw) return;

  // Match /broadcast/<slug>/<round-slug>/<roundId> or /broadcast/round/<roundId>
  const fullRoundMatch = raw.match(/lichess\.org\/broadcast\/[^/]+\/[^/]+\/([a-zA-Z0-9]{8})/);
  const directRoundMatch = raw.match(/broadcast\/round\/([a-zA-Z0-9]{8})/);
  const tourOnlyMatch = raw.match(/lichess\.org\/broadcast\/[^/]+\/([a-zA-Z0-9]{8})(?:\/?$|\?|#)/);

  if (tourOnlyMatch && !fullRoundMatch) {
    showToast(`Loading broadcast tournament ${tourOnlyMatch[1]}...`);
    await selectFeaturedTournament(tourOnlyMatch[1]);
    return;
  }

  let roundId = raw;
  if (fullRoundMatch) roundId = fullRoundMatch[1];
  else if (directRoundMatch) roundId = directRoundMatch[1];
  else {
    const parts = raw.split('/').filter(Boolean);
    roundId = parts[parts.length - 1];
  }

  state.userPinnedRound = true;
  state.liveRoundId = roundId;
  state.liveRoundName = `Custom Broadcast (${roundId})`;
  showToast(`Connecting to broadcast round ${roundId}...`);
  await pollActiveRoundPgn();
  if (state.liveRoundGames.length) {
    showToast(`Loaded ${state.liveRoundGames.length} game(s)`);
  } else {
    showToast('No games found for that Round ID (verify URL)', true);
  }
}

export function startLivePollTimer() {
  setInterval(() => {
    if (state.featuredTour?.tour?.id && Date.now() - state.lastTourRefreshAt >= TOUR_REFRESH_INTERVAL_MS) {
      refreshFeaturedTournament({ silent: true });
    }
    if (!state.liveAutoPoll) return;
    state.liveCountdown--;
    if (state.liveCountdown <= 0) {
      state.liveCountdown = 15;
      pollActiveRoundPgn();
    }
    const badge = document.getElementById('liveCountdownBadge');
    if (badge) badge.textContent = `${state.liveCountdown}s`;
  }, 1000);
}
