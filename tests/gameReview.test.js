import { describe, it, expect } from 'vitest';
import {
  cpToWinPercent,
  moveAccuracyFromWinDrop,
  classifyReviewedMove,
  collectMainlineNodes,
  summarizeGameReview,
  buildEvalGraphSvg,
  formatReviewScore,
} from '../src/engines/gameReview.js';
import { createTreeFromPgn } from '../src/chess/tree.js';

describe('Game Review calculations and graph rendering', () => {
  it('converts centipawns and mates to White winning chances symmetrically', () => {
    expect(cpToWinPercent(0)).toBeCloseTo(50, 3);
    expect(cpToWinPercent(300)).toBeGreaterThan(70);
    expect(cpToWinPercent(-300)).toBeCloseTo(100 - cpToWinPercent(300), 3);
    expect(cpToWinPercent(10000, 3)).toBe(100);
    expect(cpToWinPercent(-10000, -2)).toBe(0);
  });

  it('classifies best, inaccuracy, mistake, and blunder accurately for both sides', () => {
    // Exact best move -> best, 100% accuracy
    const best = classifyReviewedMove(
      { whiteCp: 40, mate: null, bestUci: 'e2e4' },
      { whiteCp: 20, mate: null },
      'w',
      'e2e4'
    );
    expect(best.kind).toBe('best');
    expect(best.nag).toBe('');

    // White drops from +200 to -300 -> Blunder
    const wBlunder = classifyReviewedMove(
      { whiteCp: 200, mate: null, bestUci: 'd2d4' },
      { whiteCp: -300, mate: null },
      'w',
      'a2a3'
    );
    expect(wBlunder.kind).toBe('blunder');
    expect(wBlunder.nag).toBe('??');
    expect(wBlunder.cpLoss).toBe(500);
    expect(wBlunder.accuracy).toBeLessThan(20);

    // Black drops from equal (0) to +180 for White -> Mistake
    const bMistake = classifyReviewedMove(
      { whiteCp: 0, mate: null, bestUci: 'e7e5' },
      { whiteCp: 180, mate: null },
      'b',
      'h7h6'
    );
    expect(bMistake.kind).toBe('mistake');
    expect(bMistake.nag).toBe('?');
    expect(bMistake.cpLoss).toBe(180);

    expect(moveAccuracyFromWinDrop(0)).toBe(100);
    expect(moveAccuracyFromWinDrop(30)).toBeLessThan(30);
  });

  it('collects mainline nodes, summarizes both sides, and builds interactive SVG eval graph', () => {
    const { root } = createTreeFromPgn('1. f3 e5 2. g4 Qh4#');
    const nodes = collectMainlineNodes(root);
    expect(nodes).toHaveLength(5);

    const rawPoints = [
      { nodeId: nodes[0].id, ply: 0, moveNum: 0, color: '', san: '', uci: '', fen: nodes[0].fen, whiteCp: 20, mate: null, bestUci: 'e2e4', bestSan: 'e4', depth: 12 },
      { nodeId: nodes[1].id, ply: 1, moveNum: 1, color: 'w', san: 'f3', uci: 'f2f3', fen: nodes[1].fen, whiteCp: -80, mate: null, bestUci: 'e7e5', bestSan: 'e5', depth: 12 },
      { nodeId: nodes[2].id, ply: 2, moveNum: 1, color: 'b', san: 'e5', uci: 'e7e5', fen: nodes[2].fen, whiteCp: -85, mate: null, bestUci: 'e2e4', bestSan: 'e4', depth: 12 },
      { nodeId: nodes[3].id, ply: 3, moveNum: 2, color: 'w', san: 'g4', uci: 'g2g4', fen: nodes[3].fen, whiteCp: -10000, mate: -1, bestUci: 'd8h4', bestSan: 'Qh4#', depth: 12 },
      { nodeId: nodes[4].id, ply: 4, moveNum: 2, color: 'b', san: 'Qh4#', uci: 'd8h4', fen: nodes[4].fen, whiteCp: -10000, mate: 0, bestUci: '', bestSan: '', depth: 0 },
    ];

    const summary = summarizeGameReview(rawPoints);
    expect(summary.white.moveCount).toBe(2);
    expect(summary.white.blunders).toBe(1);
    expect(summary.black.moveCount).toBe(2);
    expect(summary.black.blunders).toBe(0);
    expect(summary.black.accuracy).toBeGreaterThan(95);
    expect(summary.points[3].nag).toBe('??');
    expect(summary.points[3].bestBeforeSan).toBe('e4');

    const svg = buildEvalGraphSvg(summary.points, nodes[3].id);
    expect(svg).toContain('<svg');
    expect(svg).toContain(`data-nid="${nodes[3].id}"`);
    expect(svg).toContain('2. g4?? (-M1) · Best: e4');
    expect(formatReviewScore(-10000, -1)).toBe('-M1');
    expect(formatReviewScore(145, null)).toBe('+1.45');
  });
});
