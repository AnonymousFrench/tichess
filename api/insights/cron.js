import crypto from 'node:crypto';
import { getDb, isDbConfigured } from '../_lib/db.js';
import {
  CRON_STALE_MS,
  getUserLichessToken,
  syncArchiveSlice,
} from '../_lib/insightsSync.js';

function timingSafeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export const MIN_CRON_SECRET_LENGTH = 16;

/** True when a usable CRON_SECRET (at least 16 characters) is configured. */
export function isCronSecretConfigured(env = process.env) {
  return String(env.CRON_SECRET || '').trim().length >= MIN_CRON_SECRET_LENGTH;
}

/**
 * Authorize scheduled cron runs. Fails closed: the request must carry
 * `Authorization: Bearer <CRON_SECRET>`, which the `insights-sync` Vercel Schedule
 * (a path schedule in vercel.json) sends automatically once CRON_SECRET is set. Without a configured secret every call is rejected.
 * Request headers such as `x-vercel-cron` are never trusted, because any caller
 * can set them.
 */
export function isCronAuthorized(req, env = process.env) {
  if (!isCronSecretConfigured(env)) return false;
  const secret = String(env.CRON_SECRET).trim();
  const authHeader = String(req?.headers?.authorization || '').trim();
  return timingSafeEq(authHeader, `Bearer ${secret}`);
}

/**
 * Scheduled offline background worker: advances incomplete player backfills
 * and refreshes stale Lichess/Chess.com archives in Neon even when all tabs are closed.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isCronAuthorized(req)) {
    if (!isCronSecretConfigured()) {
      console.error(
        `[api/insights/cron] CRON_SECRET is missing or shorter than ${MIN_CRON_SECRET_LENGTH} characters; refusing all cron calls. Set it in Vercel → Settings → Environment Variables.`
      );
    }
    return res.status(401).json({ error: 'Unauthorized cron invocation' });
  }

  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Cloud sync database is not configured' });
  }

  const startedAt = Date.now();
  const totalBudgetMs = 38_000;
  const staleCutoff = startedAt - CRON_STALE_MS;

  try {
    const sql = await getDb();
    const candidates = await sql`
      SELECT *
      FROM insight_player_archives
      WHERE src IN ('lichess', 'chesscom')
        AND sync_lock_until < ${startedAt}
        AND (complete = FALSE OR last_sync_at < ${staleCutoff})
      ORDER BY complete ASC, last_sync_at ASC
      LIMIT 4
    `;

    const processed = [];
    for (const archive of candidates) {
      const elapsed = Date.now() - startedAt;
      const remaining = totalBudgetMs - elapsed;
      if (remaining < 4000) break;

      const token =
        archive.src === 'lichess' && archive.requested_by
          ? await getUserLichessToken(sql, archive.requested_by).catch(() => null)
          : null;

      const sliceRes = await syncArchiveSlice(sql, archive, {
        lichessToken: token,
        timeBudgetMs: Math.min(18_000, remaining),
        maxGamesPerSlice: 600,
        maxMonthsPerSlice: 8,
      });
      processed.push({
        src: sliceRes.src,
        acct: sliceRes.acct,
        added: sliceRes.added,
        complete: sliceRes.complete,
        hasMore: sliceRes.hasMore,
        skipped: sliceRes.skipped || null,
        error: sliceRes.error || null,
      });
    }

    const remRows = await sql`
      SELECT COUNT(*)::int AS cnt
      FROM insight_player_archives
      WHERE complete = FALSE
    `;

    return res.status(200).json({
      ok: true,
      processed,
      remainingIncomplete: Number(remRows[0]?.cnt) || 0,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    console.error('[api/insights/cron] failed:', err);
    return res.status(500).json({ error: 'Cron sync failed' });
  }
}
