import { isDbConfigured } from '../_lib/db.js';
import { readSessionFromRequest } from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const configured = isDbConfigured();
  if (!configured) {
    return res.status(200).json({
      configured: false,
      authenticated: false,
      user: null,
    });
  }

  const user = readSessionFromRequest(req);
  return res.status(200).json({
    configured: true,
    authenticated: Boolean(user),
    user: user || null,
  });
}
