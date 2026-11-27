import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { normalizeLichessGame, normalizeChessComGame, parsePgnGames } from '../src/insights/normalize.js';
import {
  eloGainFromScoreDelta,
  targetScoreForEloGain,
  gameLengthProfile,
  findOpeningCliffs,
  compareRepertoireToGames,
  detectPhase,
  classifyBlunderTag,
  buildGameAnalysis,
  buildLichessGameAnalysis,
  aggregateDiagnostics,
  buildEloPlan,
} from '../src/insights/coach.js';
import { targetRatingBrackets, normalizeBenchmarkMoves } from '../src/insights/benchmark.js';
import { extractDrillDeck, checkDrillAttempt, recordDrillOutcome, drillId } from '../src/insights/drills.js';

let seq = 0;
const rec = (o = {}) => ({
  id: `g${seq++}`,
  src: 'lichess',
  acct: 'me',
  t: 1_700_000_000_000 + seq * 60_000,
  tc: 'blitz',
  clock: '180+2',
  rated: true,
  color: 'w',
  res: 1,
  term: 'resign',
  me: 1600,
  op: 'Rival',
  opR: 1600,
  opT: '',
  eco: 'C50',
  opening: 'Italian Game',
  oply: 4,
  moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5',
  plies: 6,
  url: '',
  ...o,
});

describe('normalize clocks, accuracy, and server evals', () => {
  it('captures clocks, accuracy and compact evals from Lichess NDJSON', () => {
    const r = normalizeLichessGame(
      {
        id: 'ev1',
        rated: true,
        variant: 'standard',
        speed: 'blitz',
        createdAt: 1_700_000_000_000,
        status: 'resign',
        winner: 'white',
        players: {
          white: { user: { name: 'Me', id: 'me' }, rating: 1600, analysis: { accuracy: 86 } },
          black: { user: { name: 'Opp', id: 'opp' }, rating: 1590 },
        },
        moves: 'e4 e5 Nf3 Nc6',
        clock: { initial: 180, increment: 2 },
        clocks: [17900, 17850, 17700, 17500],
        analysis: [{ eval: 25 }, { eval: 20 }, { eval: 30 }, { eval: 210, best: 'g8f6' }],
      },
      'me'
    );
    expect(r.clks).toEqual([179, 179, 177, 175]);
    expect(r.acc).toBe(86);
    expect(r.evals).toEqual([{ c: 25 }, { c: 20 }, { c: 30 }, { c: 210, b: 'g8f6' }]);
  });

  it('captures [%clk ...] timestamps and accuracies from Chess.com games', () => {
    const pgn = [
      '[Event "Live Chess"]',
      '[UTCDate "2026.11.20"]',
      '[UTCTime "18:30:00"]',
      '[White "Me"]',
      '[Black "Opp"]',
      '[Result "1-0"]',
      '',
      '1. e4 {[%clk 0:02:59.5]} 1... e5 {[%clk 0:02:58.1]} 2. Nf3 {[%clk 0:02:55]} Nc6 1-0',
    ].join('\n');
    const parsed = parsePgnGames(pgn);
    expect(parsed[0].clks).toEqual([180, 178, 175, null]);
    const r = normalizeChessComGame(
      {
        url: 'https://www.chess.com/game/live/999',
        pgn,
        time_control: '180+2',
        time_class: 'blitz',
        rules: 'chess',
        rated: true,
        accuracies: { white: 91.2, black: 74.5 },
        white: { username: 'Me', rating: 1600, result: 'win' },
        black: { username: 'Opp', rating: 1590, result: 'resigned' },
      },
      'me'
    );
    expect(r.clks).toEqual([180, 178, 175, null]);
    expect(r.acc).toBe(91.2);
  });
});

describe('Phase 1: Elo math, game length, opening cliffs, repertoire diff', () => {
  it('computes honest Elo targets and counterfactual recovery', () => {
    expect(targetScoreForEloGain(100)).toBeCloseTo(0.6401, 3);
    expect(eloGainFromScoreDelta(0.5, 0.14)).toBeGreaterThanOrEqual(98);
    expect(eloGainFromScoreDelta(0.5, 0.14)).toBeLessThanOrEqual(102);
    expect(eloGainFromScoreDelta(0.5, 0)).toBe(0);
  });

  it('profiles games by length and counts early losses', () => {
    const games = [
      rec({ plies: 30, res: 0, term: 'mate' }),
      rec({ plies: 36, res: 1, term: 'resign' }),
      rec({ plies: 60, res: 0.5, term: 'agreement' }),
      rec({ plies: 92, res: 0, term: 'time' }),
    ];
    const p = gameLengthProfile(games);
    expect(p.earlyLosses).toBe(1);
    expect(p.buckets.map((b) => b.n)).toEqual([2, 1, 1]);
  });

  it('finds exact opening cliff moves where score drops sharply', () => {
    const games = [];
    // Winning baseline with 4.c3
    for (let i = 0; i < 20; i++) {
      games.push(rec({ moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6', res: 1, opening: 'Italian Game' }));
    }
    // Losing cliff with 4.Nc3
    for (let i = 0; i < 12; i++) {
      games.push(rec({ moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5 Nc3 Nf6', res: 0, opening: 'Italian Game' }));
    }
    const cliffs = findOpeningCliffs(games, { minGames: 5 });
    expect(cliffs.length).toBeGreaterThan(0);
    expect(cliffs[0]).toMatchObject({
      color: 'w',
      playedSan: 'Nc3',
      playedUci: 'b1c3',
      n: 12,
      score: 0,
    });
    expect(cliffs[0].eloImpact).toBeGreaterThan(20);
  });

  it('detects repertoire memory slips and missing opponent sidelines', () => {
    const c0 = new Chess();
    const f0 = c0.fen();
    c0.move('e4');
    const f1 = c0.fen();
    c0.move('e5');
    const f2 = c0.fen();
    c0.move('Nf3');
    const f3 = c0.fen();

    const repertoire = {
      pos: [
        { f: f0, e: [['e2e4', 'e4', 1, 0, [], 'c1']] },
        { f: f1, e: [['e7e5', 'e5', 2, 0, [], null]] },
        { f: f2, e: [['g1f3', 'Nf3', 3, 0, [], 'c2']] },
        { f: f3, e: [] },
      ],
    };
    const games = [
      rec({ moves: 'e4 e5 Bc4 Nc6', res: 0 }),
      rec({ moves: 'e4 e5 Bc4 Nf6', res: 0 }),
      rec({ moves: 'e4 c5 Nf3 d6', res: 0.5 }),
      rec({ moves: 'e4 c5 Nc3 Nc6', res: 0 }),
    ];
    const diff = compareRepertoireToGames(repertoire, games);
    expect(diff.memorySlips[0]).toMatchObject({ playedSan: 'Bc4', expectedSans: ['Nf3'], n: 2 });
    expect(diff.missingSidelines[0]).toMatchObject({ oppSan: 'c5', n: 2 });
  });
});

describe('Phase 2: Phase detection, blunder taxonomy, conversion & clock diagnostics', () => {
  it('classifies opening, middlegame, and endgame from board material', () => {
    expect(detectPhase(new Chess(), 6)).toBe('opening');
    expect(detectPhase(new Chess('4k3/8/3K4/4P3/8/8/8/8 w - - 0 40'), 80)).toBe('endgame');
    expect(detectPhase(new Chess('r1bq1rk1/pppp1ppp/2n2n2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 12'), 24)).toBe('middlegame');
  });

  it('tags missed mate, allowed mate, hung piece, and endgame errors deterministically', () => {
    expect(
      classifyBlunderTag({
        fenBefore: 'r4rk1/ppq2ppp/2p5/8/8/3Q4/PPP2P2/6KR w - - 0 26',
        playedUci: 'd3b3',
        bestUci: 'd3h7',
        beforeEval: { whiteCp: 10000, mate: 1 },
        afterEval: { whiteCp: 90, mate: null },
        phase: 'middlegame',
        moverColor: 'w',
        winDrop: 40,
      })
    ).toBe('missed_mate');

    expect(
      classifyBlunderTag({
        fenBefore: '4k3/8/3K4/4P3/8/8/8/8 w - - 0 44',
        playedUci: 'e5e6',
        bestUci: 'd6e6',
        beforeEval: { whiteCp: 500, mate: null },
        afterEval: { whiteCp: 0, mate: null },
        phase: 'endgame',
        moverColor: 'w',
        winDrop: 38,
      })
    ).toBe('endgame_error');

    // Hanging a knight cleanly on e5 where Black takes with d6xe5
    expect(
      classifyBlunderTag({
        fenBefore: 'r1bqkbnr/ppp2ppp/3p4/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3',
        playedUci: 'f3e5',
        bestUci: 'd2d4',
        beforeEval: { whiteCp: 40, mate: null },
        afterEval: { whiteCp: -320, mate: null, bestUci: 'd6e5' },
        phase: 'opening',
        moverColor: 'w',
        winDrop: 30,
      })
    ).toBe('hung_piece');
  });

  it('builds Lichess server analysis and aggregates conversion, clocks, and Elo plan', () => {
    // 6-ply game where White reaches +3.5 then blunders quickly (1s spent, 176s left) and loses.
    const g = rec({
      id: 'li:throw1',
      color: 'w',
      res: 0,
      clock: '180+0',
      moves: 'e4 e5 Nf3 Nc6 Bc4 Nf6',
      plies: 6,
      clks: [179, 179, 177, 176, 176, 174],
      evals: [
        { c: 25 },
        { c: 20 },
        { c: 350 },
        { c: 360 },
        { c: -280, b: 'd2d4' },
        { c: -290 },
      ],
    });
    const analysis = buildLichessGameAnalysis(g);
    expect(analysis).toBeTruthy();
    expect(analysis.peakCp).toBe(360);
    expect(analysis.blunders).toBe(1);
    expect(analysis.issues[0]).toMatchObject({
      playedSan: 'Bc4',
      bestUci: 'd2d4',
      timeSpent: 1,
      clockLeft: 176,
    });

    const map = new Map([[g.id, analysis]]);
    const diag = aggregateDiagnostics([g], map);
    expect(diag.coverage).toMatchObject({ total: 1, analyzed: 1, fromLichess: 1, clocked: 1 });
    expect(diag.conversion).toMatchObject({ reached: 1, wins: 0, losses: 1 });
    expect(diag.time.impulsive).toBe(1);

    // buildGameAnalysis direct smoke check
    const raw = [
      { whiteCp: 20, mate: null, bestUci: 'e2e4' },
      { whiteCp: 25, mate: null, bestUci: 'e7e5' },
      { whiteCp: 20, mate: null, bestUci: 'g1f3' },
      { whiteCp: 350, mate: null, bestUci: 'b8c6' },
      { whiteCp: 360, mate: null, bestUci: 'd2d4' },
      { whiteCp: -280, mate: null, bestUci: 'g8f6' },
      { whiteCp: -290, mate: null, bestUci: '' },
    ];
    const direct = buildGameAnalysis(g, raw, { source: 'stockfish', depth: 10 });
    expect(direct.blunders).toBe(1);

    // Elo plan merges items cleanly
    const games20 = [g];
    for (let i = 0; i < 19; i++) games20.push(rec({ id: `pad${i}`, res: i % 2 }));
    const plan = buildEloPlan(games20, diag);
    expect(plan.targetRating).toBe(1700);
    expect(plan.neededGainPct).toBe(14);
  });
});

describe('Phase 3: Peer rating brackets & blunder SRS drills', () => {
  it('selects the +100–200 Elo Lichess rating bracket and normalizes explorer moves', () => {
    expect(targetRatingBrackets(1550)).toMatchObject({ param: '1800,2000', label: '1800–2000' });
    expect(targetRatingBrackets(1480)).toMatchObject({ param: '1600,1800', label: '1600–1800' });
    expect(targetRatingBrackets(2450)).toMatchObject({ param: '2500', label: '2500+' });

    const norm = normalizeBenchmarkMoves(
      {
        white: 40,
        draws: 20,
        black: 40,
        moves: [{ san: 'a6', uci: 'a7a6', white: 20, draws: 10, black: 30, averageRating: 1750 }],
      },
      'b'
    );
    expect(norm.totalGames).toBe(100);
    expect(norm.moves[0].score).toBeCloseTo(35 / 60, 4);
  });

  it('extracts drill cards, checks moves including checkmates, and updates Leitner boxes', () => {
    const g = rec({ id: 'gdrill', color: 'w' });
    const issue = {
      gameId: 'gdrill',
      ply: 51,
      moveNum: 26,
      color: 'w',
      fenBefore: 'r4rk1/ppq2ppp/2p5/8/8/3Q4/PPP2P2/6KR w - - 0 26',
      playedSan: 'Qb3',
      playedUci: 'd3b3',
      bestSan: 'Qxh7#',
      bestUci: 'd3h7',
      evalBeforeLabel: '+M1',
      evalAfterLabel: '+0.90',
      winDrop: 38,
      kind: 'blunder',
      phase: 'middlegame',
      tag: 'missed_mate',
    };
    const analyses = new Map([['gdrill', { id: 'gdrill', issues: [issue] }]]);
    const deck = extractDrillDeck([g], analyses, {}, { now: 1_000_000 });
    expect(deck.cards).toHaveLength(1);
    expect(deck.dueCount).toBe(1);

    const wrong = checkDrillAttempt(deck.cards[0], 'd3', 'b3');
    expect(wrong).toMatchObject({ legal: true, correct: false });

    const right = checkDrillAttempt(deck.cards[0], 'd3', 'h7');
    expect(right).toMatchObject({ legal: true, correct: true, san: 'Qxh7#' });

    const id = drillId(issue);
    const p1 = recordDrillOutcome({}, id, true, 1_000_000);
    expect(p1[id].box).toBe(1);
    expect(p1[id].due).toBeGreaterThan(1_000_000);
    const p2 = recordDrillOutcome(p1, id, false, 2_000_000);
    expect(p2[id].box).toBe(0);
  });
});
