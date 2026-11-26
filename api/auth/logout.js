import {
  SESSION_COOKIE,
  serializeCookie,
  getRequestOrigin,
  isSameOriginRequest,
} from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!isSameOriginRequest(req)) {
    return res.status(403).json({ error: 'Cross-origin request rejected' });
  }

  const { isHttps } = getRequestOrigin(req);
  res.setHeader(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE, '', {
      maxAge: 0,
      path: '/',
      httpOnly: true,
      secure: isHttps,
      sameSite: 'Lax',
    })
  );
  return res.status(200).json({ ok: true });
}
