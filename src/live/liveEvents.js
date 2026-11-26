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
import { createTreeFromPgn, extractClocksFromPgn } from '../chess/tree.js';
import { renderPlayerClockBars } from '../board/board.js';
import { addBoardTab } from '../board/tabs.js';

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
      pgn: raw,
      whiteClk: wClk,
      blackClk: bClk,
    });
  });
  return games;
}

function updateSpotlightBanner() {
  const titleEl = document.getElementById('featuredEventTitle');
  const subEl = document.getElementById('featuredEventSubtitle');
  const badgeEl = document.getElementById('featuredEventBadge');
  const statusEl = document.getElementById('wccBroadcastStatus');
  const watchBtn = document.getElementById('btnWatchWccLive');
  const quickJumpText = document.getElementById('liveQuickJumpLabel');
  const quickJumpDot = document.getElementById('liveQuickJumpDot');

  const tour = state.featuredTour?.tour;
  const rounds = state.featuredTour?.rounds || [];
  const ongoingRound = rounds.find((r) => r.ongoing);
  const activeRound =
    rounds.find((r) => r.id === state.liveRoundId) ||
    ongoingRound ||
    rounds[rounds.length - 1];

  if (!tour) {
    if (titleEl) titleEl.textContent = 'Live FIDE & Lichess Broadcasts';
    if (subEl) subEl.textContent = 'Select a tournament below or paste any Lichess broadcast URL.';
    if (badgeEl) badgeEl.innerHTML = 'LICHESS BROADCASTS';
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

  const isOngoing = Boolean(ongoingRound);
  if (badgeEl) {
    badgeEl.innerHTML = isOngoing
      ? `<span class="w-1.5 h-1.5 rounded-full bg-ro live-dot"></span> LIVE BROADCAST`
      : `FEATURED BROADCAST`;
    badgeEl.className = isOngoing
      ? 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-ro/20 text-ro border border-ro/40 font-mono text-[9.5px] font-bold'
      : 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-cy/15 text-cy border border-cy/35 font-mono text-[9.5px] font-bold';
  }

  if (quickJumpText) {
    quickJumpText.textContent = isOngoing
      ? `LIVE: ${tour.name}`
      : `Broadcasts`;
  }
  if (quickJumpDot) {
    quickJumpDot.classList.toggle('hidden', !isOngoing);
  }

  if (statusEl) {
    if (state.liveRoundGames.length) {
      const liveCount = state.liveRoundGames.filter((g) => g.result === '*').length;
      statusEl.textContent = liveCount > 0 ? `● ${liveCount} Live Game(s)` : `${state.liveRoundGames.length} Game(s) Loaded`;
      statusEl.className =
        liveCount > 0
          ? 'font-mono text-[10px] px-2 py-0.5 rounded bg-em/15 border border-em/35 text-em'
          : 'font-mono text-[10px] px-2 py-0.5 rounded bg-surface border border-borderSubtle text-cy';
    } else {
      statusEl.textContent = isOngoing ? '● Round Live' : 'Connected';
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
      const isLive = Boolean(r.ongoing);
      const isDone = Boolean(r.finished);

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
      state.liveRoundId = rid;
      state.liveRoundName = `${state.featuredTour?.tour?.name || 'Broadcast'} · ${rname}`;
      renderTournamentRoundsTable();
      await pollActiveRoundPgn();
    };
  });
}

export async function selectFeaturedTournament(tourId, preferredRoundId = null) {
  try {
    const full = await fetchBroadcastTournament(tourId);
    state.featuredTour = full;
    const rounds = full.rounds || [];
    const chosen =
      (preferredRoundId && rounds.find((r) => r.id === preferredRoundId)) ||
      rounds.find((r) => r.ongoing) ||
      [...rounds].reverse().find((r) => r.finished) ||
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

    const broadcasts = [];
    if (topRes.status === 'fulfilled') {
      const td = topRes.value;
      const active = td.active || [];
      const upcoming = td.upcoming || [];
      active.forEach((item) => broadcasts.push({ ...item, isLive: true }));
      upcoming.slice(0, 8).forEach((item) => broadcasts.push({ ...item, isLive: false }));
    }

    if (searchRes.status === 'fulfilled') {
      const sd = searchRes.value;
      (sd.currentPageResults || []).forEach((t) => {
        if (!broadcasts.some((b) => b.tour?.id === t.id)) {
          const ongoing = t.rounds?.find((r) => r.ongoing);
          const round = ongoing || t.rounds?.[t.rounds.length - 1];
          broadcasts.push({ tour: t, round, isLive: Boolean(ongoing) });
        }
      });
    }

    state.allBroadcasts = broadcasts;
    renderAllBroadcastsList();

    // Prefer an active World Championship broadcast if one exists; otherwise top active broadcast
    const wccMatch = broadcasts.find((b) => {
      const hay = `${b.tour?.name || ''} ${b.round?.name || ''}`.toLowerCase();
      return b.isLive && hay.includes('world championship');
    });
    const fallbackMatch = broadcasts.find((b) => b.isLive && b.tour?.id) || broadcasts[0];
    const picked = wccMatch || fallbackMatch;

    if (picked?.tour?.id) {
      await selectFeaturedTournament(picked.tour.id, picked.round?.id || null);
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
    state.liveRoundGames = games;
    renderLiveRoundGamesStrip();
    updateSpotlightBanner();

    // Update any open LIVE board tabs matching this round
    let updatedActive = false;
    for (const tab of state.tabs) {
      if (tab.liveMeta && tab.liveMeta.roundId === state.liveRoundId) {
        const matched =
          games.find((g) => g.white === tab.liveMeta.white && g.black === tab.liveMeta.black) ||
          games[tab.liveMeta.gameIdx];
        if (matched && matched.pgn) {
          const { root, current, meta } = createTreeFromPgn(matched.pgn);
          tab.root = root;
          tab.meta = meta || tab.meta;
          tab.liveClocks = { white: matched.whiteClk, black: matched.blackClk };
          if (tab.autoFollow) tab.current = current;
          if (tab.id === state.activeTabId) updatedActive = true;
        }
      }
    }
    if (updatedActive) emitPositionChanged();
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
    },
    {
      jumpEnd: true,
      liveMeta: { roundId, white: g.white, black: g.black, gameIdx: g.idx },
    }
  );
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

export function renderAllBroadcastsList() {
  const list = document.getElementById('allBroadcastsList');
  if (!list) return;
  const q = (document.getElementById('broadcastSearchInput')?.value || '').toLowerCase();
  const filtered = state.allBroadcasts.filter((b) =>
    `${b.tour?.name || ''} ${b.round?.name || ''}`.toLowerCase().includes(q)
  );
  document.getElementById('broadcastCountBadge').textContent = `${filtered.length} events`;

  if (!filtered.length) {
    list.innerHTML = `<div class="col-span-full py-4 text-center text-txtMuted text-xs">No broadcasts matched. Paste any Lichess Broadcast URL above to load directly.</div>`;
    return;
  }

  list.innerHTML = filtered
    .slice(0, 16)
    .map(
      (b) => `
      <button class="bc-item text-left px-2.5 py-2 rounded bg-surface/60 hover:bg-surfaceHover border border-borderSubtle flex items-center justify-between gap-2 text-[11px]" data-tid="${escapeHtml(b.tour?.id || '')}" data-rid="${escapeHtml(b.round?.id || '')}" data-name="${escapeHtml((b.tour?.name || 'Broadcast') + ' · ' + (b.round?.name || ''))}">
        <div class="min-w-0">
          <div class="font-semibold text-txt truncate">${escapeHtml(b.tour?.name || 'Tournament')}</div>
          <div class="text-[10px] text-txtMuted truncate">${escapeHtml(b.round?.name || 'Round')}</div>
        </div>
        <span class="px-1.5 py-0.5 rounded font-mono text-[9.5px] font-bold shrink-0 ${
          b.isLive ? 'bg-ro/20 text-ro' : 'bg-panel text-txtMuted'
        }">${b.isLive ? 'LIVE' : 'SOON'}</span>
      </button>
    `
    )
    .join('');

  list.querySelectorAll('.bc-item').forEach((btn) => {
    btn.onclick = async () => {
      const tid = btn.dataset.tid;
      const rid = btn.dataset.rid;
      showToast(`Loading ${btn.dataset.name}...`);
      if (tid) {
        await selectFeaturedTournament(tid, rid || null);
      } else if (rid) {
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
