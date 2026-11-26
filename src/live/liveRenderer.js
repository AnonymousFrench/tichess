import { state, escapeHtml } from '../state.js';

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

function getStatusBadgeInfo(status) {
  if (status === 'live') return { label: 'LIVE', cls: 'bg-ro/20 text-ro' };
  if (status === 'upcoming') return { label: 'SOON', cls: 'bg-panel text-txtMuted' };
  if (status === 'finished') return { label: 'ENDED', cls: 'bg-panel text-txtMuted/75' };
  return { label: 'ACTIVE', cls: 'bg-panel text-cy' };
}

export function updateLiveIndicators(isTourLive) {
  const anyLiveBroadcast =
    isTourLive || state.allBroadcasts.some((b) => b.status === 'live');
  const hubDot = document.getElementById('liveHubDot');
  if (hubDot) {
    hubDot.className = anyLiveBroadcast
      ? 'w-2 h-2 rounded-full bg-ro live-dot'
      : 'w-2 h-2 rounded-full bg-txtMuted/50';
  }
}

export function updateSpotlightBanner() {
  const titleEl = document.getElementById('featuredEventTitle');
  const subEl = document.getElementById('featuredEventSubtitle');
  const badgeEl = document.getElementById('featuredEventBadge');
  const statusEl = document.getElementById('featuredStatus');
  const watchBtn = document.getElementById('btnWatchFeatured');
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

export function renderTournamentRoundsTable({ onSelectRound } = {}) {
  const tbody = document.getElementById('roundsTableBody');
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

  if (onSelectRound) {
    tbody.querySelectorAll('.round-row').forEach((tr) => {
      tr.onclick = () => {
        const rid = tr.dataset.rid;
        const rname = tr.dataset.rname;
        if (rid) onSelectRound(rid, rname);
      };
    });
  }
}

export function renderLiveRoundGamesStrip({ onOpenGame } = {}) {
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

  if (onOpenGame) {
    list.querySelectorAll('.live-game-card').forEach((btn) => {
      btn.onclick = () => {
        const g = state.liveRoundGames[parseInt(btn.dataset.gidx, 10)];
        if (g) onOpenGame(g, state.liveRoundId);
      };
    });
  }
}

export function renderAllBroadcastsList({ onSelectBroadcast } = {}) {
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

  if (onSelectBroadcast) {
    list.querySelectorAll('.bc-item').forEach((btn) => {
      btn.onclick = () => onSelectBroadcast(btn.dataset.tid, btn.dataset.rid, btn.dataset.name);
    });
  }
}
