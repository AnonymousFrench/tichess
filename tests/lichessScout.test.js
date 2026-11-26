import { describe, it, expect } from 'vitest';
import { parseLichessNdjsonGames } from '../src/api/lichess.js';

describe('Lichess Player Scout NDJSON parser', () => {
  it('parses standard games and filters out variants or malformed lines', () => {
    const ndjson = [
      JSON.stringify({
        id: 'abc12345',
        variant: 'standard',
        perf: 'blitz',
        createdAt: Date.UTC(2026, 10, 24),
        winner: 'black',
        players: {
          white: { user: { name: 'Alice' }, rating: 2200 },
          black: { user: { name: 'Bob' }, rating: 2350 },
        },
        pgn: '[Event "rated blitz game"]\n[White "Alice"]\n[Black "Bob"]\n[Result "0-1"]\n\n1. e4 c5 2. Nf3 d6 0-1',
      }),
      JSON.stringify({
        id: 'var99999',
        variant: 'chess960',
        perf: 'chess960',
        pgn: '1. e4 e5 *',
      }),
      'not-valid-json',
      JSON.stringify({
        id: 'draw1111',
        variant: 'standard',
        speed: 'rapid',
        createdAt: Date.UTC(2026, 10, 25),
        players: {
          white: { user: { name: 'Bob' }, rating: 2360 },
          black: { user: { name: 'Carol' }, rating: 2310 },
        },
        pgn: '[Event "rated rapid game"]\n[White "Bob"]\n[Black "Carol"]\n[Result "1/2-1/2"]\n\n1. d4 d5 1/2-1/2',
      }),
    ].join('\n');

    const games = parseLichessNdjsonGames(ndjson);
    expect(games).toHaveLength(2);
    expect(games[0]).toMatchObject({
      white: 'Alice',
      whiteElo: 2200,
      black: 'Bob',
      blackElo: 2350,
      result: '0-1',
      date: '2026-11-24',
      event: 'Lichess blitz',
    });
    expect(games[1]).toMatchObject({
      white: 'Bob',
      black: 'Carol',
      result: '1/2-1/2',
      date: '2026-11-25',
      event: 'Lichess rapid',
    });
  });

  it('returns empty array on empty input', () => {
    expect(parseLichessNdjsonGames('')).toEqual([]);
    expect(parseLichessNdjsonGames(null)).toEqual([]);
  });
});
