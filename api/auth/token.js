import { getDb, isDbConfigured } from '../_lib/db.js';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  getSigningSecret,
  encryptSecretValue,
  signToken,
  serializeCookie,
  getRequestOrigin,
  isSameOriginRequest,
} from '../_lib/session.js';
import { ensureSourceInDb, parseJsonBody } from '../_lib/insightsSync.js';

/**
 * Exchange a manually pasted Lichess personal access token for a tichess session,
 * store the encrypted token in Neon, and immediately register the user's Lichess
 * account for background Insights syncing.
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

  const body = parseJsonBody(req);
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!token || token.length < 8 || token.length > 256) {
    return res.status(400).json({ error: 'Invalid Lichess token format' });
  }

  try {
    const acctRes = await fetch('https://lichess.org/api/account', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    if (acctRes.status === 401 || acctRes.status === 403) {
      return res.status(401).json({ error: 'Lichess rejected that token (invalid or revoked)' });
    }
    if (acctRes.status === 429) {
      return res.status(429).json({ error: 'Lichess rate limited — please try again in a minute' });
    }
    if (!acctRes.ok) {
      return res.status(502).json({ error: `Could not verify token with Lichess (${acctRes.status})` });
    }

    const acct = await acctRes.json();
    const lichessId = String(acct?.id || '').trim().toLowerCase();
    const username = String(acct?.username || lichessId).trim();
    if (!lichessId) {
      return res.status(502).json({ error: 'Could not read Lichess account identity' });
    }

    const secret = getSigningSecret();
    const tokenEnc = encryptSecretValue(token, secret);
    const sql = await getDb();
    await sql`
      INSERT INTO users (lichess_id, username, lichess_token_enc, last_seen_at)
      VALUES (${lichessId}, ${username}, ${tokenEnc}, NOW())
      ON CONFLICT (lichess_id)
      DO UPDATE SET
        username = EXCLUDED.username,
        lichess_token_enc = EXCLUDED.lichess_token_enc,
        last_seen_at = NOW()
    `;

    // Immediately register the user's Lichess account so background game sync starts right away.
    await ensureSourceInDb(sql, {
      lichessId,
      src: 'lichess',
      displayName: username,
      linkToUser: true,
    });

    const { isHttps } = getRequestOrigin(req);
    const sessionVal = signToken({ sub: lichessId, username }, secret, SESSION_MAX_AGE_SEC);
    const sessionCookie = serializeCookie(SESSION_COOKIE, sessionVal, {
      maxAge: SESSION_MAX_AGE_SEC,
      path: '/',
      httpOnly: true,
      secure: isHttps,
      sameSite: 'Lax',
    });

    res.setHeader('Set-Cookie', sessionCookie);
    return res.status(200).json({
      ok: true,
      user: { id: lichessId, username },
      sourceAdded: true,
    });
  } catch (err) {
    console.error('[auth/token] Token sign-in failed:', err);
    return res.status(500).json({ error: 'Failed to save Lichess token' });
  }
}
