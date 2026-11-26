import { describe, it, expect } from 'vitest';
import {
  parseRepertoireFile,
  mergeProgress,
  cardStatus,
  gradeRecord,
  learnRecord,
  buildExportFile,
  DAY,
  MIN,
} from '../src/repertoire/model.js';
import { encodeMoveLine, decodeShareHash } from '../src/chess/shareUrl.js';
import {
  buildRepertoireFenIndex,
  lookupRepertoirePosition,
  summarizeRepertoire,
  buildMergedRepertoireTree,
} from '../src/repertoire/studioPanel.js';

// A tiny synthetic repertoire (1.e4 e5 2.Nf3 for White). No real prep here:
// actual repertoires are private import files and never live in this repo.
function sampleRepertoire() {
  return {
    secs: [{ id: 'A', name: 'Test', group: 'White · 1.e4', color: 'w', start: 0, startPly: 0, lines: [0] }],
    lines: [
      {
        id: 'A1', name: 'Main', sec: 'A', color: 'w', ev: '+0.3', note: 'n',
        san: ['e4', 'e5', 'Nf3'], uci: ['e2e4', 'e7e5', 'g1f3'], pos: [0, 1, 2, 3], alt: false,
      },
    ],
    pos: [
      { f: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', t: 0, e: [['e2e4', 'e4', 1, 1, [0], 'c1']] },
      { f: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', t: 0, e: [['e7e5', 'e5', 2, 0, [0]]] },
      { f: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', t: 0, e: [['g1f3', 'Nf3', 3, 1, [0], 'c2']] },
      { f: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2', t: 0, e: [] },
    ],
    cards: { c1: { p: 0, u: 'e2e4', s: 'e4', n: 'why' }, c2: { p: 2, u: 'g1f3', s: 'Nf3', n: 'why' } },
    warn: {},
    theory: [{ ev: 0.3, name: null, alts: [] }],
    roots: { w: 0 },
  };
}

const fileOf = (over = {}) =>
  JSON.stringify({ format: 'tichess-repertoire', version: 1, name: 'Me', repertoire: sampleRepertoire(), progress: {}, ...over });

describe('repertoire import file', () => {
  it('accepts a valid file and keeps known progress only', () => {
    const progress = {
      c1: { b: 2, d: 5, r: 3, l: 1, t: 4, s: 1 },
      zz: { b: 1, d: 1, r: 1, l: 0, t: 1, s: 1 },
      days: { t: 9, d: { '2026-11-22': { n: 3, ok: 2 }, bad: { n: 1, ok: 1 } } },
    };
    const r = parseRepertoireFile(fileOf({ progress }));
    expect(r.ok).toBe(true);
    expect(r.name).toBe('Me');
    expect(Object.keys(r.progress).sort()).toEqual(['c1', 'days']);
    expect(Object.keys(r.progress.days.d)).toEqual(['2026-11-22']);
  });

  it('rejects non-JSON, other formats and future versions', () => {
    expect(parseRepertoireFile('nope').ok).toBe(false);
    expect(parseRepertoireFile('{"format":"other"}').ok).toBe(false);
    expect(parseRepertoireFile(fileOf({ version: 2 })).error).toMatch(/version/);
  });

  it('rejects a line whose moves do not follow the position graph', () => {
    const rep = sampleRepertoire();
    rep.lines[0].uci[2] = 'b1c3';
    const r = parseRepertoireFile(fileOf({ repertoire: rep }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/line A1 move 3/);
  });

  it('rejects out-of-range references', () => {
    const rep = sampleRepertoire();
    rep.pos[0].e[0][2] = 99;
    expect(parseRepertoireFile(fileOf({ repertoire: rep })).ok).toBe(false);
  });

  it('round-trips through the export file', () => {
    const progress = { c2: { b: 1, d: 10, r: 1, l: 0, t: 7, s: 1 } };
    const text = buildExportFile(sampleRepertoire(), progress, 'Me', 123);
    const r = parseRepertoireFile(text);
    expect(r.ok).toBe(true);
    expect(r.progress).toEqual(progress);
  });
});

describe('spaced repetition', () => {
  const now = 1_000_000_000_000;

  it('walks the 1, 3, 7, 16 day ladder and reaches mastered at 16 days', () => {
    let r = learnRecord(null, now);
    expect(cardStatus(r, now)).toBe('due');
    const days = [];
    let t = now;
    for (let i = 0; i < 4; i++) {
      r = gradeRecord(r, true, t);
      days.push((r.d - t) / DAY);
      t = r.d;
    }
    expect(days).toEqual([1, 3, 7, 16]);
    expect(cardStatus(r, t - 1)).toBe('mastered');
  });

  it('a miss resets the card and brings it back in 10 minutes', () => {
    const r = gradeRecord({ b: 3, d: now, r: 4, l: 0, t: 0, s: 1 }, false, now);
    expect(r.b).toBe(0);
    expect(r.l).toBe(1);
    expect(r.d - now).toBe(10 * MIN);
    expect(cardStatus(r, now)).toBe('learning');
  });

  it('caps at the 90-day box', () => {
    let r = { b: 6, d: now, r: 9, l: 0, t: 0, s: 1 };
    r = gradeRecord(r, true, now);
    expect(r.b).toBe(6);
    expect((r.d - now) / DAY).toBe(90);
  });

  it('unseen cards are new; learning an already learned card is a no-op', () => {
    expect(cardStatus(undefined, now)).toBe('new');
    const r = { b: 2, d: now + DAY, r: 1, l: 0, t: 5, s: 1 };
    expect(learnRecord(r, now)).toBe(r);
  });
});

describe('progress merge', () => {
  it('keeps the most recently trained record per card and the larger daily count', () => {
    const a = { c1: { b: 1, t: 10 }, c2: { b: 3, t: 50 }, days: { t: 1, d: { x: { n: 5, ok: 4 } } } };
    const b = { c1: { b: 2, t: 20 }, c2: { b: 0, t: 40 }, c3: { b: 1, t: 1 }, days: { t: 2, d: { x: { n: 3, ok: 3 }, y: { n: 1, ok: 1 } } } };
    const m = mergeProgress(a, b);
    expect(m.c1.b).toBe(2);
    expect(m.c2.b).toBe(3);
    expect(m.c3.b).toBe(1);
    expect(m.days.d).toEqual({ x: { n: 5, ok: 4 }, y: { n: 1, ok: 1 } });
  });
});

describe('open repertoire line in analysis', () => {
  it('encodes a move line that the analysis studio decodes to the last move', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const hash = encodeMoveLine(start, ['e2e4', 'e7e5', 'g1f3'], { flipped: true, title: 'Italian' });
    const d = decodeShareHash(hash);
    expect(d.title).toBe('Italian');
    expect(d.flipped).toBe(true);
    expect(d.current.san).toBe('Nf3');
    expect(d.root.children[0].san).toBe('e4');
  });
});

describe('main studio repertoire lookup', () => {
  it('indexes repertoire FENs, looks up prepared moves with status/notes, and summarizes counts', () => {
    const rep = sampleRepertoire();
    const now = 1_700_000_000_000;
    const progress = {
      c1: { b: 4, d: now + DAY, r: 5, l: 0, t: now - DAY, s: 1 },
      c2: { b: 1, d: now - MIN, r: 2, l: 0, t: now - DAY, s: 1 },
    };
    const idx = buildRepertoireFenIndex(rep);

    const startHit = lookupRepertoirePosition(
      idx,
      rep,
      progress,
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      now
    );
    expect(startHit.moves).toHaveLength(1);
    expect(startHit.moves[0]).toMatchObject({
      uci: 'e2e4',
      san: 'e4',
      mine: true,
      note: 'why',
      status: 'mastered',
    });

    const summary = summarizeRepertoire(rep, progress, now);
    expect(summary.total).toMatchObject({ total: 2, mastered: 1, due: 1, newCount: 0 });
    expect(summary.sections[0].name).toBe('Test');
  });

  it('merges multiple opening sections into one unified chess tree and filters by color', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const afterE5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    const afterE6 = 'rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    const rep = {
      secs: [
        { id: 'S1', name: 'Open Game', color: 'b', start: 0, startPly: 0, lines: [0] },
        { id: 'S2', name: 'French Defense', color: 'b', start: 0, startPly: 0, lines: [1] },
        { id: 'S3', name: 'White Main', color: 'w', start: 0, startPly: 0, lines: [2] },
      ],
      lines: [
        { id: 'S1-1', name: 'e5', sec: 'S1', color: 'b', san: ['e4', 'e5'], uci: ['e2e4', 'e7e5'], pos: [0, 1, 2] },
        { id: 'S2-1', name: 'e6', sec: 'S2', color: 'b', san: ['e4', 'e6'], uci: ['e2e4', 'e7e6'], pos: [0, 1, 3] },
        { id: 'S3-1', name: 'd4', sec: 'S3', color: 'w', san: ['d4'], uci: ['d2d4'], pos: [0, 4] },
      ],
      pos: [
        { f: start, t: 0, e: [['e2e4', 'e4', 1, 0, [0, 1]], ['d2d4', 'd4', 4, 1, [2], 'cw1']] },
        { f: afterE4, t: 0, e: [['e7e5', 'e5', 2, 1, [0], 'cb1'], ['e7e6', 'e6', 3, 1, [1], 'cb2']] },
        { f: afterE5, t: 0, e: [] },
        { f: afterE6, t: 0, e: [] },
        { f: 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1', t: 0, e: [] },
      ],
      cards: {
        cw1: { p: 0, u: 'd2d4', s: 'd4', n: '' },
        cb1: { p: 1, u: 'e7e5', s: 'e5', n: '' },
        cb2: { p: 1, u: 'e7e6', s: 'e6', n: '' },
      },
      warn: {},
      theory: [{ ev: 0.2, name: null, alts: [] }],
      roots: { w: 0, b: 0 },
    };

    const mergedAll = buildMergedRepertoireTree(rep, { colorFilter: 'both' });
    expect(mergedAll.children.map((c) => c.san).sort()).toEqual(['d4', 'e4']);
    const e4Node = mergedAll.children.find((c) => c.san === 'e4');
    expect(e4Node.children.map((c) => c.san).sort()).toEqual(['e5', 'e6']);

    const mergedBlack = buildMergedRepertoireTree(rep, { colorFilter: 'b' });
    expect(mergedBlack.children.map((c) => c.san)).toEqual(['e4']);
    expect(mergedBlack.children[0].children.map((c) => c.san).sort()).toEqual(['e5', 'e6']);
  });
});
