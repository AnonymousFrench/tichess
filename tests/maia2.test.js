import { describe, it, expect } from 'vitest';
import {
  MAIA2_MOVES,
  MAIA2_MOVE_TO_IDX,
  eloToMaia2Category,
  mirrorUci,
  mirrorFenForMaia2,
  fenToMaia2Tensor,
  decodeMaia2Policy,
  decodeMaia2WhiteExpectedScore,
  gradeMaiaCandidates,
} from '../src/engines/maia2Math.js';

describe('Maia-2 move vocabulary, Elo buckets, mirroring, and tensor encoding', () => {
  it('generates the exact 1,880-move canonical vocabulary matching CSSLab/maia2', () => {
    expect(MAIA2_MOVES).toHaveLength(1880);
    expect(MAIA2_MOVES[0]).toBe('a1h8');
    expect(MAIA2_MOVES[1]).toBe('a1a8');
    expect(MAIA2_MOVE_TO_IDX.get('e2e4')).toBeTypeOf('number');
    expect(MAIA2_MOVE_TO_IDX.get('a7a8q')).toBe(1792);
    expect(MAIA2_MOVE_TO_IDX.get('h7g8n')).toBe(1879);
  });

  it('buckets Elo ratings into Maia-2 categories 0..10', () => {
    expect(eloToMaia2Category(900)).toBe(0);
    expect(eloToMaia2Category(1099)).toBe(0);
    expect(eloToMaia2Category(1100)).toBe(1);
    expect(eloToMaia2Category(1199)).toBe(1);
    expect(eloToMaia2Category(1500)).toBe(5);
    expect(eloToMaia2Category(1999)).toBe(9);
    expect(eloToMaia2Category(2000)).toBe(10);
    expect(eloToMaia2Category(2200)).toBe(10);
  });

  it('mirrors Black-to-move FENs and UCI moves accurately', () => {
    expect(mirrorUci('e7e5')).toBe('e2e4');
    expect(mirrorUci('a2a1q')).toBe('a7a8q');

    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    expect(mirrorFenForMaia2(fen)).toBe(
      'rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq e6 0 1'
    );
  });

  it('encodes FEN piece placement, turn, castling, and en passant into [18, 8, 8] tensor', () => {
    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const t = fenToMaia2Tensor(startFen);
    expect(t).toHaveLength(18 * 64);
    // White pawn on e2 (rank 1, file 4 -> idx 0*64 + 1*8 + 4 = 12)
    expect(t[0 * 64 + 1 * 8 + 4]).toBe(1);
    // Black king on e8 (channel 11, rank 7, file 4)
    expect(t[11 * 64 + 7 * 8 + 4]).toBe(1);
    // Turn channel (12) = 1.0 for White
    expect(t[12 * 64]).toBe(1);
    // Castling channels 13..16 all active
    expect(t[13 * 64]).toBe(1);
    expect(t[16 * 64]).toBe(1);
    // En passant channel empty
    expect(t[17 * 64 + 2 * 8 + 4]).toBe(0);
  });

  it('decodes legal policy logits with softmax and un-mirrors Black moves', () => {
    const logits = new Float32Array(1880).fill(-5);
    logits[MAIA2_MOVE_TO_IDX.get('e2e4')] = 3.0; // mirrors to e7e5 when Black
    logits[MAIA2_MOVE_TO_IDX.get('c2c4')] = 1.0; // mirrors to c7c5 when Black
    const ranked = decodeMaia2Policy(
      logits,
      [
        { uci: 'e7e5', san: 'e5' },
        { uci: 'c7c5', san: 'c5' },
      ],
      true
    );
    expect(ranked[0].uci).toBe('e7e5');
    expect(ranked[0].prob).toBeGreaterThan(0.85);
    expect(ranked[0].prob + ranked[1].prob).toBeCloseTo(1, 5);
  });

  it('clamps Maia-2 expected score when a side has only a bare king', () => {
    // K+b5 vs bare Black king: White can win or draw, Black CANNOT win (whiteExp must be >= 0.5)
    const kpVsK = '8/8/1k6/1P1K4/8/8/8/8 w - - 0 85';
    const clamped = decodeMaia2WhiteExpectedScore(-0.4, false, kpVsK);
    expect(clamped.whiteExp).toBe(0.5);
    expect(clamped.materialAdjusted).toBe(true);

    // Dead draw K vs K -> strictly 0.5
    const kVsK = '8/8/1k6/3K4/8/8/8/8 w - - 0 85';
    expect(decodeMaia2WhiteExpectedScore(0.8, false, kVsK).whiteExp).toBe(0.5);
  });

  it('grades Maia-2 candidates against Stockfish evals and computes trap risk', () => {
    const sfMap = new Map([
      ['c1d2', { cpWhite: 400, mate: null, pv: ['c1d2', 'b6c4', 'd2c1'] }],
      ['f7f8', { cpWhite: 20, mate: null, pv: ['f7f8', 'b6d7'] }],
    ]);
    const graded = gradeMaiaCandidates({
      candidates: [
        { uci: 'c1d2', san: 'Bd2', prob: 0.6 },
        { uci: 'f7f8', san: 'Kf8', prob: 0.1 },
      ],
      isBlack: true,
      sfEvalMap: sfMap,
      bestSfUci: 'f7f8',
      bestSfCpWhite: 20,
    });
    expect(graded.candidates[0].grade).toBe('blunder');
    expect(graded.candidates[0].refutation).toEqual(['b6c4', 'd2c1']);
    expect(graded.candidates[1].grade).toBe('best');
    expect(graded.danger.level).toBe('high');
  });
});
