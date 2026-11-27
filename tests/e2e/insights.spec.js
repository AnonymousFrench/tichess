import { test, expect } from '@playwright/test';

// A small, deterministic Lichess account served in place of the real API.
const LINES = [
  { moves: 'e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Be7', eco: 'C55', name: 'Italian Game: Two Knights Defense', ply: 6, win: 0.6 },
  { moves: 'e4 e6 d4 d5 e5 c5 c3 Nc6', eco: 'C02', name: 'French Defense: Advance Variation', ply: 5, win: 0.2 },
  { moves: 'd4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4', eco: 'D15', name: 'Slav Defense: Three Knights Variation', ply: 6, win: 0.5 },
];

function makeGames(n = 240) {
  const now = Date.now();
  const games = [];
  for (let i = 0; i < n; i++) {
    const line = LINES[i % LINES.length];
    const color = line.moves.startsWith('d4') ? 'black' : 'white';
    const win = (i * 37) % 100 < line.win * 100;
    const me = { user: { name: 'Tester', id: 'tester' }, rating: 1800 + (i % 40) };
    const them = { user: { name: `opp${i % 17}`, id: `opp${i % 17}` }, rating: 1790 + ((i * 7) % 60) };
    games.push({
      id: `t${String(i).padStart(6, '0')}`,
      rated: true,
      variant: 'standard',
      speed: i % 4 === 0 ? 'bullet' : 'blitz',
      perf: i % 4 === 0 ? 'bullet' : 'blitz',
      createdAt: now - i * 3_600_000 * 5,
      status: 'resign',
      winner: win ? color : color === 'white' ? 'black' : 'white',
      players: color === 'white' ? { white: me, black: them } : { white: them, black: me },
      opening: { eco: line.eco, name: line.name, ply: line.ply },
      moves: line.moves,
      clock: { initial: 180, increment: 0, totalTime: 180 },
    });
  }
  return games;
}

const GAMES = makeGames();

async function mockLichess(context) {
  await context.route(/lichess\.(org|ovh)|chess\.com/, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.toLowerCase() === '/api/user/tester') {
      return route.fulfill({ json: { username: 'Tester', count: { all: GAMES.length }, perfs: { blitz: { rating: 1840, games: 180 } } } });
    }
    if (url.pathname.startsWith('/api/games/user/')) {
      const since = Number(url.searchParams.get('since') || 0);
      const until = Number(url.searchParams.get('until') || Infinity);
      const rows = GAMES.filter((g) => g.createdAt >= since && g.createdAt <= until);
      // No trailing newline: the last game must still be read.
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/x-ndjson' }, body: rows.map((g) => JSON.stringify(g)).join('\n') });
    }
    return route.fulfill({ status: 404, body: '' });
  });
}

test('Insights downloads a Lichess account, explains it, and hands positions to the Studio', async ({ page, context }) => {
  await mockLichess(context);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/insights.html');
  await page.fill('input[name=name]', 'Tester');
  await page.click('form[data-act=add-account-form] button');
  await expect(page.locator('#hdrRight')).toContainText('Updated', { timeout: 20_000 });

  // Overview: all games counted and the weak opening is called out.
  await expect(page.locator('#view')).toContainText('240');
  await expect(page.locator('[data-act=takeaway]').first()).toBeVisible();
  await expect(page.locator('#view')).toContainText('French Defense is costing you points as White');

  // Every tab renders.
  for (const tab of ['openings', 'games', 'opponents', 'progress', 'overview']) {
    await page.click(`#toolbar [data-act=tab][data-v=${tab}]`);
    await expect(page.locator('#view')).not.toBeEmpty();
  }

  // A finding leads straight to the games behind it.
  const french = page.locator('[data-act=takeaway-games]').first();
  await french.click();
  await expect(page.locator('#toolbar [aria-current=page]')).toHaveText('Games');
  await expect(page.locator('[data-act=games-clear]')).toHaveCount(1);
  await expect(page.locator('#view')).toContainText('80 games');
  await page.click('[data-act=games-clear]');

  // Filters narrow the data.
  await page.click('#toolbar [data-act=set-filter][data-k=tc][data-v=bullet]');
  await expect(page.locator('#view')).toContainText('60 games');
  await page.click('#btnMoreFilters');
  await page.selectOption('#flt-rated', 'casual');
  await expect(page.locator('#btnMoreFilters')).toContainText('1');
  await expect(page.locator('#view')).toContainText('No games match');
  await page.keyboard.press('Escape');
  await page.click('[data-act=clear-filters]');

  // Openings: pick an opening, walk its moves (including tap-to-move on the board and back/forward/last/flip), and open in Studio.
  await page.click('#toolbar [data-act=tab][data-v=openings]');
  await page.click('[data-act=op-pick] >> nth=0');
  await page.click('[data-act=ex-goto][data-i="0"] >> nth=0');
  // Interactive tap-to-move directly on the Insights Openings board: play 1.e4
  await page.click('[data-act=ex-sq][data-sq="e2"]');
  await page.click('[data-act=ex-sq][data-sq="e4"]');
  await expect(page.locator('[data-act=ex-goto]')).toContainText(['Start', '1.e4']);
  await page.click('[data-act=ex-back]');
  await expect(page.locator('[data-act=ex-fwd]')).toBeEnabled();
  await page.click('[data-act=ex-fwd]');
  await expect(page.locator('[data-act=ex-goto]')).toContainText(['Start', '1.e4']);
  await page.click('[data-act=ex-goto][data-i="0"] >> nth=0');
  await page.click('[data-act=ex-last]');
  await expect(page.locator('[data-act=ex-back]')).toBeEnabled();
  await page.click('[data-act=ex-goto][data-i="1"]');
  await page.click('[data-act=ex-flip]');
  await page.click('[data-act=ex-flip]');
  const [studio] = await Promise.all([context.waitForEvent('page'), page.click('[data-act=ex-studio]')]);
  await studio.waitForLoadState('load');
  await expect(studio.locator('#variationTreeContainer')).toContainText('e4');

  // The Studio's "Mine" explorer reads the same downloaded games.
  await expect(studio.locator('#refSrcMine')).toBeVisible();
  await studio.click('#refSrcMine');
  await studio.click('.ref-pcol-btn[data-pcol=white]');
  await expect(studio.locator('#refTotalGames')).toContainText('160 games');

  // Mobile Insights header has zero nav overlap and Openings board pins cleanly while scrolling.
  await page.setViewportSize({ width: 390, height: 700 });
  const mobileIns = await page.evaluate(() => {
    const nav = document.querySelector('header [data-app-nav]').getBoundingClientRect();
    const right = document.getElementById('hdrRight').getBoundingClientRect();
    return { navRight: Math.round(nav.right), rightLeft: Math.round(right.left) };
  });
  expect(mobileIns.navRight).toBeLessThanOrEqual(mobileIns.rightLeft + 1);
  await expect(page.locator('[data-act=ex-pin]')).toBeVisible();
  await expect(page.locator('[data-act=ex-pin]')).toHaveAttribute('aria-pressed', 'true');

  expect(errors).toEqual([]);
});

test('Studio panels can be swapped, resized and arranged with presets', async ({ page, context }) => {
  await mockLichess(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const board = page.locator('#chessboard');
  await expect(board).toBeVisible();

  // Board column splitter resizes the board.
  const before = (await board.boundingBox()).width;
  const sp = await page.locator('#colSplitter').boundingBox();
  await page.mouse.move(sp.x + 4, sp.y + 200);
  await page.mouse.down();
  await page.mouse.move(sp.x - 200, sp.y + 200, { steps: 5 });
  await page.mouse.up();
  expect((await board.boundingBox()).width).toBeLessThan(before - 100);
  await page.keyboard.press('=');
  expect(Math.abs((await board.boundingBox()).width - before)).toBeLessThan(12);

  // Default order: Engine sits below the board, Live/Master Hub in r1, Explorer/Scout in r2, Variation Tree in r3.
  const rowOf = (id) => page.locator(`#${id}`).evaluate((el) => el.parentElement.dataset.row);
  expect(await rowOf('panel-sf')).toBe('below');
  expect(await rowOf('panel-hub')).toBe('r1');
  expect(await rowOf('panel-tree')).toBe('r3');

  // Board controls sit on a single row: icon-only Flip + export dropdown (FEN / PGN / Share).
  const navY = (await page.locator('#btnFirst').boundingBox()).y;
  const flipBox = await page.locator('#btnFlip').boundingBox();
  const exportBox = await page.locator('#btnBoardExport').boundingBox();
  expect(Math.abs(flipBox.y - navY)).toBeLessThan(4);
  expect(Math.abs(exportBox.y - navY)).toBeLessThan(4);
  expect((await page.locator('#btnFlip').textContent()).trim()).toBe('');
  await page.click('#btnBoardExport');
  await expect(page.locator('#menu-board-export')).toBeVisible();
  await expect(page.locator('#btnCopyFen')).toBeVisible();
  await expect(page.locator('#btnCopyPgn')).toBeVisible();
  await expect(page.locator('#btnShareLink')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu-board-export')).toBeHidden();

  // Drag Stockfish onto the explorer to swap them; the layout survives a reload.
  await page.dragAndDrop('[data-grip="sf"]', '#panel-explorer');
  expect(await rowOf('panel-sf')).toBe('r2');
  expect(await rowOf('panel-explorer')).toBe('below');
  await page.reload();
  expect(await rowOf('panel-sf')).toBe('r2');

  // Focus preset leaves only the board and notation, with a bigger board.
  await page.click('#btnPanelsMenu');
  await page.click('[data-preset="focus"]');
  await expect(page.locator('#rightWorkspaceCol')).toBeHidden();
  await expect(page.locator('#panel-tree')).toBeVisible();

  // Prep preset restores everything.
  await page.click('#btnPanelsMenu');
  await page.click('[data-preset="prep"]');
  await expect(page.locator('#panel-hub')).toBeVisible();
  await expect(page.locator('#panel-explorer')).toBeVisible();

  // Engine shows the chosen number of lines.
  await page.selectOption('#sfLinesSelect', '1');
  await expect.poll(() => page.locator('#sfLinesList > *').count(), { timeout: 20_000 }).toBe(1);
});
