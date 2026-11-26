import { state } from '../state.js';

export function getLichessHeaders() {
  return state.lichessToken
    ? { Accept: 'application/json', Authorization: `Bearer ${state.lichessToken}` }
    : { Accept: 'application/json' };
}

export async function fetchTopBroadcasts() {
  const resp = await fetch('https://lichess.org/api/broadcast/top', {
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`Broadcast top failed (${resp.status})`);
  return resp.json();
}

export async function searchBroadcasts(query) {
  const resp = await fetch(
    `https://lichess.org/api/broadcast/search?q=${encodeURIComponent(query)}`,
    { headers: { Accept: 'application/json' } }
  );
  if (!resp.ok) throw new Error(`Broadcast search failed (${resp.status})`);
  return resp.json();
}

export async function fetchBroadcastTournament(tourId) {
  const resp = await fetch(
    `https://lichess.org/api/broadcast/${encodeURIComponent(tourId)}`,
    { headers: { Accept: 'application/json' } }
  );
  if (!resp.ok) throw new Error(`Broadcast tournament failed (${resp.status})`);
  return resp.json();
}

export async function fetchBroadcastRoundPgn(roundId) {
  const resp = await fetch(
    `https://lichess.org/api/broadcast/round/${encodeURIComponent(roundId)}.pgn`
  );
  if (!resp.ok) throw new Error(`Broadcast round PGN failed (${resp.status})`);
  return resp.text();
}

export async function fetchExplorer(source, fen) {
  const url =
    source === 'masters'
      ? `https://explorer.lichess.org/masters?fen=${encodeURIComponent(fen)}&topGames=8&recentGames=4`
      : `https://explorer.lichess.org/lichess?fen=${encodeURIComponent(fen)}&ratings=2000,2200,2500&speeds=blitz,rapid,classical&topGames=4&recentGames=6`;

  const resp = await fetch(url, { headers: getLichessHeaders() });
  if (resp.status === 401 || resp.status === 403) {
    const err = new Error('Lichess token required');
    err.authRequired = true;
    throw err;
  }
  if (!resp.ok) throw new Error(`Explorer failed (${resp.status})`);
  return resp.json();
}

export async function fetchExplorerGamePgn(source, gameId) {
  const url =
    source === 'masters'
      ? `https://explorer.lichess.org/masters/pgn/${encodeURIComponent(gameId)}`
      : `https://lichess.org/game/export/${encodeURIComponent(gameId)}?evals=0&clocks=0`;
  const resp = await fetch(url, { headers: getLichessHeaders() });
  if (!resp.ok) throw new Error(`Failed to fetch game PGN (${resp.status})`);
  return resp.text();
}

export async function fetchCloudEval(fen, multiPv = 3) {
  const resp = await fetch(
    `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPv}`
  );
  if (!resp.ok) return null;
  return resp.json();
}
