import crypto from 'node:crypto';

export const SESSION_COOKIE = 'tichess_session';
export const OAUTH_COOKIE = 'tichess_oauth';
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days
export const OAUTH_MAX_AGE_SEC = 60 * 10; // 10 minutes

function toBase64Url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * Resolve server-side HMAC signing secret.
 * Uses explicit SESSION_SECRET if configured, otherwise derives a stable key from
 * DATABASE_URL (which contains Neon's server-side secret password) so zero extra
 * env vars are needed after attaching Neon on Vercel.
 */
export function getSigningSecret(env = process.env) {
  if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 16) {
    return crypto.createHash('sha256').update(`tichess-secret:${env.SESSION_SECRET}`).digest();
  }
  if (env.DATABASE_URL) {
    return crypto.createHash('sha256').update(`tichess-db-derived-v1:${env.DATABASE_URL}`).digest();
  }
  return null;
}

/**
 * Encrypt a short secret (e.g., Lichess OAuth access token) with AES-256-GCM.
 */
export function encryptSecretValue(plaintext, keyBuf) {
  if (!plaintext || !keyBuf) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${toBase64Url(iv)}.${toBase64Url(tag)}.${toBase64Url(enc)}`;
}

/**
 * Decrypt a value produced by `encryptSecretValue`. Returns null on invalid input or wrong key.
 */
export function decryptSecretValue(encoded, keyBuf) {
  if (!encoded || typeof encoded !== 'string' || !keyBuf) return null;
  const parts = encoded.split('.');
  if (parts.length !== 3) return null;
  try {
    const iv = fromBase64Url(parts[0]);
    const tag = fromBase64Url(parts[1]);
    const enc = fromBase64Url(parts[2]);
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

/**
 * Create a compact HMAC-SHA256 signed token with an expiration timestamp.
 */
export function signToken(payload, secret, ttlSec = SESSION_MAX_AGE_SEC, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret) throw new Error('Missing signing secret');
  const body = toBase64Url(
    JSON.stringify({
      ...payload,
      iat: nowSec,
      exp: nowSec + ttlSec,
    })
  );
  const sig = toBase64Url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

/**
 * Verify signature and expiration of a token signed by `signToken`.
 * Returns the decoded payload object or `null`.
 */
export function verifyToken(token, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!token || typeof token !== 'string' || !secret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = toBase64Url(crypto.createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(fromBase64Url(body).toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.exp !== 'number' || parsed.exp < nowSec) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

/**
 * Generate a PKCE S256 verifier + challenge pair and CSRF state nonce.
 */
export function generatePkceBundle() {
  const verifier = toBase64Url(crypto.randomBytes(48));
  const challenge = toBase64Url(crypto.createHash('sha256').update(verifier).digest());
  const state = toBase64Url(crypto.randomBytes(24));
  return { verifier, challenge, state };
}

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch (_) {
        out[key] = val;
      }
    }
  }
  return out;
}

export function serializeCookie(
  name,
  value,
  { maxAge, path = '/', httpOnly = true, secure = true, sameSite = 'Lax' } = {}
) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (typeof maxAge === 'number') parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function getRequestOrigin(req) {
  const xfProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const xfHost = String(req.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
  const host = xfHost || String(req.headers?.host || 'localhost:3000').trim();
  const isLocal = /^localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$/.test(host);
  const proto = xfProto || (isLocal ? 'http' : 'https');
  return { origin: `${proto}://${host}`, host, isHttps: proto === 'https' };
}

/**
 * Only permit safe same-site relative paths as post-login redirect targets.
 */
export function sanitizeReturnTo(raw) {
  if (typeof raw !== 'string') return '/';
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) return '/';
  // Only the app's own pages (optionally with a query string) are valid destinations.
  for (const page of ['/', '/repertoire.html', '/insights.html']) {
    if (trimmed === page || trimmed.startsWith(`${page}?`)) return trimmed;
  }
  return '/';
}

/**
 * Defense-in-depth CSRF check for state-changing requests (PUT/POST/DELETE):
 * verifies Origin (when present) matches the request's own host.
 */
export function isSameOriginRequest(req) {
  const originHeader = req.headers?.origin;
  if (!originHeader) return true; // Non-CORS / same-origin navigation without Origin header
  try {
    const parsed = new URL(originHeader);
    const { host } = getRequestOrigin(req);
    return parsed.host.toLowerCase() === host.toLowerCase();
  } catch (_) {
    return false;
  }
}

export function readSessionFromRequest(req, env = process.env) {
  const secret = getSigningSecret(env);
  if (!secret) return null;
  const cookies = parseCookies(req.headers?.cookie || '');
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  const payload = verifyToken(raw, secret);
  if (!payload || typeof payload.sub !== 'string' || typeof payload.username !== 'string') {
    return null;
  }
  return { id: payload.sub, username: payload.username };
}
