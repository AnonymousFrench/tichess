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

describe('Shareable analysis URL safety limits', () => {
  // Builds a payload whose mainline is `plies` legal knight moves back and forth.
  function shuffleKnightsPayload(plies) {
    const cycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    let tree = [];
    for (let i = plies - 1; i >= 0; i--) {
      tree = [[cycle[i % 4], tree]];
    }
    return tree;
  }
  const toHash = (payload) =>
    '#a=' + btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const countNodes = (n) => n.children.reduce((acc, c) => acc + 1 + countNodes(c), 0);

  it('rejects hashes longer than MAX_SHARE_HASH_LENGTH', async () => {
    const { MAX_SHARE_HASH_LENGTH } = await import('../src/chess/shareUrl.js');
    expect(decodeShareHash('#a=' + 'A'.repeat(MAX_SHARE_HASH_LENGTH + 1))).toBeNull();
  });

  it('caps the rebuilt tree at MAX_SHARE_DEPTH plies', async () => {
    const { MAX_SHARE_DEPTH } = await import('../src/chess/shareUrl.js');
    const decoded = decodeShareHash(toHash([null, shuffleKnightsPayload(MAX_SHARE_DEPTH + 50), [], 0]));
    expect(decoded).not.toBeNull();
    expect(countNodes(decoded.root)).toBe(MAX_SHARE_DEPTH);
  });

  it('caps the rebuilt tree at MAX_SHARE_NODES total moves', async () => {
    const { MAX_SHARE_NODES } = await import('../src/chess/shareUrl.js');
    // 15 legal pawn first moves, each followed by a legal 150-ply knight shuffle:
    // 15 * 151 = 2265 nodes requested, above the cap.
    const first = ['a2a3', 'a2a4', 'b2b3', 'b2b4', 'c2c3', 'c2c4', 'd2d3', 'd2d4',
      'e2e3', 'e2e4', 'f2f4', 'g2g3', 'g2g4', 'h2h3', 'h2h4'];
    const cycle = ['g8f6', 'g1f3', 'f6g8', 'f3g1'];
    const tail = () => {
      let t = [];
      for (let i = 149; i >= 0; i--) t = [[cycle[i % 4], t]];
      return t;
    };
    const tree = first.map((m) => [m, tail()]);
    const decoded = decodeShareHash(toHash([null, tree, [], 0]));
    expect(decoded).not.toBeNull();
    expect(countNodes(decoded.root)).toBe(MAX_SHARE_NODES);
  });
});
