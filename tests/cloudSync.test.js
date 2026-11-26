import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  getSigningSecret,
  encryptSecretValue,
  decryptSecretValue,
  signToken,
  verifyToken,
  generatePkceBundle,
  parseCookies,
  serializeCookie,
  sanitizeReturnTo,
  isSameOriginRequest,
} from '../api/_lib/session.js';
import { mergeScoutTargets } from '../api/sync/index.js';
import { parseLastNdjsonObject } from '../api/lichess/explorer.js';
import {
  parseExplorerPlayerNdjson,
  buildLocalPlayerExplorerIndex,
  computeSinceFilter,
} from '../src/api/lichess.js';
import { classifyPlayerMovePerformance } from '../src/explorer/explorer.js';
import { decideRepertoireSyncAction } from '../src/sync/cloudSync.js';

describe('Cloud Sync auth session & PKCE helpers', () => {
  it('signs and verifies HMAC tokens, rejecting tampering and expiry', () => {
    const secret = getSigningSecret({ DATABASE_URL: 'postgres://user:supersecret@ep-1.neon.tech/neondb' });
    expect(secret).toBeInstanceOf(Buffer);

    const token = signToken({ sub: 'magnus', username: 'Magnus' }, secret, 60, 1000);
    expect(verifyToken(token, secret, 1030)).toMatchObject({ sub: 'magnus', username: 'Magnus' });
    // Expired
    expect(verifyToken(token, secret, 1061)).toBeNull();
    // Tampered signature
    expect(verifyToken(token.slice(0, -2) + 'AA', secret, 1030)).toBeNull();
    // Wrong secret
    const otherSecret = getSigningSecret({ SESSION_SECRET: 'another-long-secret-key-1234' });
    expect(verifyToken(token, otherSecret, 1030)).toBeNull();
  });

  it('generates valid S256 PKCE verifier and challenge', () => {
    const { verifier, challenge, state } = generatePkceBundle();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(state.length).toBeGreaterThanOrEqual(24);
    const expected = crypto
      .createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });

  it('parses/serializes cookies, sanitizes returnTo, and enforces same-origin mutations', () => {
    const cookie = serializeCookie('tichess_session', 'abc.123', { maxAge: 3600, secure: true });
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(parseCookies(`foo=bar; ${cookie.split(';')[0]}`)).toEqual({
      foo: 'bar',
      tichess_session: 'abc.123',
    });

    expect(sanitizeReturnTo('/')).toBe('/');
    expect(sanitizeReturnTo('/repertoire.html')).toBe('/repertoire.html');
    expect(sanitizeReturnTo('//evil.com/phish')).toBe('/');
    expect(sanitizeReturnTo('https://evil.com')).toBe('/');
    expect(sanitizeReturnTo('/evil')).toBe('/');

    expect(
      isSameOriginRequest({
        headers: { host: 'tichess.vercel.app', origin: 'https://tichess.vercel.app' },
      })
    ).toBe(true);
    expect(
      isSameOriginRequest({
        headers: { host: 'tichess.vercel.app', origin: 'https://evil.example' },
      })
    ).toBe(false);
  });
});

describe('Two-way repertoire and scout target sync resolution', () => {
  it('picks pull, push, or noop cleanly based on presence and updatedAt timestamps', () => {
    const repA = { repertoire: { pos: [] }, name: 'A', updatedAt: 1000 };
    const repB = { repertoire: { pos: [] }, name: 'B', updatedAt: 2000 };

    expect(decideRepertoireSyncAction(null, null)).toBe('noop');
    expect(decideRepertoireSyncAction(null, repA)).toBe('pull');
    expect(decideRepertoireSyncAction(repA, null)).toBe('push');
    expect(decideRepertoireSyncAction(repA, repB)).toBe('pull');
    expect(decideRepertoireSyncAction(repB, repA)).toBe('push');
    expect(decideRepertoireSyncAction(repA, { ...repA })).toBe('noop');
  });

  it('deduplicates and sorts scout targets by most recent sync', () => {
    const merged = mergeScoutTargets(
      [{ source: 'lichess', username: 'Alireza', max: 100, updatedAt: 100 }],
      [
        { source: 'lichess', username: 'alireza', max: 200, updatedAt: 200 },
        { source: 'chesscom', username: 'Hikaru', max: 4, updatedAt: 150 },
      ]
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ source: 'lichess', username: 'alireza', max: 200 });
    expect(merged[1]).toMatchObject({ source: 'chesscom', username: 'Hikaru' });
  });

  it('encrypts and decrypts Lichess OAuth tokens with AES-256-GCM and rejects wrong keys', () => {
    const key1 = getSigningSecret({ DATABASE_URL: 'postgres://u:secret1@ep.neon.tech/db' });
    const key2 = getSigningSecret({ DATABASE_URL: 'postgres://u:secret2@ep.neon.tech/db' });
    const cipher = encryptSecretValue('lip_test_token_12345', key1);
    expect(cipher).toBeTruthy();
    expect(cipher).not.toContain('lip_test_token_12345');
    expect(decryptSecretValue(cipher, key1)).toBe('lip_test_token_12345');
    expect(decryptSecretValue(cipher, key2)).toBeNull();
  });

  it('parses the final JSON frame from Lichess player explorer NDJSON stream', () => {
    const stream = [
      JSON.stringify({ queuePosition: 1, moves: [] }),
      JSON.stringify({
        white: 10,
        draws: 2,
        black: 4,
        moves: [{ uci: 'e2e4', san: 'e4', white: 10, draws: 2, black: 4 }],
        recentGames: [],
      }),
      '',
    ].join('\n');

    expect(parseLastNdjsonObject(stream).moves[0].san).toBe('e4');
    expect(parseExplorerPlayerNdjson(stream).moves[0].san).toBe('e4');
  });

  it('builds a local White/Black opening explorer index from user Lichess games as fallback', () => {
    const byColor = buildLocalPlayerExplorerIndex(
      [
        {
          id: 'g1',
          white: 'Alice',
          black: 'Bob',
          result: '1-0',
          date: '2026-11-20',
          pgn: '1. d4 d5 2. c4 e6 1-0',
        },
        {
          id: 'g2',
          white: 'Carol',
          black: 'Alice',
          result: '0-1',
          date: '2026-11-21',
          pgn: '1. e4 c5 2. Nf3 d6 0-1',
        },
      ],
      'Alice'
    );
    const startKey = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
    expect(byColor.white.get(startKey).moves.get('d2d4').white).toBe(1);
    expect(byColor.black.get(startKey).moves.get('e2e4').black).toBe(1);
  });

  it('computes relative since cutoffs and classifies My Games move flaws/strengths', () => {
    const fixedNow = Date.UTC(2026, 10, 26, 12, 0, 0); // 2026-11-26
    expect(computeSinceFilter('', fixedNow)).toEqual({ sinceMs: null, sinceYm: '' });
    const threeMonths = computeSinceFilter('3m', fixedNow);
    expect(threeMonths.sinceYm).toBe('2026-08');
    expect(threeMonths.sinceMs).toBeLessThan(fixedNow);

    expect(classifyPlayerMovePerformance({ white: 1, draws: 0, black: 4 }, 'white')).toMatchObject({
      total: 5,
      scorePct: 20,
      badge: 'flaw',
    });
    expect(classifyPlayerMovePerformance({ white: 4, draws: 1, black: 0 }, 'white')).toMatchObject({
      total: 5,
      scorePct: 90,
      badge: 'strong',
    });
    expect(classifyPlayerMovePerformance({ white: 1, draws: 0, black: 4 }, 'black')).toMatchObject({
      total: 5,
      scorePct: 80,
      badge: 'strong',
    });
    // Small sample (< 3 games) should not trigger Flaw/Strong noise
    expect(classifyPlayerMovePerformance({ white: 0, draws: 0, black: 2 }, 'white').badge).toBeNull();
  });
});
