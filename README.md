# ChessMonitor Studio (`tichess`)

A lightweight, vanilla-JS + Vite chess analysis studio with multi-threaded Stockfish 19 WASM, an optional local UCI WebSocket bridge for GPU Lc0 / native Stockfish, live Lichess tournament broadcasts, Lichess Opening Explorer, zero-backend shareable analysis links, and local IndexedDB player scouting.

## Honesty Policy

Every metric shown in the UI comes from a real engine or API response:

- **No synthetic evaluations:** Stockfish runs real **Stockfish 19 Lite WASM** (multi-threaded via `SharedArrayBuffer` when `crossOriginIsolated`, with automatic single-threaded fallback) or Lichess Cloud Eval / your local UCI bridge. If WASM cannot load, the UI reports the error honestly instead of falling back to a fake evaluator.
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
3. Paste the token into **Settings → 1. Lichess Personal Access Token**. It is stored only in your browser's `localStorage` and sent exclusively to `explorer.lichess.org` and `lichess.org/game/export/...`.

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

Then open **Settings → 2. Local UCI WebSocket Bridge** and connect to `ws://localhost:8080` (Lc0) or `ws://localhost:8081` (Stockfish).

> **Browser note:** Connecting from an HTTPS deployment to `ws://localhost` works in Chrome and Firefox; Safari may block mixed-content WebSockets on HTTPS pages.

## Licenses & Attribution

- **Application source code:** [MIT License](LICENSE).
- **Stockfish 19 WASM:** Bundled and served from the [`stockfish`](https://www.npmjs.com/package/stockfish) npm package under the **GNU General Public License v3.0 (GPLv3)**. The full license text is copied to `public/stockfish/LICENSE.txt` at build time, and the upstream source code is available at:
  - [official-stockfish/Stockfish](https://github.com/official-stockfish/Stockfish)
  - [nmrugg/stockfish.js](https://github.com/nmrugg/stockfish.js)
