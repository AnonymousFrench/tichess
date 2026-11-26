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
