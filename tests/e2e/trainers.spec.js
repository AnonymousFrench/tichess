import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { Chess } from 'chess.js';

// Volatile pseudo-random games (fixed seed) so the scan finds blunders and thrown wins.
function buildPgn() {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const out = [];
  for (let g = 0; g < 6; g++) {
    const c = new Chess();
    for (let i = 0; i < 70 && !c.isGameOver(); i++) {
      const ms = c.moves({ verbose: true });
      const caps = ms.filter((m) => m.captured);
      c.move(caps.length && rnd() < 0.5 ? caps[Math.floor(rnd() * caps.length)] : ms[Math.floor(rnd() * ms.length)]);
    }
    const meWhite = g % 2 === 0;
    const res = g < 4 ? (meWhite ? '0-1' : '1-0') : '1/2-1/2';
    const headers = { Event: 'Rated blitz game', Site: `https://lichess.org/abcdefg${g}`, Date: `2026.11.2${g}`, Round: '-',
      White: meWhite ? 'Tibous' : `Opp${g}`, Black: meWhite ? `Opp${g}` : 'Tibous', Result: res, WhiteElo: '2050', BlackElo: '2040', TimeControl: '180+0' };
    const tags = Object.entries(headers).map(([k, v]) => `[${k} "${v}"]`).join('\n');
    const moves = c.history().map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${m}` : m)).join(' ');
    out.push(`${tags}\n\n${moves} ${res}`);
  }
  return out.join('\n\n') + '\n';
}

async function clickAnyLegalMove(page) {
  // Try own pieces until a destination marker appears, then click it.
  const squares = page.locator('[data-act="trn-sq"]');
  const n = await squares.count();
  for (let i = 0; i < n; i++) {
    const sq = squares.nth(i);
    if (!(await sq.locator('img').count())) continue;
    await sq.click();
    const dest = page.locator('[data-act="trn-sq"]:has(span.rounded-full)');
    if (await dest.count()) {
      await dest.first().click();
      return true;
    }
  }
  return false;
}

test('trainers: today, mistakes, blunder check, convert', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const PGN = testInfo.outputPath('games.pgn');
  fs.writeFileSync(PGN, buildPgn());
  const SHOT = process.env.TRAIN_SHOTS || '';
  const shot = (name) => (SHOT ? page.screenshot({ path: `${SHOT}/${name}.png`, fullPage: true }) : Promise.resolve());
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://lichess.org/**', (r) => r.abort());
  await page.route('https://explorer.lichess.org/**', (r) => r.abort());
  await page.goto('/insights.html');
  await page.locator('#pgnInput').setInputFiles(PGN);
  await page.locator('form[data-act="pgn-owner"] button:not([type="button"])').click();
  await page.locator('[data-act="tab"][data-v="coach"]').first().click();
  // Scan with Stockfish
  await page.locator('[data-act="coach-scan"]').click();
  await expect(page.locator('[data-act="coach-scan-stop"]')).toHaveCount(0, { timeout: 180_000 });

  // Today
  await page.locator('[data-act="coach-sub"][data-v="today"]').click();
  await expect(page.getByText('Mistake drills')).toBeVisible();
  await shot('today');

  // Mistakes
  await page.locator('[data-act="today-go"][data-v="mistakes"]').click();
  await expect(page.getByText('Find the best move')).toBeVisible({ timeout: 30_000 });
  await shot('mistakes');
  await page.locator('[data-act="trn-reveal"]').click();
  await expect(page.getByText(/^Best: /)).toBeVisible({ timeout: 30_000 });

  // Blunder check
  await page.locator('[data-act="trn-mode"][data-v="blunder"]').click();
  const hasBlunder = await page.getByText(/their strongest reply\?/).waitFor({ timeout: 30_000 }).then(() => true, () => false);
  if (hasBlunder) {
    await shot('blunder1');
    await page.locator('[data-act="trn-reveal"]').click();
    await expect(page.getByText("Now find a move that doesn't allow it.")).toBeVisible({ timeout: 30_000 });
    await shot('blunder2');
    expect(await clickAnyLegalMove(page)).toBe(true);
    await expect(page.locator('text=/is safe|game move|gives up/')).toBeVisible({ timeout: 30_000 });
  }

  // Convert
  await page.locator('[data-act="trn-mode"][data-v="convert"]').click();
  const hasConvert = await page.getByText(/Convert it against Maia 2/).waitFor({ timeout: 30_000 }).then(() => true, () => false);
  if (hasConvert) {
    await expect(page.locator('[data-act="trn-hint"]')).toBeVisible({ timeout: 120_000 });
    await shot('convert1');
    expect(await clickAnyLegalMove(page)).toBe(true);
    await expect(page.locator('text=/They played|slip|Converted|Drawn|held/')).toBeVisible({ timeout: 120_000 });
    await shot('convert2');
  }
  // The fixed-seed games always produce both kinds of cards.
  expect(hasBlunder).toBe(true);
  expect(hasConvert).toBe(true);
  expect(errors).toEqual([]);
});
