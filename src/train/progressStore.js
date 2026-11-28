/**
 * Spaced-repetition progress for the position trainers (mistake drills,
 * blunder checks, conversions). Dependency-light so the Studio bundle, the
 * Insights bundle and the /api/sync function can all import it.
 *
 * Card ids:
 *   mistake drill   `<gameId>:<ply>`        e.g. `li:AbCd1234:31`
 *   blunder check   `bc:<gameId>:<ply>`
 *   conversion      `cv:<gameId>:<ply>`
 * where `<gameId>` is an Insights game id (`li:…`, `cc:…` or `pgn:…`).
 *
 * Record: { box, due, ok, miss, last } (box = Leitner box, due/last = ms).
 */
import { IVL, MISS_DELAY, DAY } from '../repertoire/model.js';

export const DRILL_PROGRESS_KEY = 'tichess_insights_drills_v1';
export const MAX_DRILL_RECORDS = 5000;
export const MAX_DRILL_PROGRESS_BYTES = 512 * 1024;

const CARD_ID_RE = /^(?:(?:bc|cv):)?(?:li|cc|pgn):[A-Za-z0-9_-]{1,64}:\d{1,4}$/;
const MAX_TS = 8.64e15; // largest valid JS date

export function isValidDrillCardId(id) {
  return typeof id === 'string' && id.length <= 90 && CARD_ID_RE.test(id);
}

function intIn(v, min, max, fallback = min) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function tsOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= MAX_TS ? Math.trunc(n) : 0;
}

/**
 * Keep only well-formed records with valid card ids. Never throws.
 * Records are rebuilt field by field, so unknown keys (including
 * `__proto__`) never survive.
 */
export function sanitizeDrillProgress(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let n = 0;
  for (const id of Object.keys(raw)) {
    if (n >= MAX_DRILL_RECORDS) break;
    if (!isValidDrillCardId(id)) continue;
    const r = raw[id];
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    out[id] = {
      box: intIn(r.box, 0, IVL.length - 1, 0),
      due: tsOrZero(r.due),
      ok: intIn(r.ok, 0, 1e6, 0),
      miss: intIn(r.miss, 0, 1e6, 0),
      last: tsOrZero(r.last),
    };
    n++;
  }
  return out;
}

/** Per card, the record trained most recently (`last`) wins. Inputs are sanitized. */
export function mergeDrillProgress(current, incoming) {
  const a = sanitizeDrillProgress(current);
  const b = sanitizeDrillProgress(incoming);
  const out = { ...a };
  for (const [id, r] of Object.entries(b)) {
    if (!out[id] || (r.last || 0) > (out[id].last || 0)) out[id] = r;
  }
  // Keep the most recently trained records if the merge overflows the cap.
  const ids = Object.keys(out);
  if (ids.length > MAX_DRILL_RECORDS) {
    ids.sort((x, y) => (out[y].last || 0) - (out[x].last || 0));
    const kept = {};
    for (const id of ids.slice(0, MAX_DRILL_RECORDS)) kept[id] = out[id];
    return kept;
  }
  return out;
}

/** Apply one attempt: a clean solve promotes one box, anything else resets to box 0. */
export function recordDrillOutcome(progress, id, ok, now = Date.now()) {
  const prev = progress[id] || { box: 0, due: 0, ok: 0, miss: 0 };
  const next = { ...prev, last: now };
  if (ok) {
    next.box = Math.min(IVL.length - 1, (prev.box || 0) + 1);
    next.due = now + IVL[next.box] * DAY;
    next.ok = (prev.ok || 0) + 1;
  } else {
    next.box = 0;
    next.due = now + MISS_DELAY;
    next.miss = (prev.miss || 0) + 1;
  }
  return { ...progress, [id]: next };
}

export function loadDrillProgress() {
  try {
    return sanitizeDrillProgress(JSON.parse(localStorage.getItem(DRILL_PROGRESS_KEY) || '{}'));
  } catch (_) {
    return {};
  }
}

const saveListeners = new Set();

/** Subscribe to local saves (used by cloud sync to schedule a push). */
export function onDrillProgressSaved(fn) {
  saveListeners.add(fn);
  return () => saveListeners.delete(fn);
}

export function saveDrillProgress(progress, { silent = false } = {}) {
  try {
    localStorage.setItem(DRILL_PROGRESS_KEY, JSON.stringify(progress));
  } catch (_) {
    /* private mode */
  }
  if (silent) return;
  for (const fn of saveListeners) {
    try {
      fn(progress);
    } catch (_) {}
  }
}
