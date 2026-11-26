import { state, escapeHtml } from '../state.js';

/*
 * Live hub, two views:
 *   events: compact list (Live now / Ongoing / Upcoming / Recently finished) with search
 *   event:  one event, every round as a chip, and the selected round's games as rows
 * Rendering is pure DOM writes from `state`; liveEvents.js owns data and handlers.
 */

const SECTION_LIMIT = 8;
const expandedSections = new Set();

function fmtDay(t) {
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtDayTime(t) {
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}

const liveDot = '<span class="w-1.5 h-1.5 rounded-full bg-ro live-dot shrink-0"></span>';

/** Red dot on the hub tab and the header pill whenever something is live. */
export function updateLiveIndicators() {
  const anyLive = state.liveSections.live.length > 0 || state.featuredTour?.rounds?.some((r) => r.ongoing === true);
  const hubDot = document.getElementById('liveHubDot');
  if (hubDot) {
    hubDot.className = anyLive ? 'w-2 h-2 rounded-full bg-ro live-dot' : 'w-2 h-2 rounded-full bg-txtMuted/50';
  }
  const pick = state.liveSections.live[0] || null;
  const pill = document.getElementById('btnLiveQuickJump');
  const label = document.getElementById('liveQuickJumpLabel');
  const dot = document.getElementById('liveQuickJumpDot');
  if (label) label.textContent = pick ? pick.tourName : 'Live events';
  if (dot) dot.classList.toggle('hidden', !pick);
  if (pill) {
    pill.title = pick ? `Live now: ${pick.tourName}` : 'Open live events';
    pill.className = pick
      ? 'hidden lg:flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-ro/15 hover:bg-ro/25 border border-ro/40 text-ro text-[11px] font-semibold transition-colors min-w-0 max-w-[240px]'
      : 'hidden lg:flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-surface hover:bg-surfaceHover border border-borderSubtle text-txtMuted text-[11px] font-semibold transition-colors min-w-0 max-w-[240px]';
  }
}

/* ------------------------------------------------------------------ */
/* Events list                                                         */
/* ------------------------------------------------------------------ */

function eventRight(b) {
  const r = b.round || {};
  if (b.status === 'live') {
    return `<span class="inline-flex items-center gap-1 text-ro font-semibold">${liveDot}${escapeHtml(b.roundName || 'Live')}</span>`;
  }
  if (typeof r.startsAt === 'number' && r.startsAt > Date.now()) {
    return `<span class="text-txtMuted">${escapeHtml(b.roundName ? `${b.roundName} · ` : '')}${escapeHtml(fmtDayTime(r.startsAt))}</span>`;
  }
  if (b.dates?.[1] && b.dates[1] < Date.now()) {
    return `<span class="text-txtMuted">Ended ${escapeHtml(fmtDay(b.dates[1]))}</span>`;
  }
  return `<span class="text-txtMuted">${escapeHtml(b.roundName || '')}</span>`;
}

function eventRow(b) {
  const sub = [b.info?.format, b.info?.location].filter(Boolean).join(' · ');
  return `<button class="live-event-row w-full text-left grid grid-cols-[1fr_auto] items-center gap-x-3 px-2 py-1.5 rounded-md hover:bg-surface transition-colors" data-tid="${escapeHtml(b.tourId)}" data-rid="${escapeHtml(b.roundId)}">
      <span class="min-w-0">
        <span class="block truncate text-[11.5px] font-semibold text-txt">${escapeHtml(b.tourName)}</span>
        ${sub ? `<span class="block truncate text-[10px] text-txtMuted">${escapeHtml(sub)}</span>` : ''}
      </span>
      <span class="text-[10.5px] whitespace-nowrap text-right">${eventRight(b)}</span>
    </button>`;
}

function section(id, title, items) {
  if (!items.length) return '';
  const open = expandedSections.has(id);
  const shown = open ? items : items.slice(0, SECTION_LIMIT);
  const more = items.length - shown.length;
  return `<section class="mb-1.5">
      <h4 class="px-2 pt-1 pb-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-txtMuted">${escapeHtml(title)} <span class="font-mono normal-case tracking-normal">${items.length}</span></h4>
      ${shown.map(eventRow).join('')}
      ${more > 0 ? `<button class="live-more px-2 py-1 text-[10.5px] text-cy hover:underline" data-sec="${id}">Show ${more} more</button>` : ''}
    </section>`;
}

export function renderEventsList({ onOpenEvent } = {}) {
  const list = document.getElementById('liveEventsList');
  if (!list) return;
  const q = (document.getElementById('customBroadcastInput')?.value || '').trim().toLowerCase();
  const match = (b) => !q || `${b.tourName} ${b.roundName} ${b.info?.location || ''} ${b.info?.players || ''}`.toLowerCase().includes(q);
  const S = state.liveSections;
  const searching = q.length >= 3 && state.liveSearch.q === q;
  const searchHits = searching
    ? state.liveSearch.results.filter((b) => ![...S.live, ...S.ongoing, ...S.upcoming, ...S.recent].some((x) => x.tourId === b.tourId))
    : [];

  let html =
    section('live', 'Live now', S.live.filter(match)) +
    section('ongoing', 'Ongoing', S.ongoing.filter(match)) +
    section('upcoming', 'Upcoming', S.upcoming.filter(match)) +
    section('recent', 'Recently finished', S.recent.filter(match)) +
    section('search', 'More results', searchHits);

  if (!html) {
    if (state.liveSearch.loading) {
      html = '<div class="py-6 text-center text-[11px] text-txtMuted">Searching Lichess…</div>';
    } else if (state.liveStatus === 'loading') {
      html = '<div class="py-6 text-center text-[11px] text-txtMuted">Loading events…</div>';
    } else if (state.liveStatus === 'error') {
      html = '<div class="py-6 text-center text-[11px] text-txtMuted">Lichess is unreachable right now. Paste a broadcast link above, or try again with ↻.</div>';
    } else {
      html = `<div class="py-6 text-center text-[11px] text-txtMuted">${q ? 'No events match. Press Enter to search all of Lichess.' : 'No events right now.'}</div>`;
    }
  }
  list.innerHTML = html;

  list.querySelectorAll('.live-event-row').forEach((btn) => {
    btn.onclick = () => onOpenEvent?.(btn.dataset.tid, btn.dataset.rid);
  });
  list.querySelectorAll('.live-more').forEach((btn) => {
    btn.onclick = () => {
      expandedSections.add(btn.dataset.sec);
      renderEventsList({ onOpenEvent });
    };
  });
}

/* ------------------------------------------------------------------ */
/* One event                                                           */
/* ------------------------------------------------------------------ */

function roundChip(r) {
  const sel = r.id === state.liveRoundId;
  const live = r.ongoing === true;
  const done = r.finished === true && !live;
  const when = !live && !done && r.startsAt ? fmtDay(r.startsAt) : '';
  const base = 'live-round-chip inline-flex items-center gap-1 px-2 py-[3px] rounded-md border text-[10.5px] whitespace-nowrap transition-colors';
  const tone = sel
    ? 'bg-em text-[#041f15] border-em font-bold'
    : live
      ? 'bg-ro/10 border-ro/40 text-ro font-semibold hover:bg-ro/20'
      : done
        ? 'bg-surface border-borderSubtle text-txt hover:bg-surfaceHover'
        : 'bg-transparent border-borderSubtle text-txtMuted hover:text-txt';
  return `<button class="${base} ${tone}" data-rid="${escapeHtml(r.id)}" aria-pressed="${sel}" title="${escapeHtml(
    [r.name, r.startsAt ? fmtDayTime(r.startsAt) : '', live ? 'live' : done ? 'finished' : 'not started'].filter(Boolean).join(' · ')
  )}">${live && !sel ? liveDot : ''}${escapeHtml(r.name || 'Round')}${when ? `<span class="opacity-70 font-normal">${escapeHtml(when)}</span>` : ''}</button>`;
}

const resultLabel = (res) => (res === '1/2-1/2' ? '½-½' : res);

function gameRow(g, i) {
  const live = g.result === '*';
  const player = (name, elo, clk, white) => `<span class="flex items-center gap-1.5 min-w-0">
      <span class="w-2 h-2 rounded-[2px] shrink-0 ${white ? 'bg-[#e5e7eb]' : 'bg-[#2a2f3a] border border-[#5b6273]'}"></span>
      <span class="truncate text-txt">${escapeHtml(name)}</span>
      ${elo ? `<span class="font-mono text-[10px] text-txtMuted shrink-0">${escapeHtml(elo)}</span>` : ''}
      ${live && clk ? `<span class="ml-auto font-mono text-[10px] text-txtMuted shrink-0">${escapeHtml(clk)}</span>` : ''}
    </span>`;
  return `<button class="live-game-row w-full text-left grid grid-cols-[42px_1fr] items-center gap-2 px-2 py-1 rounded-md hover:bg-surface border-b border-borderSubtle/50 last:border-0 text-[11px] transition-colors" data-gidx="${i}">
      <span class="text-center font-mono text-[10px] font-bold rounded px-1 py-[2px] ${live ? 'bg-ro/20 text-ro' : 'bg-surface text-txtMuted'}">${live ? 'LIVE' : escapeHtml(resultLabel(g.result))}</span>
      <span class="min-w-0 grid gap-[1px]">${player(g.white, g.whiteElo, g.whiteClk, true)}${player(g.black, g.blackElo, g.blackClk, false)}</span>
    </button>`;
}

export function renderEventView({ onBack, onSelectRound, onOpenGame } = {}) {
  const head = document.getElementById('liveEventHeader');
  const chips = document.getElementById('liveRoundChips');
  const gamesEl = document.getElementById('liveRoundGames');
  if (!head || !chips || !gamesEl) return;

  const tour = state.featuredTour?.tour;
  const rounds = state.featuredTour?.rounds || [];
  const live = rounds.some((r) => r.ongoing === true);
  const info = tour?.info || {};
  const sub = [info.format, info.location, info.tc].filter(Boolean).join(' · ');
  head.innerHTML = `<div class="flex items-start gap-2">
      <button id="btnLiveBack" class="shrink-0 px-1.5 py-0.5 rounded hover:bg-surface text-txtMuted hover:text-txt text-[11px]" title="All events" aria-label="Back to all events">← Events</button>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5 min-w-0"><span class="font-bold text-[12.5px] text-txt truncate">${escapeHtml(tour?.name || (state.liveStatus === 'loading' ? 'Loading…' : 'Broadcast'))}</span>${live ? liveDot : ''}</div>
        ${sub ? `<div class="text-[10px] text-txtMuted truncate">${escapeHtml(sub)}</div>` : ''}
      </div>
      ${tour?.url ? `<a href="${escapeHtml(tour.url)}" target="_blank" rel="noopener noreferrer" class="shrink-0 text-[10.5px] text-cy hover:underline">Lichess ↗</a>` : ''}
    </div>`;

  chips.innerHTML = rounds.length
    ? `<div class="flex flex-wrap gap-1">${rounds.map(roundChip).join('')}</div>`
    : '';

  const round = rounds.find((r) => r.id === state.liveRoundId);
  const games = state.liveRoundGames;
  const liveCount = games.filter((g) => g.result === '*').length;
  let body;
  if (state.liveRoundLoading && !games.length) {
    body = '<div class="py-5 text-center text-[11px] text-txtMuted">Loading games…</div>';
  } else if (!games.length) {
    const notStarted = round && round.ongoing !== true && round.finished !== true;
    body = `<div class="py-5 text-center text-[11px] text-txtMuted">${
      notStarted && round.startsAt ? `${escapeHtml(round.name || 'This round')} starts ${escapeHtml(fmtDayTime(round.startsAt))}.` : 'No games in this round yet.'
    }</div>`;
  } else {
    body = `<div class="flex items-center justify-between px-2 pt-1 pb-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-txtMuted">
        <span>${escapeHtml(round?.name || 'Games')} · ${games.length} game${games.length === 1 ? '' : 's'}${liveCount ? ` · <span class="text-ro">${liveCount} live</span>` : ''}</span>
        <span class="normal-case tracking-normal font-normal">Click a game to open it</span>
      </div>
      <div>${games.map(gameRow).join('')}</div>`;
  }
  gamesEl.innerHTML = body;

  const back = document.getElementById('btnLiveBack');
  if (back) back.onclick = () => onBack?.();
  chips.querySelectorAll('.live-round-chip').forEach((btn) => {
    btn.onclick = () => onSelectRound?.(btn.dataset.rid);
  });
  gamesEl.querySelectorAll('.live-game-row').forEach((btn) => {
    btn.onclick = () => {
      const g = state.liveRoundGames[parseInt(btn.dataset.gidx, 10)];
      if (g) onOpenGame?.(g, state.liveRoundId);
    };
  });
}

/** Show the list or the event, and the poll controls only where they mean something. */
export function showLiveView() {
  const ev = state.liveView === 'event';
  document.getElementById('liveEventsView')?.classList.toggle('hidden', ev);
  document.getElementById('liveEventView')?.classList.toggle('hidden', !ev);
  document.getElementById('livePollBar')?.classList.toggle('hidden', state.activeHub !== 'live');
}
