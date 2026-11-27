const DEFAULT_UPSTREAM = 'https://humanfish.vercel.app';
const REQUEST_TIMEOUT_MS = 25000;
const ALLOWED_TC_CATEGORIES = new Set(['classical', 'rapid', 'blitz']);

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Resolve the upstream HumanFish base URL from environment configuration.
 */
export function resolveHumanfishUpstreamUrl(env = process.env) {
  const raw = String(env?.HUMANFISH_API_URL || '').trim();
  const base = raw || DEFAULT_UPSTREAM;
  return base.replace(/\/+$/, '');
}

/**
 * Validate and sanitize a client evaluation request for HumanFish `/api/evaluate`.
 */
export function sanitizeEvaluatePayload(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Missing JSON body' };
  }
  const fen = String(body.fen || '').trim();
  if (!fen || fen.length > 140 || fen.split(/\s+/).length < 4) {
    return { ok: false, error: 'Missing or invalid FEN' };
  }

  const tcRaw = String(body.tc_category || 'classical').toLowerCase();
  const tc_category = ALLOWED_TC_CATEGORIES.has(tcRaw) ? tcRaw : 'classical';

  const payload = {
    fen,
    white_elo: Math.round(clampNumber(body.white_elo, 1000, 3200, 2750)),
    black_elo: Math.round(clampNumber(body.black_elo, 1000, 3200, 2750)),
    clk_white_s: Math.round(clampNumber(body.clk_white_s, 0, 21600, 3600) * 10) / 10,
    clk_black_s: Math.round(clampNumber(body.clk_black_s, 0, 21600, 3600) * 10) / 10,
    tc_category,
    tc_initial_s: Math.round(clampNumber(body.tc_initial_s, 30, 21600, 5400)),
    tc_increment_s: Math.round(clampNumber(body.tc_increment_s, 0, 180, 30)),
    has_move40: body.has_move40 !== false,
  };

  if (body.ply !== undefined && body.ply !== null && body.ply !== '') {
    const ply = Number(body.ply);
    if (Number.isInteger(ply) && ply >= 0 && ply <= 1000) {
      payload.ply = ply;
    }
  }

  return { ok: true, payload };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (_) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }

  const checked = sanitizeEvaluatePayload(body);
  if (!checked.ok) {
    return res.status(400).json({ error: checked.error });
  }

  const targetUrl = `${resolveHumanfishUpstreamUrl()}/api/evaluate`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(checked.payload),
      signal: ctrl.signal,
    });

    const text = await upstream.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }

    if (!upstream.ok) {
      const detail =
        (data && typeof data.detail === 'string' && data.detail) ||
        (data && typeof data.error === 'string' && data.error) ||
        text.slice(0, 180) ||
        `HumanFish upstream error (${upstream.status})`;
      const status = upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
      return res.status(status).json({ error: detail });
    }

    if (!data || typeof data !== 'object' || !data.human) {
      return res.status(502).json({ error: 'Invalid response from HumanFish server' });
    }

    return res.status(200).json(data);
  } catch (err) {
    if (err?.name === 'AbortError') {
      return res.status(504).json({ error: 'HumanFish evaluation timed out' });
    }
    console.error('[api/humanfish/evaluate] failed:', err);
    return res.status(502).json({ error: 'Could not reach HumanFish server' });
  } finally {
    clearTimeout(timer);
  }
}
