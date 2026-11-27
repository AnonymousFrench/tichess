import { normalizeLichessGame, normalizeChessComGame } from '../../src/insights/normalize.js';
import { decryptSecretValue, getSigningSecret } from './session.js';

export const STALE_SYNC_MS = 10 * 60_000;
export const CRON_STALE_MS = 25 * 60_000;
const LOCK_LEASE_MS = 45_000;
const RATE_LIMIT_BACKOFF_MS = 65_000;
const CHESSCOM_UA = 'tichess.vercel.app (chess analytics; https://tichess.vercel.app)';
const UPSERT_CHUNK = 200;

export function parseJsonBody(req) {
  if (!req?.body) return null;
  if (typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return null;
    }
  }
  return null;
}

export function sanitizeSourceInput(rawSrc, rawName) {
  const src = rawSrc === 'chesscom' ? 'chesscom' : rawSrc === 'pgn' ? 'pgn' : rawSrc === 'lichess' ? 'lichess' : '';
  const displayName = String(rawName || '').trim();
  if (!src || !displayName) return null;
  if (src === 'pgn') {
    const clean = displayName.slice(0, 60);
    return { src, acct: clean.toLowerCase(), displayName: clean };
  }
  if (!/^[A-Za-z0-9_-]{2,30}$/.test(displayName)) return null;
  return { src, acct: displayName.toLowerCase(), displayName };
}

export function sanitizeGameRecord(raw, expectedSrc = null, expectedAcct = null) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 80) : '';
  const src = raw.src === 'chesscom' ? 'chesscom' : raw.src === 'pgn' ? 'pgn' : raw.src === 'lichess' ? 'lichess' : '';
  const acct = typeof raw.acct === 'string' ? raw.acct.trim().toLowerCase().slice(0, 60) : '';
  if (!id || !src || !acct) return null;
  if (expectedSrc && src !== expectedSrc) return null;
  if (expectedAcct && acct !== expectedAcct) return null;
  const t = Number.isFinite(Number(raw.t)) ? Math.max(0, Math.trunc(Number(raw.t))) : 0;
  const res = raw.res === 1 ? 1 : raw.res === 0.5 ? 0.5 : 0;
  const color = raw.color === 'b' ? 'b' : 'w';
  const rec = {
    id,
    src,
    acct,
    t,
    tc: typeof raw.tc === 'string' ? raw.tc.slice(0, 16) : 'blitz',
    clock: typeof raw.clock === 'string' ? raw.clock.slice(0, 20) : '',
    rated: Boolean(raw.rated),
    color,
    res,
    term: typeof raw.term === 'string' ? raw.term.slice(0, 24) : 'other',
    me: Number.isFinite(Number(raw.me)) ? Math.trunc(Number(raw.me)) : 0,
    op: typeof raw.op === 'string' ? raw.op.slice(0, 60) : '',
    opR: Number.isFinite(Number(raw.opR)) ? Math.trunc(Number(raw.opR)) : 0,
    opT: typeof raw.opT === 'string' ? raw.opT.slice(0, 12) : '',
    eco: typeof raw.eco === 'string' ? raw.eco.slice(0, 12) : '',
    opening: typeof raw.opening === 'string' ? raw.opening.slice(0, 140) : '',
    oply: Number.isFinite(Number(raw.oply)) ? Math.trunc(Number(raw.oply)) : 0,
    moves: typeof raw.moves === 'string' ? raw.moves.slice(0, 4000) : '',
    plies: Number.isFinite(Number(raw.plies)) ? Math.trunc(Number(raw.plies)) : 0,
    url: typeof raw.url === 'string' ? raw.url.slice(0, 180) : '',
  };
  if (Array.isArray(raw.clks) && raw.clks.length <= 600) {
    rec.clks = raw.clks.map((c) => (c === null || c === undefined ? null : Number.isFinite(Number(c)) ? Math.round(Number(c)) : null));
  }
  if (raw.acc !== undefined && raw.acc !== null && Number.isFinite(Number(raw.acc))) {
    rec.acc = Number(raw.acc);
  }
  if (Array.isArray(raw.evals) && raw.evals.length <= 600) {
    rec.evals = raw.evals.map((e) => {
      const o = {};
      if (typeof e?.m === 'number') o.m = Math.trunc(e.m);
      else if (typeof e?.c === 'number') o.c = Math.trunc(e.c);
      if (typeof e?.b === 'string' && e.b) o.b = e.b.slice(0, 8);
      return o;
    });
  }
  return rec;
}

export async function getUserLichessToken(sql, lichessId) {
  if (!lichessId) return null;
  const rows = await sql`
    SELECT lichess_token_enc FROM users WHERE lichess_id = ${lichessId}
  `;
  const enc = rows[0]?.lichess_token_enc;
  if (!enc) return null;
  return decryptSecretValue(enc, getSigningSecret());
}

/**
 * Ensure a public player archive exists in `insight_player_archives` and
 * optionally link it to `user_insight_sources` for a signed-in user.
 */
export async function ensureSourceInDb(sql, { lichessId = null, src, displayName, linkToUser = true, now = Date.now() }) {
  const clean = sanitizeSourceInput(src, displayName);
  if (!clean) return null;

  if (clean.src === 'lichess' || clean.src === 'chesscom') {
    await sql`
      INSERT INTO insight_player_archives (src, acct, display_name, requested_by, updated_at)
      VALUES (${clean.src}, ${clean.acct}, ${clean.displayName}, ${lichessId}, NOW())
      ON CONFLICT (src, acct)
      DO UPDATE SET
        requested_by = COALESCE(EXCLUDED.requested_by, insight_player_archives.requested_by),
        updated_at = NOW()
    `;
  }

  if (linkToUser && lichessId) {
    await sql`
      INSERT INTO user_insight_sources (lichess_id, src, acct, display_name, added_at)
      VALUES (${lichessId}, ${clean.src}, ${clean.acct}, ${clean.displayName}, ${now})
      ON CONFLICT (lichess_id, src, acct)
      DO UPDATE SET display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), user_insight_sources.display_name)
    `;
  }

  return clean;
}

export async function upsertPublicGames(sql, records) {
  if (!Array.isArray(records) || !records.length) return 0;
  let total = 0;
  for (let i = 0; i < records.length; i += UPSERT_CHUNK) {
    const chunk = records.slice(i, i + UPSERT_CHUNK).map((r) => ({
      src: r.src,
      acct: r.acct,
      game_id: r.id,
      played_at: Number(r.t) || 0,
      record_json: r,
    }));
    await sql`
      INSERT INTO insight_games (src, acct, game_id, played_at, record_json)
      SELECT x.src, x.acct, x.game_id, x.played_at, x.record_json
      FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS x(
        src TEXT,
        acct TEXT,
        game_id TEXT,
        played_at BIGINT,
        record_json JSONB
      )
      ON CONFLICT (src, acct, game_id) DO NOTHING
    `;
    total += chunk.length;
  }
  return total;
}

export async function upsertUserPgnGames(sql, lichessId, records) {
  if (!lichessId || !Array.isArray(records) || !records.length) return 0;
  let total = 0;
  for (let i = 0; i < records.length; i += UPSERT_CHUNK) {
    const chunk = records.slice(i, i + UPSERT_CHUNK).map((r) => ({
      lichess_id: lichessId,
      acct: r.acct,
      game_id: r.id,
      played_at: Number(r.t) || 0,
      record_json: r,
    }));
    await sql`
      INSERT INTO user_pgn_games (lichess_id, acct, game_id, played_at, record_json)
      SELECT x.lichess_id, x.acct, x.game_id, x.played_at, x.record_json
      FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS x(
        lichess_id TEXT,
        acct TEXT,
        game_id TEXT,
        played_at BIGINT,
        record_json JSONB
      )
      ON CONFLICT (lichess_id, game_id) DO NOTHING
    `;
    total += chunk.length;
  }
  return total;
}

async function fetchLichessWithFallback(url, { token, signal, headers = {}, fetchImpl = fetch }) {
  const res = await fetchImpl(url, {
    signal,
    headers: token ? { ...headers, Authorization: `Bearer ${token}` } : headers,
  });
  if (token && res.status === 401) {
    return fetchImpl(url, { signal, headers });
  }
  return res;
}

async function fetchLichessProfileServer(username, { token, signal, fetchImpl = fetch }) {
  const res = await fetchLichessWithFallback(
    `https://lichess.org/api/user/${encodeURIComponent(username)}`,
    { token, signal, headers: { Accept: 'application/json' }, fetchImpl }
  );
  if (res.status === 429) {
    const err = new Error('Lichess rate limited — retrying shortly.');
    err.status = 429;
    throw err;
  }
  if (res.status === 404) {
    const err = new Error('Player not found on Lichess.');
    err.status = 404;
    throw err;
  }
  if (!res.ok) throw new Error(`Lichess profile failed (${res.status})`);
  const u = await res.json();
  if (u.disabled) {
    const err = new Error('This Lichess account is closed.');
    err.status = 410;
    throw err;
  }
  const perfs = {};
  for (const [k, v] of Object.entries(u.perfs || {})) {
    if (v && typeof v.rating === 'number') {
      perfs[k] = { rating: v.rating, games: v.games || 0, prov: Boolean(v.prov) };
    }
  }
  return { name: u.username || username, title: u.title || '', total: u.count?.all || 0, perfs };
}

async function fetchChessComJson(url, { signal, fetchImpl = fetch }) {
  const res = await fetchImpl(url, {
    signal,
    headers: { Accept: 'application/json', 'User-Agent': CHESSCOM_UA },
  });
  if (res.status === 429) {
    const err = new Error('Chess.com rate limited — retrying shortly.');
    err.status = 429;
    throw err;
  }
  if (res.status === 404) {
    const err = new Error('Player not found on Chess.com.');
    err.status = 404;
    throw err;
  }
  if (!res.ok) throw new Error(`Chess.com request failed (${res.status})`);
  return res.json();
}

async function fetchChessComProfileServer(username, { signal, fetchImpl = fetch }) {
  const base = `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}`;
  const [p, stats] = await Promise.all([
    fetchChessComJson(base, { signal, fetchImpl }),
    fetchChessComJson(`${base}/stats`, { signal, fetchImpl }).catch(() => ({})),
  ]);
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
      perfs[k] = {
        rating: s.last.rating,
        games: (rec.win || 0) + (rec.loss || 0) + (rec.draw || 0),
        prov: false,
      };
    }
  }
  const name = p.url ? decodeURIComponent(p.url.split('/').pop()) : p.username || username;
  return { name, title: p.title || '', total: 0, perfs };
}

/**
 * Stream a bounded slice of Lichess NDJSON games, flushing normalized batches
 * via `onRecords` and stopping cleanly if the time budget or `max` cap is reached.
 */
export async function streamLichessSlice(
  username,
  params,
  { token = null, maxGames = 600, budgetMs = 15_000, onRecords, fetchImpl = fetch }
) {
  const qs = new URLSearchParams({
    moves: 'true',
    opening: 'true',
    clocks: 'true',
    evals: 'true',
    accuracy: 'true',
    tags: 'false',
    perfType: 'ultraBullet,bullet,blitz,rapid,classical,correspondence',
    max: String(maxGames),
    ...params,
  });
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?${qs}`;

  const ctrl = new AbortController();
  let budgetHit = false;
  const timer = setTimeout(() => {
    budgetHit = true;
    ctrl.abort();
  }, Math.max(1500, budgetMs));

  let batch = [];
  let rawCount = 0;
  let savedCount = 0;
  let reachedEnd;

  const flush = async () => {
    if (!batch.length) return;
    const toSave = batch;
    batch = [];
    await onRecords(toSave);
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
    rawCount++;
    const rec = normalizeLichessGame(g, username);
    if (rec) {
      savedCount++;
      batch.push(rec);
    } else {
      batch.push({ skipped: true, t: Number(g.createdAt) || 0 });
    }
    if (batch.length >= 100) {
      await flush();
    }
  };

  try {
    const res = await fetchLichessWithFallback(url, {
      token,
      signal: ctrl.signal,
      headers: { Accept: 'application/x-ndjson' },
      fetchImpl,
    });
    if (res.status === 429) {
      const err = new Error('Lichess rate limited — retrying shortly.');
      err.status = 429;
      throw err;
    }
    if (res.status === 404) {
      const err = new Error(`Lichess refused game export for "${username}" (404).`);
      err.status = 404;
      throw err;
    }
    if (!res.ok) throw new Error(`Lichess export failed (${res.status})`);

    if (!res.body?.getReader) {
      const text = await res.text();
      for (const line of text.split('\n')) {
        if (budgetHit) break;
        await take(line);
      }
      await flush();
      reachedEnd = !budgetHit && rawCount < maxGames;
      return { rawCount, savedCount, reachedEnd, budgetHit };
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
    buf += decoder.decode();
    if (buf.trim()) await take(buf);
    await flush();
    reachedEnd = !budgetHit && rawCount < maxGames;
    return { rawCount, savedCount, reachedEnd, budgetHit };
  } catch (err) {
    if (budgetHit && err?.name === 'AbortError') {
      await flush();
      return { rawCount, savedCount, reachedEnd: false, budgetHit: true };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Advance one bounded sync slice for a single `(src, acct)` player archive in Neon.
 * Safe to invoke repeatedly from user requests or scheduled cron jobs.
 */
export async function syncArchiveSlice(
  sql,
  archive,
  {
    lichessToken = null,
    timeBudgetMs = 18_000,
    maxGamesPerSlice = 600,
    maxMonthsPerSlice = 8,
    fetchImpl = fetch,
    nowFn = () => Date.now(),
  } = {}
) {
  const startedAt = nowFn();
  const lockUntil = startedAt + LOCK_LEASE_MS;

  const acquired = await sql`
    UPDATE insight_player_archives
    SET sync_lock_until = ${lockUntil}, updated_at = NOW()
    WHERE src = ${archive.src}
      AND acct = ${archive.acct}
      AND sync_lock_until < ${startedAt}
    RETURNING src, acct, display_name, title, total_games, perfs_json, newest_ms, oldest_ms, complete, months_done, last_sync_at
  `;

  if (!acquired.length) {
    return {
      src: archive.src,
      acct: archive.acct,
      displayName: archive.display_name || archive.acct,
      skipped: 'locked',
      added: 0,
      complete: Boolean(archive.complete),
      hasMore: !archive.complete,
    };
  }

  const row = acquired[0];
  let displayName = row.display_name || row.acct;
  let title = row.title || '';
  let totalGames = Number(row.total_games) || 0;
  let perfs = row.perfs_json && typeof row.perfs_json === 'object' ? row.perfs_json : {};
  let newestMs = Number(row.newest_ms) || 0;
  let oldestMs = Number(row.oldest_ms) || 0;
  let complete = Boolean(row.complete);
  let monthsDone = Array.isArray(row.months_done) ? [...row.months_done] : [];
  let added = 0;
  let hasMore = false;
  let nextLockUntil = 0;
  let syncError = '';

  const persistProgress = async ({ markSynced = false } = {}) => {
    const lastSyncAt = markSynced ? nowFn() : Number(row.last_sync_at) || 0;
    await sql`
      UPDATE insight_player_archives
      SET
        display_name = ${displayName},
        title = ${title},
        total_games = ${totalGames},
        perfs_json = ${JSON.stringify(perfs)}::jsonb,
        newest_ms = ${newestMs},
        oldest_ms = ${oldestMs},
        complete = ${complete},
        months_done = ${JSON.stringify(monthsDone)}::jsonb,
        last_sync_at = ${lastSyncAt},
        sync_error = ${syncError},
        updated_at = NOW()
      WHERE src = ${row.src} AND acct = ${row.acct}
    `;
  };

  try {
    if (row.src === 'lichess') {
      const profileCtrl = new AbortController();
      const profileTimer = setTimeout(() => profileCtrl.abort(), 8000);
      let profile;
      try {
        profile = await fetchLichessProfileServer(displayName, {
          token: lichessToken,
          signal: profileCtrl.signal,
          fetchImpl,
        });
      } finally {
        clearTimeout(profileTimer);
      }
      displayName = profile.name;
      title = profile.title;
      totalGames = profile.total;
      perfs = profile.perfs;
      await persistProgress();

      const handleBatch = (dir) => async (records) => {
        const good = records.filter((r) => !r.skipped);
        if (good.length) {
          await upsertPublicGames(sql, good);
          added += good.length;
        }
        for (const r of records) {
          const ts = Number(r.t) || 0;
          if (!ts) continue;
          if (dir === 'new' || !newestMs) newestMs = Math.max(newestMs, ts);
          if (dir === 'old' || !oldestMs) oldestMs = oldestMs ? Math.min(oldestMs, ts) : ts;
        }
        await persistProgress();
      };

      // 1. Fetch newer games since `newestMs` (oldest-first so interruption never leaves gaps).
      if (newestMs > 0) {
        const rem = Math.max(2000, timeBudgetMs - (nowFn() - startedAt));
        const resNew = await streamLichessSlice(
          displayName,
          { since: String(newestMs + 1), sort: 'dateAsc' },
          {
            token: lichessToken,
            maxGames: maxGamesPerSlice,
            budgetMs: rem,
            onRecords: handleBatch('new'),
            fetchImpl,
          }
        );
        if (!resNew.reachedEnd) hasMore = true;
      }

      // 2. Backfill older games until reaching the player's earliest game.
      const elapsed = nowFn() - startedAt;
      if (!complete && !hasMore && elapsed < timeBudgetMs - 1500) {
        const rem = Math.max(2000, timeBudgetMs - elapsed);
        const params = oldestMs > 0 ? { until: String(oldestMs - 1) } : {};
        const resOld = await streamLichessSlice(displayName, params, {
          token: lichessToken,
          maxGames: maxGamesPerSlice,
          budgetMs: rem,
          onRecords: handleBatch('old'),
          fetchImpl,
        });
        if (resOld.reachedEnd) {
          complete = true;
          hasMore = false;
        } else {
          hasMore = true;
        }
      } else if (!complete) {
        hasMore = true;
      }

      syncError = '';
      await persistProgress({ markSynced: true });
    } else if (row.src === 'chesscom') {
      const profileCtrl = new AbortController();
      const profileTimer = setTimeout(() => profileCtrl.abort(), 8000);
      let profile;
      let archives = [];
      try {
        profile = await fetchChessComProfileServer(displayName, {
          signal: profileCtrl.signal,
          fetchImpl,
        });
        const userEnc = encodeURIComponent(profile.name.toLowerCase());
        const archRes = await fetchChessComJson(`https://api.chess.com/pub/player/${userEnc}/games/archives`, {
          signal: profileCtrl.signal,
          fetchImpl,
        });
        archives = Array.isArray(archRes.archives) ? archRes.archives : [];
      } finally {
        clearTimeout(profileTimer);
      }

      displayName = profile.name;
      title = profile.title;
      perfs = profile.perfs;
      await persistProgress();

      const doneSet = new Set(monthsDone);
      const nowDate = new Date(nowFn());
      const currentMonth = `${nowDate.getUTCFullYear()}/${String(nowDate.getUTCMonth() + 1).padStart(2, '0')}`;
      const todo = archives.filter((u) => !doneSet.has(u)).reverse();

      let processedMonths = 0;
      for (const monthUrl of todo) {
        if (processedMonths >= maxMonthsPerSlice || nowFn() - startedAt >= timeBudgetMs - 1500) {
          hasMore = true;
          break;
        }
        const mCtrl = new AbortController();
        const mTimer = setTimeout(() => mCtrl.abort(), 8000);
        let data;
        try {
          data = await fetchChessComJson(monthUrl, { signal: mCtrl.signal, fetchImpl });
        } finally {
          clearTimeout(mTimer);
        }
        const recs = (data.games || [])
          .map((g) => normalizeChessComGame(g, displayName))
          .filter(Boolean);
        if (recs.length) {
          await upsertPublicGames(sql, recs);
          added += recs.length;
        }
        for (const r of recs) {
          if (!r.t) continue;
          newestMs = Math.max(newestMs, r.t);
          oldestMs = oldestMs ? Math.min(oldestMs, r.t) : r.t;
        }
        if (!monthUrl.endsWith(currentMonth)) doneSet.add(monthUrl);
        monthsDone = [...doneSet];
        processedMonths++;
        await persistProgress();
      }

      if (!hasMore) {
        complete = true;
      }
      syncError = '';
      await persistProgress({ markSynced: true });
    }
  } catch (err) {
    syncError = err?.message || 'Sync failed';
    if (err?.status === 429) {
      nextLockUntil = nowFn() + RATE_LIMIT_BACKOFF_MS;
      hasMore = true;
    } else if (err?.status === 404 || err?.status === 410) {
      // Do not keep retrying a nonexistent/closed account forever on cron
      complete = true;
      hasMore = false;
    } else {
      hasMore = !complete;
    }
    await persistProgress({ markSynced: err?.status === 404 || err?.status === 410 }).catch(() => {});
  } finally {
    await sql`
      UPDATE insight_player_archives
      SET sync_lock_until = ${nextLockUntil}, updated_at = NOW()
      WHERE src = ${row.src} AND acct = ${row.acct}
    `.catch(() => {});
  }

  const statRows = await sql`
    SELECT COUNT(*)::int AS cached_count, COALESCE(MAX(seq), 0)::bigint AS max_seq
    FROM insight_games
    WHERE src = ${row.src} AND acct = ${row.acct}
  `;

  return {
    src: row.src,
    acct: row.acct,
    displayName,
    title,
    totalGames,
    perfs,
    newestMs,
    oldestMs,
    complete,
    hasMore,
    added,
    error: syncError,
    cachedCount: Number(statRows[0]?.cached_count) || 0,
    maxSeq: Number(statRows[0]?.max_seq) || 0,
  };
}
