import { describe, it, expect } from 'vitest';
import {
  normalizeLayout,
  swapPanels,
  movePanelToRow,
  migrateLegacyLayout,
  DEFAULT_LAYOUT,
  PANEL_KEYS,
} from '../src/ui/layout.js';

const allPanels = (rows) => Object.values(rows).flat().sort();

describe('studio dock layout', () => {
  it('falls back to the default layout for missing or broken data', () => {
    expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(normalizeLayout('nope').rows).toEqual(DEFAULT_LAYOUT.rows);
    expect(DEFAULT_LAYOUT.rows).toEqual({
      below: ['lc0', 'sf'],
      r1: ['hub'],
      r2: ['explorer', 'scout'],
      r3: ['tree'],
    });
  });

  it('keeps every panel exactly once and drops unknown or duplicate entries', () => {
    const l = normalizeLayout({ rows: { below: ['sf', 'sf', 'bogus'], r1: ['hub', 'tree'], r2: [], r3: [] } });
    expect(allPanels(l.rows)).toEqual([...PANEL_KEYS].sort());
    expect(l.rows.below).toEqual(['sf', 'lc0']);
    expect(l.rows.r1).toEqual(['hub', 'tree']);
  });

  it('validates sizes and board theme', () => {
    const l = normalizeLayout({ weights: { r1: 2, r2: -1, r3: 'x' }, leftW: 50, boardTheme: 'neon' });
    expect(l.weights).toEqual({ r1: 2, r2: 1, r3: 0.9 });
    expect(l.leftW).toBeNull();
    expect(l.boardTheme).toBe('slate');
    expect(normalizeLayout({ leftW: 720.4, boardTheme: 'green' })).toMatchObject({ leftW: 720, boardTheme: 'green' });
  });

  it('swaps two panels across rows', () => {
    const rows = swapPanels(DEFAULT_LAYOUT.rows, 'tree', 'sf');
    expect(rows.below).toEqual(['lc0', 'tree']);
    expect(rows.r3).toEqual(['sf']);
    expect(DEFAULT_LAYOUT.rows.below).toEqual(['lc0', 'sf']);
  });

  it('moves a panel into a row with room, and refuses full rows', () => {
    const moved = movePanelToRow(DEFAULT_LAYOUT.rows, 'scout', 'r1');
    expect(moved.r1).toEqual(['hub', 'scout']);
    expect(moved.r2).toEqual(['explorer']);
    const full = { below: ['lc0', 'sf'], r1: ['hub', 'explorer', 'scout'], r2: [], r3: ['tree'] };
    expect(movePanelToRow(full, 'tree', 'r1')).toEqual(full);
  });

  it('migrates untouched v1 layouts to Engine-first while preserving theme and custom rows', () => {
    const untouchedV1 = {
      rows: { below: ['tree'], r1: ['hub'], r2: ['explorer', 'scout'], r3: ['lc0', 'sf'] },
      weights: { r1: 1.25, r2: 1, r3: 1 },
      leftW: 560,
      boardTheme: 'brown',
    };
    const migrated = migrateLegacyLayout(untouchedV1);
    expect(migrated.rows).toEqual(DEFAULT_LAYOUT.rows);
    expect(migrated.boardTheme).toBe('brown');
    expect(migrated.leftW).toBe(560);

    const customV1 = {
      rows: { below: ['explorer'], r1: ['hub'], r2: ['tree', 'scout'], r3: ['lc0', 'sf'] },
      boardTheme: 'green',
    };
    const preserved = migrateLegacyLayout(customV1);
    expect(preserved.rows).toEqual(customV1.rows);
    expect(preserved.boardTheme).toBe('green');
  });
});
