import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Chess } from 'chess.js';
import {
  sanitizeDrillProgress,
  mergeDrillProgress,
  recordDrillOutcome,
  isValidDrillCardId,
  MAX_DRILL_RECORDS,
} from '../src/train/progressStore.js';
import {
  gradeAgainstBest,
  isCritical,
  pickMaiaMove,
  convertVerdict,
  findLine,
  fenAtPly,
  applyUci,
  extractBlunderCheckDeck,
  extractConvertDeck,
  ACCEPT_WIN_DROP,
  SAFE_WIN_DROP,
} from '../src/train/grading.js';
import { findOpponentWeakSpots, groupPositionMoves, plyMoveLabel, sanPathLabel } from '../src/repertoire/opponentWeakSpots.js';
import { computeToday } from '../src/insights/todayView.js';

/* ------------------------------------------------------------------ */
/* Progress store                                                      */
/* ------------------------------------------------------------------ */

describe('trainer progress store', () => {
  it('accepts only well-formed card ids', () => {
    expect(isValidDrillCardId('li:AbCd1234:31')).toBe(true);
    expect(isValidDrillCardId('bc:cc:123456:40')).toBe(true);
    expect(isValidDrillCardId('cv:pgn:1x9zq:22')).toBe(true);
    expect(isValidDrillCardId('__proto__')).toBe(false);
    expect(isValidDrillCardId('xx:abc:1')).toBe(false);
    expect(isValidDrillCardId('li:abc:<script>')).toBe(false);
    expect(isValidDrillCardId('li:' + 'a'.repeat(80) + ':1')).toBe(false);
    expect(isValidDrillCardId(42)).toBe(false);
  });

  it('sanitizes records field by field and drops junk', () => {
    const raw = JSON.parse(
      '{"li:abc:3":{"box":99,"due":"5","ok":-4,"miss":2.7,"last":1000,"evil":"x"},' +
        '"__proto__":{"box":1},"bad id":{"box":1},"li:def:4":"nope","cv:li:abc:9":{"box":2,"due":1e20,"last":-5}}'
    );
    const out = sanitizeDrillProgress(raw);
    expect(Object.keys(out).sort()).toEqual(['cv:li:abc:9', 'li:abc:3']);
    expect(out['li:abc:3']).toEqual({ box: 6, due: 5, ok: 0, miss: 2, last: 1000 });
    expect(out['cv:li:abc:9']).toEqual({ box: 2, due: 0, ok: 0, miss: 0, last: 0 });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(sanitizeDrillProgress(null)).toEqual({});
    expect(sanitizeDrillProgress([1, 2])).toEqual({});
  });

  it('merges by most recent training time and caps size', () => {
    const a = { 'li:a:1': { box: 1, due: 1, ok: 1, miss: 0, last: 100 } };
    const b = { 'li:a:1': { box: 3, due: 9, ok: 3, miss: 0, last: 200 }, 'li:b:2': { box: 0, due: 0, ok: 0, miss: 1, last: 50 } };
    const m = mergeDrillProgress(a, b);
    expect(m['li:a:1'].box).toBe(3);
    expect(m['li:b:2'].miss).toBe(1);
    expect(mergeDrillProgress(b, a)['li:a:1'].box).toBe(3);

    const big = {};
    for (let i = 0; i < MAX_DRILL_RECORDS + 50; i++) big[`li:g${i}:1`] = { box: 0, due: 0, ok: 0, miss: 0, last: i };
    const capped = mergeDrillProgress({}, big);
    expect(Object.keys(capped).length).toBeLessThanOrEqual(MAX_DRILL_RECORDS);
  });

  it('promotes on a clean solve and resets on a miss', () => {
    const p1 = recordDrillOutcome({}, 'bc:li:x:30', true, 1_000);
    expect(p1['bc:li:x:30'].box).toBe(1);
    const p2 = recordDrillOutcome(p1, 'bc:li:x:30', false, 2_000);
    expect(p2['bc:li:x:30'].box).toBe(0);
    expect(p2['bc:li:x:30'].miss).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Grading                                                             */
/* ------------------------------------------------------------------ */

describe('trainer grading', () => {
  const best = { uci: 'e2e4', cp: 120, mate: null };

  it('accepts near-equal moves and rejects real drops', () => {
    expect(gradeAgainstBest(best, { uci: 'd2d4', cp: 100, mate: null }).ok).toBe(true);
    expect(gradeAgainstBest(best, { uci: 'g2g4', cp: -150, mate: null }).ok).toBe(false);
    // Totally winning either way is fine.
    expect(gradeAgainstBest({ cp: 900, mate: null }, { cp: 600, mate: null }).ok).toBe(true);
    // Any forced mate counts when a mate exists.
    expect(gradeAgainstBest({ cp: null, mate: 2 }, { cp: null, mate: 5 }).ok).toBe(true);
    expect(gradeAgainstBest({ cp: null, mate: 2 }, { cp: 50, mate: null }).ok).toBe(false);
    expect(gradeAgainstBest(null, best).ok).toBe(false);
  });

  it('uses a wider tolerance for safe moves', () => {
    const b = { cp: 0, mate: null };
    const p = { cp: -60, mate: null }; // ~5.5 win-% points worse
    const q = { cp: -100, mate: null }; // ~9 points worse
    expect(gradeAgainstBest(b, p, ACCEPT_WIN_DROP).ok).toBe(true);
    expect(gradeAgainstBest(b, q, ACCEPT_WIN_DROP).ok).toBe(false);
    expect(gradeAgainstBest(b, q, SAFE_WIN_DROP).ok).toBe(true);
  });

  it('detects positions with one clearly best move', () => {
    expect(isCritical([{ cp: 300 }, { cp: 280 }])).toBe(false);
    expect(isCritical([{ cp: 300 }, { cp: -50 }])).toBe(true);
    expect(isCritical([{ cp: 10 }])).toBe(true);
    expect(isCritical([])).toBe(false);
  });

  it('finds engine lines with normalized castling', () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    const lines = [{ uci: 'e1g1', cp: 10 }];
    expect(findLine(lines, fen, 'e1h1')).toBe(lines[0]);
    expect(findLine(lines, fen, 'e1c1')).toBeNull();
  });

  it('samples Maia moves above the probability floor', () => {
    const cands = [
      { uci: 'e2e4', prob: 0.6 },
      { uci: 'd2d4', prob: 0.3 },
      { uci: 'g2g4', prob: 0.05 },
    ];
    expect(pickMaiaMove(cands, { rand: () => 0 }).uci).toBe('e2e4');
    expect(pickMaiaMove(cands, { rand: () => 0.99 }).uci).toBe('d2d4');
    for (let i = 0; i < 50; i++) expect(pickMaiaMove(cands).uci).not.toBe('g2g4');
    expect(pickMaiaMove([{ uci: 'a2a3', prob: 0.02 }]).uci).toBe('a2a3');
    expect(pickMaiaMove([])).toBeNull();
  });

  it('decides conversion outcomes', () => {
    expect(convertVerdict({ myCp: 50, myMoves: 1 })).toBe('slipped');
    expect(convertVerdict({ myCp: 900, myMoves: 1 })).toBe('playing');
    expect(convertVerdict({ myCp: 900, myMoves: 3 })).toBe('won');
    expect(convertVerdict({ myCp: 250, myMoves: 20 })).toBe('held');
    expect(convertVerdict({ myCp: 250, myMoves: 5, gameOver: 'draw' })).toBe('drawn');
    expect(convertVerdict({ myCp: 0, myMoves: 5, gameOver: 'checkmate-win' })).toBe('won');
  });

  it('replays SAN to a ply and applies UCI moves', () => {
    expect(fenAtPly('e4 e5 Nf3', 2)).toBe(new Chess().move('e4') && (() => { const c = new Chess(); c.move('e4'); c.move('e5'); return c.fen(); })());
    expect(fenAtPly('e4 e5', 5)).toBe('');
    expect(fenAtPly('e4 Ke7?? x', 3)).toBe('');
    expect(applyUci(new Chess().fen(), 'e2e5')).toBeNull();
    expect(applyUci(new Chess().fen(), 'e2e4').move.san).toBe('e4');
  });
});

/* ------------------------------------------------------------------ */
/* Card selection                                                      */
/* ------------------------------------------------------------------ */

function gameAndAnalysis({ id = 'li:g1', res = 0, peakCp = 350, peakPly = 6 } = {}) {
  const moves = 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4 exd4 cxd4 Bb4+ Bd2 Bxd2+ Nbxd2 d5 exd5 Nxd5 Qb3 Nce7 O-O O-O Rfe1 c6 a4 Qb6 Qxb6 axb6 Ne4 h6';
  const c = new Chess();
  const sans = moves.split(' ');
  for (let i = 0; i < 26; i++) c.move(sans[i]);
  const fenBefore = c.fen();
  const g = { id, res, color: 'w', moves, op: 'opp', opR: 2000, t: 1000, tc: 'blitz' };
  const a = {
    id,
    peakCp,
    peakPly,
    issues: [
      {
        gameId: id,
        ply: 27,
        moveNum: 14,
        color: 'w',
        fenBefore,
        playedSan: 'a5',
        playedUci: 'a4a5',
        kind: 'blunder',
        winDrop: 30,
        tag: 'hung_piece',
        evalBeforeLabel: '+0.3',
        evalAfterLabel: '-2.5',
      },
      { gameId: id, ply: 9, moveNum: 5, color: 'w', fenBefore, playedSan: 'a5', playedUci: 'a4a5', kind: 'blunder', winDrop: 30 },
    ],
  };
  return { g, a };
}

describe('trainer decks', () => {
  it('builds blunder checks only from moves 13 to 30', () => {
    const { g, a } = gameAndAnalysis();
    const deck = extractBlunderCheckDeck([g], new Map([[g.id, a]]), {}, { now: 5000 });
    expect(deck.cards.length).toBe(1);
    expect(deck.cards[0].id).toBe('bc:li:g1:27');
    expect(deck.cards[0].fenAfter).not.toBe(deck.cards[0].fenBefore);
    expect(deck.dueCount).toBe(1);
    const later = extractBlunderCheckDeck([g], new Map([[g.id, a]]), { 'bc:li:g1:27': { box: 1, due: 9000 } }, { now: 5000 });
    expect(later.dueCount).toBe(0);
  });

  it('builds conversion cards from thrown +2 games only', () => {
    const lost = gameAndAnalysis({ id: 'li:lost', res: 0 });
    const won = gameAndAnalysis({ id: 'li:won', res: 1 });
    const small = gameAndAnalysis({ id: 'li:small', res: 0, peakCp: 150 });
    const games = [lost.g, won.g, small.g];
    const map = new Map([
      [lost.g.id, lost.a],
      [won.g.id, won.a],
      [small.g.id, small.a],
    ]);
    const deck = extractConvertDeck(games, map, {}, { now: 1 });
    expect(deck.cards.map((c) => c.id)).toEqual(['cv:li:lost:6']);
    expect(deck.cards[0].fen).toBe(fenAtPly(lost.g.moves, 6));
  });
});

/* ------------------------------------------------------------------ */
/* Opponent weak spots                                                 */
/* ------------------------------------------------------------------ */

describe('opponent weak spots', () => {
  const norm = (fen) => fen.split(' ').slice(0, 4).join(' ');

  function buildIndex(games) {
    // games: [{ sans, pColor, res }]
    const map = new Map();
    for (const g of games) {
      const c = new Chess();
      for (const san of g.sans) {
        const key = norm(c.fen());
        const m = c.move(san);
        const arr = map.get(key) || [];
        arr.push({ uci: m.from + m.to + (m.promotion || ''), san: m.san, res: g.res, pColor: g.pColor, gid: 'x' });
        map.set(key, arr);
      }
    }
    return map;
  }

  it('groups moves and scores only the scouted player', () => {
    const groups = groupPositionMoves(
      [
        { uci: 'e2e4', san: 'e4', res: 'w', pColor: 'white' },
        { uci: 'e2e4', san: 'e4', res: 'b', pColor: 'white' },
        { uci: 'e2e4', san: 'e4', res: 'd', pColor: 'black' },
      ],
      'w'
    );
    expect(groups[0]).toMatchObject({ uci: 'e2e4', n: 3, playerN: 2, playerScore: 0.5 });
  });

  it('finds a move the opponent keeps losing with', async () => {
    const games = [
      // As Black they answer 1.e4 with ...f6 and lose.
      ...Array.from({ length: 4 }, () => ({ sans: ['e4', 'f6', 'd4'], pColor: 'black', res: 'w' })),
      // As Black vs 1.d4 they play ...d5 and do fine.
      ...Array.from({ length: 4 }, () => ({ sans: ['d4', 'd5', 'c4'], pColor: 'black', res: 'b' })),
    ];
    const index = buildIndex(games);
    const lookupBatch = async (keys) => new Map(keys.filter((k) => index.has(k)).map((k) => [k, index.get(k)]));
    const spots = await findOpponentWeakSpots({ lookupBatch, minGames: 3 });
    expect(spots.length).toBe(1);
    expect(spots[0]).toMatchObject({ moveSan: 'f6', games: 4, scorePct: 0, theirColor: 'b', myColor: 'w', ply: 1 });
    expect(spots[0].pathSans).toEqual(['e4']);
    expect(plyMoveLabel(spots[0].ply, spots[0].moveSan)).toBe('1...f6');
    expect(sanPathLabel(['e4', 'c5', 'Nf3'])).toBe('1.e4 c5 2.Nf3');
  });

  it('copes with a missing lookup function and empty data', async () => {
    expect(await findOpponentWeakSpots({})).toEqual([]);
    expect(await findOpponentWeakSpots({ lookupBatch: async () => new Map() })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Today                                                               */
/* ------------------------------------------------------------------ */

describe('Today summary', () => {
  it('counts due work, today’s progress and picks an unreviewed loss', () => {
    const now = new Date(2026, 10, 28, 15, 0, 0).getTime();
    const earlier = new Date(2026, 10, 28, 9, 0, 0).getTime();
    const yesterday = new Date(2026, 10, 27, 9, 0, 0).getTime();
    const dayKey = '2026-11-28';
    const t = computeToday({
      repertoire: { cards: { a: {}, b: {}, c: {} } },
      repProgress: { a: { s: 1, d: now - 1, b: 1 }, b: { s: 1, d: now + 1e6, b: 2 }, days: { d: { [dayKey]: { n: 4, ok: 3 } } } },
      decks: {
        mistakes: { cards: [1, 2, 3], dueCount: 2 },
        blunder: { cards: [1], dueCount: 1 },
        convert: { cards: [], dueCount: 0 },
      },
      drillProgress: {
        'li:a:1': { last: earlier },
        'bc:li:a:30': { last: earlier },
        'cv:li:a:6': { last: yesterday },
      },
      games: [
        { id: 'li:1', res: 0, t: 300, moves: 'e4' },
        { id: 'li:2', res: 0, t: 500, moves: 'e4' },
        { id: 'li:3', res: 1, t: 900, moves: 'e4' },
      ],
      reviewed: [{ id: 'li:2', t: earlier }],
      scoutTargets: [{ source: 'lichess', username: 'x' }],
      now,
    });
    expect(t.repertoire).toEqual({ hasRepertoire: true, due: 1, fresh: 1, done: 4 });
    expect(t.mistakes).toEqual({ due: 2, total: 3, done: 1 });
    expect(t.blunder.done).toBe(1);
    expect(t.convert.done).toBe(0);
    expect(t.review.game.id).toBe('li:1');
    expect(t.review.done).toBe(1);
    expect(t.prep.targets).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* /api/sync drill progress                                            */
/* ------------------------------------------------------------------ */

const dbState = { rows: new Map(), queries: [] };

vi.mock('../api/_lib/db.js', () => ({
  isDbConfigured: () => true,
  getDb: async () => {
    const sql = (strings, ...values) => {
      const text = strings.join('?');
      dbState.queries.push(text);
      if (/SELECT progress_json FROM user_drill_progress/.test(text)) {
        const v = dbState.rows.get(values[0]);
        return Promise.resolve(v ? [{ progress_json: v }] : []);
      }
      if (/INSERT INTO user_drill_progress/.test(text)) {
        dbState.rows.set(values[0], JSON.parse(values[1]));
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    };
    return sql;
  },
}));

describe('/api/sync drill progress', () => {
  let handler;
  let signToken;
  let getSigningSecret;
  const prevEnv = { ...process.env };

  beforeEach(async () => {
    process.env.SESSION_SECRET = 'unit-test-session-secret-0123456789';
    dbState.rows.clear();
    dbState.queries.length = 0;
    ({ default: handler } = await import('../api/sync/index.js'));
    ({ signToken, getSigningSecret } = await import('../api/_lib/session.js'));
  });
  afterEach(() => {
    process.env = { ...prevEnv };
  });

  function mockRes() {
    const res = { statusCode: 0, body: null, headers: {} };
    res.status = (c) => ((res.statusCode = c), res);
    res.json = (b) => ((res.body = b), res);
    res.setHeader = (k, v) => (res.headers[k] = v);
    return res;
  }
  function authedReq(body, extraHeaders = {}) {
    const token = signToken({ sub: 'tibous', username: 'Tibous' }, getSigningSecret());
    return {
      method: 'PUT',
      headers: { host: 'tichess.vercel.app', cookie: `tichess_session=${encodeURIComponent(token)}`, ...extraHeaders },
      body,
    };
  }

  it('rejects unauthenticated and cross-origin writes', async () => {
    const r1 = mockRes();
    await handler({ method: 'PUT', headers: { host: 'tichess.vercel.app' }, body: { type: 'drillProgress', drillProgress: {} } }, r1);
    expect(r1.statusCode).toBe(401);

    const r2 = mockRes();
    await handler(authedReq({ type: 'drillProgress', drillProgress: {} }, { origin: 'https://evil.example' }), r2);
    expect(r2.statusCode).toBe(403);
    expect(dbState.rows.size).toBe(0);
  });

  it('validates the payload', async () => {
    const r1 = mockRes();
    await handler(authedReq({ type: 'drillProgress', drillProgress: [1, 2] }), r1);
    expect(r1.statusCode).toBe(400);

    const huge = {};
    for (let i = 0; i < 12000; i++) huge[`li:game${i}:12`] = { box: 1, due: 1, ok: 1, miss: 0, last: i };
    const r2 = mockRes();
    await handler(authedReq({ type: 'drillProgress', drillProgress: huge }), r2);
    expect(r2.statusCode).toBe(413);
  });

  it('stores only sanitized records and merges with what is saved', async () => {
    dbState.rows.set('tibous', { 'li:a:1': { box: 4, due: 10, ok: 4, miss: 0, last: 500 } });
    const r = mockRes();
    await handler(
      authedReq({
        type: 'drillProgress',
        drillProgress: {
          'li:a:1': { box: 1, due: 1, ok: 1, miss: 0, last: 100 },
          'bc:li:b:30': { box: 2, due: 2, ok: 2, miss: 0, last: 900, extra: 'x' },
          'not valid': { box: 1 },
        },
      }),
      r
    );
    expect(r.statusCode).toBe(200);
    const saved = dbState.rows.get('tibous');
    expect(Object.keys(saved).sort()).toEqual(['bc:li:b:30', 'li:a:1']);
    expect(saved['li:a:1'].box).toBe(4);
    expect(saved['bc:li:b:30']).toEqual({ box: 2, due: 2, ok: 2, miss: 0, last: 900 });
    expect(r.body.drillProgress).toEqual(saved);
  });
});
