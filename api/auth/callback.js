import crypto from 'node:crypto';
import { getDb, isDbConfigured } from '../_lib/db.js';
import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  getSigningSecret,
  encryptSecretValue,
  signToken,
  verifyToken,
  parseCookies,
  serializeCookie,
  getRequestOrigin,
  sanitizeReturnTo,
} from '../_lib/session.js';

function redirectWithError(res, returnTo, code) {
  const safe = sanitizeReturnTo(returnTo);
  const sep = safe.includes('?') ? '&' : '?';
  return res.redirect(302, `${safe}${sep}sync_err=${encodeURIComponent(code)}`);
}

function timingSafeStrEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!isDbConfigured()) {
    return redirectWithError(res, '/', 'db_not_configured');
  }

  const secret = getSigningSecret();
  const { isHttps } = getRequestOrigin(req);
  const cookies = parseCookies(req.headers?.cookie || '');
  const oauthPayload = verifyToken(cookies[OAUTH_COOKIE], secret);

  const clearOauthCookie = serializeCookie(OAUTH_COOKIE, '', {
    maxAge: 0,
    path: '/api/auth',
    httpOnly: true,
    secure: isHttps,
    sameSite: 'Lax',
  });

  if (!oauthPayload) {
    res.setHeader('Set-Cookie', clearOauthCookie);
    return redirectWithError(res, '/', 'oauth_expired');
  }

  const returnTo = sanitizeReturnTo(oauthPayload.returnTo);
  const { code, state, error } = req.query || {};

  if (error || typeof code !== 'string' || !code || !timingSafeStrEq(String(state || ''), oauthPayload.state)) {
    res.setHeader('Set-Cookie', clearOauthCookie);
    return redirectWithError(res, returnTo, error ? 'oauth_denied' : 'oauth_state');
  }

  try {
    // 1. Exchange authorization code + PKCE verifier for Lichess access token
    const tokenRes = await fetch('https://lichess.org/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: oauthPayload.verifier,
        redirect_uri: oauthPayload.redirectUri,
        client_id: oauthPayload.clientId,
      }),
    });

    if (!tokenRes.ok) {
      res.setHeader('Set-Cookie', clearOauthCookie);
      return redirectWithError(res, returnTo, 'token_exchange');
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData?.access_token;
    if (!accessToken || typeof accessToken !== 'string') {
      res.setHeader('Set-Cookie', clearOauthCookie);
      return redirectWithError(res, returnTo, 'token_missing');
    }

    // 2. Verify Lichess user identity via /api/account (works with zero scopes)
    const acctRes = await fetch('https://lichess.org/api/account', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!acctRes.ok) {
      res.setHeader('Set-Cookie', clearOauthCookie);
      return redirectWithError(res, returnTo, 'account_lookup');
    }

    const acct = await acctRes.json();
    const lichessId = String(acct?.id || '').trim().toLowerCase();
    const username = String(acct?.username || lichessId).trim();
    if (!lichessId) {
      res.setHeader('Set-Cookie', clearOauthCookie);
      return redirectWithError(res, returnTo, 'account_invalid');
    }

    // 3. Upsert user + encrypted unscoped Lichess token in Neon Postgres
    const tokenEnc = encryptSecretValue(accessToken, secret);
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

    // 4. Issue signed HttpOnly session cookie (we do NOT need to persist the raw Lichess token)
    const sessionVal = signToken({ sub: lichessId, username }, secret, SESSION_MAX_AGE_SEC);
    const sessionCookie = serializeCookie(SESSION_COOKIE, sessionVal, {
      maxAge: SESSION_MAX_AGE_SEC,
      path: '/',
      httpOnly: true,
      secure: isHttps,
      sameSite: 'Lax',
    });

    res.setHeader('Set-Cookie', [clearOauthCookie, sessionCookie]);
    return res.redirect(302, returnTo);
  } catch (err) {
    console.error('[auth/callback] OAuth callback failed:', err);
    res.setHeader('Set-Cookie', clearOauthCookie);
    return redirectWithError(res, returnTo, 'server_error');
  }
}
