import { describe, it, expect } from 'vitest';
import { normalizeLayout, swapPanels, movePanelToRow, DEFAULT_LAYOUT, PANEL_KEYS } from '../src/ui/layout.js';

const allPanels = (rows) => Object.values(rows).flat().sort();

describe('studio dock layout', () => {
  it('falls back to the default layout for missing or broken data', () => {
    expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(normalizeLayout('nope').rows).toEqual(DEFAULT_LAYOUT.rows);
  });

  it('keeps every panel exactly once and drops unknown or duplicate entries', () => {
    const l = normalizeLayout({ rows: { below: ['sf', 'sf', 'bogus'], r1: ['hub', 'tree'], r2: [], r3: [] } });
    expect(allPanels(l.rows)).toEqual([...PANEL_KEYS].sort());
    expect(l.rows.below).toEqual(['sf']);
    expect(l.rows.r1).toEqual(['hub', 'tree']);
  });

  it('validates sizes and board theme', () => {
    const l = normalizeLayout({ weights: { r1: 2, r2: -1, r3: 'x' }, leftW: 50, boardTheme: 'neon' });
    expect(l.weights).toEqual({ r1: 2, r2: 1, r3: 1 });
    expect(l.leftW).toBeNull();
    expect(l.boardTheme).toBe('slate');
    expect(normalizeLayout({ leftW: 720.4, boardTheme: 'green' })).toMatchObject({ leftW: 720, boardTheme: 'green' });
  });

  it('swaps two panels across rows', () => {
    const rows = swapPanels(DEFAULT_LAYOUT.rows, 'tree', 'sf');
    expect(rows.below).toEqual(['sf']);
    expect(rows.r3).toEqual(['lc0', 'tree']);
    expect(DEFAULT_LAYOUT.rows.below).toEqual(['tree']);
  });

  it('moves a panel into a row with room, and refuses full rows', () => {
    const moved = movePanelToRow(DEFAULT_LAYOUT.rows, 'scout', 'r1');
    expect(moved.r1).toEqual(['hub', 'scout']);
    expect(moved.r2).toEqual(['explorer']);
    const full = { below: ['tree'], r1: ['hub', 'explorer', 'scout'], r2: [], r3: ['lc0', 'sf'] };
    expect(movePanelToRow(full, 'sf', 'r1')).toEqual(full);
  });
});
