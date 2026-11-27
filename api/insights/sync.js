import { getDb, isDbConfigured } from '../_lib/db.js';
import { readSessionFromRequest, isSameOriginRequest } from '../_lib/session.js';
import {
  STALE_SYNC_MS,
  parseJsonBody,
  sanitizeSourceInput,
  ensureSourceInDb,
  getUserLichessToken,
  syncArchiveSlice,
} from '../_lib/insightsSync.js';

/**
 * Advance one bounded background sync slice (~18s) for the authenticated user's
 * Insights accounts (their own AND other players they track) plus scouted opponents.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Cloud sync database is not configured' });
  }

  if (!isSameOriginRequest(req)) {
    return res.status(403).json({ error: 'Cross-origin request rejected' });
  }

  const user = readSessionFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: 'Sign in with Lichess to run background sync' });
  }

  const body = parseJsonBody(req) || {};
  const force = Boolean(body.force);
  const includeScout = body.includeScout !== false;
  const now = Date.now();

  try {
    const sql = await getDb();
    await sql`
      INSERT INTO users (lichess_id, username, last_seen_at)
      VALUES (${user.id}, ${user.username}, NOW())
      ON CONFLICT (lichess_id)
      DO UPDATE SET username = EXCLUDED.username, last_seen_at = NOW()
    `;

    // Ensure the signed-in user's own Lichess archive exists if they have zero sources yet.
    const existingLinks = await sql`
      SELECT COUNT(*)::int AS cnt FROM user_insight_sources WHERE lichess_id = ${user.id}
    `;
    if ((Number(existingLinks[0]?.cnt) || 0) === 0) {
      await ensureSourceInDb(sql, {
        lichessId: user.id,
        src: 'lichess',
        displayName: user.username,
        linkToUser: true,
        now,
      });
    }

    let target = null;
    let pendingOthers = 0;

    if (body.src && (body.acct || body.name)) {
      const clean = sanitizeSourceInput(body.src, body.acct || body.name);
      if (!clean || clean.src === 'pgn') {
        return res.status(400).json({ error: 'Invalid sync source' });
      }
      await ensureSourceInDb(sql, {
        lichessId: user.id,
        src: clean.src,
        displayName: clean.displayName,
        linkToUser: body.linkToUser === true,
        now,
      });
      const rows = await sql`
        SELECT * FROM insight_player_archives
        WHERE src = ${clean.src} AND acct = ${clean.acct}
        LIMIT 1
      `;
      target = rows[0] || null;
    } else {
      // 1. Prioritize the user's Insights sources (their own + other tracked users).
      const userArchives = await sql`
        SELECT a.*
        FROM user_insight_sources u
        JOIN insight_player_archives a
          ON a.src = u.src AND a.acct = u.acct
        WHERE u.lichess_id = ${user.id}
          AND u.src IN ('lichess', 'chesscom')
        ORDER BY a.complete ASC, a.last_sync_at ASC
      `;

      const eligible = userArchives.filter((a) => {
        if (Number(a.sync_lock_until) > now) return false;
        if (!a.complete) return true;
        if (force) return now - (Number(a.last_sync_at) || 0) > 15_000;
        return now - (Number(a.last_sync_at) || 0) > STALE_SYNC_MS;
      });

      if (eligible.length) {
        target = eligible[0];
        pendingOthers = eligible.length - 1;
      } else if (includeScout) {
        // 2. Next, archive games for any scouted opponents from Studio.
        const scoutRows = await sql`
          SELECT targets_json FROM user_scout_targets WHERE lichess_id = ${user.id}
        `;
        const scoutTargets = Array.isArray(scoutRows[0]?.targets_json) ? scoutRows[0].targets_json : [];
        for (const t of scoutTargets.slice(0, 12)) {
          const clean = sanitizeSourceInput(t?.source, t?.username);
          if (!clean || clean.src === 'pgn') continue;
          await ensureSourceInDb(sql, {
            lichessId: user.id,
            src: clean.src,
            displayName: clean.displayName,
            linkToUser: false,
            now,
          });
          const archRows = await sql`
            SELECT * FROM insight_player_archives
            WHERE src = ${clean.src} AND acct = ${clean.acct}
            LIMIT 1
          `;
          const a = archRows[0];
          if (!a || Number(a.sync_lock_until) > now) continue;
          if (!a.complete || now - (Number(a.last_sync_at) || 0) > STALE_SYNC_MS * 3) {
            if (!target) target = a;
            else pendingOthers++;
          }
        }
      }
    }

    if (!target) {
      return res.status(200).json({
        ok: true,
        synced: null,
        hasMore: false,
        pendingCount: 0,
      });
    }

    const token = target.src === 'lichess' ? await getUserLichessToken(sql, user.id) : null;
    const result = await syncArchiveSlice(sql, target, {
      lichessToken: token,
      timeBudgetMs: 18_000,
      maxGamesPerSlice: 600,
      maxMonthsPerSlice: 8,
    });

    const hasMore = Boolean(result.hasMore || pendingOthers > 0);
    return res.status(200).json({
      ok: true,
      synced: result,
      hasMore,
      pendingCount: pendingOthers + (result.hasMore ? 1 : 0),
    });
  } catch (err) {
    console.error('[api/insights/sync] POST failed:', err);
    return res.status(500).json({ error: 'Background sync failed' });
  }
}
