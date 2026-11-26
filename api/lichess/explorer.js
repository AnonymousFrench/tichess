import { getDb, isDbConfigured } from '../_lib/db.js';
import {
  getSigningSecret,
  decryptSecretValue,
  readSessionFromRequest,
} from '../_lib/session.js';

const STREAM_TIMEOUT_MS = 7500;

/**
 * Parse the final valid JSON object from an NDJSON stream (used by explorer.lichess.org/player).
 */
export function parseLastNdjsonObject(ndjsonText) {
  if (!ndjsonText || typeof ndjsonText !== 'string') return null;
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
  return null;
}

/**
 * Read a streaming NDJSON response up to `timeoutMs` so on-demand Lichess player
 * indexing cannot cause a Vercel 504 timeout.
 */
async function readNdjsonWithTimeout(upstream, timeoutMs = STREAM_TIMEOUT_MS) {
  if (!upstream.body?.getReader) {
    const text = await upstream.text();
    return { frame: parseLastNdjsonObject(text), timedOut: false };
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let lastFrame = null;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    try {
      reader.cancel();
    } catch (_) {}
  }, timeoutMs);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() || '';
      for (const raw of parts) {
        const line = raw.trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj === 'object') lastFrame = obj;
        } catch (_) {}
      }
    }
    const tail = (buf + decoder.decode()).trim();
    if (tail) {
      try {
        const obj = JSON.parse(tail);
        if (obj && typeof obj === 'object') lastFrame = obj;
      } catch (_) {}
    }
  } catch (_) {
    // Expected when timer cancels reader
  } finally {
    clearTimeout(timer);
  }

  return { frame: lastFrame, timedOut };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Cloud sync is not configured' });
  }

  const user = readSessionFromRequest(req);
  if (!user) {
    return res.status(401).json({ code: 'unauthenticated', error: 'Sign in with Lichess first' });
  }

  const source = String(req.query?.source || 'player');
  const fen = String(req.query?.fen || '').trim();
  const color = req.query?.color === 'black' ? 'black' : 'white';

  if (!fen || fen.length > 140) {
    return res.status(400).json({ error: 'Missing or invalid FEN' });
  }
  if (!['masters', 'lichess', 'player'].includes(source)) {
    return res.status(400).json({ error: 'Invalid explorer source' });
  }

  try {
    const sql = await getDb();
    const rows = await sql`
      SELECT lichess_token_enc FROM users WHERE lichess_id = ${user.id}
    `;
    const enc = rows[0]?.lichess_token_enc;
    const accessToken = enc ? decryptSecretValue(enc, getSigningSecret()) : null;
    if (!accessToken) {
      return res.status(401).json({
        code: 'reauth_needed',
        error: 'Sign in with Lichess once more to enable your Lichess Explorer',
      });
    }

    let targetUrl;
    if (source === 'masters') {
      targetUrl = `https://explorer.lichess.org/masters?fen=${encodeURIComponent(fen)}&topGames=8&recentGames=4`;
    } else if (source === 'lichess') {
      targetUrl = `https://explorer.lichess.org/lichess?fen=${encodeURIComponent(fen)}&ratings=2000,2200,2500&speeds=blitz,rapid,classical&topGames=4&recentGames=6`;
    } else {
      // Lichess /player explorer caps recentGames at 4
      targetUrl = `https://explorer.lichess.org/player?player=${encodeURIComponent(user.username)}&color=${color}&fen=${encodeURIComponent(fen)}&recentGames=4`;
    }

    const upstream = await fetch(targetUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: source === 'player' ? 'application/x-ndjson' : 'application/json',
      },
    });

    if (upstream.status === 401 || upstream.status === 403) {
      return res.status(401).json({
        code: 'reauth_needed',
        error: 'Lichess session expired — sign in again',
      });
    }
    if (upstream.status === 429) {
      return res.status(429).json({ error: 'Lichess Explorer rate limited' });
    }
    if (!upstream.ok) {
      const detail = (await upstream.text().catch(() => '')).slice(0, 160);
      return res.status(upstream.status).json({ error: detail || `Explorer error (${upstream.status})` });
    }

    if (source === 'player') {
      const { frame, timedOut } = await readNdjsonWithTimeout(upstream);
      if (!frame) {
        return res.status(200).json({
          white: 0,
          draws: 0,
          black: 0,
          moves: [],
          recentGames: [],
          indexing: timedOut,
        });
      }
      return res.status(200).json({
        ...frame,
        indexing: Boolean(timedOut || typeof frame.queuePosition === 'number'),
      });
    }

    const data = await upstream.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('[api/lichess/explorer] failed:', err);
    return res.status(500).json({ error: 'Explorer lookup failed' });
  }
}
