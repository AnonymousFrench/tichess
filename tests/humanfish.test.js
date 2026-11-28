import { describe, it, expect } from 'vitest';
import {
  parseClockSeconds,
  formatShortClock,
  parseTimeControlHeader,
  extractGameContextFromTab,
  resolveHumanfishEndpoint,
  buildHumanfishCacheKey,
  getActiveHumanOutcome,
  analyzeMatingMaterial,
  enforceMatingMaterialConstraint,
  computeDangerLevel,
  computeDivergenceInfo,
  formatSignedPp,
} from '../src/engines/humanfishMath.js';
import handler, {
  sanitizeEvaluatePayload,
  resolveHumanfishUpstreamUrl,
  isHumanfishApiEnabled,
  isHumanfishUserAllowed,
} from '../api/humanfish/evaluate.js';
import { isHumanfishEnabled } from '../src/engines/humanfishFlag.js';
import { createTreeFromPgn } from '../src/chess/tree.js';

describe('HumanFish math and context extraction', () => {
  it('parses PGN and broadcast clock formats into seconds', () => {
    expect(parseClockSeconds('1:59:45')).toBe(7185);
    expect(parseClockSeconds('0:44')).toBe(44);
    expect(parseClockSeconds('12:30.5')).toBe(750.5);
    expect(parseClockSeconds(180)).toBe(180);
    expect(parseClockSeconds('')).toBeNull();
    expect(parseClockSeconds('invalid')).toBeNull();
  });

  it('formats short clock labels cleanly', () => {
    expect(formatShortClock(44)).toBe('44s');
    expect(formatShortClock(95)).toBe('1:35');
    expect(formatShortClock(600)).toBe('10m');
    expect(formatShortClock(5400)).toBe('1h30m');
  });

  it('parses classical, rapid, blitz, and move-40 PGN TimeControl headers', () => {
    expect(parseTimeControlHeader('40/5400+30:1800+30')).toEqual({
      tc_category: 'classical',
      tc_initial_s: 5400,
      tc_increment_s: 30,
      has_move40: true,
    });
    expect(parseTimeControlHeader('900+10')).toEqual({
      tc_category: 'rapid',
      tc_initial_s: 900,
      tc_increment_s: 10,
      has_move40: false,
    });
    expect(parseTimeControlHeader('180+2')).toEqual({
      tc_category: 'blitz',
      tc_initial_s: 180,
      tc_increment_s: 2,
      has_move40: false,
    });
    expect(parseTimeControlHeader('?')).toMatchObject({
      tc_category: 'classical',
      has_move40: true,
    });
  });

  it('extracts FEN, ply, Elos, clocks, and time control from a PGN tab', () => {
    const pgn = `[Event "Test Match"]
[White "Carlsen, Magnus"]
[Black "Niemann, Hans"]
[WhiteElo "2823"]
[BlackElo "2725"]
[TimeControl "180+2"]
[Result "*"]

1. e4 { [%clk 0:02:58] } 1... e5 { [%clk 0:02:55] } 2. Nf3 { [%clk 0:02:44] } *`;
    const parsed = createTreeFromPgn(pgn);
    const ctx = extractGameContextFromTab(parsed);

    expect(ctx.ply).toBe(3);
    expect(ctx.white_elo).toBe(2823);
    expect(ctx.black_elo).toBe(2725);
    expect(ctx.clk_white_s).toBe(164);
    expect(ctx.clk_black_s).toBe(175);
    expect(ctx.tc_category).toBe('blitz');
    expect(ctx.tc_initial_s).toBe(180);
    expect(ctx.tc_increment_s).toBe(2);
    expect(ctx.has_move40).toBe(false);
    expect(ctx.hasGameElos).toBe(true);
    expect(ctx.hasGameClocks).toBe(true);
  });

  it('resolves default proxy and custom self-hosted HumanFish endpoints', () => {
    expect(resolveHumanfishEndpoint('')).toBe('/api/humanfish/evaluate');
    expect(resolveHumanfishEndpoint('http://localhost:8842')).toBe('http://localhost:8842/api/evaluate');
    expect(resolveHumanfishEndpoint('http://localhost:8842/')).toBe('http://localhost:8842/api/evaluate');
    expect(resolveHumanfishEndpoint('http://localhost:8842/api/evaluate')).toBe(
      'http://localhost:8842/api/evaluate'
    );
  });

  it('computes danger levels, active outcomes, and Stockfish divergence accurately', () => {
    const sample = {
      human: { white: 0.5409, draw: 0.4358, black: 0.0233, expected_score: 0.7588 },
      human_no_clock: { white: 0.5413, draw: 0.4303, black: 0.0284, expected_score: 0.7564 },
      stockfish: { expected_score: 0.5135, cp_white: 36 },
      diagnostics: { expected_regret_mover: 0.4542, p_human_blunder_08: 1.0, hidden_only_move_score: 0.1415 },
    };

    expect(getActiveHumanOutcome(sample, true).expected_score).toBe(0.7588);
    expect(getActiveHumanOutcome(sample, false).expected_score).toBe(0.7564);
    expect(computeDangerLevel(sample)).toEqual({ level: 'high', label: 'Trap Risk' });

    const div = computeDivergenceInfo(sample, true);
    expect(div.significant).toBe(true);
    expect(div.deltaPp).toBeCloseTo(24.5, 1);
    expect(div.summary).toContain('White');

    expect(formatSignedPp(0.1942)).toBe('+19.4 pp');
    expect(formatSignedPp(-0.042)).toBe('-4.2 pp');
    expect(formatSignedPp(0)).toBe('0.0 pp');

    const k1 = buildHumanfishCacheKey(
      {
        fen: '8/8/8/8/8/8/8/8 w - - 0 1',
        white_elo: 2800,
        black_elo: 2700,
        clk_white_s: 60,
        clk_black_s: 30,
        tc_category: 'blitz',
        tc_initial_s: 180,
        tc_increment_s: 2,
        has_move40: false,
      },
      '/api/humanfish/evaluate'
    );
    expect(k1).toContain('2800|2700|60|30|blitz');
  });

  it('enforces chess insufficient-material rules so a bare king never has nonzero win odds', () => {
    // Exact K+b5 vs bare Black king position where raw HumanFish gave Black 4% win odds
    const kpVsK = '8/8/1k6/1P1K4/8/8/8/8 w - - 0 85';
    expect(analyzeMatingMaterial(kpVsK)).toMatchObject({
      whiteCanWin: true,
      blackCanWin: false,
      deadDraw: false,
    });
    const fixed = enforceMatingMaterialConstraint(kpVsK, {
      white: 0.01,
      draw: 0.95,
      black: 0.04,
      expected_score: 0.485,
    });
    expect(fixed.black).toBe(0);
    expect(fixed.white).toBeCloseTo(0.01, 4);
    expect(fixed.draw).toBeCloseTo(0.99, 4);
    expect(fixed.expected_score).toBeCloseTo(0.505, 3);
    expect(fixed.materialAdjusted).toBe(true);

    // Dead draw K+B vs K -> 0 / 100 / 0
    const kbVsK = '8/8/1k6/3K4/4B3/8/8/8 w - - 0 85';
    const dead = getActiveHumanOutcome(
      { fen: kbVsK, human: { white: 0.12, draw: 0.84, black: 0.04, expected_score: 0.54 } },
      true
    );
    expect(dead.white).toBe(0);
    expect(dead.draw).toBe(1);
    expect(dead.black).toBe(0);
    expect(dead.expected_score).toBe(0.5);
    expect(dead.materialAdjusted).toBe(true);
  });
});

describe('HumanFish API proxy validation', () => {
  it('sanitizes valid requests and clamps out-of-range fields', () => {
    const res = sanitizeEvaluatePayload({
      fen: '8/5kp1/1N5p/5K1P/5PP1/8/8/2b5 b - - 28 81',
      white_elo: 9999,
      black_elo: 500,
      clk_white_s: -10,
      clk_black_s: 34.44,
      tc_category: 'BLITZ',
      tc_initial_s: 180,
      tc_increment_s: 2,
      has_move40: false,
      ply: 161,
    });
    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({
      fen: '8/5kp1/1N5p/5K1P/5PP1/8/8/2b5 b - - 28 81',
      white_elo: 3200,
      black_elo: 1000,
      clk_white_s: 0,
      clk_black_s: 34.4,
      tc_category: 'blitz',
      tc_initial_s: 180,
      tc_increment_s: 2,
      has_move40: false,
      ply: 161,
    });
  });

  it('rejects missing or malformed FENs', () => {
    expect(sanitizeEvaluatePayload(null).ok).toBe(false);
    expect(sanitizeEvaluatePayload({ fen: '' }).ok).toBe(false);
    expect(sanitizeEvaluatePayload({ fen: 'not-a-fen' }).ok).toBe(false);
  });

  it('resolves upstream base URL cleanly', () => {
    expect(resolveHumanfishUpstreamUrl({})).toBe('https://humanfish.vercel.app');
    expect(resolveHumanfishUpstreamUrl({ HUMANFISH_API_URL: 'http://localhost:8842/' })).toBe(
      'http://localhost:8842'
    );
  });
});

describe('HumanFish off switch', () => {
  function mockRes() {
    const res = { statusCode: 0, body: null, headers: {} };
    res.status = (c) => ((res.statusCode = c), res);
    res.json = (b) => ((res.body = b), res);
    res.setHeader = (k, v) => (res.headers[k] = v);
    return res;
  }
  const fenBody = { fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1' };

  it('client and API flags default to on and can be switched off', () => {
    expect(isHumanfishEnabled({})).toBe(true);
    expect(isHumanfishEnabled({ VITE_HUMANFISH_ENABLED: 'false' })).toBe(false);
    expect(isHumanfishEnabled({ VITE_HUMANFISH_ENABLED: 'true' })).toBe(true);
    expect(isHumanfishApiEnabled({})).toBe(true);
    expect(isHumanfishApiEnabled({ HUMANFISH_ENABLED: 'FALSE' })).toBe(false);
  });

  it('returns 404 when switched off, before reaching the upstream server', async () => {
    const prev = process.env.HUMANFISH_ENABLED;
    process.env.HUMANFISH_ENABLED = 'false';
    try {
      const res = mockRes();
      await handler({ method: 'POST', headers: {}, body: fenBody }, res);
      expect(res.statusCode).toBe(404);
    } finally {
      if (prev === undefined) delete process.env.HUMANFISH_ENABLED;
      else process.env.HUMANFISH_ENABLED = prev;
    }
  });

  it('requires a signed-in session when enabled', async () => {
    const prev = { ...process.env };
    process.env.HUMANFISH_ENABLED = 'true';
    process.env.SESSION_SECRET = 'test-session-secret-123456';
    try {
      const res = mockRes();
      await handler({ method: 'POST', headers: { host: 'tichess.vercel.app' }, body: fenBody }, res);
      expect(res.statusCode).toBe(401);

      const cross = mockRes();
      await handler(
        { method: 'POST', headers: { host: 'tichess.vercel.app', origin: 'https://evil.example' }, body: fenBody },
        cross
      );
      expect(cross.statusCode).toBe(403);
    } finally {
      process.env = prev;
    }
  });

  it('can be limited to listed Lichess accounts', () => {
    expect(isHumanfishUserAllowed('anyone', {})).toBe(true);
    expect(isHumanfishUserAllowed('tibous', { HUMANFISH_ALLOWED_USERS: 'Tibous, other' })).toBe(true);
    expect(isHumanfishUserAllowed('stranger', { HUMANFISH_ALLOWED_USERS: 'tibous' })).toBe(false);
    expect(isHumanfishUserAllowed('', { HUMANFISH_ALLOWED_USERS: 'tibous' })).toBe(false);
  });
});
