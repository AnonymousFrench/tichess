import { test, expect } from '@playwright/test';

const MOCK_TOP = {
  active: [
    {
      tour: { id: 'qfkdt8mn', name: 'FIDE World Chess Championship 2026' },
      round: { id: 'fnmEB1kH', name: 'Game 3', ongoing: true, finished: false },
    },
  ],
  upcoming: [],
};

const MOCK_TOUR = {
  tour: {
    id: 'qfkdt8mn',
    name: 'FIDE World Chess Championship 2026',
    info: { location: 'Geneva', tc: '120+30' },
  },
  rounds: [
    { id: 'r1id0001', name: 'Game 1', ongoing: false, finished: true, startsAt: 1763992800000 },
    { id: 'r2id0002', name: 'Game 2', ongoing: false, finished: true, startsAt: 1764079200000 },
    { id: 'fnmEB1kH', name: 'Game 3', ongoing: true, finished: false, startsAt: 1764165600000 },
    { id: 'r4id0004', name: 'Game 4', ongoing: false, finished: false, startsAt: 1764338400000 },
  ],
};

const MOCK_PGN = `[Event "FIDE World Chess Championship 2026"]
[White "Sindarov, Javokhir"]
[Black "Gukesh D"]
[Result "*"]
[ECO "C50"]
[Opening "Italian Game"]

1. e4 { [%clk 1:59:50] } 1... e5 { [%clk 1:59:45] } 2. Nf3 { [%clk 1:59:10] } *`;

const MOCK_CLOUD_CASTLING = {
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  knodes: 695524,
  depth: 75,
  pvs: [{ moves: 'e2e4 e7e5 g1f3', cp: 19 }],
};

test('Stockfish 19 WASM worker works, UI is honest, and rounds table is visible at 1280x720', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.route('https://lichess.org/api/broadcast/top', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(MOCK_TOP) })
  );
  await page.route('https://lichess.org/api/broadcast/search*', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ currentPageResults: [] }) })
  );
  await page.route('https://lichess.org/api/broadcast/qfkdt8mn', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(MOCK_TOUR) })
  );
  await page.route('https://lichess.org/api/broadcast/round/fnmEB1kH.pgn', (r) =>
    r.fulfill({ contentType: 'text/plain', body: MOCK_PGN })
  );
  await page.route('https://lichess.org/api/cloud-eval*', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(MOCK_CLOUD_CASTLING) })
  );
  await page.route('https://explorer.lichess.org/**', (r) =>
    r.fulfill({ status: 401, contentType: 'application/json', body: '{}' })
  );

  await page.goto('/');

  // 1. Direct Stockfish 19 WASM worker check
  const wasmResult = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const w = new Worker('/stockfish/stockfish-19-lite-single.js');
        const out = [];
        const timer = setTimeout(() => resolve({ ok: false, out }), 20_000);
        w.onerror = (e) => {
          clearTimeout(timer);
          resolve({ ok: false, err: e.message, out });
        };
        w.onmessage = (e) => {
          const line = String(e.data);
          out.push(line);
          if (line === 'uciok') {
            w.postMessage('position startpos');
            w.postMessage('go depth 8');
          }
          if (line.startsWith('bestmove ')) {
            clearTimeout(timer);
            w.terminate();
            resolve({ ok: true, out });
          }
        };
        w.postMessage('uci');
      })
  );
  expect(wasmResult.ok).toBe(true);
  expect(wasmResult.out.some((l) => l.includes('Stockfish 19'))).toBe(true);

  // 2. Honest Lc0 disconnected badge
  await expect(page.locator('#lc0ModeBadge')).toHaveText('Not Connected');

  // 3. Cloud eval displays nodes (NEVER kn/s)
  await expect(page.locator('#sfModeBadge')).toHaveText('Lichess Cloud');
  await expect(page.locator('#sfDepth')).toHaveText('Depth: 75');
  const sfNps = await page.locator('#sfNps').textContent();
  expect(sfNps).toContain('nodes');
  expect(sfNps).not.toContain('kn/s');

  // 4. Rounds table has visible rows at 1280x720
  await expect(page.locator('#roundsTableBody .round-row')).toHaveCount(4);
  const tableWrapBox = await page.locator('#liveScheduleWrap').boundingBox();
  expect(tableWrapBox.height).toBeGreaterThanOrEqual(150);

  expect(pageErrors).toEqual([]);
});

test('falls back cleanly to real Stockfish 19 WASM when Lichess is blocked', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.route('https://lichess.org/**', (r) => r.abort());
  await page.route('https://explorer.lichess.org/**', (r) => r.abort());

  await page.goto('/');

  const isolated = await page.evaluate(() => window.crossOriginIsolated);
  expect(isolated).toBe(true);

  await expect(page.locator('#sfModeBadge')).toHaveText(/^SF 19 (MT \(\d+T\)|WASM)$/, {
    timeout: 20_000,
  });
  await expect(page.locator('#sfDepth')).toHaveText(/^Depth: \d+$/, { timeout: 20_000 });
  await expect(page.locator('#lc0ModeBadge')).toHaveText('Not Connected');
  expect(pageErrors).toEqual([]);
});

test('clicking a cloud PV line with king-to-rook castling (e1h1) plays O-O on the board', async ({
  page,
}) => {
  const CASTLE_FEN = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 0 5';
  await page.route('https://lichess.org/api/broadcast/**', (r) => r.abort());
  await page.route('https://explorer.lichess.org/**', (r) => r.abort());
  await page.route('https://lichess.org/api/cloud-eval*', (r) => {
    const url = r.request().url();
    if (url.includes('RNBQK2R')) {
      return r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          fen: CASTLE_FEN,
          knodes: 120000,
          depth: 40,
          pvs: [{ moves: 'e1h1 d7d6 c2c3', cp: 25 }],
        }),
      });
    }
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/');

  // Open Load FEN modal and load the castling position
  await page.click('[data-menu="file"]');
  await page.click('#actLoadModal');
  await page.fill('#loadPgnTextarea', CASTLE_FEN);
  await page.click('#btnConfirmLoad');

  // Verify cloud PV normalized e1h1 -> O-O and clicking it plays 5.O-O
  const firstPv = page.locator('#sfLinesList .pv-row').first();
  await expect(firstPv).toContainText('5.O-O d6 6.c3', { timeout: 10_000 });
  await expect(firstPv).toHaveAttribute('data-uci', 'e1g1');
  await firstPv.click();

  await expect(page.locator('#variationTreeContainer')).toContainText('5.O-O');
});

test('opening a shareable #a=... link restores variation tree, comments, and current move', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.route('https://lichess.org/**', (r) => r.abort());
  await page.route('https://explorer.lichess.org/**', (r) => r.abort());

  // Payload: 1. e4 e5 (2. Nf3) (2. d4 {Center Game}!), current at 2. d4, title "Shared Prep"
  const payload = [
    null,
    [['e2e4', [['e7e5', [['g1f3'], ['d2d4', [], 'Center Game', ['!']]]]]]],
    [0, 0, 1],
    0,
    'Shared Prep',
  ];
  const encoded = Buffer.from(JSON.stringify(payload))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  await page.goto(`/#a=${encoded}`);

  await expect(page.locator('#boardTabsBar')).toContainText('Shared Prep');
  await expect(page.locator('#variationTreeContainer')).toContainText('Center Game');
  await expect(page.locator('#variationTreeContainer .tree-move.active')).toContainText('d4!');
  expect(pageErrors).toEqual([]);
});
