import { describe, it, expect } from 'vitest';
import { Chess } from 'chess.js';
import { normalizeFen } from '../src/state.js';
import { buildRepertoireFromPgn } from '../src/repertoire/pgnImport.js';
import {
  collectRepertoireOpponentFens,
  analyzeOpponentAgainstRepertoire,
} from '../src/repertoire/opponentPrep.js';

function fenAfter(moves) {
  const c = new Chess();
  for (const m of moves) c.move(m);
  return normalizeFen(c.fen());
}

describe('Scout x Repertoire Opponent Prep analyzer', () => {
  it('identifies prepared overlaps, unprepared opponent gaps, coverage %, and drill cards', () => {
    const built = buildRepertoireFromPgn(
      '[Event "Italian"]\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *',
      { color: 'w', sectionName: 'Italian' }
    );
    expect(built.ok).toBe(true);
    const rep = built.repertoire;

    const oppFens = collectRepertoireOpponentFens(rep, 'w');
    expect(oppFens).toContain(fenAfter(['e4']));
    expect(oppFens).toContain(fenAfter(['e4', 'e5', 'Nf3']));

    // Simulate a scouted opponent playing Black:
    // After 1.e4: 3 games of 1...c5 (GAP!), 2 games of 1...e5 (COVERED!)
    // After 1.e4 e5 2.Nf3: 2 games of 2...Nc6 (COVERED!), 1 game of 2...Nf6 (GAP!)
    const scoutPosMap = new Map([
      [
        fenAfter(['e4']),
        [
          { uci: 'c7c5', san: 'c5', res: 'b', pColor: 'black', gid: 'g1' },
          { uci: 'c7c5', san: 'c5', res: 'd', pColor: 'black', gid: 'g2' },
          { uci: 'c7c5', san: 'c5', res: 'w', pColor: 'black', gid: 'g3' },
          { uci: 'e7e5', san: 'e5', res: 'b', pColor: 'black', gid: 'g4' },
          { uci: 'e7e5', san: 'e5', res: 'w', pColor: 'black', gid: 'g5' },
          // Opponent's White games should be ignored when checking our White repertoire
          { uci: 'd7d5', san: 'd5', res: 'w', pColor: 'white', gid: 'g9' },
        ],
      ],
      [
        fenAfter(['e4', 'e5', 'Nf3']),
        [
          { uci: 'b8c6', san: 'Nc6', res: 'd', pColor: 'black', gid: 'g4' },
          { uci: 'b8c6', san: 'Nc6', res: 'w', pColor: 'black', gid: 'g5' },
          { uci: 'g8f6', san: 'Nf6', res: 'b', pColor: 'black', gid: 'g6' },
        ],
      ],
    ]);

    const analysis = analyzeOpponentAgainstRepertoire({
      repertoire: rep,
      scoutPosMap,
      userColor: 'w',
      progress: {},
    });

    // Total opponent decisions = 5 (after 1.e4) + 3 (after 2.Nf3) = 8; covered = 2 + 2 = 4 -> 50%
    expect(analysis.totalOpponentDecisions).toBe(8);
    expect(analysis.coveredDecisions).toBe(4);
    expect(analysis.coveragePct).toBe(50);

    // Gaps sorted by frequency: 1...c5 (3 games) before 2...Nf6 (1 game), and white game ignored
    expect(analysis.gaps).toHaveLength(2);
    expect(analysis.gaps[0].oppSan).toBe('c5');
    expect(analysis.gaps[0].games).toBe(3);
    expect(analysis.gaps[0].oppWins).toBe(1);
    expect(analysis.gaps[0].oppDraws).toBe(1);
    expect(analysis.gaps[0].oppLosses).toBe(1);
    expect(analysis.gaps[0].pgn).toContain('1. e4 c5');
    expect(analysis.gaps[1].oppSan).toBe('Nf6');

    // Overlaps & prioritized drill cards
    expect(analysis.overlaps).toHaveLength(1);
    expect(analysis.overlaps[0].games).toBe(2);
    expect(analysis.drillCardIds.length).toBeGreaterThanOrEqual(3);
  });
});
