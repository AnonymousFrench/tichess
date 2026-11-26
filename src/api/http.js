const hostCooldowns = new Map();

export class RateLimitError extends Error {
  constructor(host, retryAfterMs = 60_000) {
    const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
    super(`Rate limited by ${host} — retrying in ${secs}s`);
    this.name = 'RateLimitError';
    this.host = host;
    this.retryAfterMs = retryAfterMs;
    this.status = 429;
  }
}

function getHost(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return 'default';
  }
}

export function getHostCooldownRemainingMs(url) {
  const host = getHost(url);
  const until = hostCooldowns.get(host) || 0;
  return Math.max(0, until - Date.now());
}

export function clearRateLimits() {
  hostCooldowns.clear();
}

async function rawFetch(url, { signal, headers } = {}) {
  const host = getHost(url);
  const remaining = getHostCooldownRemainingMs(url);
  if (remaining > 0) {
    throw new RateLimitError(host, remaining);
  }

  const resp = await fetch(url, { signal, headers });
  if (resp.status === 429) {
    const retryHeader = parseInt(resp.headers?.get?.('Retry-After') || '0', 10);
    const waitMs = Math.max(60_000, Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader * 1000 : 60_000);
    hostCooldowns.set(host, Date.now() + waitMs);
    throw new RateLimitError(host, waitMs);
  }
  return resp;
}

export async function fetchJson(url, { signal, headers, allow404 = false } = {}) {
  const resp = await rawFetch(url, { signal, headers });
  if (allow404 && resp.status === 404) return null;
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status} for ${url}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

export async function fetchText(url, { signal, headers } = {}) {
  const resp = await rawFetch(url, { signal, headers });
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status} for ${url}`);
    err.status = resp.status;
    throw err;
  }
  return resp.text();
}
