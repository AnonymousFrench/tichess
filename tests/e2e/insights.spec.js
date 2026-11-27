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
    const isFrench = line.eco === 'C02';
    const hasServerEval = isFrench && i < 30;
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
      ...(hasServerEval
        ? {
            clocks: [17900, 17900, 17700, 17600, 17500, 17400, 17300, 17100],
            analysis: [
              { eval: 25 },
              { eval: 20 },
              { eval: 30 },
              { eval: 25 },
              { eval: 320 },
              { eval: 310 },
              { eval: -260, best: 'g1f3' },
              { eval: -250 },
            ],
          }
        : {}),
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

  // Every tab renders, including Coach (+100 Elo plan, Diagnostics, Benchmark & Drills).
  for (const tab of ['coach', 'openings', 'games', 'opponents', 'progress', 'overview']) {
    await page.click(`#toolbar [data-act=tab][data-v=${tab}]`);
    await expect(page.locator('#view')).not.toBeEmpty();
  }

  // Coach: Plan, Diagnostics (ingested from Lichess evals+clocks), and playable Blunder Drill.
  await page.click('#toolbar [data-act=tab][data-v=coach]');
  await expect(page.locator('#view')).toContainText('Where your +100 Elo comes from');
  await page.click('[data-act=coach-sub][data-v=diagnostics]');
  await expect(page.locator('#view')).toContainText('Accuracy by phase');
  await expect(page.locator('#view')).toContainText('Conversion & resilience');
  await page.click('[data-act=coach-sub][data-v=drills]');
  await expect(page.locator('#view')).toContainText('Drill your mistakes');
  // Solve the blunder puzzle by clicking g1 -> f3 (best move for 4.c3?? in the mocked French games).
  await page.click('[data-act=drill-sq][data-sq=g1]');
  await page.click('[data-act=drill-sq][data-sq=f3]');
  await expect(page.locator('#view')).toContainText('✓ Nf3');
  await page.click('#toolbar [data-act=tab][data-v=overview]');

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

  // Mobile Insights header has zero nav overlap, zero horizontal sliders, and Openings board pins cleanly.
  await page.setViewportSize({ width: 390, height: 700 });
  const mobileIns = await page.evaluate(() => {
    const nav = document.querySelector('header [data-app-nav]').getBoundingClientRect();
    const right = document.getElementById('hdrRight').getBoundingClientRect();
    const tbNav = document.querySelector('#toolbar nav');
    const fltRow = document.getElementById('insFiltersRow');
    return {
      navRight: Math.round(nav.right),
      rightLeft: Math.round(right.left),
      tbNavOverflow: tbNav.scrollWidth - tbNav.clientWidth,
      fltRowOverflow: fltRow.scrollWidth - fltRow.clientWidth,
    };
  });
  expect(mobileIns.navRight).toBeLessThanOrEqual(mobileIns.rightLeft + 1);
  expect(mobileIns.tbNavOverflow).toBeLessThanOrEqual(1);
  expect(mobileIns.fltRowOverflow).toBeLessThanOrEqual(1);
  await expect(page.locator('[data-act=ex-pin]')).toBeVisible();
  await expect(page.locator('[data-act=ex-pin]')).toHaveAttribute('aria-pressed', 'true');

  // Mobile More menu holds Games, Opponents, and Progress; selecting Games updates the More button label.
  await expect(page.locator('#btnMoreTabs')).toBeVisible();
  await page.click('#btnMoreTabs');
  await expect(page.locator('#moreTabsMenu [data-act=tab]')).toHaveText(['Games', 'Opponents', 'Progress']);
  await page.click('#moreTabsMenu [data-act=tab][data-v=games]');
  await expect(page.locator('#btnMoreTabs')).toContainText('Games');

  // Mobile compact filter dropdowns filter games without horizontal sliders.
  await page.selectOption('#flt-tc', 'bullet');
  await expect(page.locator('#view')).toContainText('60 games');
  await page.selectOption('#flt-color', 'w');
  await expect(page.locator('#view')).toContainText('40 games');

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
  await page.click('#btnEngineTabSf');
  await page.selectOption('#sfLinesSelect', '1');
  await expect.poll(() => page.locator('#sfLinesList > *').count(), { timeout: 20_000 }).toBe(1);
});

test('Lichess token triggers immediate background sync and Insights reuses DB cache for self and other players', async ({ page, context }) => {
  let authed = false;
  let tokenPostCount = 0;
  let bgSyncCalls = 0;
  let directLichessCalls = 0;
  const now = Date.now();

  const dbSources = [
    {
      src: 'lichess',
      acct: 'alice',
      name: 'Alice',
      title: '',
      total: 2,
      perfs: { blitz: { rating: 1920, games: 2, prov: false } },
      newest: now - 10_000,
      oldest: now - 20_000,
      complete: true,
      monthsDone: [],
      lastSync: now - 5_000,
      syncError: '',
      addedAt: now - 60_000,
      cachedCount: 2,
      maxSeq: 2,
    },
  ];

  const dbGames = {
    'lichess:alice': [
      {
        id: 'li:a1',
        src: 'lichess',
        acct: 'alice',
        t: now - 10_000,
        tc: 'blitz',
        clock: '180+0',
        rated: true,
        color: 'w',
        res: 1,
        term: 'mate',
        me: 1920,
        op: 'Bob',
        opR: 1900,
        opT: '',
        eco: 'C50',
        opening: 'Italian Game',
        oply: 4,
        moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5',
        plies: 6,
        url: 'https://lichess.org/a1',
      },
      {
        id: 'li:a2',
        src: 'lichess',
        acct: 'alice',
        t: now - 20_000,
        tc: 'blitz',
        clock: '180+0',
        rated: true,
        color: 'b',
        res: 0.5,
        term: 'agreement',
        me: 1915,
        op: 'Carol',
        opR: 1910,
        opT: '',
        eco: 'B20',
        opening: 'Sicilian Defense',
        oply: 2,
        moves: 'e4 c5 Nf3 d6',
        plies: 4,
        url: 'https://lichess.org/a2/black',
      },
    ],
    'lichess:drnykterstein': [
      {
        id: 'li:m1',
        src: 'lichess',
        acct: 'drnykterstein',
        t: now - 30_000,
        tc: 'blitz',
        clock: '180+0',
        rated: true,
        color: 'w',
        res: 1,
        term: 'resign',
        me: 3100,
        op: 'RivalGM',
        opR: 3050,
        opT: 'GM',
        eco: 'C65',
        opening: 'Ruy Lopez: Berlin Defense',
        oply: 6,
        moves: 'e4 e5 Nf3 Nc6 Bb5 Nf6',
        plies: 6,
        url: 'https://lichess.org/m1',
      },
    ],
  };

  await context.route(/lichess\.org|chess\.com/, async (route) => {
    directLichessCalls++;
    return route.fulfill({ status: 404, body: '' });
  });

  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();

    if (url.pathname === '/api/auth/me') {
      return route.fulfill({
        json: authed
          ? { configured: true, authenticated: true, user: { id: 'alice', username: 'Alice' } }
          : { configured: true, authenticated: false, user: null },
      });
    }
    if (url.pathname === '/api/auth/token' && method === 'POST') {
      tokenPostCount++;
      authed = true;
      return route.fulfill({ json: { ok: true, user: { id: 'alice', username: 'Alice' }, sourceAdded: true } });
    }
    if (url.pathname === '/api/sync') {
      return route.fulfill({
        json: {
          user: { id: 'alice', username: 'Alice' },
          repertoire: null,
          repertoireName: '',
          repertoireUpdatedAt: 0,
          progress: {},
          progressUpdatedAt: 0,
          scoutTargets: [],
          scoutTargetsUpdatedAt: 0,
        },
      });
    }
    if (url.pathname === '/api/insights' && method === 'GET') {
      if (url.searchParams.get('action') === 'games') {
        const key = `${url.searchParams.get('src')}:${url.searchParams.get('acct')}`;
        const list = dbGames[key] || [];
        return route.fulfill({ json: { games: list, lastSeq: list.length, hasMore: false } });
      }
      return route.fulfill({ json: { user: { id: 'alice', username: 'Alice' }, sources: dbSources } });
    }
    if (url.pathname === '/api/insights' && method === 'POST') {
      const body = route.request().postDataJSON();
      if (body?.action === 'addSource' && body?.name?.toLowerCase() === 'drnykterstein') {
        const added = {
          src: 'lichess',
          acct: 'drnykterstein',
          name: 'DrNykterstein',
          title: 'GM',
          total: 1,
          perfs: { blitz: { rating: 3100, games: 1, prov: false } },
          newest: now - 30_000,
          oldest: now - 30_000,
          complete: true,
          monthsDone: [],
          lastSync: now - 5_000,
          syncError: '',
          addedAt: now,
          cachedCount: 1,
          maxSeq: 1,
        };
        if (!dbSources.some((s) => s.acct === 'drnykterstein')) dbSources.push(added);
        return route.fulfill({ json: { ok: true, source: added, sources: dbSources } });
      }
      return route.fulfill({ json: { ok: true, saved: 0 } });
    }
    if (url.pathname === '/api/insights/sync' && method === 'POST') {
      bgSyncCalls++;
      return route.fulfill({
        json: {
          ok: true,
          synced: {
            src: 'lichess',
            acct: 'alice',
            displayName: 'Alice',
            added: 0,
            complete: true,
            totalGames: 2,
            cachedCount: 2,
            maxSeq: 2,
          },
          hasMore: false,
          pendingCount: 0,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'Not mocked' } });
  });

  // 1. User pastes a manual Lichess token in Studio Settings -> immediately signs in and starts background sync job.
  await page.goto('/');
  await page.click('#btnSettingsMenu');
  await page.click('#actOpenSettings');
  await page.fill('#inputLichessToken', 'lip_valid_test_token_123456');
  await page.click('#btnSaveToken');
  await expect.poll(() => tokenPostCount).toBe(1);
  await expect.poll(() => bgSyncCalls).toBeGreaterThanOrEqual(1);

  // 2. Opening Insights loads Alice's cached games directly from Neon without touching lichess.org.
  directLichessCalls = 0;
  await page.goto('/insights.html');
  await expect(page.locator('#hdrRight')).toContainText('2');
  await expect(page.locator('#view')).toContainText('Bob');

  // 3. Adding another player (DrNykterstein) loads their cached DB games right away too.
  await page.click('[data-act=accounts]');
  await page.fill('[role=dialog] input[name=name]', 'DrNykterstein');
  await page.click('[role=dialog] button:has-text("Add")');
  await expect(page.locator('#hdrRight')).toContainText('3');
  await expect(page.locator('#view')).toContainText('RivalGM');
  expect(directLichessCalls).toBe(0);

  // 4. Studio "My Games" reads directly from the database (no live lichess.org/api/games call),
  //    hides duplicate "Mine" tab when signed in, and never overlaps on 390px mobile.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/');
  await expect(page.locator('#refSrcPlayer')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#refSrcMine')).toBeHidden();
  await page.click('#refSrcPlayer');
  await expect(page.locator('#refTableBody')).toContainText('e4');
  await expect(page.locator('#refTotalGames')).toContainText('2 games');
  const expHdr = await page.evaluate(() => {
    const pBtn = document.getElementById('refSrcPlayer').getBoundingClientRect();
    const tot = document.getElementById('refTotalGames').getBoundingClientRect();
    return { tabRight: Math.round(pBtn.right), totLeft: Math.round(tot.left) };
  });
  expect(expHdr.tabRight).toBeLessThanOrEqual(expHdr.totLeft + 1);
});
