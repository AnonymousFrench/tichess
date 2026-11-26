import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseBroadcastItem,
  mergeBroadcastLists,
  selectFeaturedBroadcast,
  computeRoundTransition,
  parseBroadcastInput,
} from '../src/live/liveEvents.js';

const topFixture = JSON.parse(
  readFileSync(resolve(process.cwd(), 'tests/fixtures/broadcast-top.json'), 'utf8')
);
const searchFixture = JSON.parse(
  readFileSync(resolve(process.cwd(), 'tests/fixtures/broadcast-search.json'), 'utf8')
);

describe('Broadcast parsing and round transitions', () => {
  it('does NOT mark an item with ongoing: null as live', () => {
    const item = parseBroadcastItem(
      {
        tour: { id: 'abc12345', name: 'Test Open' },
        round: { id: 'rnd12345', name: 'Round 1', ongoing: null, finished: false, startsAt: 1000 },
      },
      2000
    );
    expect(item.status).toBe('unknown');
    expect(item.status).not.toBe('live');
  });

  it('parses real broadcast-top and broadcast-search fixtures with defined IDs/names and dedupes', () => {
    const merged = mergeBroadcastLists(topFixture, searchFixture);
    expect(merged.length).toBeGreaterThan(0);

    // Every entry from search fixture must have defined tourId and tourName
    const searchParsed = (searchFixture.currentPageResults || []).map((item) =>
      parseBroadcastItem(item)
    );
    for (const s of searchParsed) {
      expect(s.tourId).toBeTruthy();
      expect(s.tourName).toBeTruthy();
      expect(s.tourName).not.toBe('Tournament');
    }

    // Deduplicated by tourId
    const tourIds = merged.map((b) => b.tourId).filter(Boolean);
    expect(new Set(tourIds).size).toBe(tourIds.length);
  });

  it('prefers a live World Championship broadcast when selecting featured event', () => {
    const items = [
      { tourId: 't1', tourName: 'Random Open', roundId: 'r1', roundName: 'R1', status: 'live' },
      {
        tourId: 't2',
        tourName: 'FIDE World Chess Championship 2026',
        roundId: 'r2',
        roundName: 'Game 3',
        status: 'live',
      },
    ];
    expect(selectFeaturedBroadcast(items).tourId).toBe('t2');
  });

  it('auto-advances when round 3 finishes and round 4 becomes ongoing (unless user pinned round)', () => {
    const tourData = {
      tour: { id: 'qfkdt8mn', name: 'FIDE World Chess Championship 2026' },
      rounds: [
        { id: 'r3', name: 'Game 3', ongoing: false, finished: true },
        { id: 'r4', name: 'Game 4', ongoing: true, finished: false },
      ],
    };

    const autoRes = computeRoundTransition({
      currentRoundId: 'r3',
      userPinnedRound: false,
      tourData,
    });
    expect(autoRes.advanced).toBe(true);
    expect(autoRes.nextRoundId).toBe('r4');
    expect(autoRes.round.name).toBe('Game 4');

    const pinnedRes = computeRoundTransition({
      currentRoundId: 'r3',
      userPinnedRound: true,
      tourData,
    });
    expect(pinnedRes.advanced).toBe(false);
    expect(pinnedRes.nextRoundId).toBe('r3');
  });

  it('parses all Lichess broadcast URL and bare ID forms', () => {
    expect(
      parseBroadcastInput('https://lichess.org/broadcast/wcc-2026/game-3/fnmEB1kH')
    ).toEqual({ type: 'round', id: 'fnmEB1kH' });
    expect(
      parseBroadcastInput('https://lichess.org/broadcast/wcc-2026/game-3/fnmEB1kH/AbCdEf12')
    ).toEqual({ type: 'round', id: 'fnmEB1kH' });
    expect(parseBroadcastInput('https://lichess.org/broadcast/wcc-2026/qfkdt8mn')).toEqual({
      type: 'tour',
      id: 'qfkdt8mn',
    });
    expect(parseBroadcastInput('fnmEB1kH')).toEqual({ type: 'round', id: 'fnmEB1kH' });
  });
});
