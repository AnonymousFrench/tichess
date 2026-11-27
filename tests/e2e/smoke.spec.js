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

test('Stockfish 19 WASM worker works, UI is honest, and live events lead to rounds and games', async ({
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

  // 4. Live hub starts with the list of events; an event shows every round, then its games
  await expect(page.locator('.live-event-row')).toHaveCount(1);
  await expect(page.locator('#liveEventsList')).toContainText('Live now');
  await expect(page.locator('#liveQuickJumpLabel')).toHaveText('FIDE World Chess Championship 2026');
  await page.click('.live-event-row');
  await expect(page.locator('.live-round-chip')).toHaveCount(4);
  await expect(page.locator('.live-round-chip[aria-pressed="true"]')).toHaveText('Game 3');
  await expect(page.locator('.live-game-row')).toHaveCount(1);
  await page.click('.live-game-row');
  await expect(page.locator('#boardTabsBar')).toContainText('Sindarov - Gukesh D');
  await page.click('#btnLiveBack');
  await expect(page.locator('.live-event-row')).toHaveCount(1);

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

  await expect(page.locator('#sfModeBadge')).toHaveText(/^SF 19 Lite( MT \(\d+T\))?$/, {
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
  await page.click('[data-menu="settings"]');
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

const SAMPLE_REPERTOIRE = {
  secs: [{ id: 'A', name: 'Italian Prep', group: 'White · 1.e4', color: 'w', start: 0, startPly: 0, lines: [0] }],
  lines: [
    {
      id: 'A1',
      name: 'Main Line',
      sec: 'A',
      color: 'w',
      ev: '+0.3',
      note: 'Control the center',
      san: ['e4', 'e5', 'Nf3'],
      uci: ['e2e4', 'e7e5', 'g1f3'],
      pos: [0, 1, 2, 3],
      alt: false,
    },
  ],
  pos: [
    { f: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', t: 0, e: [['e2e4', 'e4', 1, 1, [0], 'c1']] },
    { f: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', t: 0, e: [['e7e5', 'e5', 2, 0, [0]]] },
    { f: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', t: 0, e: [['g1f3', 'Nf3', 3, 1, [0], 'c2']] },
    { f: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2', t: 0, e: [] },
  ],
  cards: {
    c1: { p: 0, u: 'e2e4', s: 'e4', n: 'Best by test' },
    c2: { p: 2, u: 'g1f3', s: 'Nf3', n: 'Attack e5' },
  },
  warn: {},
  theory: [{ ev: 0.3, name: 'King Pawn Game', alts: [] }],
  roots: { w: 0 },
};

async function seedRepertoireInIdb(page) {
  await page.evaluate(async (rep) => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('tichess-repertoire', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ repertoire: rep, name: 'My Prep' }, 'repertoire');
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, SAMPLE_REPERTOIRE);
}

test('repertoire.html Play vs Stockfish boots engine and plays a legal reply', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/repertoire.html');
  await seedRepertoireInIdb(page);
  await page.reload();

  await page.click('.tabs-top [data-tab="study"]');
  await page.click('#s-fwd'); // 1.e4 — now Black to move
  await page.click('#s-vs'); // User plays White, Stockfish plays Black immediately

  await expect(page.locator('#x-head')).toContainText('Playing Stockfish', { timeout: 15_000 });
  await expect(page.locator('#x-sheet .mv')).toHaveCount(1, { timeout: 15_000 });
  expect(pageErrors).toEqual([]);
});

test('main site Repertoire hub shows prepared moves for current position and plays them', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.route('https://lichess.org/**', (r) => r.abort());
  await page.route('https://explorer.lichess.org/**', (r) => r.abort());

  await page.goto('/');
  await seedRepertoireInIdb(page);
  await page.reload();

  await page.click('[data-hub="repertoire"]');
  await expect(page.locator('#hub-repertoire')).toContainText('My Prep');
  await expect(page.locator('#hub-repertoire')).toContainText('Best by test');

  // Click prepared move e4 -> plays 1.e4 on main board and shows opponent reply e5
  await page.locator('#hub-repertoire .rep-pos-move').first().click();
  await expect(page.locator('#variationTreeContainer')).toContainText('1.e4');
  await expect(page.locator('#hub-repertoire')).toContainText('e5');

  // The tree follows the board: the current move is highlighted and the status says in book
  await expect(page.locator('#hub-repertoire .rep-tree-move[data-active]')).toContainText('e4');
  await expect(page.locator('#hub-repertoire .rep-book-status')).toContainText('In your repertoire');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#hub-repertoire .rep-tree-move[data-active]')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await page.locator('#hub-repertoire .rep-pos-move').first().click(); // 1...e5
  await expect(page.locator('#hub-repertoire .rep-tree-move[data-active]')).toContainText('e5');

  // Leaving the prepared line says where, and "Back to book" returns to it
  await page.click('[data-menu="settings"]');
  await page.click('#actLoadModal');
  await page.fill('#loadPgnTextarea', '1. e4 e5 2. Bc4');
  await page.click('#btnConfirmLoad');
  await expect(page.locator('#hub-repertoire .rep-book-status')).toContainText('Out of your repertoire at 2.Bc4');
  await expect(page.locator('#hub-repertoire .rep-book-status')).toContainText('Nf3');
  await page.click('.rep-back-to-book');
  await expect(page.locator('#hub-repertoire .rep-tree-move[data-active]')).toContainText('e5');

  // "n" starts the current board over
  await page.locator('#chessboard').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('n');
  await expect(page.locator('#variationTreeContainer')).not.toContainText('Bc4');
  await expect(page.locator('#hub-repertoire .rep-book-status')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('Player Scout syncs Lichess username games and indexes opening moves', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const mockNdjson = JSON.stringify({
    id: 'liGame01',
    variant: 'standard',
    perf: 'blitz',
    createdAt: Date.UTC(2026, 10, 24),
    winner: 'white',
    players: {
      white: { user: { name: 'LichessTestUser' }, rating: 2400 },
      black: { user: { name: 'OpponentA' }, rating: 2380 },
    },
    pgn: '[Event "rated blitz game"]\n[White "LichessTestUser"]\n[Black "OpponentA"]\n[Result "1-0"]\n\n1. d4 d5 2. c4 e6 1-0',
  });

  await page.route('https://lichess.org/api/games/user/LichessTestUser*', (r) =>
    r.fulfill({ contentType: 'application/x-ndjson', body: mockNdjson + '\n' })
  );
  await page.route('https://lichess.org/api/broadcast/**', (r) => r.abort());
  await page.route('https://lichess.org/api/cloud-eval*', (r) => r.abort());
  await page.route('https://explorer.lichess.org/**', (r) => r.abort());

  await page.goto('/');
  await page.click('#btnOpenScoutModal');
  await page.fill('#scLichessUser', 'LichessTestUser');
  await page.click('#btnRunLichessSync');

  await expect(page.locator('#scoutCollectionSelect')).toContainText('LichessTestUser (Lichess)', {
    timeout: 10_000,
  });
  await expect(page.locator('#scoutTableBody')).toContainText('d4');
  expect(pageErrors).toEqual([]);
});

test('Game Review evaluates a loaded game locally, renders eval graph, and jumps on click', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.route('https://lichess.org/**', (r) => r.abort());
  await page.route('https://explorer.lichess.org/**', (r) => r.abort());

  await page.goto('/');

  // Load Fool's Mate via Load PGN modal
  await page.click('[data-menu="settings"]');
  await page.click('#actLoadModal');
  await page.fill('#loadPgnTextarea', '1. f3 e5 2. g4 Qh4#');
  await page.click('#btnConfirmLoad');

  // Run fast local Stockfish review at depth 10
  await page.selectOption('#reviewDepthSelect', '10');
  await page.click('#btnGameReview');

  // Wait for review to complete and render summary + SVG eval graph + blunder tag on 2.g4
  await expect(page.locator('#btnReviewNextIssue')).toBeVisible({ timeout: 25_000 });
  await expect(page.locator('#evalGraphContainer svg')).toBeVisible();
  await expect(page.locator('#variationTreeContainer')).toContainText('g4??');

  // Jump to the flagged blunder via Next ?! button and verify move callout appears
  await page.click('#btnReviewNextIssue');
  await expect(page.locator('#reviewMoveCallout')).toBeVisible();
  await expect(page.locator('#reviewMoveCallout')).toContainText('Best:');
  expect(pageErrors).toEqual([]);
});

test('Repertoire hub imports a Lichess Study PGN, saves a board line, and opens in repertoire.html', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.route('https://lichess.org/**', (r) => r.abort());
  await page.route('https://explorer.lichess.org/**', (r) => r.abort());

  await page.goto('/');
  await page.click('[data-hub="repertoire"]');

  // Open PGN/Study import drawer and import a PGN with a variation & comment
  await page.click('#btnStudioRepPgnToggle');
  await page.fill(
    '#repPgnTextarea',
    '[Event "Study: Scotch Game"]\n1. e4 { Center control } e5 2. Nf3 Nc6 3. d4 (3. Bc4 Bc5) 3... exd4 *'
  );
  await page.click('#btnConfirmRepPgn');

  await expect(page.locator('#hub-repertoire')).toContainText('Study');
  await expect(page.locator('#hub-repertoire')).toContainText('Center control');

  // Load a new board line 1. d4 d5 2. c4 and save it into the repertoire
  await page.click('[data-menu="settings"]');
  await page.click('#actLoadModal');
  await page.fill('#loadPgnTextarea', '1. d4 d5 2. c4');
  await page.click('#btnConfirmLoad');

  await page.click('#btnStudioRepAddLine');
  await page.fill('#repAddSection', 'Queen Gambit');
  await page.fill('#repAddLineName', 'Main');
  await page.click('#btnConfirmAddLine');

  await expect(page.locator('#hub-repertoire')).toContainText('Queen Gambit');

  // Verify the saved repertoire opens cleanly on repertoire.html
  await page.goto('/repertoire.html');
  await expect(page.locator('#v-train')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#whoami')).toContainText('Study');
  expect(pageErrors).toEqual([]);
});

test('Scout x Repertoire Opponent Prep finds gaps, badges moves, preps gap, and launches drill', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // Mock Lichess opponent playing Black: 2x Sicilian (gap against SAMPLE_REPERTOIRE) and 1x 1...e5 (book)
  const makeGame = (id, moves, winner) =>
    JSON.stringify({
      id,
      variant: 'standard',
      perf: 'blitz',
      createdAt: Date.UTC(2026, 10, 24),
      winner,
      players: {
        white: { user: { name: 'RandomWhite' }, rating: 2200 },
        black: { user: { name: 'PrepRival' }, rating: 2250 },
      },
      pgn: `[Event "rated blitz"]\n[White "RandomWhite"]\n[Black "PrepRival"]\n[Result "${winner === 'black' ? '0-1' : '1-0'}"]\n\n${moves}`,
    });

  const ndjson = [
    makeGame('r1', '1. e4 c5 2. Nf3 d6 0-1', 'black'),
    makeGame('r2', '1. e4 c5 2. Nc3 Nc6 0-1', 'black'),
    makeGame('r3', '1. e4 e5 2. Nf3 Nc6 1-0', 'white'),
  ].join('\n');

  await page.route('https://lichess.org/api/games/user/PrepRival*', (r) =>
    r.fulfill({ contentType: 'application/x-ndjson', body: ndjson + '\n' })
  );
  await page.route('https://lichess.org/api/broadcast/**', (r) => r.abort());
  await page.route('https://lichess.org/api/cloud-eval*', (r) => r.abort());
  await page.route('https://explorer.lichess.org/**', (r) => r.abort());

  await page.goto('/');
  await seedRepertoireInIdb(page);
  await page.reload();

  // Sync opponent in Player Scout
  await page.click('#btnOpenScoutModal');
  await page.fill('#scLichessUser', 'PrepRival');
  await page.click('#btnRunLichessSync');
  await expect(page.locator('#scoutCollectionSelect')).toContainText('PrepRival (Lichess)', {
    timeout: 10_000,
  });

  // Open Repertoire hub -> Opponent Prep drawer
  await page.click('[data-hub="repertoire"]');
  await page.click('#btnStudioRepPrepToggle');

  await expect(page.locator('#studioRepPrepDrawer')).toContainText('Coverage:');
  await expect(page.locator('#studioRepPrepDrawer')).toContainText('1...c5');
  await expect(page.locator('#studioRepPrepDrawer')).toContainText('A1');

  // Clicking Prep -> on the 1...c5 gap loads 1. e4 c5 and opens pre-filled Add Line drawer
  await page.locator('.rep-prep-gap').first().click();
  await expect(page.locator('#variationTreeContainer')).toContainText('c5');
  await expect(page.locator('#studioRepAddLineDrawer')).toBeVisible();

  // Re-open Prep drawer and launch targeted opponent drill on repertoire.html?prep=1
  await page.click('#btnStudioRepPrepToggle');
  await expect(page.locator('#btnRepPrepDrill')).toBeVisible();
  await page.click('#btnRepPrepDrill');

  await expect(page).toHaveURL(/repertoire\.html\?prep=1/, { timeout: 10_000 });
  await expect(page.locator('#session')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#se-title')).toContainText('Prep vs PrepRival');
  expect(pageErrors).toEqual([]);
});

test('Cloud Sync pulls repertoire & scout targets on fresh device and pushes edits to /api/sync', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const putBodies = [];
  await page.route('https://lichess.org/**', (r) => r.abort());
  await page.route('https://explorer.lichess.org/**', (r) => r.abort());

  await page.route('**/api/auth/me', (r) =>
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        authenticated: true,
        user: { id: 'phonesyncuser', username: 'PhoneSyncUser' },
      }),
    })
  );

  await page.route('**/api/sync', async (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'phonesyncuser', username: 'PhoneSyncUser' },
          repertoire: SAMPLE_REPERTOIRE,
          repertoireName: 'Cloud Italian',
          repertoireUpdatedAt: 1_700_000_000_000,
          progress: {},
          progressUpdatedAt: 0,
          scoutTargets: [
            { source: 'lichess', username: 'DesktopRival', max: 100, perfType: '', updatedAt: 1000 },
          ],
          scoutTargetsUpdatedAt: 1000,
        }),
      });
    }
    if (r.request().method() === 'PUT') {
      putBodies.push(r.request().postDataJSON());
      return r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, updatedAt: Date.now() }),
      });
    }
    return r.continue();
  });

  await page.route('**/api/lichess/explorer*', (r) => {
    const url = new URL(r.request().url());
    const source = url.searchParams.get('source');
    const color = url.searchParams.get('color');
    if (source === 'player') {
      const moves =
        color === 'black'
          ? [{ uci: 'c7c5', san: 'c5', white: 1, draws: 1, black: 5 }]
          : [{ uci: 'd2d4', san: 'd4', white: 8, draws: 2, black: 1 }];
      return r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ white: 8, draws: 2, black: 1, moves, recentGames: [] }),
      });
    }
    return r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        white: 100,
        draws: 50,
        black: 50,
        moves: [{ uci: 'e2e4', san: 'e4', white: 100, draws: 50, black: 50 }],
        topGames: [],
      }),
    });
  });

  // 1. Fresh browser on main studio automatically pulls repertoire and displays signed-in username
  await page.goto('/');
  await expect(page.locator('header [data-account] .ta-name')).toHaveText('PhoneSyncUser', { timeout: 10_000 });
  await expect(page.locator('header [data-account] .ta-signin')).toHaveCount(0);

  // My Games tab appears next to Masters OTB & Lichess DB and switches W/B
  await expect(page.locator('#refSrcPlayer')).toBeVisible();
  await page.click('#refSrcPlayer');
  await expect(page.locator('#refTableBody')).toContainText('d4');
  await page.click('.ref-pcol-btn[data-pcol="black"]');
  await expect(page.locator('#refTableBody')).toContainText('c5');

  await page.click('[data-hub="repertoire"]');
  await expect(page.locator('#hub-repertoire')).toContainText('Cloud Italian');
  await expect(page.locator('#hub-repertoire')).toContainText('Best by test');

  // Synced opponent target from desktop shows up in Scout modal
  await page.click('#btnOpenScoutModal');
  await expect(page.locator('#scoutSyncedTargetsBox')).toContainText('DesktopRival');
  await page.click('#scoutModal .modal-close');

  // Adding a board line automatically pushes the updated repertoire to /api/sync
  await page.click('[data-menu="settings"]');
  await page.click('#actLoadModal');
  await page.fill('#loadPgnTextarea', '1. d4 d5');
  await page.click('#btnConfirmLoad');
  await page.click('#btnStudioRepAddLine');
  await page.fill('#repAddSection', 'Queen Pawn');
  await page.click('#btnConfirmAddLine');

  await expect.poll(() => putBodies.some((b) => b?.type === 'repertoire')).toBe(true);

  // 2. Opening repertoire.html automatically displays cloud sync status without empty importer
  await page.goto('/repertoire.html');
  await expect(page.locator('#v-train')).toBeVisible({ timeout: 10_000 });
  // Same account, no second sign-in: the shared header control shows it on every page.
  await expect(page.locator('[data-account] .ta-name')).toHaveText('PhoneSyncUser');
  await expect(page.locator('#sync')).toContainText('synced');

  // 3. Insights picks up the same Lichess account by itself.
  await page.goto('/insights.html');
  await expect(page.locator('[data-account] .ta-name')).toHaveText('PhoneSyncUser');
  await expect(page.locator('#hdrRight [data-act="accounts"]')).toHaveAttribute('aria-label', /PhoneSyncUser/, { timeout: 10_000 });
  expect(pageErrors).toEqual([]);
});

test('mobile board moves never scroll the screen, repertoire tree jumps on click, and My Games falls back cleanly', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.setViewportSize({ width: 390, height: 700 });
  await page.route('https://lichess.org/api/broadcast/top', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(MOCK_TOP) })
  );
  await page.route('https://lichess.org/api/broadcast/search*', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ currentPageResults: [] }) })
  );
  await page.route('https://lichess.org/api/cloud-eval*', (r) => r.abort());
  await page.route('https://explorer.lichess.org/**', (r) => r.abort());

  // Signed in, but /api/lichess/explorer returns reauth_needed -> My Games must seamlessly fall back to public user games
  await page.route('**/api/auth/me', (r) =>
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        authenticated: true,
        user: { id: 'mobileuser', username: 'MobileUser' },
      }),
    })
  );
  await page.route('**/api/sync', (r) =>
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'mobileuser', username: 'MobileUser' },
        repertoire: SAMPLE_REPERTOIRE,
        repertoireName: 'Mobile Rep',
        repertoireUpdatedAt: 1_700_000_000_000,
        progress: {},
        progressUpdatedAt: 0,
        scoutTargets: [],
        scoutTargetsUpdatedAt: 0,
      }),
    })
  );
  await page.route('**/api/lichess/explorer*', (r) =>
    r.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'reauth_needed', error: 'Re-auth needed' }),
    })
  );
  await page.route('https://lichess.org/api/games/user/MobileUser*', (r) =>
    r.fulfill({
      contentType: 'application/x-ndjson',
      body:
        JSON.stringify({
          id: 'm1',
          variant: 'standard',
          perf: 'blitz',
          createdAt: Date.UTC(2026, 10, 25),
          winner: 'white',
          players: {
            white: { user: { name: 'MobileUser' }, rating: 2000 },
            black: { user: { name: 'Foe' }, rating: 1990 },
          },
          pgn: '1. c4 e5 2. Nc3 Nf6 1-0',
        }) + '\n',
    })
  );

  await page.goto('/');
  await expect(page.locator('#chessboard .sq[data-sq="e2"]')).toBeVisible();
  await expect(page.locator('#liveEventsList')).toContainText('FIDE World Chess Championship 2026');

  // Phone header hides the live tournament quick-jump pill and stays strictly single-row
  await expect(page.locator('#btnLiveQuickJump')).toBeHidden();
  const headerLayout = await page.evaluate(() => {
    const hdr = document.querySelector('header');
    const left = hdr.children[0].getBoundingClientRect();
    const right = hdr.children[1].getBoundingClientRect();
    return {
      height: Math.round(hdr.getBoundingClientRect().height),
      yDiff: Math.abs(Math.round(left.y) - Math.round(right.y)),
      overflow: hdr.scrollWidth > hdr.clientWidth,
    };
  });
  expect(headerLayout.height).toBeLessThanOrEqual(42);
  expect(headerLayout.yDiff).toBeLessThanOrEqual(4);
  expect(headerLayout.overflow).toBe(false);

  // Play 1. e4 e5 by clicking squares on mobile viewport and verify neither window nor <main> scrolled!
  await page.click('#chessboard .sq[data-sq="e2"]');
  await page.click('#chessboard .sq[data-sq="e4"]');
  await page.click('#chessboard .sq[data-sq="e7"]');
  await page.click('#chessboard .sq[data-sq="e5"]');

  const scrollPos = await page.evaluate(() => ({
    winY: window.scrollY,
    mainTop: document.querySelector('main')?.scrollTop || 0,
  }));
  expect(scrollPos.winY).toBe(0);
  expect(scrollPos.mainTop).toBe(0);

  // Mobile board controls fit into one single row, and sub-board order is Engine -> Live/Master -> Variation Tree
  const mobileLayout = await page.evaluate(() => {
    const ids = ['btnFirst', 'btnPrev', 'btnNext', 'btnLast', 'btnFlip', 'btnBoardExport'];
    const ys = ids.map((id) => Math.round(document.getElementById(id).getBoundingClientRect().y));
    const sfY = document.getElementById('panel-sf').getBoundingClientRect().y;
    const hubY = document.getElementById('panel-hub').getBoundingClientRect().y;
    const treeY = document.getElementById('panel-tree').getBoundingClientRect().y;
    return { ys, sfY, hubY, treeY };
  });
  expect(Math.max(...mobileLayout.ys) - Math.min(...mobileLayout.ys)).toBeLessThanOrEqual(2);
  expect(mobileLayout.sfY).toBeLessThan(mobileLayout.hubY);
  expect(mobileLayout.hubY).toBeLessThan(mobileLayout.treeY);

  // Verify My Games seamlessly falls back to recent public games and shows 1. c4
  await page.click('#btnFirst');
  await expect(page.locator('#refSrcPlayer')).toBeVisible();
  await page.click('#refSrcPlayer');
  await expect(page.locator('#refTableBody')).toContainText('c4', { timeout: 10_000 });

  // Verify slim Repertoire chess tree lets user click directly to 2. Nf3
  await page.click('[data-hub="repertoire"]');
  await page.locator('#hub-repertoire .rep-tree-move', { hasText: 'Nf3' }).click();
  await expect(page.locator('#variationTreeContainer')).toContainText('Nf3');

  // Verify pinned board stays fixed at top when scrolling down to tools, and toggles off cleanly
  await expect(page.locator('#btnPinBoard')).toBeVisible();
  await expect(page.locator('#btnPinBoard')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => window.scrollTo(0, 450));
  const pinnedBoardTop = await page.evaluate(() => ({
    scrollY: window.scrollY,
    boardTop: Math.round(document.getElementById('boardPanel').getBoundingClientRect().top),
  }));
  expect(pinnedBoardTop.scrollY).toBeGreaterThanOrEqual(400);
  expect(pinnedBoardTop.boardTop).toBeLessThanOrEqual(2);
  await page.click('#btnPinBoard');
  await expect(page.locator('#btnPinBoard')).toHaveAttribute('aria-pressed', 'false');
  const unpinnedBoardTop = await page.evaluate(() =>
    Math.round(document.getElementById('boardPanel').getBoundingClientRect().top)
  );
  expect(unpinnedBoardTop).toBeLessThan(-100);

  // Verify /repertoire.html scrolls freely on mobile without body trapping scroll
  await page.goto('/repertoire.html');
  await expect(page.locator('#v-train')).toBeVisible({ timeout: 10_000 });
  const repScroll = await page.evaluate(() => {
    const bodyStyle = getComputedStyle(document.body);
    window.scrollTo(0, 260);
    return {
      overflowY: bodyStyle.overflowY,
      overscrollY: bodyStyle.overscrollBehaviorY,
      scrollY: window.scrollY,
    };
  });
  expect(repScroll.overflowY).toBe('visible');
  expect(repScroll.overscrollY).toBe('auto');
  expect(repScroll.scrollY).toBeGreaterThan(100);
  expect(pageErrors).toEqual([]);
});

test('configurable panels close/persist/restore, repertoire shows multi-move arrows & Merged tree, and My Games filters + flags flaws', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const seenGamesUrls = [];
  const makeGame = (id, moves, winner) =>
    JSON.stringify({
      id,
      variant: 'standard',
      perf: 'blitz',
      createdAt: Date.UTC(2026, 10, 25),
      winner,
      players: {
        white: { user: { name: 'FlawUser' }, rating: 2050 },
        black: { user: { name: 'Rival' }, rating: 2040 },
      },
      pgn: `${moves} ${winner === 'white' ? '1-0' : winner === 'black' ? '0-1' : '1/2-1/2'}`,
    });

  // 4 losses with 1. f4 (0% -> Flaw) and 4 wins with 1. e4 (100% -> Strong)
  const mockGamesNdjson = [
    makeGame('f1', '1. f4 d5', 'black'),
    makeGame('f2', '1. f4 e5', 'black'),
    makeGame('f3', '1. f4 Nf6', 'black'),
    makeGame('f4', '1. f4 c5', 'black'),
    makeGame('e1', '1. e4 e5', 'white'),
    makeGame('e2', '1. e4 c5', 'white'),
    makeGame('e3', '1. e4 e6', 'white'),
    makeGame('e4', '1. e4 d5', 'white'),
  ].join('\n');

  await page.route('https://lichess.org/api/broadcast/**', (r) => r.abort());
  await page.route('https://lichess.org/api/cloud-eval*', (r) => r.abort());
  await page.route('https://explorer.lichess.org/**', (r) => r.abort());
  await page.route('**/api/auth/me', (r) =>
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        authenticated: true,
        user: { id: 'flawuser', username: 'FlawUser' },
      }),
    })
  );
  await page.route('**/api/sync', (r) =>
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'flawuser', username: 'FlawUser' },
        repertoire: null,
        repertoireName: null,
        repertoireUpdatedAt: 0,
        progress: {},
        progressUpdatedAt: 0,
        scoutTargets: [],
        scoutTargetsUpdatedAt: 0,
      }),
    })
  );
  await page.route('https://lichess.org/api/games/user/FlawUser*', (r) => {
    seenGamesUrls.push(r.request().url());
    return r.fulfill({ contentType: 'application/x-ndjson', body: mockGamesNdjson + '\n' });
  });

  await page.goto('/');

  // 1. Lc0 panel starts hidden by default (clean single Stockfish panel); Scout can be closed with X and persists across reload
  await expect(page.locator('#panel-lc0')).toBeHidden();
  await expect(page.locator('#panel-sf')).toBeVisible();
  await expect(page.locator('#panel-scout')).toBeVisible();

  await page.click('#panel-scout .panel-close-btn');
  await expect(page.locator('#panel-scout')).toBeHidden();

  await page.reload();
  await expect(page.locator('#panel-scout')).toBeHidden();

  // Restore Scout via ⊞ Panels menu
  await page.click('#btnPanelsMenu');
  await page.click('.panel-toggle-item[data-panel="scout"]');
  await expect(page.locator('#panel-scout')).toBeVisible();
  await page.keyboard.press('Escape');

  // 2. My Games Explorer shows time/count filters, position W/D/L summary, and Flaw / Strong badges
  await expect(page.locator('#refSrcPlayer')).toBeVisible({ timeout: 10_000 });
  await page.click('#refSrcPlayer');
  await expect(page.locator('#refPlayerFilterBar')).toBeVisible();
  await expect(page.locator('#refTableBody')).toContainText('Flaw', { timeout: 10_000 });
  await expect(page.locator('#refTableBody')).toContainText('Strong');
  await expect(page.locator('#refPlayerSummary')).toContainText('50%');

  // Change filters to Last 1m & Last 50 games and verify request carries max=50 & since=<ms>
  await page.selectOption('#refPlayerMax', '50');
  await page.selectOption('#refPlayerSince', '1m');
  await expect
    .poll(() => seenGamesUrls.some((u) => u.includes('max=50') && u.includes('since=')))
    .toBe(true);

  // 3. Repertoire multi-move arrows (1. e4 -> both 1...e5 and 1...e6 arrows simultaneously) + Merged tree toggle
  await page.click('[data-hub="repertoire"]');
  await page.click('#btnStudioRepPgnToggle');
  await page.selectOption('#repPgnColor', 'b');
  await page.fill('#repPgnTextarea', '1. e4 e5 (1... e6 2. d4 d5) 2. Nf3 Nc6 *');
  await page.click('#btnConfirmRepPgn');

  // Step into 1. e4 and verify arrowOverlay renders at least 2 repertoire arrows (e5 & e6)
  await page.click('#chessboard .sq[data-sq="e2"]');
  await page.click('#chessboard .sq[data-sq="e4"]');
  await expect
    .poll(() => page.locator('#arrowOverlay line').count(), { timeout: 5_000 })
    .toBeGreaterThanOrEqual(2);

  // Toggle Merged tree view and verify both e5 and e6 appear in the unified tree
  await page.click('#btnRepViewMerged');
  await expect(page.locator('#hub-repertoire')).toContainText('e5');
  await expect(page.locator('#hub-repertoire')).toContainText('e6');
  expect(pageErrors).toEqual([]);
});






