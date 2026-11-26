/**
 * Downloads a player's games from Lichess (streamed NDJSON) or Chess.com
 * (monthly archives) and hands normalized records to `save` in batches.
 *
 * Syncs are resumable: account meta keeps the newest and oldest downloaded
 * game, so an interrupted first sync continues backwards from where it
 * stopped, and later syncs only fetch new games.
 */
import { normalizeLichessGame, normalizeChessComGame } from './normalize.js';

const FIRST_BATCH = 20;
const BATCH = 60;
const FLUSH_MS = 2000;
const PROGRESS_MS = 250;

export class RateLimitError extends Error {
  constructor(site) {
    super(`${site} asked us to slow down. Wait a minute, then sync again.`);
    this.name = 'RateLimitError';
  }
}

function lichessToken() {
  try {
    return localStorage.getItem('cms_lichess_token') || '';
  } catch (_) {
    return '';
  }
}

async function fetchLichessWithTokenFallback(url, { signal, headers = {} } = {}) {
  const token = lichessToken();
  const res = await fetch(url, {
    signal,
    headers: token ? { ...headers, Authorization: `Bearer ${token}` } : headers,
  });
  // If a saved manual token expired or was revoked, retry publicly instead of failing the sync.
  if (token && res.status === 401) {
    return fetch(url, { signal, headers });
  }
  return res;
}

async function getJson(url, { signal, headers } = {}) {
  const res = await fetch(url, { signal, headers });
  if (res.status === 429) throw new RateLimitError(url.includes('chess.com') ? 'Chess.com' : 'Lichess');
  if (res.status === 404) {
    const err = new Error('Player not found');
    err.status = 404;
    throw err;
  }
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

/** Look up a Lichess account: canonical name, title, ratings and game count. */
export async function fetchLichessProfile(username, { signal } = {}) {
  const res = await fetchLichessWithTokenFallback(
    `https://lichess.org/api/user/${encodeURIComponent(username)}`,
    { signal, headers: { Accept: 'application/json' } }
  );
  if (res.status === 429) throw new RateLimitError('Lichess');
  if (res.status === 404) {
    const err = new Error('Player not found');
    err.status = 404;
    throw err;
  }
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  const u = await res.json();
  if (u.disabled) throw new Error('This Lichess account is closed.');
  const perfs = {};
  for (const [k, v] of Object.entries(u.perfs || {})) {
    if (v && typeof v.rating === 'number') perfs[k] = { rating: v.rating, games: v.games || 0, prov: Boolean(v.prov) };
  }
  return { name: u.username || username, title: u.title || '', total: u.count?.all || 0, perfs };
}

/** Look up a Chess.com account: canonical name and current ratings. */
export async function fetchChessComProfile(username, { signal } = {}) {
  const base = `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}`;
  const [p, stats] = await Promise.all([getJson(base, { signal }), getJson(`${base}/stats`, { signal }).catch(() => ({}))]);
  const perfs = {};
  for (const [k, key] of [
    ['bullet', 'chess_bullet'],
    ['blitz', 'chess_blitz'],
    ['rapid', 'chess_rapid'],
    ['daily', 'chess_daily'],
  ]) {
    const s = stats[key];
    if (s?.last?.rating) {
      const rec = s.record || {};
      perfs[k] = { rating: s.last.rating, games: (rec.win || 0) + (rec.loss || 0) + (rec.draw || 0), prov: false };
    }
  }
  const name = p.url ? decodeURIComponent(p.url.split('/').pop()) : p.username || username;
  return { name, title: p.title || '', total: 0, perfs };
}

/**
 * Stream one Lichess export request. Flushes the first small batch quickly so
 * the page populates within ~1 second, then saves larger batches incrementally
 * while ticking `onTick(count)` smoothly as lines arrive.
 */
async function streamLichess(account, params, { signal, onRecords, onTick }) {
  const qs = new URLSearchParams({
    moves: 'true',
    opening: 'true',
    clocks: 'false',
    evals: 'false',
    tags: 'false',
    perfType: 'ultraBullet,bullet,blitz,rapid,classical,correspondence',
    ...params,
  });
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(account)}?${qs}`;
  const res = await fetchLichessWithTokenFallback(url, {
    signal,
    headers: { Accept: 'application/x-ndjson' },
  });
  if (res.status === 429) throw new RateLimitError('Lichess');
  if (res.status === 404) {
    throw new Error(`Lichess refused game export for "${account}" (404). Try again in a moment or import a PGN file.`);
  }
  if (!res.ok) throw new Error(`Lichess export failed (${res.status})`);

  let batch = [];
  let count = 0;
  let flushedAny = false;
  let lastFlushAt = Date.now();
  let lastTickAt = 0;

  const flush = async () => {
    if (!batch.length) return;
    const toSave = batch;
    batch = [];
    flushedAny = true;
    lastFlushAt = Date.now();
    await onRecords(toSave, count);
  };

  const take = async (rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    let g;
    try {
      g = JSON.parse(line);
    } catch (_) {
      return;
    }
    count++;
    const r = normalizeLichessGame(g, account);
    // Pass the raw time too, so resume points advance even past skipped games.
    batch.push(r || { skipped: true, t: Number(g.createdAt) || 0 });
    const now = Date.now();
    if (onTick && now - lastTickAt >= PROGRESS_MS) {
      lastTickAt = now;
      onTick(count);
    }
    const target = flushedAny ? BATCH : FIRST_BATCH;
    if (batch.length >= target || (batch.length > 0 && now - lastFlushAt >= FLUSH_MS)) {
      await flush();
    }
  };

  if (!res.body?.getReader) {
    const text = await res.text();
    for (const line of text.split('\n')) await take(line);
    await flush();
    return { count, ended: true };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      await take(line);
    }
  }
  // The last line may arrive without a trailing newline.
  buf += decoder.decode();
  await take(buf);
  await flush();
  return { count, ended: true };
}

/**
 * Sync a Lichess account. `acct` is the account meta object; it is updated in
 * place (newest, oldest, complete, count) and passed to saveMeta after each batch.
 */
export async function syncLichess(acct, { signal, save, saveMeta, onProgress }) {
  const profile = await fetchLichessProfile(acct.name, { signal });
  Object.assign(acct, { name: profile.name, title: profile.title, perfs: profile.perfs, total: profile.total });
  await saveMeta();
  const goalTotal = acct.complete ? null : profile.total;
  onProgress?.({ fetched: 0, total: goalTotal });

  let committed = 0;
  const handle = (dir) => async (records) => {
    const good = records.filter((r) => !r.skipped);
    if (good.length) await save(good);
    for (const r of records) {
      if (!r.t) continue;
      if (dir === 'new' || !acct.newest) acct.newest = Math.max(acct.newest || 0, r.t);
      if (dir === 'old' || !acct.oldest) acct.oldest = acct.oldest ? Math.min(acct.oldest, r.t) : r.t;
    }
    committed += records.length;
    await saveMeta();
    onProgress?.({ fetched: committed, total: goalTotal });
  };

  // 1. New games since the last sync.
  if (acct.newest) {
    const base = committed;
    // Oldest first, so an interrupted sync never leaves a gap behind `newest`.
    await streamLichess(
      profile.name,
      { since: String(acct.newest + 1), sort: 'dateAsc' },
      {
        signal,
        onRecords: handle('new'),
        onTick: (n) => onProgress?.({ fetched: base + n, total: goalTotal }),
      }
    );
  }
  // 2. Backfill older games until the account's first game.
  if (!acct.complete) {
    const base = committed;
    const params = acct.oldest ? { until: String(acct.oldest - 1) } : {};
    const { ended } = await streamLichess(profile.name, params, {
      signal,
      onRecords: handle('old'),
      onTick: (n) => onProgress?.({ fetched: base + n, total: goalTotal }),
    });
    if (ended) acct.complete = true;
  }
  acct.lastSync = Date.now();
  await saveMeta();
}

/** Sync a Chess.com account, newest month first. Finished months are not fetched again. */
export async function syncChessCom(acct, { signal, save, saveMeta, onProgress }) {
  const profile = await fetchChessComProfile(acct.name, { signal });
  Object.assign(acct, { name: profile.name, title: profile.title, perfs: profile.perfs });
  await saveMeta();

  const user = encodeURIComponent(profile.name.toLowerCase());
  const { archives = [] } = await getJson(`https://api.chess.com/pub/player/${user}/games/archives`, { signal });
  const done = new Set(acct.monthsDone || []);
  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const todo = archives.filter((u) => !done.has(u)).reverse();
  let i = 0;
  for (const url of todo) {
    const data = await getJson(url, { signal });
    const recs = (data.games || []).map((g) => normalizeChessComGame(g, profile.name)).filter(Boolean);
    if (recs.length) await save(recs);
    for (const r of recs) {
      acct.newest = Math.max(acct.newest || 0, r.t);
      acct.oldest = acct.oldest ? Math.min(acct.oldest, r.t) : r.t;
    }
    if (!url.endsWith(currentMonth)) done.add(url);
    acct.monthsDone = [...done];
    i++;
    await saveMeta();
    onProgress?.({ fetched: i, total: todo.length, unit: 'months' });
  }
  acct.complete = true;
  acct.lastSync = Date.now();
  await saveMeta();
}
