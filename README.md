# tichess

A lightweight, vanilla-JS + Vite chess app with three sections, switched from the top bar on every page:

- **Insights** (`insights.html`): your own games from Lichess, Chess.com or PGN files, explained: openings, opponents, habits, activity and rating.
- **Studio** (`/`): analysis board with multi-threaded Stockfish 19 WASM, an optional local UCI bridge for Lc0 / native Stockfish, live Lichess broadcasts, opening explorers, player scouting and shareable analysis links, in a workspace you can rearrange.
- **Repertoire** (`repertoire.html`): build and drill your opening repertoire with spaced repetition.

## Insights

Add a Lichess or Chess.com username (or import a PGN file) and Insights downloads your games into this browser's IndexedDB. Large accounts stream in over a few minutes the first time, with results filling in as games arrive; later visits only fetch new games, and an interrupted download resumes where it stopped. A Lichess token from Settings, if present, raises Lichess's download rate.

- **Overview:** games, score, current rating, recent performance, and plain-language findings: openings that cost or win you points, results after a loss, long sessions, best time of day, losses on time, color balance. Each finding links to the evidence.
- **Games:** search, filter by result and ending, sort, open any game in the Studio, and download the selection as PGN.
- **Explorer:** your own move tree as White or Black with results per move, on a board with frequency arrows.
- **Openings:** by family or variation, sorted by most played, best or worst, with score and performance.
- **Opponents:** results by rating gap against what Elo predicts, how games end, most played and titled opponents.
- **Activity:** a calendar of every day you played, an hour × weekday grid, results by hour, weekday and month, and session habits.
- **Rating:** history per time control, peak and change, and performance over your last 10 to 5,000 games.

Global filters (time control, color, period, opponent strength, rated, account) apply to every view. Performance is the standard rating-performance calculation (average opponent rating plus the Elo difference implied by your score, capped at ±800). Insights does not convert online ratings to FIDE, because no published formula is accurate enough to show as a number.

The Studio's opening explorer gets a **Mine** source once Insights has games: your games from every linked account at the current position, offline and without signing in.

## Studio workspace

- **Board size:** drag the divider between the board and the panels (double-click or `=` to fit the screen), or use `[` / `]` and **View → Board size**. The board always fits the screen height.
- **Rearrange:** drag any panel by its `⠿` grip onto another panel to swap them, or onto a row's `+` strip to move it there. Drag the dividers between rows to resize them.
- **Layouts:** **Panels → Layouts** offers Prep, Analysis, Broadcast and Focus presets.
- **Board themes:** Slate, Green, Wood, Blue and Graphite under **View**.
- **Engine:** choose 1–5 Stockfish lines and the search depth (14 to unlimited) in the Stockfish panel.
- **Shortcuts:** press `?` for the full list.

Layout, sizes and theme are saved in this browser.

## Honesty Policy

Every metric shown in the UI comes from a real engine or API response:

- **No synthetic evaluations:** Stockfish runs real **Stockfish 19 Lite WASM** (multi-threaded via `SharedArrayBuffer` when `crossOriginIsolated`, with automatic single-threaded fallback) or Lichess Cloud Eval / your local UCI bridge. If the multi-threaded build does not respond within 5 seconds (as can happen in Safari), it retries single-threaded. The Lite build uses Stockfish's smaller NNUE network, so it is somewhat weaker than desktop Stockfish. If WASM cannot load, the UI reports the error honestly instead of falling back to a fake evaluator.
- **Real Lc0 only:** The Lc0 panel only displays evaluations and WDL bars when connected to a real local Lc0 instance over the UCI WebSocket bridge.
- **No invented depths or speeds:** Cloud Eval shows the real depth and total node count (`nodes`, never mislabelled as `kn/s`). Unknown fields render `—`.
- **Live broadcast status from Lichess:** Tournament rounds, start times, and `LIVE` badges come directly from the Lichess Broadcast API (`round.ongoing === true`), refresh periodically, and auto-advance when a new round starts.
- **Zero-backend shareable links:** Click **Share** below the board (or **File → Copy Shareable Analysis Link**) to encode the active tab's variation tree, comments, NAGs, board orientation, and exact move pointer into a `#a=...` URL hash.

## Development & Build

Requires Node.js 20+.

```bash
npm install
npm run dev       # Start Vite dev server (COOP/COEP enabled, copies Stockfish WASM via predev)
npm run build     # Build production bundle to dist/ (copies Stockfish WASM via prebuild)
npm run preview   # Serve dist/ locally (COOP/COEP enabled)
npm run lint      # ESLint check
npm test          # Vitest unit test suite
npm run e2e       # Playwright browser smoke test (requires Chromium: npx playwright install chromium)
```

### Vercel Deployment

Vercel builds this Vite project with zero extra configuration (`npm run build` runs `prebuild` to copy both multi-threaded and single-threaded Stockfish 19 Lite WASM builds plus its GPLv3 license into `public/stockfish/`). Fonts (`Inter` and `IBM Plex Mono`) are self-hosted via Fontsource, and [`vercel.json`](vercel.json) configures `COOP`/`COEP` headers (unlocking multi-threaded WASM), a strict `Content-Security-Policy` header, and static asset caching.

## Optional Lichess Personal Access Token

Live broadcasts and Lichess Cloud Eval work without a token. To unlock the Masters OTB and Lichess Opening Explorer panels:

1. Create a free personal access token at [lichess.org/account/oauth/token/create?description=tichess](https://lichess.org/account/oauth/token/create?description=tichess).
2. **Leave all scopes unchecked** — Opening Explorer only needs an unscoped read token.
3. Paste the token into **Settings → 1. Lichess Personal Access Token**. It is stored only in your browser's `localStorage` and sent only to Lichess (`explorer.lichess.org`, game exports, and the game downloads that power Insights).

## Local UCI WebSocket Bridge (Lc0 / Native Stockfish)

To connect a native GPU Lc0 or native Stockfish binary running on your machine, run the included localhost-only bridge script (`ws` is already included in `devDependencies`):

```bash
ENGINE=lc0 PORT=8080 node tools/bridge.mjs
# Optional extra flags:
ENGINE=lc0 ENGINE_ARGS="--weights=/path/to/weights.pb.gz" PORT=8080 node tools/bridge.mjs
# Native Stockfish on port 8081:
ENGINE=stockfish PORT=8081 node tools/bridge.mjs
```

The bridge binds to `127.0.0.1` and only accepts WebSocket `Origin` headers from `https://tichess.vercel.app` and `localhost`/`127.0.0.1` (set `ALLOWED_ORIGINS=https://your-domain.com` to allow a custom domain).

> **Preview deployments:** Vercel preview URLs are deliberately *not* allowed by pattern, because anyone can create a Vercel project whose URL matches a `tichess-*.vercel.app` pattern. To test the bridge on a preview, pass its exact URL: `ALLOWED_ORIGINS=https://tichess-abc123-yourteam.vercel.app ENGINE=lc0 node tools/bridge.mjs`.

Then open **Settings → 2. Local UCI WebSocket Bridge** and connect to `ws://localhost:8080` (Lc0) or `ws://localhost:8081` (Stockfish).

> **Browser note:** Connecting from an HTTPS deployment to `ws://localhost` works in Chrome and Firefox; Safari may block mixed-content WebSockets on HTTPS pages.

## Repertoire Trainer

`repertoire.html` (the **Repertoire** link in the menu bar) is a spaced-repetition opening trainer: learn new lines with explanations, review due moves, play through an opening against random replies from your repertoire, drill weak spots, browse the repertoire tree with stored engine lines, and play out positions against Stockfish 19 Lite. **Open in analysis** sends the current line to the main studio.

The app ships **no repertoire data**. Load your own `tichess-repertoire` JSON file or any PGN / Lichess Study export; the repertoire is stored in IndexedDB and review progress in `localStorage`. Use **Back up** to download a local JSON copy anytime. `*repertoire*.json` is git-ignored so a personal file can't be committed by accident.

## Optional Phone ↔ Computer Cloud Sync (Neon Postgres + Lichess OAuth)

To automatically sync your opening repertoire, spaced-repetition drill progress (conflict-free merge by timestamp), and scouted player list between phone and desktop:

1. In your Vercel project dashboard, open **Storage → Connect Store → Neon Postgres** (free tier). Vercel injects `DATABASE_URL` automatically and redeploys.
2. Tables (`users`, `user_repertoires`, `user_progress`, `user_scout_targets`) are created automatically on first request — no manual SQL migrations needed.
3. Click **Sign in** (uses Lichess OAuth 2.0 PKCE with zero scopes — no Lichess app registration or client secret required). Optionally set `SESSION_SECRET` in Vercel Environment Variables for explicit cookie signing (otherwise derived from `DATABASE_URL`).

## Licenses & Attribution

- **Application source code:** [MIT License](LICENSE).
- **Stockfish 19 WASM:** Bundled and served from the [`stockfish`](https://www.npmjs.com/package/stockfish) npm package under the **GNU General Public License v3.0 (GPLv3)**. The full license text is copied to `public/stockfish/LICENSE.txt` at build time, and the upstream source code is available at:
  - [official-stockfish/Stockfish](https://github.com/official-stockfish/Stockfish)
  - [nmrugg/stockfish.js](https://github.com/nmrugg/stockfish.js)
