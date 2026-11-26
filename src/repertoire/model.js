/**
 * Pure logic for the repertoire trainer: import-file validation, progress
 * merging and the spaced-repetition schedule. No DOM access, so it is unit
 * tested directly.
 *
 * Repertoire data never ships with the app. The user imports a private
 * `tichess-repertoire` JSON file, which is kept only in their browser.
 */

export const FILE_FORMAT = 'tichess-repertoire';
export const FILE_VERSION = 1;

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** Review intervals in days, indexed by box (0 = just missed / learning). */
export const IVL = [0, 1, 3, 7, 16, 35, 90];
/** A missed move comes back after this long. */
export const MISS_DELAY = 10 * MIN;
/** Box at which a move counts as mastered (the 16-day step). */
export const MASTERED_BOX = 4;

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v) && v >= 0;

/**
 * Validate the shape of a repertoire import file. Returns
 * `{ ok: true, repertoire, progress, name }` or `{ ok: false, error }`.
 * Checks the structural invariants the trainer relies on, so a damaged or
 * unrelated file is rejected up front instead of breaking the page later.
 */
export function parseRepertoireFile(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'The file is empty.' };
  if (text.length > MAX_FILE_BYTES) return { ok: false, error: 'The file is too large to be a repertoire.' };

  let doc;
  try {
    doc = JSON.parse(text);
  } catch (_) {
    return { ok: false, error: 'This is not a JSON file.' };
  }
  if (!isObj(doc) || doc.format !== FILE_FORMAT) {
    return { ok: false, error: 'This is not a tichess repertoire file.' };
  }
  if (doc.version !== FILE_VERSION) {
    return { ok: false, error: `Unsupported repertoire file version (${String(doc.version)}).` };
  }

  const rep = doc.repertoire;
  const err = validateRepertoire(rep);
  if (err) return { ok: false, error: `The repertoire data is damaged: ${err}` };

  const progress = isObj(doc.progress) ? sanitizeProgress(doc.progress, rep.cards) : {};
  const name = typeof doc.name === 'string' ? doc.name.slice(0, 60) : '';
  return { ok: true, repertoire: rep, progress, name };
}

function validateRepertoire(rep) {
  if (!isObj(rep)) return 'missing repertoire object';
  const { secs, lines, pos, cards, warn, theory } = rep;
  if (!Array.isArray(secs) || !secs.length) return 'no openings';
  if (!Array.isArray(lines) || !lines.length) return 'no lines';
  if (!Array.isArray(pos) || !pos.length) return 'no positions';
  if (!isObj(cards)) return 'no move cards';
  if (warn !== undefined && !isObj(warn)) return 'bad warnings';
  if (!Array.isArray(theory)) return 'no engine data';

  for (const [i, p] of pos.entries()) {
    if (!isObj(p) || typeof p.f !== 'string' || !Array.isArray(p.e)) return `position ${i}`;
    if (p.t !== undefined && p.t !== null && !(isInt(p.t) && p.t < theory.length)) return `position ${i} engine ref`;
    for (const e of p.e) {
      if (!Array.isArray(e) || !UCI_RE.test(e[0]) || typeof e[1] !== 'string') return `position ${i} move`;
      if (!isInt(e[2]) || e[2] >= pos.length) return `position ${i} target`;
      if (!Number.isInteger(e[3]) || !Array.isArray(e[4])) return `position ${i} flags`;
      if (e[5] !== undefined && e[5] !== null && e[5] !== 0 && !(typeof e[5] === 'string' && cards[e[5]])) {
        return `position ${i} card`;
      }
    }
  }
  const secIds = new Set();
  for (const s of secs) {
    if (!isObj(s) || typeof s.id !== 'string' || typeof s.name !== 'string') return 'opening entry';
    if (s.color !== 'w' && s.color !== 'b') return `opening ${s.id} color`;
    if (!isInt(s.start) || s.start >= pos.length || !isInt(s.startPly)) return `opening ${s.id} start`;
    if (!Array.isArray(s.lines) || !s.lines.length || s.lines.some((li) => !isInt(li) || li >= lines.length)) {
      return `opening ${s.id} lines`;
    }
    secIds.add(s.id);
  }
  for (const ln of lines) {
    if (!isObj(ln) || typeof ln.id !== 'string' || typeof ln.name !== 'string') return 'line entry';
    if (!secIds.has(ln.sec)) return `line ${ln.id} opening`;
    if (ln.color !== 'w' && ln.color !== 'b') return `line ${ln.id} color`;
    if (!Array.isArray(ln.uci) || !Array.isArray(ln.san) || !Array.isArray(ln.pos)) return `line ${ln.id} moves`;
    if (ln.san.length !== ln.uci.length || ln.pos.length !== ln.uci.length + 1) return `line ${ln.id} length`;
    if (ln.pos.some((pi) => !isInt(pi) || pi >= pos.length)) return `line ${ln.id} positions`;
    for (let p = 0; p < ln.uci.length; p++) {
      const edge = pos[ln.pos[p]].e.find((e) => e[0] === ln.uci[p]);
      if (!edge || edge[2] !== ln.pos[p + 1]) return `line ${ln.id} move ${p + 1}`;
    }
  }
  for (const [id, c] of Object.entries(cards)) {
    if (!isObj(c) || !UCI_RE.test(c.u) || typeof c.s !== 'string') return `card ${id}`;
  }
  return null;
}

/** Keep only well-formed progress records for cards that exist. */
export function sanitizeProgress(progress, cards) {
  const out = {};
  for (const [id, r] of Object.entries(progress || {})) {
    if (id === 'days') {
      if (isObj(r) && isObj(r.d)) {
        const d = {};
        for (const [k, v] of Object.entries(r.d)) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(k) && isObj(v) && isInt(v.n) && isInt(v.ok)) d[k] = { n: v.n, ok: v.ok };
        }
        out.days = { t: Number(r.t) || 0, d };
      }
      continue;
    }
    if (!cards[id] || !isObj(r)) continue;
    const b = Number(r.b), d = Number(r.d), t = Number(r.t);
    if (!Number.isFinite(b) || !Number.isFinite(d)) continue;
    out[id] = {
      b: Math.max(0, Math.min(IVL.length - 1, Math.trunc(b))),
      d,
      r: isInt(r.r) ? r.r : 0,
      l: isInt(r.l) ? r.l : 0,
      t: Number.isFinite(t) ? t : 0,
      s: r.s ? 1 : 0,
    };
  }
  return out;
}

/**
 * Merge imported progress into existing progress. For each card the record
 * with the more recent training time wins; daily activity takes the larger
 * count per day.
 */
export function mergeProgress(current, incoming) {
  const out = { ...current };
  for (const [id, r] of Object.entries(incoming || {})) {
    if (id === 'days') continue;
    const cur = out[id];
    if (!cur || (r.t || 0) > (cur.t || 0)) out[id] = { ...r };
  }
  const a = (current && current.days && current.days.d) || {};
  const b = (incoming && incoming.days && incoming.days.d) || {};
  if (Object.keys(a).length || Object.keys(b).length) {
    const d = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (!d[k] || v.n > d[k].n) d[k] = { ...v };
    }
    out.days = { t: Math.max(current?.days?.t || 0, incoming?.days?.t || 0), d };
  }
  return out;
}

/** 'new' | 'due' | 'learning' | 'mastered' for one card record. */
export function cardStatus(rec, now) {
  if (!rec || !rec.s) return 'new';
  if (rec.d <= now) return 'due';
  return rec.b >= MASTERED_BOX ? 'mastered' : 'learning';
}

/**
 * Apply one review result and return the new record. A first-try hit moves
 * the card up one box (1, 3, 7, 16, 35, then 90 days); a miss resets it and
 * brings it back in 10 minutes.
 */
export function gradeRecord(rec, ok, now) {
  const r = rec ? { ...rec } : { b: 0, d: now, r: 0, l: 0, t: 0, s: 1 };
  r.s = 1;
  r.r = (r.r || 0) + 1;
  r.t = now;
  if (ok) {
    r.b = Math.min((r.b || 0) + 1, IVL.length - 1);
    r.d = now + IVL[r.b] * DAY;
  } else {
    r.l = (r.l || 0) + 1;
    r.b = 0;
    r.d = now + MISS_DELAY;
  }
  return r;
}

/** Record a newly introduced card (due immediately, box 0). */
export function learnRecord(rec, now) {
  if (rec && rec.s) return rec;
  return { b: 0, d: now, r: 0, l: 0, t: now, s: 1 };
}

/** Build the export file contents from repertoire data and progress. */
export function buildExportFile(repertoire, progress, name, now) {
  return JSON.stringify({
    format: FILE_FORMAT,
    version: FILE_VERSION,
    name: name || '',
    exportedAt: now,
    repertoire,
    progress,
  });
}
