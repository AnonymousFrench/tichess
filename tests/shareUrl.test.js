import { describe, it, expect } from 'vitest';
import { createTreeFromPgn, createNode } from '../src/chess/tree.js';
import { encodeShareHash, decodeShareHash } from '../src/chess/shareUrl.js';

describe('Shareable analysis URL encoding/decoding', () => {
  it('round-trips mainline, sidelines, comments, NAGs, flip state, and exact current node', () => {
    const { root } = createTreeFromPgn('1. e4 e5 2. Nf3 Nc6 3. Bb5 *');
    const afterE5 = root.children[0].children[0];
    afterE5.comment = 'Classical reply';
    afterE5.nags = ['!'];

    // Add a sideline 2. d4 exd4
    const d4 = createNode({
      parent: afterE5,
      san: 'd4',
      uci: 'd2d4',
      from: 'd2',
      to: 'd4',
      color: 'w',
      moveNum: 2,
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2',
      comment: 'Center Game',
      nags: ['?!'],
    });
    afterE5.children.push(d4);

    const hash = encodeShareHash(
      { title: 'Ruy Lopez Prep', root, current: d4 },
      { flipped: true }
    );
    expect(hash.startsWith('#a=')).toBe(true);

    const decoded = decodeShareHash(hash);
    expect(decoded).not.toBeNull();
    expect(decoded.title).toBe('Ruy Lopez Prep');
    expect(decoded.flipped).toBe(true);
    expect(decoded.current.san).toBe('d4');
    expect(decoded.current.comment).toBe('Center Game');
    expect(decoded.current.nags).toEqual(['?!']);

    const decAfterE5 = decoded.root.children[0].children[0];
    expect(decAfterE5.comment).toBe('Classical reply');
    expect(decAfterE5.nags).toEqual(['!']);
    expect(decAfterE5.children.map((c) => c.san)).toEqual(['Nf3', 'd4']);
  });

  it('preserves a custom starting FEN', () => {
    const customFen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 0 5';
    const { root, current } = createTreeFromPgn(customFen);
    const hash = encodeShareHash({ title: 'Italian Position', root, current });
    const decoded = decodeShareHash(hash);
    expect(decoded.root.fen).toBe(customFen);
    expect(decoded.current).toBe(decoded.root);
  });

  it('returns null cleanly on empty or malformed hashes', () => {
    expect(decodeShareHash('')).toBeNull();
    expect(decodeShareHash('#other=123')).toBeNull();
    expect(decodeShareHash('#a=!!!not-base64!!!')).toBeNull();
    expect(decodeShareHash('#a=e30')).toBeNull();
  });
});
