import { mergeProgress } from '../repertoire/model.js';
import {
  loadRepertoire,
  saveRepertoire,
  loadProgress,
  saveProgress,
} from '../repertoire/storage.js';

const SCOUT_TARGETS_KEY = 'tichess-scout-targets';

const syncState = {
  configured: false,
  authenticated: false,
  user: null, // { id, username }
  status: 'idle', // 'idle' | 'syncing' | 'synced' | 'offline' | 'error'
  lastSyncedAt: 0,
  error: '',
  scoutTargets: [],
};

const stateListeners = new Set();
const dataListeners = new Set();
let progressTimer = null;
let syncInFlight = null;
let lastAutoPullAt = 0;

function emitState() {
  const snap = getCloudSyncState();
  for (const fn of stateListeners) {
    try {
      fn(snap);
    } catch (_) {}
  }
}

function emitDataPulled(changes) {
  for (const fn of dataListeners) {
    try {
      fn(changes);
    } catch (_) {}
  }
}

export function getCloudSyncState() {
  return {
    ...syncState,
    user: syncState.user ? { ...syncState.user } : null,
    scoutTargets: [...syncState.scoutTargets],
  };
}

export function onCloudSyncState(fn) {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}

export function onCloudDataPulled(fn) {
  dataListeners.add(fn);
  return () => dataListeners.delete(fn);
}

/**
 * Pure decision rule for two-way repertoire sync between local IndexedDB and cloud Neon.
 */
export function decideRepertoireSyncAction(localRep, cloudRep) {
  const hasLocal = Boolean(localRep?.repertoire);
  const hasCloud = Boolean(cloudRep?.repertoire);
  if (!hasLocal && !hasCloud) return 'noop';
  if (!hasLocal && hasCloud) return 'pull';
  if (hasLocal && !hasCloud) return 'push';
  const localTs = Number(localRep.updatedAt) || 0;
  const cloudTs = Number(cloudRep.updatedAt) || 0;
  if (cloudTs > localTs) return 'pull';
  if (localTs > cloudTs) return 'push';
  return 'noop';
}

export function loadLocalScoutTargets() {
  try {
    const arr = JSON.parse(localStorage.getItem(SCOUT_TARGETS_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function saveLocalScoutTargets(list) {
  try {
    localStorage.setItem(SCOUT_TARGETS_KEY, JSON.stringify(list));
  } catch (_) {}
}

function mergeLocalTargets(a, b) {
  const map = new Map();
  for (const item of [...(a || []), ...(b || [])]) {
    if (!item?.source || !item?.username) continue;
    const key = `${item.source}:${item.username.toLowerCase()}`;
    const prev = map.get(key);
    if (!prev || (item.updatedAt || 0) >= (prev.updatedAt || 0)) {
      map.set(key, item);
    }
  }
  return Array.from(map.values()).sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
}

function consumeSyncErrorFromUrl() {
  if (typeof window === 'undefined') return '';
  try {
    const url = new URL(window.location.href);
    const err = url.searchParams.get('sync_err');
    if (!err) return '';
    url.searchParams.delete('sync_err');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    const messages = {
      db_not_configured: 'Connect Neon Postgres in your Vercel project Storage tab to enable cloud sync.',
      oauth_denied: 'Lichess sign-in was cancelled.',
      oauth_expired: 'Sign-in session expired — please try again.',
      oauth_state: 'Sign-in verification failed — please try again.',
      token_exchange: 'Could not complete Lichess sign-in — please retry.',
    };
    return messages[err] || 'Cloud sign-in failed — please try again.';
  } catch (_) {
    return '';
  }
}

/** Sign-in URL that brings you back to the page you are on (the session works on every page). */
export function getLoginUrl(returnTo = null) {
  const path = returnTo || (typeof window !== 'undefined' ? window.location.pathname || '/' : '/');
  return `/api/auth/login?returnTo=${encodeURIComponent(path)}`;
}

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
 * Perform a full two-way sync (pull + merge progress, repertoire, and scout targets).
 */
export async function syncNow() {
  if (!syncState.authenticated) return { ok: false, reason: 'unauthenticated' };
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    syncState.status = 'syncing';
    syncState.error = '';
    emitState();

    try {
      const { ok, status, data } = await apiJson('/api/sync');
      if (status === 401) {
        syncState.authenticated = false;
        syncState.user = null;
        syncState.status = 'idle';
        emitState();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!ok || !data) {
        throw new Error(data?.error || `Sync failed (${status})`);
      }

      const changes = { repertoireUpdated: false, progressUpdated: false, scoutTargetsUpdated: false };

      // 1. Merge SRS progress (most recent review per card always wins)
      const localProg = loadProgress();
      const cloudProg = data.progress && typeof data.progress === 'object' ? data.progress : {};
      const mergedProg = mergeProgress(cloudProg, localProg);
      const localProgJson = JSON.stringify(localProg);
      const cloudProgJson = JSON.stringify(cloudProg);
      const mergedProgJson = JSON.stringify(mergedProg);

      if (mergedProgJson !== localProgJson) {
        saveProgress(mergedProg);
        changes.progressUpdated = true;
      }

      // 2. Sync repertoire by timestamp
      const localRep = await loadRepertoire();
      const cloudRep = data.repertoire
        ? {
            repertoire: data.repertoire,
            name: data.repertoireName || '',
            updatedAt: Number(data.repertoireUpdatedAt) || 0,
          }
        : null;

      const repAction = decideRepertoireSyncAction(localRep, cloudRep);
      if (repAction === 'pull') {
        await saveRepertoire(cloudRep.repertoire, cloudRep.name, cloudRep.updatedAt || Date.now());
        changes.repertoireUpdated = true;
      } else if (repAction === 'push') {
        const pushTs = Number(localRep.updatedAt) || Date.now();
        if (!localRep.updatedAt) {
          await saveRepertoire(localRep.repertoire, localRep.name, pushTs);
        }
        await apiJson('/api/sync', {
          method: 'PUT',
          body: JSON.stringify({
            type: 'repertoire',
            name: localRep.name || '',
            repertoire: localRep.repertoire,
            updatedAt: pushTs,
            progress: mergedProg,
          }),
        });
      }

      // If we didn't push progress alongside repertoire, push merged progress if cloud was behind
      if (repAction !== 'push' && mergedProgJson !== cloudProgJson && Object.keys(mergedProg).length) {
        await apiJson('/api/sync', {
          method: 'PUT',
          body: JSON.stringify({ type: 'progress', progress: mergedProg }),
        });
      }

      // 3. Merge scout target bookmarks
      const localTargets = loadLocalScoutTargets();
      const cloudTargets = Array.isArray(data.scoutTargets) ? data.scoutTargets : [];
      const mergedTargets = mergeLocalTargets(cloudTargets, localTargets);
      if (JSON.stringify(mergedTargets) !== JSON.stringify(localTargets)) {
        saveLocalScoutTargets(mergedTargets);
        changes.scoutTargetsUpdated = true;
      }
      syncState.scoutTargets = mergedTargets;
      if (JSON.stringify(mergedTargets) !== JSON.stringify(cloudTargets) && mergedTargets.length) {
        await apiJson('/api/sync', {
          method: 'PUT',
          body: JSON.stringify({ type: 'scoutTargets', scoutTargets: mergedTargets }),
        });
      }

      syncState.status = 'synced';
      syncState.lastSyncedAt = Date.now();
      lastAutoPullAt = syncState.lastSyncedAt;
      emitState();
      if (changes.repertoireUpdated || changes.progressUpdated || changes.scoutTargetsUpdated) {
        emitDataPulled(changes);
      }
      return { ok: true, changes };
    } catch (err) {
      syncState.status = typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error';
      syncState.error = err?.message || 'Cloud sync failed';
      emitState();
      return { ok: false, error: syncState.error };
    } finally {
      syncInFlight = null;
    }
  })();

  return syncInFlight;
}

/**
 * Push a newly saved/edited repertoire immediately to Neon when signed in.
 */
export async function pushRepertoireToCloud(repertoire, name, updatedAt = Date.now(), progress = null) {
  if (!syncState.authenticated || !repertoire) return false;
  syncState.status = 'syncing';
  emitState();
  try {
    const { ok, data } = await apiJson('/api/sync', {
      method: 'PUT',
      body: JSON.stringify({
        type: 'repertoire',
        name: name || '',
        repertoire,
        updatedAt,
        ...(progress ? { progress } : {}),
      }),
    });
    if (!ok) throw new Error(data?.error || 'Repertoire push failed');
    if (data?.progress) {
      saveProgress(data.progress);
    }
    syncState.status = 'synced';
    syncState.lastSyncedAt = Date.now();
    syncState.error = '';
    emitState();
    return true;
  } catch (err) {
    syncState.status = 'error';
    syncState.error = err?.message || 'Repertoire sync failed';
    emitState();
    return false;
  }
}

/**
 * Debounced push of SRS progress after drilling moves (merges server-side by timestamp).
 */
export function scheduleProgressSync(progress) {
  if (!syncState.authenticated) return;
  clearTimeout(progressTimer);
  progressTimer = setTimeout(async () => {
    progressTimer = null;
    if (!syncState.authenticated) return;
    syncState.status = 'syncing';
    emitState();
    try {
      const { ok, data } = await apiJson('/api/sync', {
        method: 'PUT',
        body: JSON.stringify({ type: 'progress', progress: progress || loadProgress() }),
      });
      if (!ok) throw new Error(data?.error || 'Progress sync failed');
      if (data?.progress) {
        saveProgress(data.progress);
      }
      syncState.status = 'synced';
      syncState.lastSyncedAt = Date.now();
      syncState.error = '';
      emitState();
    } catch (err) {
      syncState.status = typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'error';
      syncState.error = err?.message || 'Progress sync failed';
      emitState();
    }
  }, 1200);
}

/**
 * Record a scouted Lichess or Chess.com opponent and sync the bookmark list across devices.
 */
export async function recordScoutTarget({ source, username, max = 100, perfType = '' }) {
  if (!source || !username) return;
  const entry = { source, username: username.trim(), max, perfType, updatedAt: Date.now() };
  const merged = mergeLocalTargets(loadLocalScoutTargets(), [entry]);
  saveLocalScoutTargets(merged);
  syncState.scoutTargets = merged;
  emitState();

  if (!syncState.authenticated) return;
  try {
    const { ok, data } = await apiJson('/api/sync', {
      method: 'PUT',
      body: JSON.stringify({ type: 'scoutTargets', scoutTargets: merged }),
    });
    if (ok && Array.isArray(data?.scoutTargets)) {
      saveLocalScoutTargets(data.scoutTargets);
      syncState.scoutTargets = data.scoutTargets;
      emitState();
    }
  } catch (_) {}
}

export async function signOutCloudSync() {
  try {
    await apiJson('/api/auth/logout', { method: 'POST' });
  } catch (_) {}
  clearTimeout(progressTimer);
  syncState.authenticated = false;
  syncState.user = null;
  syncState.status = 'idle';
  syncState.error = '';
  emitState();
}

let lifecycleBound = false;

/**
 * Initialize cloud sync on page boot. Safe on static servers (404 on /api/auth/me degrades silently).
 */
export async function initCloudSync() {
  syncState.scoutTargets = loadLocalScoutTargets();
  const urlErr = consumeSyncErrorFromUrl();
  if (urlErr) {
    syncState.error = urlErr;
  }

  if (!lifecycleBound && typeof window !== 'undefined') {
    lifecycleBound = true;
    document.addEventListener('visibilitychange', () => {
      if (
        document.visibilityState === 'visible' &&
        syncState.authenticated &&
        Date.now() - lastAutoPullAt > 10_000
      ) {
        syncNow();
      }
    });
    window.addEventListener('online', () => {
      if (syncState.authenticated) syncNow();
    });
  }

  try {
    const { ok, data } = await apiJson('/api/auth/me');
    if (ok && data && typeof data === 'object') {
      syncState.configured = Boolean(data.configured);
      syncState.authenticated = Boolean(data.authenticated && data.user);
      syncState.user = data.user || null;
      emitState();
      if (syncState.authenticated) {
        await syncNow();
      }
      return getCloudSyncState();
    }
  } catch (_) {
    // Static preview or offline mode — degrade cleanly with zero noise
  }

  syncState.configured = false;
  syncState.authenticated = false;
  syncState.user = null;
  emitState();
  return getCloudSyncState();
}
