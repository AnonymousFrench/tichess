import { describe, it, expect } from 'vitest';
import {
  cleanPgnComment,
  splitPgnChapters,
  buildRepertoireFromPgn,
  mergeRepertoires,
  extractPathToNode,
  appendBoardLineToRepertoire,
} from '../src/repertoire/pgnImport.js';
import { parseRepertoireFile, buildExportFile } from '../src/repertoire/model.js';
import { createTreeFromPgn } from '../src/chess/tree.js';

const LICHESS_STUDY_PGN = `[Event "My 1.e4 Study: Italian Game"]
[Orientation "white"]
[Result "*"]

1. e4 { [%cal Ge2e4] Best by test } 1... e5 2. Nf3 Nc6 3. Bc4 { Aim at f7 } (3. Bb5 a6 { Ruy Lopez sideline }) 3... Bc5 4. c3 *

[Event "My 1.e4 Study: Sicilian Defense"]
[Orientation "white"]
[Result "*"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 *`;

describe('Repertoire PGN / Lichess Study import & editing', () => {
  it('strips engine/arrow annotations from PGN comments while preserving notes', () => {
    expect(cleanPgnComment(' [%cal Ge2e4] [%csl Rd5]  Control   the center  ')).toBe(
      'Control the center'
    );
  });

  it('splits multi-chapter Lichess Study PGN and builds a valid tichess-repertoire', () => {
    const chapters = splitPgnChapters(LICHESS_STUDY_PGN);
    expect(chapters).toHaveLength(2);

    const built = buildRepertoireFromPgn(LICHESS_STUDY_PGN, { color: 'w' });
    expect(built.ok).toBe(true);
    expect(built.name).toBe('My 1.e4 Study');
    expect(built.stats.sections).toBe(2);
    expect(built.stats.lines).toBe(3); // Italian main + Ruy Lopez RAV + Sicilian main

    // Must pass strict parseRepertoireFile validation when serialized
    const serialized = buildExportFile(built.repertoire, {}, built.name, Date.now());
    const validated = parseRepertoireFile(serialized);
    expect(validated.ok).toBe(true);

    // Notes should be preserved on the card for 1.e4
    const e4Card = Object.values(built.repertoire.cards).find((c) => c.u === 'e2e4');
    expect(e4Card?.n).toBe('Best by test');
  });

  it('merges a Black PGN repertoire into a White repertoire without clobbering cards or validity', () => {
    const white = buildRepertoireFromPgn('1. e4 e5 2. Nf3 Nc6 *', {
      color: 'w',
      sectionName: 'Italian',
    });
    const black = buildRepertoireFromPgn('1. e4 c5 2. Nf3 d6 *', {
      color: 'b',
      sectionName: 'Sicilian Najdorf',
    });
    expect(white.ok && black.ok).toBe(true);

    const whiteCardIds = Object.keys(white.repertoire.cards);
    const merged = mergeRepertoires(white.repertoire, black.repertoire);

    expect(merged.secs).toHaveLength(2);
    expect(merged.lines).toHaveLength(2);
    for (const id of whiteCardIds) {
      expect(merged.cards[id]).toBeDefined();
    }

    const validated = parseRepertoireFile(buildExportFile(merged, {}, 'Merged', Date.now()));
    expect(validated.ok).toBe(true);
  });

  it('appends a line played on the main analysis board and validates cleanly', () => {
    const { current } = createTreeFromPgn('1. d4 d5 2. c4 e6');
    current.comment = 'Queen Gambit Declined';
    const path = extractPathToNode(current);
    expect(path.moves).toHaveLength(4);

    const res = appendBoardLineToRepertoire(null, {
      ...path,
      color: 'w',
      sectionName: 'QGD',
      lineName: 'Main',
      note: 'Classic center fight',
    });
    expect(res.ok).toBe(true);
    const validated = parseRepertoireFile(buildExportFile(res.repertoire, {}, 'Custom', Date.now()));
    expect(validated.ok).toBe(true);
    expect(res.repertoire.lines[0].san).toEqual(['d4', 'd5', 'c4', 'e6']);
  });
});
