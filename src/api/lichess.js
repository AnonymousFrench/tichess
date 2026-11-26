import { Chess } from 'chess.js';
import { state, START_FEN, normalizeFen } from '../state.js';
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

export function parseExplorerPlayerNdjson(ndjsonText) {
  if (!ndjsonText || typeof ndjsonText !== 'string') {
    return { white: 0, draws: 0, black: 0, moves: [], recentGames: [] };
  }
  const lines = ndjsonText.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {
      // Keep scanning backwards for last complete JSON object
    }
  }
  return { white: 0, draws: 0, black: 0, moves: [], recentGames: [] };
}

// In-memory cache of a user's recent Lichess games for instant zero-token fallback
const playerFallbackCache = new Map(); // lowerUsername -> { fetchedAt, games, indexByColor: { white: Map, black: Map } }
const FALLBACK_CACHE_TTL_MS = 10 * 60 * 1000;

export function buildLocalPlayerExplorerIndex(games, username) {
  const lower = String(username || '').toLowerCase();
  const byColor = { white: new Map(), black: new Map() };

  for (const g of games || []) {
    if (!g?.pgn) continue;
    const isWhite = (g.white || '').toLowerCase() === lower;
    const isBlack = (g.black || '').toLowerCase() === lower;
    if (!isWhite && !isBlack) continue;
    const pCol = isWhite ? 'white' : 'black';
    const targetMap = byColor[pCol];

    const parser = new Chess();
    try {
      parser.loadPgn(g.pgn, { strict: false });
    } catch (_) {
      continue;
    }
    const headers = parser.getHeaders();
    const startFen = headers.FEN || START_FEN;
    const verbose = parser.history({ verbose: true });
    if (!verbose.length) continue;

    let replay;
    try {
      replay = new Chess(startFen);
    } catch (_) {
      continue;
    }

    const winner = g.result === '1-0' ? 'white' : g.result === '0-1' ? 'black' : null;
    const gameSummary = {
      id: g.id || `${g.date}_${g.white}_${g.black}`,
      winner,
      white: { name: g.white, rating: g.whiteElo || 0 },
      black: { name: g.black, rating: g.blackElo || 0 },
      month: (g.date || '').slice(0, 7),
      pgn: g.pgn,
    };

    const lim = Math.min(verbose.length, 36);
    for (let p = 0; p < lim; p++) {
      const nf = normalizeFen(replay.fen());
      let mv;
      try {
        mv = replay.move({
          from: verbose[p].from,
          to: verbose[p].to,
          promotion: verbose[p].promotion,
        });
      } catch (_) {
        break;
      }
      if (!mv) break;
      const uci = mv.from + mv.to + (mv.promotion || '');
      let bucket = targetMap.get(nf);
      if (!bucket) {
        bucket = { white: 0, draws: 0, black: 0, moves: new Map(), recentGames: [] };
        targetMap.set(nf, bucket);
      }
      if (winner === 'white') bucket.white++;
      else if (winner === 'black') bucket.black++;
      else bucket.draws++;

      let mRec = bucket.moves.get(uci);
      if (!mRec) {
        mRec = { uci, san: mv.san, white: 0, draws: 0, black: 0 };
        bucket.moves.set(uci, mRec);
      }
      if (winner === 'white') mRec.white++;
      else if (winner === 'black') mRec.black++;
      else mRec.draws++;

      if (bucket.recentGames.length < 6 && !bucket.recentGames.some((x) => x.id === gameSummary.id)) {
        bucket.recentGames.push(gameSummary);
      }
    }
  }

  return byColor;
}

const WINDOW_MONTHS = { '1m': 1, '3m': 3, '6m': 6, '12m': 12 };

/**
 * Convert a relative time-window key ('1m' | '3m' | '6m' | '12m' | '') into
 * both an epoch-ms cutoff (for /api/games/user?since=...) and a YYYY-MM string
 * (for explorer.lichess.org/player?since=...).
 */
export function computeSinceFilter(windowKey, now = Date.now()) {
  const months = WINDOW_MONTHS[String(windowKey || '')];
  if (!months) return { sinceMs: null, sinceYm: '' };
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return { sinceMs: d.getTime(), sinceYm: ym };
}

async function fetchPlayerExplorerViaRecentGames(
  username,
  color,
  fen,
  { max = 200, sinceKey = '', signal, reauthNeeded = false } = {}
) {
  const maxNum = Math.min(500, Math.max(10, Number(max) || 200));
  const { sinceMs } = computeSinceFilter(sinceKey);
  const key = `${username.toLowerCase()}|${maxNum}|${sinceKey || 'all'}`;
  let cached = playerFallbackCache.get(key);
  if (!cached || Date.now() - cached.fetchedAt > FALLBACK_CACHE_TTL_MS) {
    const games = await fetchLichessUserGames(username, {
      max: maxNum,
      since: sinceMs,
      signal,
    });
    cached = {
      fetchedAt: Date.now(),
      sampledGames: games.length,
      byColor: buildLocalPlayerExplorerIndex(games, username),
    };
    playerFallbackCache.set(key, cached);
  }

  const colKey = color === 'black' ? 'black' : 'white';
  const bucket = cached.byColor[colKey].get(normalizeFen(fen));
  if (!bucket) {
    return {
      white: 0,
      draws: 0,
      black: 0,
      moves: [],
      recentGames: [],
      fallbackLocal: true,
      reauthNeeded,
      sampledGames: cached.sampledGames,
      sinceKey,
      maxGames: String(maxNum),
    };
  }

  const moves = Array.from(bucket.moves.values()).sort(
    (a, b) => b.white + b.draws + b.black - (a.white + a.draws + a.black)
  );
  return {
    white: bucket.white,
    draws: bucket.draws,
    black: bucket.black,
    moves,
    recentGames: bucket.recentGames,
    fallbackLocal: true,
    reauthNeeded,
    sampledGames: cached.sampledGames,
    sinceKey,
    maxGames: String(maxNum),
  };
}

async function fetchExplorerViaSessionProxy(source, fen, { color = 'white', sinceYm = '', signal } = {}) {
  const params = new URLSearchParams({ source, fen });
  if (source === 'player') {
    params.set('color', color === 'black' ? 'black' : 'white');
    if (sinceYm) params.set('since', sinceYm);
  }
  const res = await fetch(`/api/lichess/explorer?${params.toString()}`, {
    credentials: 'same-origin',
    signal,
    headers: { Accept: 'application/json' },
  });
  let body = null;
  try {
    body = await res.json();
  } catch (_) {}
  if (res.ok && body) return body;
  const err = new Error(body?.error || `Explorer proxy HTTP ${res.status}`);
  err.status = res.status;
  if (res.status === 429) err.name = 'RateLimitError';
  if (body?.code === 'reauth_needed') err.reauthNeeded = true;
  if (res.status === 401 || res.status === 403) err.authRequired = true;
  throw err;
}

export async function fetchExplorer(
  source,
  fen,
  {
    signal,
    player = '',
    color = 'white',
    sinceKey = '',
    maxGames = '200',
    authenticated = false,
  } = {}
) {
  // Signed-in Lichess player games explorer
  if (source === 'player') {
    const { sinceYm } = computeSinceFilter(sinceKey);
    const wantsBoundedCap = maxGames && maxGames !== 'all';

    // When the user selects a specific game-count cap (Last 50/100/200/500),
    // index their exact recent games (with optional since time window) directly.
    if (player && wantsBoundedCap) {
      try {
        return await fetchPlayerExplorerViaRecentGames(player, color, fen, {
          max: Number(maxGames) || 200,
          sinceKey,
          signal,
        });
      } catch (err) {
        if (err.name === 'AbortError' || err.name === 'RateLimitError') throw err;
        if (!authenticated && !state.lichessToken) throw err;
        // Fall through to authenticated explorer proxy if public games fetch failed
      }
    }

    let reauthNeeded = false;

    // 1. Try server-side OAuth proxy (full Lichess history via explorer.lichess.org/player)
    if (authenticated) {
      try {
        const res = await fetchExplorerViaSessionProxy('player', fen, { color, sinceYm, signal });
        if (res && (!res.indexing || (res.moves && res.moves.length))) {
          return { ...res, sinceKey, maxGames: 'all' };
        }
        // If Lichess is still building the on-demand index with 0 moves yet, fall through to instant recent-games cache
      } catch (err) {
        if (err.name === 'AbortError' || err.name === 'RateLimitError') throw err;
        if (err.reauthNeeded) reauthNeeded = true;
      }
    }

    // 2. Try direct explorer.lichess.org/player if user has a manual token saved
    if (player && state.lichessToken) {
      const sinceParam = sinceYm ? `&since=${encodeURIComponent(sinceYm)}` : '';
      const url = `https://explorer.lichess.org/player?player=${encodeURIComponent(player)}&color=${color === 'black' ? 'black' : 'white'}&fen=${encodeURIComponent(fen)}&recentGames=4${sinceParam}`;
      try {
        const text = await fetchText(url, {
          signal,
          headers: {
            Accept: 'application/x-ndjson',
            Authorization: `Bearer ${state.lichessToken}`,
          },
        });
        const parsed = parseExplorerPlayerNdjson(text);
        if (parsed && (parsed.moves?.length || !parsed.queuePosition)) {
          return { ...parsed, sinceKey, maxGames: 'all' };
        }
      } catch (err) {
        if (err.name === 'AbortError' || err.name === 'RateLimitError') throw err;
      }
    }

    // 3. Seamless zero-token fallback: index up to 500 recent public Lichess games directly
    if (player) {
      return fetchPlayerExplorerViaRecentGames(player, color, fen, {
        max: 500,
        sinceKey,
        signal,
        reauthNeeded,
      });
    }

    const authErr = new Error('Sign in with Lichess to browse your own games');
    authErr.authRequired = true;
    throw authErr;
  }

  // When signed in via Lichess OAuth without a manual token, route Masters/Lichess through session proxy
  if (!state.lichessToken && authenticated) {
    try {
      return await fetchExplorerViaSessionProxy(source, fen, { signal });
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'RateLimitError') throw err;
      // Fall through to direct fetch attempt
    }
  }

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

export async function fetchLichessUserGames(
  username,
  { max = 100, perfType = '', since = null, signal } = {}
) {
  const params = new URLSearchParams({
    max: String(max),
    pgnInJson: 'true',
    opening: 'true',
    clocks: 'false',
    evals: 'false',
  });
  if (perfType) params.set('perfType', perfType);
  if (Number.isFinite(since) && since > 0) {
    params.set('since', String(Math.floor(since)));
  }

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
