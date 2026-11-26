import { isDbConfigured } from '../_lib/db.js';
import {
  OAUTH_COOKIE,
  OAUTH_MAX_AGE_SEC,
  getSigningSecret,
  signToken,
  generatePkceBundle,
  serializeCookie,
  getRequestOrigin,
  sanitizeReturnTo,
} from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const returnTo = sanitizeReturnTo(req.query?.returnTo);

  if (!isDbConfigured()) {
    const sep = returnTo.includes('?') ? '&' : '?';
    return res.redirect(302, `${returnTo}${sep}sync_err=db_not_configured`);
  }

  const secret = getSigningSecret();
  if (!secret) {
    const sep = returnTo.includes('?') ? '&' : '?';
    return res.redirect(302, `${returnTo}${sep}sync_err=auth_config`);
  }

  const { origin, host, isHttps } = getRequestOrigin(req);
  const clientId = (process.env.LICHESS_CLIENT_ID || host).trim();
  const redirectUri = `${origin}/api/auth/callback`;
  const { verifier, challenge, state } = generatePkceBundle();

  const oauthCookieVal = signToken(
    { state, verifier, returnTo, clientId, redirectUri },
    secret,
    OAUTH_MAX_AGE_SEC
  );

  res.setHeader(
    'Set-Cookie',
    serializeCookie(OAUTH_COOKIE, oauthCookieVal, {
      maxAge: OAUTH_MAX_AGE_SEC,
      path: '/api/auth',
      httpOnly: true,
      secure: isHttps,
      sameSite: 'Lax',
    })
  );

  const authUrl = new URL('https://lichess.org/oauth');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('state', state);

  return res.redirect(302, authUrl.toString());
}
