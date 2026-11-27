import { getDb, isDbConfigured } from '../_lib/db.js';
import { readSessionFromRequest, isSameOriginRequest } from '../_lib/session.js';
import {
  parseJsonBody,
  sanitizeSourceInput,
  sanitizeGameRecord,
  ensureSourceInDb,
  upsertPublicGames,
  upsertUserPgnGames,
} from '../_lib/insightsSync.js';

const MAX_USER_SOURCES = 25;
const MAX_UPLOAD_RECORDS = 500;
const MAX_UPLOAD_BYTES = 2_500_000;
const MAX_PAGE_LIMIT = 1500;

async function ensureUserRow(sql, user) {
  await sql`
    INSERT INTO users (lichess_id, username, last_seen_at)
    VALUES (${user.id}, ${user.username}, NOW())
    ON CONFLICT (lichess_id)
    DO UPDATE SET username = EXCLUDED.username, last_seen_at = NOW()
  `;
}

async function listUserSources(sql, lichessId) {
  const rows = await sql`
    SELECT
      u.src,
      u.acct,
      COALESCE(NULLIF(a.display_name, ''), u.display_name) AS name,
      COALESCE(a.title, '') AS title,
      COALESCE(a.total_games, 0) AS total_games,
      COALESCE(a.perfs_json, '{}'::jsonb) AS perfs_json,
      COALESCE(a.newest_ms, 0) AS newest_ms,
      COALESCE(a.oldest_ms, 0) AS oldest_ms,
      COALESCE(a.complete, CASE WHEN u.src = 'pgn' THEN TRUE ELSE FALSE END) AS complete,
      COALESCE(a.months_done, '[]'::jsonb) AS months_done,
      COALESCE(a.last_sync_at, u.added_at) AS last_sync_at,
      COALESCE(a.sync_error, '') AS sync_error,
      u.added_at,
      CASE
        WHEN u.src = 'pgn' THEN (
          SELECT COUNT(*)::int FROM user_pgn_games p
          WHERE p.lichess_id = u.lichess_id AND p.acct = u.acct
        )
        ELSE (
          SELECT COUNT(*)::int FROM insight_games g
          WHERE g.src = u.src AND g.acct = u.acct
        )
      END AS cached_count,
      CASE
        WHEN u.src = 'pgn' THEN (
          SELECT COALESCE(MAX(p.seq), 0)::bigint FROM user_pgn_games p
          WHERE p.lichess_id = u.lichess_id AND p.acct = u.acct
        )
        ELSE (
          SELECT COALESCE(MAX(g.seq), 0)::bigint FROM insight_games g
          WHERE g.src = u.src AND g.acct = u.acct
        )
      END AS max_seq
    FROM user_insight_sources u
    LEFT JOIN insight_player_archives a
      ON a.src = u.src AND a.acct = u.acct
    WHERE u.lichess_id = ${lichessId}
    ORDER BY u.added_at ASC
  `;

  return rows.map((r) => ({
    src: r.src,
    acct: r.acct,
    name: r.name,
    title: r.title || '',
    total: Number(r.total_games) || 0,
    perfs: r.perfs_json && typeof r.perfs_json === 'object' ? r.perfs_json : {},
    newest: Number(r.newest_ms) || 0,
    oldest: Number(r.oldest_ms) || 0,
    complete: Boolean(r.complete),
    monthsDone: Array.isArray(r.months_done) ? r.months_done : [],
    lastSync: Number(r.last_sync_at) || 0,
    syncError: r.sync_error || '',
    addedAt: Number(r.added_at) || 0,
    cachedCount: Number(r.cached_count) || 0,
    maxSeq: Number(r.max_seq) || 0,
  }));
}

export default async function handler(req, res) {
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Cloud sync database is not configured' });
  }

  const user = readSessionFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: 'Sign in with Lichess to access cloud Insights storage' });
  }

  if (req.method === 'GET') {
    try {
      const sql = await getDb();
      const action = String(req.query?.action || '');

      if (action === 'games') {
        const clean = sanitizeSourceInput(req.query?.src, req.query?.acct);
        if (!clean) {
          return res.status(400).json({ error: 'Invalid source or account' });
        }
        const afterSeq = Math.max(0, Math.trunc(Number(req.query?.afterSeq) || 0));
        const limit = Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.trunc(Number(req.query?.limit) || 1200)));

        let rows;
        if (clean.src === 'pgn') {
          rows = await sql`
            SELECT seq, record_json
            FROM user_pgn_games
            WHERE lichess_id = ${user.id} AND acct = ${clean.acct} AND seq > ${afterSeq}
            ORDER BY seq ASC
            LIMIT ${limit + 1}
          `;
        } else {
          rows = await sql`
            SELECT seq, record_json
            FROM insight_games
            WHERE src = ${clean.src} AND acct = ${clean.acct} AND seq > ${afterSeq}
            ORDER BY seq ASC
            LIMIT ${limit + 1}
          `;
        }

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const lastSeq = page.length ? Number(page[page.length - 1].seq) || afterSeq : afterSeq;
        return res.status(200).json({
          src: clean.src,
          acct: clean.acct,
          games: page.map((r) => r.record_json),
          lastSeq,
          hasMore,
        });
      }

      const sources = await listUserSources(sql, user.id);
      return res.status(200).json({ user, sources });
    } catch (err) {
      console.error('[api/insights] GET failed:', err);
      return res.status(500).json({ error: 'Failed to load Insights data' });
    }
  }

  if (req.method === 'POST') {
    if (!isSameOriginRequest(req)) {
      return res.status(403).json({ error: 'Cross-origin request rejected' });
    }

    const body = parseJsonBody(req);
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    try {
      const sql = await getDb();
      await ensureUserRow(sql, user);

      if (body.action === 'addSource' || body.action === 'registerOtherPlayer') {
        const clean = sanitizeSourceInput(body.src, body.name);
        if (!clean) {
          return res.status(400).json({ error: 'Invalid source or username' });
        }
        const linkToUser = body.action === 'addSource';
        if (linkToUser) {
          const countRows = await sql`
            SELECT COUNT(*)::int AS cnt FROM user_insight_sources WHERE lichess_id = ${user.id}
          `;
          if ((Number(countRows[0]?.cnt) || 0) >= MAX_USER_SOURCES) {
            return res.status(400).json({ error: `Maximum of ${MAX_USER_SOURCES} Insights sources reached` });
          }
        }
        await ensureSourceInDb(sql, {
          lichessId: user.id,
          src: clean.src,
          displayName: clean.displayName,
          linkToUser,
        });
        if (!linkToUser) {
          return res.status(200).json({ ok: true, src: clean.src, acct: clean.acct });
        }
        const sources = await listUserSources(sql, user.id);
        const added = sources.find((s) => s.src === clean.src && s.acct === clean.acct) || null;
        return res.status(200).json({ ok: true, source: added, sources });
      }

      if (body.action === 'uploadGames') {
        const clean = sanitizeSourceInput(body.src, body.name);
        if (!clean) {
          return res.status(400).json({ error: 'Invalid source or account name' });
        }
        const rawRecords = Array.isArray(body.records) ? body.records : [];
        if (rawRecords.length > MAX_UPLOAD_RECORDS) {
          return res.status(413).json({ error: `Max ${MAX_UPLOAD_RECORDS} games per upload batch` });
        }
        if (JSON.stringify(rawRecords).length > MAX_UPLOAD_BYTES) {
          return res.status(413).json({ error: 'Game upload batch too large' });
        }

        const good = rawRecords
          .map((r) => sanitizeGameRecord(r, clean.src, clean.acct))
          .filter(Boolean);

        const linkToUser = body.linkToUser !== false;
        await ensureSourceInDb(sql, {
          lichessId: user.id,
          src: clean.src,
          displayName: clean.displayName,
          linkToUser: clean.src === 'pgn' ? true : linkToUser,
        });

        let saved = 0;
        if (clean.src === 'pgn') {
          saved = await upsertUserPgnGames(sql, user.id, good);
        } else {
          saved = await upsertPublicGames(sql, good);
          if (good.length) {
            let minT = Infinity;
            let maxT = 0;
            for (const r of good) {
              if (!r.t) continue;
              if (r.t < minT) minT = r.t;
              if (r.t > maxT) maxT = r.t;
            }
            if (maxT > 0) {
              await sql`
                UPDATE insight_player_archives
                SET
                  newest_ms = GREATEST(newest_ms, ${maxT}),
                  oldest_ms = CASE
                    WHEN oldest_ms = 0 THEN ${minT === Infinity ? maxT : minT}
                    ELSE LEAST(oldest_ms, ${minT === Infinity ? maxT : minT})
                  END,
                  updated_at = NOW()
                WHERE src = ${clean.src} AND acct = ${clean.acct}
              `;
            }
          }
        }

        return res.status(200).json({ ok: true, saved });
      }

      return res.status(400).json({ error: 'Unknown Insights action' });
    } catch (err) {
      console.error('[api/insights] POST failed:', err);
      return res.status(500).json({ error: 'Failed to update Insights storage' });
    }
  }

  if (req.method === 'DELETE') {
    if (!isSameOriginRequest(req)) {
      return res.status(403).json({ error: 'Cross-origin request rejected' });
    }
    const body = parseJsonBody(req) || req.query || {};
    const clean = sanitizeSourceInput(body.src, body.acct || body.name);
    if (!clean) {
      return res.status(400).json({ error: 'Invalid source or account' });
    }
    try {
      const sql = await getDb();
      await sql`
        DELETE FROM user_insight_sources
        WHERE lichess_id = ${user.id} AND src = ${clean.src} AND acct = ${clean.acct}
      `;
      if (clean.src === 'pgn') {
        await sql`
          DELETE FROM user_pgn_games
          WHERE lichess_id = ${user.id} AND acct = ${clean.acct}
        `;
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[api/insights] DELETE failed:', err);
      return res.status(500).json({ error: 'Failed to remove Insights source' });
    }
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
