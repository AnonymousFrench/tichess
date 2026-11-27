/**
 * Client-side coordinator for Neon-backed Insights storage and background sync jobs.
 *
 * Local IndexedDB remains the instant 0 ms read cache on every device; this module
 * incrementally pulls new games from Neon (`afterSeq` per source), uploads local/PGN
 * and scouted other-player games to Neon, and drives chunked server-side sync slices
 * across Studio, Repertoire, and Insights.
 */
import {
  loadAccounts,
  saveAccounts,
  loadAllGames,
  putGames,
  loadServerSeqs,
  saveServerSeqs,
} from './store.js';

const BG_LEASE_KEY = 'tichess_insights_bg_lease_v1';
const BG_LEASE_MS = 28_000;
const UPLOAD_CHUNK = 350;

export const sourceKey = (src, name) => `${src}:${String(name || '').toLowerCase()}`;

async function apiJson(url, opts = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...opts,
    headers: {
      Accept: 'application/json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Pure merge of local IndexedDB account metadata with authoritative server archive state.
 */
export function mergeAccountsWithServer(localAccounts, serverSources) {
  const byKey = new Map();
  for (const a of localAccounts || []) {
    if (!a?.src || !a?.name) continue;
    byKey.set(sourceKey(a.src, a.name), { ...a });
  }
  for (const s of serverSources || []) {
    if (!s?.src || !s?.name) continue;
    const key = sourceKey(s.src, s.acct || s.name);
    const prev = byKey.get(key) || {};
    byKey.set(key, {
      ...prev,
      src: s.src,
      name: s.name || prev.name,
      title: s.title || prev.title || '',
      total: Number(s.total) || Number(prev.total) || 0,
      perfs: s.perfs && Object.keys(s.perfs).length ? s.perfs : prev.perfs || {},
      newest: Math.max(Number(s.newest) || 0, Number(prev.newest) || 0),
      oldest:
        Number(s.oldest) && Number(prev.oldest)
          ? Math.min(Number(s.oldest), Number(prev.oldest))
          : Number(s.oldest) || Number(prev.oldest) || 0,
      complete: Boolean(s.complete),
      monthsDone: Array.isArray(s.monthsDone) && s.monthsDone.length ? s.monthsDone : prev.monthsDone || [],
      lastSync: Math.max(Number(s.lastSync) || 0, Number(prev.lastSync) || 0),
      syncError: s.syncError || '',
      addedAt: Number(prev.addedAt) || Number(s.addedAt) || Date.now(),
      cachedCount: Number(s.cachedCount) || 0,
      maxSeq: Number(s.maxSeq) || 0,
    });
  }
  return [...byKey.values()].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

function tryAcquireBgLease() {
  try {
    const now = Date.now();
    const raw = Number(localStorage.getItem(BG_LEASE_KEY) || 0);
    if (raw > now) return false;
    localStorage.setItem(BG_LEASE_KEY, String(now + BG_LEASE_MS));
    return true;
  } catch (_) {
    return true;
  }
}

function renewBgLease() {
  try {
    localStorage.setItem(BG_LEASE_KEY, String(Date.now() + BG_LEASE_MS));
  } catch (_) {}
}

function releaseBgLease() {
  try {
    localStorage.removeItem(BG_LEASE_KEY);
  } catch (_) {}
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Verify a manually entered Lichess personal access token on the server,
 * store it encrypted in Neon, issue a session cookie, and queue the user's archive.
 */
export async function registerManualLichessToken(token) {
  const clean = String(token || '').trim();
  if (!clean) return { ok: false, status: 400, error: 'Empty token' };
  try {
    const { ok, status, data } = await apiJson('/api/auth/token', {
      method: 'POST',
      body: JSON.stringify({ token: clean }),
    });
    if (!ok) {
      return { ok: false, status, error: data?.error || `Token setup failed (${status})` };
    }
    return { ok: true, status, user: data?.user || null };
  } catch (err) {
    return { ok: false, status: 0, error: err?.message || 'Network error' };
  }
}

/**
 * Link any Lichess or Chess.com player (self or another user) to the signed-in user's Insights.
 */
export async function addCloudInsightsSource(src, name) {
  const { ok, status, data } = await apiJson('/api/insights', {
    method: 'POST',
    body: JSON.stringify({ action: 'addSource', src, name }),
  });
  if (!ok) return { ok: false, status, error: data?.error || `Could not add source (${status})` };
  return { ok: true, source: data?.source || null, sources: data?.sources || [] };
}

/**
 * Register another player (e.g., scouted opponent) in Neon's shared archive without adding them
 * to the signed-in user's personal Insights sources list.
 */
export async function registerOtherPlayerArchive(src, name) {
  try {
    const { ok } = await apiJson('/api/insights', {
      method: 'POST',
      body: JSON.stringify({ action: 'registerOtherPlayer', src, name }),
    });
    return ok;
  } catch (_) {
    return false;
  }
}

/**
 * Remove a source link from Neon (and delete private PGN games if src === 'pgn').
 */
export async function removeCloudInsightsSource(src, name) {
  try {
    const seqs = await loadServerSeqs().catch(() => ({}));
    delete seqs[sourceKey(src, name)];
    await saveServerSeqs(seqs).catch(() => {});
    const { ok } = await apiJson('/api/insights', {
      method: 'DELETE',
      body: JSON.stringify({ src, acct: String(name || '').toLowerCase() }),
    });
    return ok;
  } catch (_) {
    return false;
  }
}

/**
 * Upload normalized games in chunks to Neon (used for private PGN imports,
 * scouted other players, and migrating pre-sign-in IndexedDB games).
 */
export async function uploadGamesToCloud(src, name, records, { linkToUser = false, signal } = {}) {
  if (!Array.isArray(records) || !records.length) return { ok: true, saved: 0 };
  let saved = 0;
  for (let i = 0; i < records.length; i += UPLOAD_CHUNK) {
    if (signal?.aborted) break;
    const chunk = records.slice(i, i + UPLOAD_CHUNK);
    const { ok, data } = await apiJson('/api/insights', {
      method: 'POST',
      signal,
      body: JSON.stringify({
        action: 'uploadGames',
        src,
        name,
        linkToUser,
        records: chunk,
      }),
    });
    if (!ok) return { ok: false, saved };
    saved += Number(data?.saved) || chunk.length;
  }
  return { ok: true, saved };
}

/**
 * Pull any games from Neon that aren't in local IndexedDB yet (`afterSeq` per source).
 * Also migrates any local-only IndexedDB accounts/games to Neon so nothing is lost.
 */
export async function pullInsightsFromServer({ onBatch, onSources, signal, syncLocalOnly = true } = {}) {
  const { ok, status, data } = await apiJson('/api/insights', { signal });
  if (!ok || !data || !Array.isArray(data.sources)) {
    return { ok: false, status, sources: [], pulledCount: 0 };
  }

  let serverSources = data.sources;
  const localAccounts = await loadAccounts().catch(() => []);

  // Push any pre-existing local-only accounts (e.g., added before signing in) up to Neon once.
  if (syncLocalOnly && localAccounts.length) {
    const serverKeys = new Set(serverSources.map((s) => sourceKey(s.src, s.acct || s.name)));
    const localOnly = localAccounts.filter((a) => !serverKeys.has(sourceKey(a.src, a.name)));
    if (localOnly.length) {
      const localGames = await loadAllGames().catch(() => []);
      for (const a of localOnly) {
        if (signal?.aborted) break;
        const acct = a.name.toLowerCase();
        const mine = localGames.filter((g) => g.src === a.src && g.acct === acct);
        if (mine.length) {
          await uploadGamesToCloud(a.src, a.name, mine, { linkToUser: true, signal }).catch(() => {});
        } else if (a.src === 'lichess' || a.src === 'chesscom') {
          await addCloudInsightsSource(a.src, a.name).catch(() => {});
        }
      }
      const refreshed = await apiJson('/api/insights', { signal });
      if (refreshed.ok && Array.isArray(refreshed.data?.sources)) {
        serverSources = refreshed.data.sources;
      }
    }
  }

  const mergedAccounts = mergeAccountsWithServer(localAccounts, serverSources);
  await saveAccounts(mergedAccounts).catch(() => {});
  onSources?.(mergedAccounts, serverSources);

  const seqs = await loadServerSeqs().catch(() => ({}));
  let pulledCount = 0;

  for (const s of serverSources) {
    if (signal?.aborted) break;
    const key = sourceKey(s.src, s.acct || s.name);
    let cursor = Number(seqs[key]) || 0;
    const targetSeq = Number(s.maxSeq) || 0;
    if (targetSeq <= cursor) continue;

    while (!signal?.aborted) {
      const qs = new URLSearchParams({
        action: 'games',
        src: s.src,
        acct: s.acct || s.name.toLowerCase(),
        afterSeq: String(cursor),
        limit: '1200',
      });
      const page = await apiJson(`/api/insights?${qs}`, { signal });
      if (!page.ok || !page.data) break;
      const games = Array.isArray(page.data.games) ? page.data.games : [];
      if (games.length) {
        await putGames(games).catch(() => {});
        pulledCount += games.length;
        onBatch?.(games, s);
      }
      const nextSeq = Number(page.data.lastSeq) || cursor;
      if (nextSeq > cursor) {
        cursor = nextSeq;
        seqs[key] = cursor;
        await saveServerSeqs(seqs).catch(() => {});
      }
      if (!page.data.hasMore || !games.length) break;
    }
  }

  return { ok: true, status: 200, sources: serverSources, accounts: mergedAccounts, pulledCount };
}

let activeBackgroundRun = null;

/**
 * Run a chunked background sync loop against `/api/insights/sync` + delta pull into IndexedDB.
 * Safe to invoke from Studio, Repertoire, or Insights:
 * - Silent background calls share a cross-tab lease so multiple tabs don't double-sync.
 * - Foreground calls (`foreground: true`, e.g., Insights page) run immediately and report progress.
 */
export async function runBackgroundInsightsSync({
  force = false,
  source = null,
  includeScout = true,
  foreground = false,
  maxSlices = 10,
  signal = null,
  onProgress = null,
  onBatch = null,
  onSources = null,
} = {}) {
  if (!foreground) {
    if (activeBackgroundRun) return activeBackgroundRun;
    if (!tryAcquireBgLease()) return { ok: true, skipped: 'leased', added: 0 };
  }

  const run = (async () => {
    let totalAdded = 0;
    let totalPulled = 0;
    let lastError = '';

    try {
      // 1. Immediately pull any games already stored in Neon (from cron, other devices, or other users).
      const initial = await pullInsightsFromServer({ onBatch, onSources, signal });
      if (!initial.ok) {
        return { ok: false, status: initial.status, added: 0, pulled: 0 };
      }
      totalPulled += initial.pulledCount;

      // 2. Advance server-side sync slices while any archive is incomplete or stale.
      let slices = 0;
      let shouldContinue = true;
      while (shouldContinue && slices < maxSlices && !signal?.aborted) {
        if (!foreground) renewBgLease();
        slices++;

        const payload = {
          force: force && slices === 1,
          includeScout,
          ...(source?.src && source?.name ? { src: source.src, acct: source.name.toLowerCase(), name: source.name } : {}),
        };

        const { ok, status, data } = await apiJson('/api/insights/sync', {
          method: 'POST',
          signal,
          body: JSON.stringify(payload),
        });

        if (!ok || !data) {
          lastError = data?.error || `Sync failed (${status})`;
          break;
        }

        const synced = data.synced;
        if (!synced) {
          shouldContinue = false;
          break;
        }

        totalAdded += Number(synced.added) || 0;
        if (synced.error) lastError = synced.error;

        onProgress?.({
          src: synced.src,
          acct: synced.acct,
          label: `${synced.src === 'lichess' ? 'Lichess' : 'Chess.com'} · ${synced.displayName || synced.acct}`,
          fetched: Number(synced.cachedCount) || totalAdded,
          total: Number(synced.totalGames) || 0,
          added: Number(synced.added) || 0,
          complete: Boolean(synced.complete),
          hasMore: Boolean(data.hasMore),
          error: synced.error || '',
        });

        // Pull newly stored games into local IndexedDB right after each slice.
        if ((Number(synced.added) || 0) > 0 || slices === 1) {
          const delta = await pullInsightsFromServer({
            onBatch,
            onSources,
            signal,
            syncLocalOnly: false,
          });
          totalPulled += delta.pulledCount;
        }

        shouldContinue = Boolean(data.hasMore) && synced.skipped !== 'locked';
        if (shouldContinue && !signal?.aborted) {
          await sleep(900, signal);
        }
      }

      return { ok: !lastError, added: totalAdded, pulled: totalPulled, error: lastError };
    } catch (err) {
      if (err?.name === 'AbortError') {
        return { ok: true, aborted: true, added: totalAdded, pulled: totalPulled };
      }
      return { ok: false, error: err?.message || 'Background sync failed', added: totalAdded, pulled: totalPulled };
    } finally {
      if (!foreground) {
        releaseBgLease();
        activeBackgroundRun = null;
      }
    }
  })();

  if (!foreground) activeBackgroundRun = run;
  return run;
}

/**
 * Fire-and-forget kick used by Studio, Repertoire, and post-login hooks so server
 * background sync jobs begin immediately without blocking page load.
 */
export function kickBackgroundInsightsSync(opts = {}) {
  if (typeof window === 'undefined') return;
  void runBackgroundInsightsSync({ foreground: false, maxSlices: 6, ...opts }).catch(() => {});
}
