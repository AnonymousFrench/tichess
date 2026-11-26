import { describe, it, expect } from 'vitest';
import {
  parseUciInfoLine,
  normalizeCastlingUci,
  normalizePv,
  uciPvToSan,
  formatEvalBarLabel,
} from '../src/engines/uci.js';

describe('UCI parsing and castling normalization', () => {
  it('parses cp, multipv, depth, nps, nodes, wdl and pv', () => {
    const parsed = parseUciInfoLine(
      'info depth 18 seldepth 24 multipv 2 score cp -35 wdl 120 640 240 nodes 412345 nps 825000 pv e7e5 g1f3 b8c6'
    );
    expect(parsed).toEqual({
      multipv: 2,
      depth: 18,
      scoreType: 'cp',
      scoreVal: -35,
      nps: 825000,
      nodes: 412345,
      wdl: [120, 640, 240],
      pv: ['e7e5', 'g1f3', 'b8c6'],
    });
  });

  it('parses mate scores without nps or wdl', () => {
    const parsed = parseUciInfoLine('info depth 12 score mate 3 pv d1h5 g7g6 h5e5');
    expect(parsed.scoreType).toBe('mate');
    expect(parsed.scoreVal).toBe(3);
    expect(parsed.nps).toBeNull();
    expect(parsed.wdl).toBeNull();
  });

  it('normalizes king-to-rook castling notation in cloud PVs', () => {
    const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 0 5';
    expect(normalizeCastlingUci(fen, 'e1h1')).toBe('e1g1');
    expect(normalizePv(fen, ['e1h1', 'd7d6'])).toEqual(['e1g1', 'd7d6']);
    expect(uciPvToSan(fen, ['e1h1', 'd7d6'])).toBe('5.O-O d6');
  });

  it('normalizes black kingside and queenside castling too', () => {
    const fen = 'r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R b KQkq - 0 8';
    expect(normalizeCastlingUci(fen, 'e8h8')).toBe('e8g8');
    expect(normalizeCastlingUci(fen, 'e8a8')).toBe('e8c8');
    expect(uciPvToSan(fen, ['e8a8', 'e1h1'])).toBe('8...O-O-O 9.O-O');
  });

  it('does NOT rewrite a non-castling rook move e1h1', () => {
    const fen = '4k3/8/8/8/8/8/8/4R2K w - - 0 1';
    expect(normalizeCastlingUci(fen, 'e1h1')).toBe('e1h1');
    // Rook moving from e1 to g1/f1 or capturing a black rook on h1:
    const fenCapture = '4k3/8/8/8/8/8/8/3KR2r w - - 0 1';
    expect(normalizeCastlingUci(fenCapture, 'e1h1')).toBe('e1h1');
    expect(uciPvToSan(fenCapture, ['e1h1'])).toBe('1.Rxh1');
  });

  it('formats eval bar labels cleanly without clipping', () => {
    expect(formatEvalBarLabel('+0.19', 19)).toBe('0.2');
    expect(formatEvalBarLabel('-1.45', -145)).toBe('1.4');
    expect(formatEvalBarLabel('+12.40', 1240)).toBe('12');
    expect(formatEvalBarLabel('+M8', 9999)).toBe('M8');
    expect(formatEvalBarLabel('-M3', -9999)).toBe('M3');
    expect(formatEvalBarLabel('—', 0)).toBe('0.0');
  });
});
