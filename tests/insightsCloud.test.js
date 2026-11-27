import { describe, it, expect } from 'vitest';
import {
  sanitizeSourceInput,
  sanitizeGameRecord,
  streamLichessSlice,
} from '../api/_lib/insightsSync.js';
import { isCronAuthorized } from '../api/insights/cron.js';
import { mergeAccountsWithServer } from '../src/insights/cloudInsights.js';

describe('Server Insights sync helpers', () => {
  it('validates and normalizes Lichess, Chess.com, and PGN source inputs', () => {
    expect(sanitizeSourceInput('lichess', 'DrNykterstein')).toEqual({
      src: 'lichess',
      acct: 'drnykterstein',
      displayName: 'DrNykterstein',
    });
    expect(sanitizeSourceInput('chesscom', 'Hikaru')).toEqual({
      src: 'chesscom',
      acct: 'hikaru',
      displayName: 'Hikaru',
    });
    expect(sanitizeSourceInput('pgn', 'Club OTB 2026')).toEqual({
      src: 'pgn',
      acct: 'club otb 2026',
      displayName: 'Club OTB 2026',
    });
    expect(sanitizeSourceInput('lichess', 'bad name!')).toBeNull();
    expect(sanitizeSourceInput('unknown', 'Alice')).toBeNull();
  });

  it('sanitizes normalized game records and enforces expected source/account', () => {
    const rec = sanitizeGameRecord(
      {
        id: 'li:abc123',
        src: 'lichess',
        acct: 'Magnus',
        t: 1700000000000,
        tc: 'blitz',
        color: 'w',
        res: 1,
        term: 'mate',
        me: 2900,
        op: 'Hikaru',
        opR: 2890,
        moves: 'e4 e5 Nf3 Nc6',
        plies: 4,
      },
      'lichess',
      'magnus'
    );
    expect(rec).toMatchObject({
      id: 'li:abc123',
      src: 'lichess',
      acct: 'magnus',
      res: 1,
      plies: 4,
    });
    // Mismatched account is rejected
    expect(sanitizeGameRecord(rec, 'lichess', 'someoneelse')).toBeNull();
  });

  it('streams Lichess NDJSON slice, falls back to public on 401, and distinguishes complete vs capped slices', async () => {
    const sampleGames = [1, 2, 3].map((i) =>
      JSON.stringify({
        id: `g${i}`,
        rated: true,
        variant: 'standard',
        speed: 'blitz',
        perf: 'blitz',
        createdAt: 1700000000000 + i * 1000,
        status: 'resign',
        winner: 'white',
        players: {
          white: { user: { name: 'Tester', id: 'tester' }, rating: 1900 },
          black: { user: { name: 'Rival', id: 'rival' }, rating: 1880 },
        },
        opening: { eco: 'C50', name: 'Italian Game', ply: 4 },
        moves: 'e4 e5 Nf3 Nc6',
      })
    );

    const calls = [];
    const mockFetch = async (_url, opts) => {
      calls.push(opts?.headers?.Authorization || '');
      if (opts?.headers?.Authorization) {
        return { ok: false, status: 401, text: async () => '' };
      }
      return {
        ok: true,
        status: 200,
        text: async () => sampleGames.join('\n'),
      };
    };

    const collected = [];
    const resComplete = await streamLichessSlice(
      'Tester',
      {},
      {
        token: 'lip_expired',
        maxGames: 10,
        budgetMs: 5000,
        fetchImpl: mockFetch,
        onRecords: async (batch) => collected.push(...batch),
      }
    );

    expect(calls).toEqual(['Bearer lip_expired', '']);
    expect(resComplete.savedCount).toBe(3);
    expect(resComplete.reachedEnd).toBe(true);
    expect(collected).toHaveLength(3);

    // When rawCount === maxGames, reachedEnd must be false so the next slice checks for older games.
    const resCapped = await streamLichessSlice(
      'Tester',
      {},
      {
        token: null,
        maxGames: 3,
        budgetMs: 5000,
        fetchImpl: mockFetch,
        onRecords: async () => {},
      }
    );
    expect(resCapped.rawCount).toBe(3);
    expect(resCapped.reachedEnd).toBe(false);
  });

  it('enforces CRON_SECRET when configured and accepts x-vercel-cron only when unset', () => {
    expect(
      isCronAuthorized({ headers: { authorization: 'Bearer top-secret-123' } }, { CRON_SECRET: 'top-secret-123' })
    ).toBe(true);
    expect(
      isCronAuthorized({ headers: { authorization: 'Bearer wrong' } }, { CRON_SECRET: 'top-secret-123' })
    ).toBe(false);
    expect(
      isCronAuthorized({ headers: { 'x-vercel-cron': '1' } }, { CRON_SECRET: 'top-secret-123' })
    ).toBe(false);
    expect(isCronAuthorized({ headers: { 'x-vercel-cron': '1' } }, {})).toBe(true);
    expect(isCronAuthorized({ headers: {} }, {})).toBe(false);
  });

  it('merges server archive metadata with local IndexedDB accounts without dropping local-only sources', () => {
    const merged = mergeAccountsWithServer(
      [
        { src: 'lichess', name: 'tester', addedAt: 100, newest: 500 },
        { src: 'pgn', name: 'OTB Club', addedAt: 150, complete: true },
      ],
      [
        {
          src: 'lichess',
          acct: 'tester',
          name: 'Tester',
          title: 'FM',
          total: 420,
          newest: 900,
          oldest: 100,
          complete: true,
          lastSync: 1000,
          cachedCount: 420,
          maxSeq: 420,
          addedAt: 100,
        },
        {
          src: 'chesscom',
          acct: 'hikaru',
          name: 'Hikaru',
          total: 1000,
          complete: false,
          cachedCount: 250,
          maxSeq: 670,
          addedAt: 200,
        },
      ]
    );

    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ src: 'lichess', name: 'Tester', title: 'FM', cachedCount: 420, complete: true });
    expect(merged[1]).toMatchObject({ src: 'pgn', name: 'OTB Club', complete: true });
    expect(merged[2]).toMatchObject({ src: 'chesscom', name: 'Hikaru', cachedCount: 250, maxSeq: 670 });
  });
});
