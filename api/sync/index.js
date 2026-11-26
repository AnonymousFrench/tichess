import { getDb, isDbConfigured } from '../_lib/db.js';
import { readSessionFromRequest, isSameOriginRequest } from '../_lib/session.js';
import { mergeProgress } from '../../src/repertoire/model.js';

const MAX_REPERTOIRE_BYTES = 4 * 1024 * 1024;
const MAX_PROGRESS_BYTES = 512 * 1024;
const MAX_TARGETS = 40;

function sanitizeScoutTargets(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const source = item.source === 'chesscom' ? 'chesscom' : item.source === 'lichess' ? 'lichess' : '';
    const username = String(item.username || '').trim().slice(0, 60);
    if (!source || !username) continue;
    const key = `${source}:${username.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source,
      username,
      max: Number.isFinite(Number(item.max)) ? Math.max(10, Math.min(500, Math.trunc(Number(item.max)))) : 100,
      perfType: typeof item.perfType === 'string' ? item.perfType.slice(0, 24) : '',
      updatedAt: Number.isFinite(Number(item.updatedAt)) ? Math.trunc(Number(item.updatedAt)) : Date.now(),
    });
    if (out.length >= MAX_TARGETS) break;
  }
  return out;
}

export function mergeScoutTargets(serverList, clientList) {
  const map = new Map();
  for (const item of [...sanitizeScoutTargets(serverList), ...sanitizeScoutTargets(clientList)]) {
    const key = `${item.source}:${item.username.toLowerCase()}`;
    const prev = map.get(key);
    if (!prev || (item.updatedAt || 0) >= (prev.updatedAt || 0)) {
      map.set(key, item);
    }
  }
  return Array.from(map.values())
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_TARGETS);
}

function parseBody(req) {
  if (!req.body) return null;
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

export default async function handler(req, res) {
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Cloud sync database is not configured' });
  }

  const user = readSessionFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: 'Sign in with Lichess to sync' });
  }

  if (req.method === 'GET') {
    try {
      const sql = await getDb();
      const [repRows, progRows, targetRows] = await Promise.all([
        sql`SELECT name, repertoire_json, updated_at FROM user_repertoires WHERE lichess_id = ${user.id}`,
        sql`SELECT progress_json, updated_at FROM user_progress WHERE lichess_id = ${user.id}`,
        sql`SELECT targets_json, updated_at FROM user_scout_targets WHERE lichess_id = ${user.id}`,
      ]);

      const repRow = repRows[0] || null;
      const progRow = progRows[0] || null;
      const targetRow = targetRows[0] || null;

      return res.status(200).json({
        user,
        repertoire: repRow ? repRow.repertoire_json : null,
        repertoireName: repRow ? repRow.name : '',
        repertoireUpdatedAt: repRow ? Number(repRow.updated_at) || 0 : 0,
        progress: progRow ? progRow.progress_json || {} : {},
        progressUpdatedAt: progRow ? Number(progRow.updated_at) || 0 : 0,
        scoutTargets: targetRow ? targetRow.targets_json || [] : [],
        scoutTargetsUpdatedAt: targetRow ? Number(targetRow.updated_at) || 0 : 0,
      });
    } catch (err) {
      console.error('[api/sync] GET failed:', err);
      return res.status(500).json({ error: 'Failed to load synced data' });
    }
  }

  if (req.method === 'PUT') {
    if (!isSameOriginRequest(req)) {
      return res.status(403).json({ error: 'Cross-origin request rejected' });
    }

    const body = parseBody(req);
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const now = Date.now();
    try {
      const sql = await getDb();

      // Guarantee user row exists in case DB was reset while cookie stayed valid
      await sql`
        INSERT INTO users (lichess_id, username, last_seen_at)
        VALUES (${user.id}, ${user.username}, NOW())
        ON CONFLICT (lichess_id)
        DO UPDATE SET username = EXCLUDED.username, last_seen_at = NOW()
      `;

      if (body.type === 'progress') {
        const incoming = body.progress && typeof body.progress === 'object' ? body.progress : null;
        if (!incoming) return res.status(400).json({ error: 'Missing progress object' });
        if (JSON.stringify(incoming).length > MAX_PROGRESS_BYTES) {
          return res.status(413).json({ error: 'Progress payload too large' });
        }

        const existingRows = await sql`
          SELECT progress_json FROM user_progress WHERE lichess_id = ${user.id}
        `;
        const current = existingRows[0]?.progress_json || {};
        const merged = mergeProgress(current, incoming);

        await sql`
          INSERT INTO user_progress (lichess_id, progress_json, updated_at)
          VALUES (${user.id}, ${JSON.stringify(merged)}::jsonb, ${now})
          ON CONFLICT (lichess_id)
          DO UPDATE SET progress_json = EXCLUDED.progress_json, updated_at = EXCLUDED.updated_at
        `;

        return res.status(200).json({ ok: true, progress: merged, updatedAt: now });
      }

      if (body.type === 'repertoire') {
        const rep = body.repertoire;
        if (!rep || typeof rep !== 'object' || !Array.isArray(rep.pos) || !Array.isArray(rep.lines) || !Array.isArray(rep.secs)) {
          return res.status(400).json({ error: 'Invalid repertoire object' });
        }
        const serialized = JSON.stringify(rep);
        if (serialized.length > MAX_REPERTOIRE_BYTES) {
          return res.status(413).json({ error: 'Repertoire exceeds 4 MB sync limit' });
        }
        const name = typeof body.name === 'string' ? body.name.slice(0, 60) : '';
        const updatedAt = Number.isFinite(Number(body.updatedAt)) ? Math.trunc(Number(body.updatedAt)) : now;

        await sql`
          INSERT INTO user_repertoires (lichess_id, name, repertoire_json, updated_at)
          VALUES (${user.id}, ${name}, ${serialized}::jsonb, ${updatedAt})
          ON CONFLICT (lichess_id)
          DO UPDATE SET
            name = EXCLUDED.name,
            repertoire_json = EXCLUDED.repertoire_json,
            updated_at = EXCLUDED.updated_at
        `;

        let mergedProg = null;
        if (body.progress && typeof body.progress === 'object') {
          const existingRows = await sql`
            SELECT progress_json FROM user_progress WHERE lichess_id = ${user.id}
          `;
          mergedProg = mergeProgress(existingRows[0]?.progress_json || {}, body.progress);
          await sql`
            INSERT INTO user_progress (lichess_id, progress_json, updated_at)
            VALUES (${user.id}, ${JSON.stringify(mergedProg)}::jsonb, ${now})
            ON CONFLICT (lichess_id)
            DO UPDATE SET progress_json = EXCLUDED.progress_json, updated_at = EXCLUDED.updated_at
          `;
        }

        return res.status(200).json({
          ok: true,
          updatedAt,
          ...(mergedProg ? { progress: mergedProg } : {}),
        });
      }

      if (body.type === 'scoutTargets') {
        const existingRows = await sql`
          SELECT targets_json FROM user_scout_targets WHERE lichess_id = ${user.id}
        `;
        const mergedTargets = mergeScoutTargets(existingRows[0]?.targets_json || [], body.scoutTargets);
        await sql`
          INSERT INTO user_scout_targets (lichess_id, targets_json, updated_at)
          VALUES (${user.id}, ${JSON.stringify(mergedTargets)}::jsonb, ${now})
          ON CONFLICT (lichess_id)
          DO UPDATE SET targets_json = EXCLUDED.targets_json, updated_at = EXCLUDED.updated_at
        `;
        return res.status(200).json({ ok: true, scoutTargets: mergedTargets, updatedAt: now });
      }

      return res.status(400).json({ error: 'Unknown sync type' });
    } catch (err) {
      console.error('[api/sync] PUT failed:', err);
      return res.status(500).json({ error: 'Failed to save synced data' });
    }
  }

  res.setHeader('Allow', 'GET, PUT');
  return res.status(405).json({ error: 'Method not allowed' });
}
