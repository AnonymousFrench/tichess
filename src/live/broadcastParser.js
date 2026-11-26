import { extractClocksFromPgn } from '../chess/tree.js';

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
 * Events grouped the way people look for them: what is live right now, what is
 * running between rounds, what is coming, and what just ended (so finished
 * rounds and games stay one click away). Each event appears once.
 *   live / ongoing: `/api/broadcast/top` active tours, split by whether a round is on
 *   upcoming:       `/api/broadcast/top` upcoming tours
 *   recent:         `/api/broadcast/top` past tours (first page)
 * A live result from `searchData` that the top list missed joins "live".
 * Order within a group is Lichess's own ranking (tier, then recency).
 */
export function buildEventSections(topData, searchData = null, now = Date.now()) {
  const seen = new Set();
  const take = (items) => {
    const out = [];
    for (const it of items || []) {
      const b = parseBroadcastItem(it, now);
      const key = b.tourId || b.roundId;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ ...b, info: b.tour?.info || null, tier: b.tour?.tier || 0, dates: b.tour?.dates || null });
    }
    return out;
  };
  const active = take(topData?.active);
  const upcoming = take(topData?.upcoming);
  const recent = take(topData?.past?.currentPageResults);
  const extraLive = take((searchData?.currentPageResults || []).filter((it) => it?.round?.ongoing === true));
  const all = [...extraLive, ...active];
  return {
    live: all.filter((b) => b.status === 'live'),
    ongoing: all.filter((b) => b.status !== 'live'),
    upcoming,
    recent,
  };
}

/** True for text that is a Lichess broadcast link or an 8-character id (ids always contain a digit). */
export function looksLikeBroadcastRef(raw) {
  const s = (raw || '').trim();
  if (/lichess\.org\/broadcast\//i.test(s)) return true;
  return /^[a-zA-Z0-9]{8}$/.test(s) && /\d/.test(s);
}

/** Round to show when an event opens: the asked-for one, the live one, Lichess's default, the last finished, or the first. */
export function pickRound(tourData, preferredRoundId = null) {
  const rounds = tourData?.rounds || [];
  return (
    (preferredRoundId && rounds.find((r) => r.id === preferredRoundId)) ||
    rounds.find((r) => r.ongoing === true) ||
    (tourData?.defaultRoundId && rounds.find((r) => r.id === tourData.defaultRoundId)) ||
    [...rounds].reverse().find((r) => r.finished === true) ||
    rounds[0] ||
    null
  );
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
export function computeRoundTransition({
  currentRoundId,
  currentRoundName = '',
  userPinnedRound,
  tourData,
}) {
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
      : currentRoundName,
    advanced: false,
    round: currentRound,
  };
}

/**
 * Parse multi-game PGN returned by Lichess Broadcast Round endpoint.
 */
export function parseBroadcastRoundPgn(pgnText, fallbackEvent = 'Live Broadcast') {
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
    const event = getH('Event') || fallbackEvent;
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

/**
 * Parse a pasted Lichess broadcast URL or raw ID into `{ type: 'round'|'tour', id }`.
 */
export function parseBroadcastInput(raw) {
  const s = (raw || '').trim();
  if (!s) return null;

  // Match /broadcast/<slug>/<round-slug>/<roundId> (optionally followed by /<gameId>)
  const fullRoundMatch = s.match(
    /lichess\.org\/broadcast\/[^/]+\/[^/]+\/([a-zA-Z0-9]{8})(?:\/[a-zA-Z0-9]{8})?(?:\/?$|\?|#)/
  );
  if (fullRoundMatch) return { type: 'round', id: fullRoundMatch[1] };

  // Match /broadcast/round/<roundId>
  const directRoundMatch = s.match(/broadcast\/round\/([a-zA-Z0-9]{8})/);
  if (directRoundMatch) return { type: 'round', id: directRoundMatch[1] };

  // Match /broadcast/<slug>/<tourId>
  const tourOnlyMatch = s.match(/lichess\.org\/broadcast\/[^/]+\/([a-zA-Z0-9]{8})(?:\/?$|\?|#)/);
  if (tourOnlyMatch) return { type: 'tour', id: tourOnlyMatch[1] };

  // Bare 8-char ID or last path segment
  const bareId = s.match(/^([a-zA-Z0-9]{8})$/);
  if (bareId) return { type: 'round', id: bareId[1] };

  const clean = s.split(/[?#]/)[0];
  const parts = clean.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  return last ? { type: 'round', id: last } : null;
}
