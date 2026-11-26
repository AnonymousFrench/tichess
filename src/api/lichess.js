import { state } from '../state.js';
import { fetchJson, fetchText } from './http.js';

export function getLichessHeaders() {
  return state.lichessToken
    ? { Accept: 'application/json', Authorization: `Bearer ${state.lichessToken}` }
    : { Accept: 'application/json' };
}

export async function fetchTopBroadcasts({ signal } = {}) {
  return fetchJson('https://lichess.org/api/broadcast/top', {
    signal,
    headers: { Accept: 'application/json' },
  });
}

export async function searchBroadcasts(query, { signal } = {}) {
  return fetchJson(
    `https://lichess.org/api/broadcast/search?q=${encodeURIComponent(query)}`,
    { signal, headers: { Accept: 'application/json' } }
  );
}

export async function fetchBroadcastTournament(tourId, { signal } = {}) {
  return fetchJson(
    `https://lichess.org/api/broadcast/${encodeURIComponent(tourId)}`,
    { signal, headers: { Accept: 'application/json' } }
  );
}

export async function fetchBroadcastRoundById(roundId, { signal } = {}) {
  return fetchJson(
    `https://lichess.org/api/broadcast/-/-/${encodeURIComponent(roundId)}`,
    { signal, headers: { Accept: 'application/json' } }
  );
}

export async function fetchBroadcastRoundPgn(roundId, { signal } = {}) {
  return fetchText(
    `https://lichess.org/api/broadcast/round/${encodeURIComponent(roundId)}.pgn`,
    { signal }
  );
}

export async function fetchExplorer(source, fen, { signal } = {}) {
  const url =
    source === 'masters'
      ? `https://explorer.lichess.org/masters?fen=${encodeURIComponent(fen)}&topGames=8&recentGames=4`
      : `https://explorer.lichess.org/lichess?fen=${encodeURIComponent(fen)}&ratings=2000,2200,2500&speeds=blitz,rapid,classical&topGames=4&recentGames=6`;

  try {
    return await fetchJson(url, { signal, headers: getLichessHeaders() });
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      const authErr = new Error('Lichess token required');
      authErr.authRequired = true;
      throw authErr;
    }
    throw err;
  }
}

export async function fetchExplorerGamePgn(source, gameId, { signal } = {}) {
  const url =
    source === 'masters'
      ? `https://explorer.lichess.org/masters/pgn/${encodeURIComponent(gameId)}`
      : `https://lichess.org/game/export/${encodeURIComponent(gameId)}?evals=0&clocks=0`;
  return fetchText(url, { signal, headers: getLichessHeaders() });
}

export async function fetchCloudEval(fen, multiPv = 3, { signal } = {}) {
  return fetchJson(
    `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPv}`,
    { signal, allow404: true }
  );
}

/**
 * Parse Lichess NDJSON user-games response (`pgnInJson=true`) into normalized
 * game objects suitable for Player Scout IndexedDB indexing.
 */
export function parseLichessNdjsonGames(ndjsonText) {
  if (!ndjsonText || typeof ndjsonText !== 'string') return [];
  const games = [];
  for (const rawLine of ndjsonText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let g;
    try {
      g = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (!g || g.variant !== 'standard' || typeof g.pgn !== 'string' || !g.pgn.trim()) continue;
    const white = g.players?.white?.user?.name || 'White';
    const black = g.players?.black?.user?.name || 'Black';
    const whiteElo = Number(g.players?.white?.rating) || 0;
    const blackElo = Number(g.players?.black?.rating) || 0;
    const result = g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : '1/2-1/2';
    const date = g.createdAt ? new Date(g.createdAt).toISOString().slice(0, 10) : '';
    const event = `Lichess ${g.perf || g.speed || ''}`.trim();
    games.push({ pgn: g.pgn, white, whiteElo, black, blackElo, result, date, event });
  }
  return games;
}

export async function fetchLichessUserGames(username, { max = 100, perfType = '', signal } = {}) {
  const params = new URLSearchParams({
    max: String(max),
    pgnInJson: 'true',
    opening: 'true',
    clocks: 'false',
    evals: 'false',
  });
  if (perfType) params.set('perfType', perfType);

  const headers = { Accept: 'application/x-ndjson' };
  if (state.lichessToken) {
    headers.Authorization = `Bearer ${state.lichessToken}`;
  }

  try {
    const text = await fetchText(
      `https://lichess.org/api/games/user/${encodeURIComponent(username)}?${params.toString()}`,
      { signal, headers }
    );
    return parseLichessNdjsonGames(text);
  } catch (err) {
    if (err.status === 404) {
      throw new Error(`Player "${username}" not found on Lichess`, { cause: err });
    }
    throw err;
  }
}
