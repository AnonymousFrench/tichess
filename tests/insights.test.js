import { describe, it, expect } from 'vitest';
import {
  normalizeLichessGame,
  normalizeChessComGame,
  normalizePgnGame,
  parsePgnGames,
  guessPgnOwner,
  openingNameFromChessComUrl,
  openingFamily,
  classifyClock,
} from '../src/insights/normalize.js';
import {
  wdl,
  performance,
  expectedScore,
  filterGames,
  byTimeControl,
  openings,
  opponents,
  terminations,
  ratingBuckets,
  habits,
  explorerNode,
  performanceWindows,
  ratingSeries,
  takeaways,
  DAY_MS,
  previousPeriodGames,
  ratingContext,
  openingExtremes,
  versusStrength,
  gamesWithPrefix,
  recentForm,
} from '../src/insights/stats.js';

const lichessGame = (over = {}) => ({
  id: 'abc123',
  rated: true,
  variant: 'standard',
  speed: 'blitz',
  perf: 'blitz',
  createdAt: 1_700_000_000_000,
  status: 'resign',
  winner: 'black',
  players: {
    white: { user: { name: 'Rival', id: 'rival', title: 'FM' }, rating: 2100 },
    black: { user: { name: 'Tibous', id: 'tibous' }, rating: 2050 },
  },
  opening: { eco: 'B27', name: 'Sicilian Defense: Hyperaccelerated Dragon', ply: 4 },
  moves: 'e4 c5 Nf3 g6 d4 cxd4',
  clock: { initial: 180, increment: 0, totalTime: 180 },
  ...over,
});

describe('normalize', () => {
  it('turns a Lichess game into an owner-side record', () => {
    const r = normalizeLichessGame(lichessGame(), 'TIBOUS');
    expect(r).toMatchObject({
      id: 'li:abc123', color: 'b', res: 1, term: 'resign', me: 2050, op: 'Rival', opR: 2100, opT: 'FM',
      tc: 'blitz', clock: '180+0', plies: 6, eco: 'B27', oply: 4,
    });
    expect(r.url).toBe('https://lichess.org/abc123/black');
  });

  it('skips variants, aborted games and games without the owner', () => {
    expect(normalizeLichessGame(lichessGame({ variant: 'chess960' }), 'tibous')).toBeNull();
    expect(normalizeLichessGame(lichessGame({ status: 'aborted' }), 'tibous')).toBeNull();
    expect(normalizeLichessGame(lichessGame(), 'someoneelse')).toBeNull();
  });

  it('maps Lichess draws and time-outs', () => {
    expect(normalizeLichessGame(lichessGame({ status: 'outoftime', winner: undefined }), 'tibous').term).toBe('insufficient');
    expect(normalizeLichessGame(lichessGame({ status: 'outoftime', winner: 'white' }), 'tibous')).toMatchObject({ res: 0, term: 'time' });
    expect(normalizeLichessGame(lichessGame({ status: 'draw', winner: undefined }), 'tibous')).toMatchObject({ res: 0.5, term: 'agreement' });
    expect(normalizeLichessGame(lichessGame({ speed: 'correspondence' }), 'tibous').tc).toBe('daily');
  });

  it('turns a Chess.com game into a record, reading moves from its PGN', () => {
    const pgn = [
      '[Event "Live Chess"]', '[Site "Chess.com"]', '[UTCDate "2026.11.20"]', '[UTCTime "18:30:00"]',
      '[White "Tibous"]', '[Black "other"]', '[Result "1-0"]', '[ECO "C50"]',
      '[ECOUrl "https://www.chess.com/openings/Italian-Game-Two-Knights-Defense-4.d3"]', '',
      '1. e4 {[%clk 0:02:59]} 1... e5 {[%clk 0:02:58]} 2. Nf3 Nc6 3. Bc4 Nf6 4. d3 1-0',
    ].join('\n');
    const r = normalizeChessComGame({
      url: 'https://www.chess.com/game/live/123456', pgn, time_control: '180+2', time_class: 'blitz', rules: 'chess', rated: true,
      white: { username: 'Tibous', rating: 1900, result: 'win' },
      black: { username: 'other', rating: 1880, result: 'checkmated' },
    }, 'tibous');
    expect(r).toMatchObject({ id: 'cc:123456', color: 'w', res: 1, term: 'mate', clock: '180+2', moves: 'e4 e5 Nf3 Nc6 Bc4 Nf6 d3', eco: 'C50' });
    expect(r.opening).toBe('Italian Game: Two Knights Defense');
    expect(r.t).toBe(Date.UTC(2026, 10, 20, 18, 30, 0));
  });

  it('parses PGN files with comments and variations and finds the owner', () => {
    const text = [
      '[Event "Club"]', '[White "Me"]', '[Black "A"]', '[Result "0-1"]', '[TimeControl "600+5"]', '',
      '1. d4 {main} d5 (1... Nf6 2. c4) 2. c4 $1 e6 0-1', '',
      '[Event "Club"]', '[White "B"]', '[Black "Me"]', '[Result "1/2-1/2"]', '', '1. e4 c5 1/2-1/2',
    ].join('\n');
    const games = parsePgnGames(text);
    expect(games).toHaveLength(2);
    expect(games[0].sans).toEqual(['d4', 'd5', 'c4', 'e6']);
    expect(guessPgnOwner(games)).toBe('Me');
    const r = normalizePgnGame(games[0], 'me');
    expect(r).toMatchObject({ color: 'w', res: 0, tc: 'rapid', clock: '600+5', moves: 'd4 d5 c4 e6' });
    expect(normalizePgnGame(games[1], 'me')).toMatchObject({ color: 'b', res: 0.5 });
  });

  it('names openings and time controls', () => {
    expect(openingFamily('Sicilian Defense: Najdorf Variation')).toBe('Sicilian Defense');
    expect(openingNameFromChessComUrl('https://www.chess.com/openings/Kings-Pawn-Opening')).toBe("King's Pawn Opening");
    expect(classifyClock(60, 0)).toBe('bullet');
    expect(classifyClock(180, 2)).toBe('blitz');
    expect(classifyClock(600, 0)).toBe('rapid');
    expect(classifyClock(1800, 30)).toBe('classical');
  });
});

// A compact record builder for stats tests.
let seq = 0;
const rec = (o = {}) => ({
  id: `t${seq++}`, src: 'lichess', acct: 'me', t: 1_700_000_000_000 + seq * 600_000, tc: 'blitz', clock: '180+0',
  rated: true, color: 'w', res: 1, term: 'resign', me: 2000, op: 'Opp', opR: 2000, opT: '', eco: '', opening: 'Italian Game',
  oply: 2, moves: 'e4 e5 Nf3', plies: 3, url: '', ...o,
});

describe('stats', () => {
  it('tallies results and performance', () => {
    const g = [rec({ res: 1 }), rec({ res: 0.5 }), rec({ res: 0 }), rec({ res: 1 })];
    expect(wdl(g)).toMatchObject({ n: 4, w: 2, d: 1, l: 1, score: 0.625 });
    // 62.5% against 2000 → about +89
    expect(performance(g)).toBe(2089);
    expect(performance([rec({ res: 1 })])).toBe(2798);
    expect(expectedScore(2000, 2000)).toBeCloseTo(0.5);
  });

  it('filters by time control, color, period, opponent strength and search', () => {
    const now = 1_800_000_000_000;
    const g = [
      rec({ tc: 'bullet', t: now - 2 * DAY_MS }),
      rec({ color: 'b', t: now - 40 * DAY_MS, opR: 2200 }),
      rec({ t: now - 400 * DAY_MS, op: 'Magnus' }),
    ];
    expect(filterGames(g, { tc: ['bullet'] }, now)).toHaveLength(1);
    expect(filterGames(g, { color: 'b' }, now)).toHaveLength(1);
    expect(filterGames(g, { period: '30d' }, now)).toHaveLength(1);
    expect(filterGames(g, { period: '12m' }, now)).toHaveLength(2);
    expect(filterGames(g, { opp: 'higher' }, now)).toHaveLength(1);
    expect(filterGames(g, { search: 'magn' }, now)).toHaveLength(1);
  });

  it('reports the latest rating per time control', () => {
    const rows = byTimeControl([rec({ me: 1900, t: 1 }), rec({ me: 1950, t: 2 }), rec({ tc: 'rapid', me: 1800 })]);
    expect(rows[0]).toMatchObject({ tc: 'blitz', n: 2, rating: 1950, peak: 1950 });
  });

  it('groups openings by family with a representative move prefix', () => {
    const g = [
      rec({ opening: 'Sicilian Defense: Najdorf', moves: 'e4 c5 Nf3 d6', oply: 4, res: 0 }),
      rec({ opening: 'Sicilian Defense: Dragon', moves: 'e4 c5 Nf3 d6 d4', oply: 4, res: 0 }),
      rec({ opening: 'Sicilian Defense: Alapin', moves: 'e4 c5 c3', oply: 3, res: 1 }),
      rec({ opening: 'Italian Game', moves: 'e4 e5 Nf3 Nc6 Bc4', oply: 5 }),
    ];
    const rows = openings(g, { color: 'w' });
    expect(rows[0]).toMatchObject({ name: 'Sicilian Defense', n: 3, prefix: 'e4 c5' });
    expect(openings(g, { color: 'w', sort: 'best' })[0].name).toBe('Italian Game');
    expect(openings(g, { color: 'w', groupBy: 'name', minGames: 1 })).toHaveLength(4);
  });

  it('ranks opponents and describes how games end', () => {
    const g = [rec({ op: 'Ann', opT: 'IM', opR: 2400 }), rec({ op: 'ann', res: 0, term: 'time', plies: 80 }), rec({ op: 'Bob' })];
    const o = opponents(g);
    expect(o.mostPlayed[0]).toMatchObject({ name: 'Ann', n: 2, title: 'IM' });
    expect(o.titled).toHaveLength(1);
    const t = terminations(g);
    expect(t.loss[0]).toMatchObject({ term: 'time', n: 1, share: 1, avgMoves: 40 });
    expect(t.totals).toEqual({ win: 2, loss: 1, draw: 0 });
  });

  it('compares results with Elo expectations by rating gap', () => {
    const b = ratingBuckets([rec({ opR: 2300 }), rec({ opR: 2010, res: 0 })]);
    expect(b[6]).toMatchObject({ n: 1, score: 1 });
    expect(b[6].expected).toBeCloseTo(expectedScore(2000, 2300));
    expect(b[3]).toMatchObject({ n: 1, score: 0 });
  });

  it('measures sessions, streaks and results after wins and losses', () => {
    const base = 1_700_000_000_000;
    const g = [
      rec({ t: base, res: 0 }), rec({ t: base + 5 * 60e3, res: 0 }), rec({ t: base + 10 * 60e3, res: 1 }),
      rec({ t: base + 5 * 3600e3, res: 1 }),
    ];
    const h = habits(g);
    expect(h.sessions).toBe(2);
    expect(h.afterLoss).toMatchObject({ n: 2, w: 1, l: 1 });
    expect(h.longestLoss).toBe(2);
    expect(h.longestWin).toBe(2);
  });

  it('explores the owner’s moves by move order', () => {
    const g = [
      rec({ moves: 'e4 e5 Nf3', res: 1 }), rec({ moves: 'e4 e5 Bc4', res: 0 }), rec({ moves: 'e4 c5', res: 1 }),
      rec({ moves: 'e4 e55', res: 1 }), rec({ moves: 'd4', color: 'b' }),
    ];
    const root = explorerNode(g, [], { color: 'w' });
    expect(root.moves[0]).toMatchObject({ san: 'e4', n: 4 });
    const node = explorerNode(g, ['e4', 'e5'], { color: 'w' });
    expect(node.total.n).toBe(2);
    expect(node.moves.map((m) => m.san).sort()).toEqual(['Bc4', 'Nf3']);
  });

  it('builds rating series and performance windows', () => {
    const day = DAY_MS;
    const g = [rec({ t: day * 10, me: 1500 }), rec({ t: day * 10 + 1000, me: 1510 }), rec({ t: day * 12, me: 1490 })];
    expect(ratingSeries(g, 'blitz').map((p) => p.r)).toEqual([1510, 1490]);
    const w = performanceWindows(g, [2, 10]);
    expect(w.map((x) => x.n)).toEqual([2, 3]);
  });

  it('finds a costly opening among enough games', () => {
    const now = 1_800_000_000_000;
    const g = [];
    for (let i = 0; i < 60; i++) g.push(rec({ t: now - i * 3_600_000, opening: 'Italian Game', moves: 'e4 e5 Nf3 Nc6 Bc4', oply: 5, res: 1 }));
    for (let i = 0; i < 40; i++) g.push(rec({ t: now - i * 3_600_000 - 1, opening: 'French Defense: Advance', moves: 'e4 e6 d4 d5 e5', oply: 5, res: 0 }));
    const tk = takeaways(g, now);
    const bad = tk.find((x) => x.title.startsWith('French Defense'));
    expect(bad).toBeTruthy();
    expect(bad.tone).toBe('bad');
    expect(bad.link).toMatchObject({ tab: 'explorer', color: 'w', prefix: 'e4 e6 d4 d5 e5' });
  });

  it('compares with the previous period and with your own rating', () => {
    const now = 1_800_000_000_000;
    const g = [rec({ t: now - 2 * DAY_MS }), rec({ t: now - 10 * DAY_MS, res: 0 }), rec({ t: now - 40 * DAY_MS }), rec({ t: now - 50 * DAY_MS, res: 0 }), rec({ t: now - 70 * DAY_MS })];
    const prev = previousPeriodGames(g, { period: '30d' }, now);
    expect(prev.map((x) => x.t)).toEqual([now - 40 * DAY_MS, now - 50 * DAY_MS]);
    expect(previousPeriodGames(g, { period: 'all' }, now)).toBeNull();
    const rc = ratingContext([rec({ me: 1900, opR: 2000, res: 0.5 }), rec({ me: 1900, opR: 2000, res: 0.5 })]);
    expect(rc).toMatchObject({ own: 1900, perf: 2000, diff: 100 });
    expect(recentForm([rec({ t: 3 }), rec({ t: 1 }), rec({ t: 2 })], 2).map((x) => x.t)).toEqual([2, 3]);
  });

  it('ranks openings against your own average and splits stronger and weaker opponents', () => {
    const g = [];
    for (let i = 0; i < 30; i++) g.push(rec({ opening: 'Italian Game', moves: 'e4 e5 Nf3 Nc6 Bc4', oply: 5, res: i % 4 ? 1 : 0 }));
    for (let i = 0; i < 30; i++) g.push(rec({ opening: 'French Defense', moves: 'e4 e6 d4 d5', oply: 4, res: i % 4 ? 0 : 1 }));
    const x = openingExtremes(g, 'w');
    expect(x.best[0].name).toBe('Italian Game');
    expect(x.worst[0].name).toBe('French Defense');
    expect(x.n).toBe(60);

    const vs = versusStrength([rec({ me: 2000, opR: 2200, res: 1 }), rec({ me: 2000, opR: 1800, res: 0 }), rec({ me: 2000, opR: 2010, res: 1 })]);
    expect(vs.stronger).toMatchObject({ n: 1, score: 1 });
    expect(vs.weaker).toMatchObject({ n: 1, score: 0 });
    expect(vs.stronger.expected).toBeCloseTo(0.24, 2);
  });

  it('drills down to games by move prefix', () => {
    const g = [rec({ moves: 'e4 e5 Nf3' }), rec({ moves: 'e4 e5' }), rec({ moves: 'e4 e6 d4' }), rec({ moves: 'e4 e5 Nf3', color: 'b' })];
    expect(gamesWithPrefix(g, 'e4 e5', 'w')).toHaveLength(2);
    expect(gamesWithPrefix(g, 'e4 e', 'w')).toHaveLength(0);
    expect(gamesWithPrefix(g, '', null)).toHaveLength(4);
  });
});

describe('syncLichess', () => {
  it('flushes an early first batch, reports progress immediately, and retries publicly on stale token 401', async () => {
    const { syncLichess } = await import('../src/insights/sync.js');
    const origFetch = globalThis.fetch;
    const origStorage = globalThis.localStorage;
    const games = Array.from({ length: 35 }, (_, i) =>
      JSON.stringify(lichessGame({ id: `g${i}`, createdAt: 1_700_000_000_000 - i * 1000 }))
    ).join('\n');

    const seenAuth = [];
    globalThis.localStorage = { getItem: (k) => (k === 'cms_lichess_token' ? 'expired_tok' : null) };
    globalThis.fetch = async (url, opts = {}) => {
      const hasAuth = Boolean(opts.headers?.Authorization);
      seenAuth.push([String(url).includes('/api/user/') ? 'profile' : 'games', hasAuth]);
      if (hasAuth) return new Response('Unauthorized', { status: 401 });
      if (String(url).includes('/api/user/')) {
        return new Response(JSON.stringify({ username: 'Tibous', count: { all: 35 }, perfs: {} }), { status: 200 });
      }
      return new Response(games, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    };

    try {
      const acct = { src: 'lichess', name: 'tibous' };
      const batchSizes = [];
      const totals = [];
      await syncLichess(acct, {
        save: async (recs) => batchSizes.push(recs.length),
        saveMeta: async () => {},
        onProgress: (p) => totals.push(p),
      });
      // Retried without Authorization after 401 on both profile and games endpoints
      expect(seenAuth).toEqual([
        ['profile', true],
        ['profile', false],
        ['games', true],
        ['games', false],
      ]);
      // First batch flushed at 20 games instead of buffering all 35
      expect(batchSizes).toEqual([20, 15]);
      // Profile total reported immediately before games finished
      expect(totals[0]).toEqual({ fetched: 0, total: 35 });
      expect(acct.complete).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
      globalThis.localStorage = origStorage;
    }
  });
});
