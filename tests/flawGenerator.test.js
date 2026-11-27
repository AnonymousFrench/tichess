import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { START_FEN, normalizeFen } from '../src/state.js';
import { parseRepertoireFile, buildExportFile } from '../src/repertoire/model.js';
import { buildRepertoireFromPgn, mergeRepertoires } from '../src/repertoire/pgnImport.js';
import {
  diagnoseFlawMove,
  pickBestUserMove,
  pickOpponentReplies,
  buildPersonalOppMap,
  buildPersonalUserMoveMap,
  generateFlawRepertoire,
} from '../src/repertoire/flawGenerator.js';

function buildPrefix(sans) {
  const chess = new Chess();
  const moves = [];
  for (const s of sans) {
    const mv = chess.move(s);
    moves.push({
      san: mv.san,
      uci: mv.from + mv.to + (mv.promotion || ''),
      fen: chess.fen(),
      color: mv.color,
    });
  }
  return { moves, fen: chess.fen() };
}

const NAJDORF_PREFIX = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'];

describe('diagnoseFlawMove (weak move vs. sound move with weak follow-up)', () => {
  it('diagnoses 6.f3 in the Sicilian Najdorf as a sound move with weak follow-ups', () => {
    const { fen, moves } = buildPrefix(NAJDORF_PREFIX);
    const diag = diagnoseFlawMove({
      fen,
      ply: moves.length,
      color: 'w',
      flawedUci: 'f2f3',
      flawedSan: 'f3',
      flawedStats: { total: 3, wins: 0, draws: 1, losses: 2, scorePct: 17 },
      engineLines: [
        { uci: 'c1e3', san: 'Be3', whiteCp: 32, mate: null, pvSan: ['Be3', 'e5', 'Nb3'] },
        { uci: 'c1g5', san: 'Bg5', whiteCp: 28, mate: null, pvSan: ['Bg5', 'e6', 'f4'] },
        { uci: 'f2f3', san: 'f3', whiteCp: 24, mate: null, pvSan: ['f3', 'e5', 'Nb3'] },
        { uci: 'f1e2', san: 'Be2', whiteCp: 22, mate: null, pvSan: ['Be2', 'e5', 'Nb3'] },
      ],
      peerMoves: [
        { uci: 'c1e3', san: 'Be3', games: 5000, share: 0.4, score: 0.56 },
        { uci: 'c1g5', san: 'Bg5', games: 2200, share: 0.18, score: 0.54 },
        { uci: 'f2f3', san: 'f3', games: 900, share: 0.08, score: 0.52 },
      ],
      peerBracketLabel: 'Lichess 1800–2000',
    });

    expect(diag.kind).toBe('sound_followup');
    expect(diag.recommendedMode).toBe('repair');
    expect(diag.smallSample).toBe(true);
    expect(diag.sampleNote).toContain('3 games');
    expect(diag.explanation).toContain('6.f3');
    expect(diag.explanation).toContain("isn't because");
    expect(diag.whyDistinction).toContain('keep 6.f3');
    expect(diag.candidates.length).toBeGreaterThanOrEqual(2);
    expect(diag.candidates[0].san).toBe('Be3');
    expect(diag.candidates.some((c) => c.san === 'f3')).toBe(false);
  });

  it('diagnoses an objectively bad opening move as weak_move and recommends switching', () => {
    const { fen, moves } = buildPrefix(NAJDORF_PREFIX);
    const diag = diagnoseFlawMove({
      fen,
      ply: moves.length,
      color: 'w',
      flawedUci: 'g2g4',
      flawedSan: 'g4',
      flawedStats: { total: 12, wins: 2, draws: 1, losses: 9, scorePct: 21 },
      engineLines: [
        { uci: 'c1e3', san: 'Be3', whiteCp: 32, mate: null, pvSan: ['Be3', 'e5'] },
        { uci: 'c1g5', san: 'Bg5', whiteCp: 28, mate: null, pvSan: ['Bg5', 'e6'] },
      ],
      flawedEval: { uci: 'g2g4', san: 'g4', whiteCp: -95, mate: null, pvSan: ['g4', 'e5'] },
      peerMoves: [{ uci: 'c1e3', san: 'Be3', games: 4000, share: 0.45, score: 0.56 }],
      peerBracketLabel: 'Lichess 1800–2000',
    });

    expect(diag.kind).toBe('weak_move');
    expect(diag.recommendedMode).toBe('replace');
    expect(diag.smallSample).toBe(false);
    expect(diag.flawedMove.cpDrop).toBe(127);
    expect(diag.explanation).toContain('1.3 pawns');
    expect(diag.candidates[0].san).toBe('Be3');
  });

  it('diagnoses a moderate ~0.45 pawn inaccuracy as dubious_move', () => {
    const { fen, moves } = buildPrefix(NAJDORF_PREFIX);
    const diag = diagnoseFlawMove({
      fen,
      ply: moves.length,
      color: 'w',
      flawedUci: 'a2a4',
      flawedSan: 'a4',
      flawedStats: { total: 9, wins: 2, draws: 2, losses: 5, scorePct: 33 },
      engineLines: [
        { uci: 'c1e3', san: 'Be3', whiteCp: 32, mate: null, pvSan: ['Be3', 'e5'] },
      ],
      flawedEval: { uci: 'a2a4', san: 'a4', whiteCp: -14, mate: null, pvSan: ['a4', 'e5'] },
      peerMoves: [{ uci: 'c1e3', san: 'Be3', games: 3000, share: 0.4, score: 0.55 }],
    });

    expect(diag.kind).toBe('dubious_move');
    expect(diag.recommendedMode).toBe('replace');
    expect(diag.flawedMove.cpDrop).toBe(46);
  });
});

describe('move selection helpers', () => {
  it('filters out unsound high-winrate Explorer traps using Stockfish soundness gate', () => {
    const { fen } = buildPrefix(NAJDORF_PREFIX);
    const pick = pickBestUserMove({
      fen,
      color: 'w',
      explorerMoves: [
        // Unsound trap not even in Stockfish's sound candidates
        { uci: 'g2g4', san: 'g4', games: 200, share: 0.05, score: 0.68 },
        // Sound practical main move
        { uci: 'c1e3', san: 'Be3', games: 5000, share: 0.45, score: 0.56 },
      ],
      engineLines: [
        { uci: 'c1g5', san: 'Bg5', whiteCp: 35, mate: null, pvSan: ['Bg5'] },
        { uci: 'c1e3', san: 'Be3', whiteCp: 30, mate: null, pvSan: ['Be3'] },
      ],
    });
    expect(pick?.san).toBe('Be3');
    expect(pick?.source).toBe('explorer+engine');
  });

  it('prioritizes opponent replies that actually beat the user over generic Explorer replies', () => {
    const { fen } = buildPrefix([...NAJDORF_PREFIX, 'f3']);
    const replies = pickOpponentReplies({
      fen,
      maxReplies: 2,
      minShare: 0.12,
      minGames: 5,
      personalOppMoves: [{ uci: 'd8b6', san: 'Qb6', games: 2, losses: 2 }],
      explorerMoves: [
        { uci: 'e7e5', san: 'e5', games: 800, share: 0.52 },
        { uci: 'e7e6', san: 'e6', games: 400, share: 0.26 },
        { uci: 'd8b6', san: 'Qb6', games: 100, share: 0.07 },
      ],
      engineLines: [],
    });

    expect(replies.map((r) => r.san)).toEqual(['Qb6', 'e5']);
    expect(replies[0].personalLosses).toBe(2);
    expect(replies[0].source).toBe('personal');
  });

  it('indexes opponent replies from both Insights records and Studio Explorer PGNs', () => {
    const map = buildPersonalOppMap(
      [
        {
          color: 'w',
          res: 0,
          moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 f3 Qb6 Be3 e5',
        },
        {
          winner: 'black',
          pgn: '[Result "0-1"]\n\n1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. f3 e5 0-1',
        },
      ],
      'w'
    );
    const { fen } = buildPrefix([...NAJDORF_PREFIX, 'f3']);
    const afterF3 = map.get(normalizeFen(fen)) || [];
    expect(afterF3.map((r) => r.san).sort()).toEqual(['Qb6', 'e5']);
    expect(afterF3.every((r) => r.losses === 1)).toBe(true);
  });
});

describe('generateFlawRepertoire end-to-end compilation & merging', () => {
  // Deterministic legal-move mock engine + explorer keyed by FEN turn.
  function makeMocks(scriptByNormFen = new Map()) {
    const evaluateFn = async (fen, { multipv = 3 } = {}) => {
      const nf = normalizeFen(fen);
      const scripted = scriptByNormFen.get(nf)?.engine;
      if (scripted) return scripted.slice(0, multipv);
      const chess = new Chess(fen);
      const legal = chess.moves({ verbose: true }).slice(0, multipv);
      return legal.map((mv, i) => ({
        uci: mv.from + mv.to + (mv.promotion || ''),
        san: mv.san,
        whiteCp: 25 - i * 10,
        mate: null,
        pvSan: [mv.san],
      }));
    };

    const fetchExplorerFn = async (fen) => {
      const nf = normalizeFen(fen);
      const scripted = scriptByNormFen.get(nf)?.explorer;
      if (scripted) return { status: 'ok', poolLabel: 'Mock 1800–2000', ...scripted };
      return { status: 'ok', poolLabel: 'Mock 1800–2000', totalGames: 0, moves: [] };
    };

    return { evaluateFn, fetchExplorerFn };
  }

  it('builds a valid replacement repertoire with habit warnings, theory alts, and clean merge', async () => {
    const { moves: prefixMoves, fen: najdorfFen } = buildPrefix(NAJDORF_PREFIX);
    const afterBe3 = buildPrefix([...NAJDORF_PREFIX, 'Be3']).fen;
    const afterBe3E5 = buildPrefix([...NAJDORF_PREFIX, 'Be3', 'e5']).fen;
    const afterBe3E6 = buildPrefix([...NAJDORF_PREFIX, 'Be3', 'e6']).fen;

    const script = new Map([
      [
        normalizeFen(najdorfFen),
        {
          engine: [
            { uci: 'c1e3', san: 'Be3', whiteCp: 32, mate: null, pvSan: ['Be3', 'e5', 'Nb3'] },
            { uci: 'c1g5', san: 'Bg5', whiteCp: 28, mate: null, pvSan: ['Bg5', 'e6', 'f4'] },
          ],
        },
      ],
      [
        normalizeFen(afterBe3),
        {
          explorer: {
            totalGames: 1000,
            moves: [
              { uci: 'e7e5', san: 'e5', games: 550, share: 0.55, score: 0.54 },
              { uci: 'e7e6', san: 'e6', games: 300, share: 0.3, score: 0.56 },
            ],
          },
        },
      ],
      [
        normalizeFen(afterBe3E5),
        {
          engine: [{ uci: 'd4b3', san: 'Nb3', whiteCp: 35, mate: null, pvSan: ['Nb3', 'Be6', 'f3'] }],
          explorer: {
            totalGames: 500,
            moves: [{ uci: 'd4b3', san: 'Nb3', games: 420, share: 0.84, score: 0.56 }],
          },
        },
      ],
      [
        normalizeFen(afterBe3E6),
        {
          engine: [{ uci: 'f2f3', san: 'f3', whiteCp: 38, mate: null, pvSan: ['f3', 'b5', 'Qd2'] }],
          explorer: {
            totalGames: 300,
            moves: [{ uci: 'f2f3', san: 'f3', games: 210, share: 0.7, score: 0.57 }],
          },
        },
      ],
    ]);

    const { evaluateFn, fetchExplorerFn } = makeMocks(script);
    const result = await generateFlawRepertoire({
      prefixMoves,
      startFen: START_FEN,
      fen: najdorfFen,
      color: 'w',
      openingName: 'Sicilian Defense: Najdorf Variation',
      flawedUci: 'f2f3',
      flawedSan: 'f3',
      flawedStats: { total: 3, wins: 0, draws: 1, losses: 2, scorePct: 17 },
      mode: 'replace',
      anchorMove: { uci: 'c1e3', san: 'Be3', evLabel: '+0.3', peerScore: 56 },
      presetKey: 'quick',
      evaluateFn,
      fetchExplorerFn,
    });

    // Strict tichess-repertoire v1 validation
    const validated = parseRepertoireFile(buildExportFile(result.repertoire, {}, 'Flaw Fix', Date.now()));
    expect(validated.ok).toBe(true);
    expect(result.stats.lines).toBeGreaterThanOrEqual(2);
    expect(result.drillCardIds.length).toBeGreaterThan(0);

    // Every drill card should be at or after the flaw ply (move 6), not 1.e4/2.Nf3
    const earlyUcis = new Set(['e2e4', 'g1f3', 'd2d4']);
    for (const cid of result.drillCardIds) {
      expect(earlyUcis.has(result.repertoire.cards[cid].u)).toBe(false);
    }

    // Habit warnings attached to both the flawed move (f2f3) and the preceding opponent move (a7a6)
    const warnValues = Object.values(result.repertoire.warn);
    expect(warnValues.some((w) => w.includes('Old habit') && w.includes('6.f3'))).toBe(true);
    expect(warnValues.some((w) => w.includes('Watch out') && w.includes('6.Be3'))).toBe(true);

    // Theory alts populated at the Najdorf root
    const najdorfPosIdx = result.repertoire.pos.findIndex((p) => normalizeFen(p.f) === normalizeFen(najdorfFen));
    expect(najdorfPosIdx).toBeGreaterThanOrEqual(0);
    const th = result.repertoire.theory[result.repertoire.pos[najdorfPosIdx].t];
    expect(th.alts.length).toBeGreaterThanOrEqual(2);
    expect(th.alts[0].san).toBe('Be3');
    expect(th.alts[0].pv[0]).toBe('Be3');

    // Merges non-destructively into an existing repertoire AND preserves the avoided-habit warn!
    const existing = buildRepertoireFromPgn('1. d4 d5 2. c4 e6 *', { color: 'w', sectionName: 'Queen Gambit' });
    expect(existing.ok).toBe(true);
    const merged = mergeRepertoires(existing.repertoire, result.repertoire);
    const mergedValid = parseRepertoireFile(buildExportFile(merged, {}, 'Merged', Date.now()));
    expect(mergedValid.ok).toBe(true);
    expect(merged.secs.length).toBe(2);
    expect(Object.values(merged.warn).some((w) => w.includes('Old habit') && w.includes('6.f3'))).toBe(true);
  });

  it('builds a repair repertoire keeping 6.f3 and covering personal loss replies without warning against 6.f3', async () => {
    const { moves: prefixMoves, fen: najdorfFen } = buildPrefix(NAJDORF_PREFIX);
    const afterF3 = buildPrefix([...NAJDORF_PREFIX, 'f3']).fen;
    const afterF3Qb6 = buildPrefix([...NAJDORF_PREFIX, 'f3', 'Qb6']).fen;

    const script = new Map([
      [
        normalizeFen(afterF3),
        {
          explorer: {
            totalGames: 800,
            moves: [{ uci: 'e7e5', san: 'e5', games: 500, share: 0.62, score: 0.52 }],
          },
        },
      ],
      [
        normalizeFen(afterF3Qb6),
        {
          engine: [{ uci: 'd1d2', san: 'Qd2', whiteCp: 42, mate: null, pvSan: ['Qd2', 'e5', 'Nb3'] }],
        },
      ],
    ]);

    const { evaluateFn, fetchExplorerFn } = makeMocks(script);
    const result = await generateFlawRepertoire({
      prefixMoves,
      startFen: START_FEN,
      fen: najdorfFen,
      color: 'w',
      openingName: 'Sicilian Defense: Najdorf Variation',
      flawedUci: 'f2f3',
      flawedSan: 'f3',
      flawedStats: { total: 3, wins: 0, draws: 1, losses: 2, scorePct: 17 },
      mode: 'repair',
      anchorMove: { uci: 'f2f3', san: 'f3', evLabel: '+0.2', peerScore: 52 },
      presetKey: 'quick',
      personalGames: [
        {
          color: 'w',
          res: 0,
          moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 f3 Qb6 Qd2 e5',
        },
      ],
      evaluateFn,
      fetchExplorerFn,
    });

    const validated = parseRepertoireFile(buildExportFile(result.repertoire, {}, 'Repair Fix', Date.now()));
    expect(validated.ok).toBe(true);
    // In repair mode, 6.f3 is kept (no "Old habit" warn against it)
    expect(Object.keys(result.repertoire.warn).length).toBe(0);
    // Personal loss reply 6...Qb6 must be covered and tagged
    expect(result.linesPreview.some((ln) => ln.movesText.includes('Qb6') && ln.personalLosses === 1)).toBe(true);
    // Anchor card note explains 6.f3 is sound and the leak starts after it
    const anchorCard = Object.values(result.repertoire.cards).find((c) => c.u === 'f2f3');
    expect(anchorCard?.n).toContain('objectively sound');
  });

  it('diagnoses and builds a repertoire against an opponent-turn Flaw reply (e.g. 6...e5 after 6.f3)', async () => {
    const { moves: prefixMoves, fen: afterE5 } = buildPrefix([...NAJDORF_PREFIX, 'f3', 'e5']);
    const diag = diagnoseFlawMove({
      fen: afterE5,
      ply: prefixMoves.length,
      color: 'w',
      flawedSan: 'e5',
      flawedStats: { total: 3, wins: 0, draws: 1, losses: 2, scorePct: 17 },
      triggerType: 'opponent_reply',
      oppMove: { uci: 'e7e5', san: 'e5', ply: prefixMoves.length - 1 },
      engineLines: [
        { uci: 'd4b3', san: 'Nb3', whiteCp: 22, mate: null, pvSan: ['Nb3', 'Be6', 'Be3'] },
        { uci: 'd4e2', san: 'Nde2', whiteCp: 10, mate: null, pvSan: ['Nde2', 'Be7', 'Be3'] },
      ],
      peerMoves: [
        { uci: 'd4b3', san: 'Nb3', games: 3000, share: 0.72, score: 0.55 },
        { uci: 'd4e2', san: 'Nde2', games: 600, share: 0.14, score: 0.51 },
      ],
      peerBracketLabel: 'Lichess 1800–2000',
    });

    expect(diag.kind).toBe('opponent_reply');
    expect(diag.recommendedMode).toBe('vs_opponent');
    expect(diag.headline).toContain('6...e5');
    expect(diag.candidates[0].san).toBe('Nb3');

    const { evaluateFn, fetchExplorerFn } = makeMocks();
    const result = await generateFlawRepertoire({
      prefixMoves,
      startFen: START_FEN,
      fen: afterE5,
      color: 'w',
      openingName: 'Sicilian Defense: Najdorf Variation',
      flawedStats: { total: 3, wins: 0, draws: 1, losses: 2, scorePct: 17 },
      mode: 'vs_opponent',
      oppMove: { uci: 'e7e5', san: 'e5', ply: prefixMoves.length - 1 },
      anchorMove: { uci: 'd4b3', san: 'Nb3', evLabel: '+0.2', peerScore: 55 },
      presetKey: 'quick',
      evaluateFn,
      fetchExplorerFn,
    });

    const validated = parseRepertoireFile(buildExportFile(result.repertoire, {}, 'Vs e5', Date.now()));
    expect(validated.ok).toBe(true);
    expect(result.sectionName).toContain('vs 6...e5');
    expect(Object.values(result.repertoire.warn).some((w) => w.includes('6...e5') && w.includes('7.Nb3'))).toBe(true);
    expect(result.drillCardIds.length).toBeGreaterThan(0);
    // Drill cards start at 7.Nb3 (not 1.e4 or 6.f3)
    const firstDrillCard = result.repertoire.cards[result.drillCardIds[0]];
    expect(firstDrillCard.s).toBe('Nb3');
  });

  it('inserts what the player used to play wrong into notes, warnings, and previews at deeper moves', async () => {
    const { moves: prefixMoves, fen: najdorfFen } = buildPrefix(NAJDORF_PREFIX);
    const afterF3 = buildPrefix([...NAJDORF_PREFIX, 'f3']).fen;
    const afterF3E5 = buildPrefix([...NAJDORF_PREFIX, 'f3', 'e5']).fen;

    // Duplicate IDs should be deduplicated cleanly
    const personalGames = [
      { id: 'g1', color: 'w', res: 0, moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 f3 e5 Nde2 Be7' },
      { id: 'g1', color: 'w', res: 0, moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 f3 e5 Nde2 Be7' },
      { id: 'g2', color: 'w', res: 0, moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 f3 e5 Nde2 Be6' },
    ];

    const userMap = buildPersonalUserMoveMap(personalGames, 'w');
    const playedAfterE5 = userMap.get(normalizeFen(afterF3E5)) || [];
    expect(playedAfterE5.length).toBe(1);
    expect(playedAfterE5[0].san).toBe('Nde2');
    expect(playedAfterE5[0].games).toBe(2);
    expect(playedAfterE5[0].losses).toBe(2);
    expect(playedAfterE5[0].scorePct).toBe(0);

    const script = new Map([
      [
        normalizeFen(afterF3),
        {
          explorer: {
            totalGames: 800,
            moves: [{ uci: 'e7e5', san: 'e5', games: 500, share: 0.62, score: 0.52 }],
          },
        },
      ],
      [
        normalizeFen(afterF3E5),
        {
          engine: [
            { uci: 'd4b3', san: 'Nb3', whiteCp: 32, mate: null, pvSan: ['Nb3', 'Be6', 'Be3'] },
            { uci: 'd4e2', san: 'Nde2', whiteCp: -25, mate: null, pvSan: ['Nde2', 'Be7', 'Be3'] },
          ],
          explorer: {
            totalGames: 600,
            moves: [{ uci: 'd4b3', san: 'Nb3', games: 420, share: 0.7, score: 0.56 }],
          },
        },
      ],
    ]);

    const { evaluateFn, fetchExplorerFn } = makeMocks(script);
    const result = await generateFlawRepertoire({
      prefixMoves,
      startFen: START_FEN,
      fen: najdorfFen,
      color: 'w',
      openingName: 'Sicilian Defense: Najdorf Variation',
      flawedUci: 'f2f3',
      flawedSan: 'f3',
      flawedStats: { total: 3, wins: 0, draws: 1, losses: 2, scorePct: 17 },
      mode: 'repair',
      anchorMove: { uci: 'f2f3', san: 'f3', evLabel: '+0.2', peerScore: 52 },
      presetKey: 'quick',
      personalGames,
      evaluateFn,
      fetchExplorerFn,
    });

    const validated = parseRepertoireFile(buildExportFile(result.repertoire, {}, 'Habits Fix', Date.now()));
    expect(validated.ok).toBe(true);

    // 7.Nb3 card note must explicitly explain what the player used to play wrong (7.Nde2)
    const nb3Card = Object.values(result.repertoire.cards).find((c) => c.u === 'd4b3');
    expect(nb3Card?.n).toContain('You used to play 7.Nde2');
    expect(nb3Card?.n).toContain('0%, 2g, 2L');
    expect(nb3Card?.n).toContain('Play 7.Nb3');

    // Warning map must include both the old habit 7.Nde2 (for red arrow + wrong-move catch) and the heads-up on 6...e5
    const warnValues = Object.values(result.repertoire.warn);
    expect(warnValues.some((w) => w.includes('Old habit') && w.includes('7.Nde2') && w.includes('7.Nb3'))).toBe(true);
    expect(warnValues.some((w) => w.includes('You used to play 7.Nde2') && w.includes('7.Nb3'))).toBe(true);

    // Line preview exposes fixedHabits for the modal UI
    expect(result.linesPreview.some((ln) => ln.fixedHabits.some((h) => h.label === '7.Nde2'))).toBe(true);

    // Line plan ("THE PLAN" shown on Line complete) must mention the fixed old habit even in repair mode
    expect(result.repertoire.lines[0].note).toContain('Fixes your old habit: 7.Nde2');
    expect(result.repertoire.lines[0].note).toContain('7.Nb3');
  });

  it('mentions deeper fixed habits in THE PLAN and refreshes existing Fix sections on regeneration + merge', async () => {
    const { moves: prefixMoves, fen: najdorfFen } = buildPrefix(NAJDORF_PREFIX);
    const afterF3 = buildPrefix([...NAJDORF_PREFIX, 'f3']).fen;
    const afterF3E5 = buildPrefix([...NAJDORF_PREFIX, 'f3', 'e5']).fen;
    const afterNb3 = buildPrefix([...NAJDORF_PREFIX, 'f3', 'e5', 'Nb3']).fen;
    const afterBe7 = buildPrefix([...NAJDORF_PREFIX, 'f3', 'e5', 'Nb3', 'Be7']).fen;

    // Player ALREADY played 7.Nb3 correctly, but kept playing 8.Qd2 (wrong habit) instead of 8.Be3
    const personalGames = [
      { id: 'h1', color: 'w', res: 0, moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 f3 e5 Nb3 Be7 Qd2 O-O' },
      { id: 'h2', color: 'w', res: 0, moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 f3 e5 Nb3 Be7 Qd2 Be6' },
      { id: 'h3', color: 'w', res: 0, moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 f3 e5 Nb3 Be7 Qd2 Nbd7' },
    ];

    const script = new Map([
      [
        normalizeFen(afterF3),
        {
          explorer: {
            totalGames: 800,
            moves: [{ uci: 'e7e5', san: 'e5', games: 500, share: 0.62, score: 0.52 }],
          },
        },
      ],
      [
        normalizeFen(afterF3E5),
        {
          engine: [{ uci: 'd4b3', san: 'Nb3', whiteCp: 35, mate: null, pvSan: ['Nb3', 'Be7', 'Be3'] }],
          explorer: {
            totalGames: 600,
            moves: [{ uci: 'd4b3', san: 'Nb3', games: 420, share: 0.7, score: 0.54 }],
          },
        },
      ],
      [
        normalizeFen(afterNb3),
        {
          explorer: {
            totalGames: 500,
            moves: [{ uci: 'f8e7', san: 'Be7', games: 300, share: 0.6, score: 0.5 }],
          },
        },
      ],
      [
        normalizeFen(afterBe7),
        {
          engine: [
            { uci: 'c1e3', san: 'Be3', whiteCp: 42, mate: null, pvSan: ['Be3', 'O-O', 'Qd2'] },
            { uci: 'd1d2', san: 'Qd2', whiteCp: -10, mate: null, pvSan: ['Qd2', 'O-O'] },
          ],
          explorer: {
            totalGames: 450,
            moves: [{ uci: 'c1e3', san: 'Be3', games: 310, share: 0.68, score: 0.57 }],
          },
        },
      ],
    ]);

    const { evaluateFn, fetchExplorerFn } = makeMocks(script);

    // 1. Simulate an older pre-PR#6 Fix section saved WITHOUT personalGames (no old-habit notes or warnings)
    const oldResult = await generateFlawRepertoire({
      prefixMoves,
      startFen: START_FEN,
      fen: najdorfFen,
      color: 'w',
      openingName: 'Sicilian Defense: Najdorf Variation',
      flawedUci: 'f2f3',
      flawedSan: 'f3',
      flawedStats: { total: 3, wins: 0, draws: 0, losses: 3, scorePct: 0 },
      mode: 'repair',
      anchorMove: { uci: 'f2f3', san: 'f3', evLabel: '+0.2', peerScore: 52 },
      presetKey: 'standard',
      personalGames: [],
      evaluateFn,
      fetchExplorerFn,
    });
    const oldBe3Card = Object.values(oldResult.repertoire.cards).find((c) => c.u === 'c1e3');
    expect(oldBe3Card).toBeDefined();
    expect(oldBe3Card.n).not.toContain('8.Qd2');
    expect(Object.keys(oldResult.repertoire.warn)).toHaveLength(0);

    // 2. Regenerate the SAME Fix section WITH personalGames while passing existingRepertoire = oldResult.repertoire
    const refreshed = await generateFlawRepertoire({
      prefixMoves,
      startFen: START_FEN,
      fen: najdorfFen,
      color: 'w',
      openingName: 'Sicilian Defense: Najdorf Variation',
      flawedUci: 'f2f3',
      flawedSan: 'f3',
      flawedStats: { total: 3, wins: 0, draws: 0, losses: 3, scorePct: 0 },
      mode: 'repair',
      anchorMove: { uci: 'f2f3', san: 'f3', evLabel: '+0.2', peerScore: 52 },
      presetKey: 'standard',
      existingRepertoire: oldResult.repertoire,
      personalGames,
      evaluateFn,
      fetchExplorerFn,
    });

    // Must NOT truncate early on the old section's positions
    expect(refreshed.repertoire.lines[0].san).toContain('Be3');
    // Line plan ("THE PLAN") must surface the deeper wrong habit 8.Qd2 -> 8.Be3
    expect(refreshed.repertoire.lines[0].note).toContain('Fixes your old habit: 8.Qd2');
    expect(refreshed.repertoire.lines[0].note).toContain('8.Be3');

    // 3. Merge refreshed section back into the old saved repertoire with preferIncomingMeta
    const merged = mergeRepertoires(oldResult.repertoire, refreshed.repertoire, { preferIncomingMeta: true });
    const mergedValidated = parseRepertoireFile(buildExportFile(merged, {}, 'Refreshed Fix', Date.now()));
    expect(mergedValidated.ok).toBe(true);

    // Existing card ID is preserved (keeps SRS progress) while its note is upgraded with the old habit!
    const mergedBe3Card = Object.values(merged.cards).find((c) => c.u === 'c1e3');
    expect(mergedBe3Card?.n).toContain('You used to play 8.Qd2');
    expect(mergedBe3Card?.n).toContain('Play 8.Be3');

    // Existing line's THE PLAN note and off-edge habit warnings are refreshed!
    expect(merged.lines[0].note).toContain('Fixes your old habit: 8.Qd2');
    const mergedWarns = Object.values(merged.warn);
    expect(mergedWarns.some((w) => w.includes('Old habit') && w.includes('8.Qd2') && w.includes('8.Be3'))).toBe(true);
    expect(mergedWarns.some((w) => w.includes('You used to play 8.Qd2') && w.includes('8.Be3'))).toBe(true);
  });

  it('regenerates the same branch without self-blocking, streams lines live, and refreshes notes on merge', async () => {
    const { moves: prefixMoves, fen: najdorfFen } = buildPrefix(NAJDORF_PREFIX);
    const { evaluateFn, fetchExplorerFn } = makeMocks();

    // First generation (Quick) saved into existing repertoire
    const first = await generateFlawRepertoire({
      prefixMoves,
      startFen: START_FEN,
      fen: najdorfFen,
      color: 'w',
      openingName: 'Sicilian Defense: Najdorf Variation',
      flawedUci: 'f2f3',
      flawedSan: 'f3',
      flawedStats: { total: 8, wins: 2, draws: 1, losses: 5, scorePct: 31 },
      mode: 'repair',
      anchorMove: { uci: 'f2f3', san: 'f3', evLabel: '+0.3', peerScore: 51 },
      presetKey: 'quick',
      sectionName: 'Fix: Sicilian Defense (6.f3 follow-ups)',
      evaluateFn,
      fetchExplorerFn,
    });

    // Clear a card note to simulate an older saved repertoire without rich habit notes
    const firstCardIds = Object.keys(first.repertoire.cards);
    first.repertoire.cards[firstCardIds[firstCardIds.length - 1]].n = 'Old plain note';

    // Second generation on the EXACT SAME branch with deeper preset + 1,000 unrelated games
    const noiseGames = Array.from({ length: 1000 }, (_, i) => ({
      id: `noise_${i}`,
      color: 'w',
      res: 1,
      moves: 'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6',
    }));
    const streamed = [];

    const second = await generateFlawRepertoire({
      prefixMoves,
      startFen: START_FEN,
      fen: najdorfFen,
      color: 'w',
      openingName: 'Sicilian Defense: Najdorf Variation',
      flawedUci: 'f2f3',
      flawedSan: 'f3',
      flawedStats: { total: 8, wins: 2, draws: 1, losses: 5, scorePct: 31 },
      mode: 'repair',
      anchorMove: { uci: 'f2f3', san: 'f3', evLabel: '+0.3', peerScore: 51 },
      presetKey: 'standard',
      sectionName: 'Fix: Sicilian Defense (6.f3 follow-ups)',
      existingRepertoire: first.repertoire,
      personalGames: noiseGames,
      onLineReady: (line) => streamed.push(line),
      evaluateFn,
      fetchExplorerFn,
    });

    // Must NOT stop immediately at move 7 with 'repertoire'
    expect(second.linesPreview.every((ln) => ln.stoppedBy !== 'repertoire')).toBe(true);
    expect(streamed.length).toBe(second.stats.lines);
    // Lines should expand deeper than 1 move after 6.f3
    expect(second.repertoire.lines[0].uci.length).toBeGreaterThan(prefixMoves.length + 4);

    // Merging with refreshNotes: true refreshes existing card notes without losing SRS card IDs
    const merged = mergeRepertoires(first.repertoire, second.repertoire, { refreshNotes: true });
    const mergedValid = parseRepertoireFile(buildExportFile(merged, {}, 'Refreshed', Date.now()));
    expect(mergedValid.ok).toBe(true);
    expect(merged.cards[firstCardIds[firstCardIds.length - 1]].n).not.toBe('Old plain note');
  });
});
