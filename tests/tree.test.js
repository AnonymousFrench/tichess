import { describe, it, expect } from 'vitest';
import {
  createTreeFromPgn,
  extractClocksFromPgn,
  exportTreeToPgn,
  mergeMainline,
  createNode,
} from '../src/chess/tree.js';

describe('Variation tree, PGN, clocks, and live mainline merge', () => {
  it('extracts [%clk] comments accurately even with spaces and black move ellipsis', () => {
    const pgn = `[Event "Test"]
[White "A"]
[Black "B"]
[Result "*"]

1. e4 { [%clk 1:59:49] } 1... e5 { [%clk 1:59:30] } 2. Nf3 { [%clk 1:58:10] } *`;
    expect(extractClocksFromPgn(pgn)).toEqual(['1:59:49', '1:59:30', '1:58:10']);
  });

  it('round-trips PGN moves and captures ECO/Opening headers', () => {
    const pgn = `[Event "WCC"]
[White "Gukesh"]
[Black "Sindarov"]
[ECO "C65"]
[Opening "Ruy Lopez: Berlin Defense"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6 *`;
    const { root, current, meta } = createTreeFromPgn(pgn);
    expect(current.san).toBe('Nf6');
    expect(meta.eco).toBe('C65');
    expect(meta.opening).toBe('Ruy Lopez: Berlin Defense');

    const exported = exportTreeToPgn({ root, meta });
    expect(exported).toContain('1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6');
  });

  it('handles invalid FEN headers safely without throwing', () => {
    const badPgn = `[Event "Broken"]
[SetUp "1"]
[FEN "not-a-valid-fen-at-all"]

1. e4 *`;
    const res = createTreeFromPgn(badPgn);
    expect(res.root).toBeTruthy();
    expect(res.root.children).toEqual([]);
  });

  it('mergeMainline appends new plies while preserving user variations', () => {
    const pgn1 = '1. e4 { [%clk 1:59:00] } 1... e5 { [%clk 1:58:00] } *';
    const { root } = createTreeFromPgn(pgn1);

    // User adds a sideline 2. d4 after 1...e5
    const afterE5 = root.children[0].children[0];
    const userSide = createNode({
      parent: afterE5,
      san: 'd4',
      uci: 'd2d4',
      from: 'd2',
      to: 'd4',
      color: 'w',
      moveNum: 2,
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2',
    });
    afterE5.children.push(userSide);

    // Broadcast updates with 2 new plies: 2. Nf3 Nc6
    const pgn2 =
      '1. e4 { [%clk 1:59:00] } 1... e5 { [%clk 1:58:00] } 2. Nf3 { [%clk 1:57:30] } 2... Nc6 { [%clk 1:57:00] } *';
    const { root: freshRoot } = createTreeFromPgn(pgn2);

    const { added, lastNode } = mergeMainline(root, freshRoot);
    expect(added).toBe(2);
    expect(lastNode.san).toBe('Nc6');
    // Mainline is now Nf3 (index 0) and user sideline d4 is preserved (index 1)
    expect(afterE5.children.map((c) => c.san)).toEqual(['Nf3', 'd4']);
  });

  it('mergeMainline returns added === 0 for identical PGN', () => {
    const pgn = '1. e4 e5 2. Nf3 Nc6 *';
    const a = createTreeFromPgn(pgn);
    const b = createTreeFromPgn(pgn);
    const res = mergeMainline(a.root, b.root);
    expect(res.added).toBe(0);
    expect(res.clockChanged).toBe(false);
  });

  it('mergeMainline demotes prior mainline to variation on broadcast correction', () => {
    const a = createTreeFromPgn('1. e4 e5 2. Bc4 *');
    const b = createTreeFromPgn('1. e4 e5 2. Nf3 Nc6 *');
    const afterE5 = a.root.children[0].children[0];
    const res = mergeMainline(a.root, b.root);
    expect(res.added).toBe(2);
    expect(afterE5.children.map((c) => c.san)).toEqual(['Nf3', 'Bc4']);
  });
});
