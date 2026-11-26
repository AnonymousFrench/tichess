const SHORTCUTS = [
  ['← / →', 'Previous / next move'],
  ['Home / End', 'First / last move'],
  ['f', 'Flip board'],
  ['Space', 'Start or stop engines'],
  ['[ / ]', 'Smaller / larger board'],
  ['=', 'Fit board to screen'],
  ['Alt+N', 'New analysis tab'],
  ['?', 'Show this list'],
];

const MODALS_HTML = `
  <!-- Keyboard Shortcuts -->
  <div id="shortcutsModal" class="hidden fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
    <div class="bg-panel border border-borderBright rounded-lg w-full max-w-sm p-4 shadow-2xl">
      <div class="flex items-center justify-between mb-2">
        <h2 class="font-bold text-sm">Keyboard shortcuts</h2>
        <button class="modal-close text-txtMuted hover:text-txt px-1.5" aria-label="Close modal">✕</button>
      </div>
      <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
        ${SHORTCUTS.map(([k, d]) => `<kbd class="font-mono text-[11px] px-1.5 py-0.5 rounded bg-surface border border-borderSubtle text-txt justify-self-start">${k}</kbd><span class="text-txtMuted">${d}</span>`).join('')}
      </div>
    </div>
  </div>

  <!-- Promotion Modal -->
  <div id="promotionModal" class="hidden fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
    <div class="bg-panel border border-borderBright rounded-lg p-4 shadow-2xl">
      <div class="text-[11px] font-semibold uppercase tracking-wider text-txtMuted text-center mb-3">Promote Pawn</div>
      <div id="promotionChoices" class="flex gap-2"></div>
    </div>
  </div>

  <!-- Load FEN / PGN Modal -->
  <div id="loadModal" class="hidden fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
    <div class="bg-panel border border-borderBright rounded-lg w-full max-w-lg p-4 shadow-2xl flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <h2 class="font-bold text-sm">Load PGN or FEN into New Tab</h2>
        <button class="modal-close text-txtMuted hover:text-txt px-1.5" aria-label="Close modal">✕</button>
      </div>
      <input id="loadTabTitle" type="text" placeholder="Optional tab title..." class="w-full px-2.5 py-1.5 rounded bg-surface border border-borderSubtle text-xs focus:outline-none focus:border-em" />
      <textarea id="loadPgnTextarea" rows="7" placeholder="Paste PGN or FEN here..." class="w-full p-2.5 rounded bg-surface border border-borderSubtle font-mono text-xs focus:outline-none focus:border-em resize-y"></textarea>
      <div class="flex justify-end gap-2">
        <button class="modal-close px-3 py-1.5 rounded bg-surface border border-borderSubtle text-xs">Cancel</button>
        <button id="btnConfirmLoad" class="px-4 py-1.5 rounded bg-em text-[#041f15] font-semibold text-xs">Load</button>
      </div>
    </div>
  </div>

  <!-- Player Scout Modal (Lichess + Chess.com Sync + Local PGN Import) -->
  <div id="scoutModal" class="hidden fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
    <div class="bg-panel border border-borderBright rounded-lg w-full max-w-md max-h-[90vh] overflow-y-auto p-4 shadow-2xl flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <h2 class="font-bold text-sm">Player Scout — Lichess, Chess.com &amp; Local PGN</h2>
        <button class="modal-close text-txtMuted hover:text-txt px-1.5" aria-label="Close modal">✕</button>
      </div>

      <div class="p-3 rounded bg-surface/60 border border-borderSubtle flex flex-col gap-2">
        <div class="text-xs font-semibold text-cy">Sync Lichess Username (No Token Needed)</div>
        <div class="flex gap-1.5">
          <input id="scLichessUser" type="text" placeholder="e.g. DrNykterstein, Alireza2003" class="flex-1 min-w-0 px-2.5 py-1.5 rounded bg-panel border border-borderSubtle text-xs focus:outline-none focus:border-cy" />
          <select id="scLichessMax" class="px-2 py-1.5 rounded bg-panel border border-borderSubtle text-xs" aria-label="Max Lichess games">
            <option value="50">50</option>
            <option value="100" selected>100</option>
            <option value="200">200</option>
            <option value="300">300</option>
          </select>
        </div>
        <select id="scLichessPerf" class="w-full px-2.5 py-1.5 rounded bg-panel border border-borderSubtle text-xs" aria-label="Lichess time control">
          <option value="">All standard speeds</option>
          <option value="blitz,rapid,classical" selected>Blitz, Rapid &amp; Classical</option>
          <option value="rapid,classical">Rapid &amp; Classical only</option>
          <option value="bullet,blitz">Bullet &amp; Blitz only</option>
        </select>
        <button id="btnRunLichessSync" class="w-full py-1.5 rounded bg-cy hover:bg-cyan-400 text-[#041f15] font-semibold text-xs">Sync Lichess Games</button>
      </div>

      <div class="p-3 rounded bg-surface/60 border border-borderSubtle flex flex-col gap-2">
        <div class="text-xs font-semibold text-em">Sync Chess.com Username (No Token Needed)</div>
        <div class="flex gap-1.5">
          <input id="scChesscomUser" type="text" placeholder="e.g. Hikaru, MagnusCarlsen" class="flex-1 px-2.5 py-1.5 rounded bg-panel border border-borderSubtle text-xs focus:outline-none focus:border-em" />
          <select id="scChesscomMonths" class="px-2 py-1.5 rounded bg-panel border border-borderSubtle text-xs" aria-label="Chess.com archive months">
            <option value="2">2 mo</option>
            <option value="4" selected>4 mo</option>
            <option value="8">8 mo</option>
          </select>
        </div>
        <button id="btnRunChesscomSync" class="w-full py-1.5 rounded bg-em hover:bg-emerald-400 text-[#041f15] font-semibold text-xs">Sync Chess.com Games</button>
      </div>

      <div id="scProgressWrap" class="hidden p-2.5 rounded bg-surface/60 border border-borderSubtle flex flex-col gap-1">
        <div class="flex justify-between text-[10px] font-mono text-txtMuted">
          <span id="scProgressText">Syncing...</span>
          <span id="scProgressPct">0%</span>
        </div>
        <div class="w-full h-1.5 rounded-full bg-panel overflow-hidden">
          <div id="scProgressBar" class="h-full bg-em transition-all" style="width:0%"></div>
        </div>
      </div>

      <div id="scoutSyncedTargetsBox" class="hidden p-2.5 rounded bg-em/10 border border-em/30 flex flex-col gap-1.5">
        <div class="text-[11px] font-semibold text-em">☁ Synced from your other devices</div>
        <div id="scoutSyncedTargetsList" class="flex flex-wrap gap-1.5"></div>
      </div>

      <div class="p-3 rounded bg-surface/60 border border-borderSubtle flex flex-col gap-2">
        <div class="text-xs font-semibold text-vi">Import Local .PGN Database</div>
        <input id="scPgnPlayerFilter" type="text" placeholder="Optional player name for W/D/L perspective..." class="w-full px-2.5 py-1.5 rounded bg-panel border border-borderSubtle text-xs focus:outline-none focus:border-vi" />
        <label class="w-full py-2 rounded border border-dashed border-borderBright hover:border-vi bg-panel text-center text-xs font-medium cursor-pointer">
          Choose .PGN File
          <input id="scPgnFileInput" type="file" accept=".pgn,.txt" class="hidden" />
        </label>
      </div>
    </div>
  </div>

  <!-- Settings Modal (Cloud Sync + Lichess Token + Local UCI WebSocket Bridge + Storage + Licenses) -->
  <div id="settingsModal" class="hidden fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
    <div class="bg-panel border border-borderBright rounded-lg w-full max-w-xl max-h-[90vh] overflow-y-auto p-4 shadow-2xl flex flex-col gap-3.5">
      <div class="flex items-center justify-between">
        <h2 class="font-bold text-sm">Studio Settings, Cloud Sync &amp; Local Bridge</h2>
        <button class="modal-close text-txtMuted hover:text-txt px-1.5" aria-label="Close modal">✕</button>
      </div>

      <!-- Cloud Sync (Neon Postgres + Sign in with Lichess) -->
      <div class="p-3 rounded bg-surface/60 border border-cy/35 flex flex-col gap-2">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-semibold text-cy">☁ Phone ↔ Computer Cloud Sync (Lichess + Neon)</span>
          <span id="settingsSyncStatusBadge" class="font-mono text-[10px] px-1.5 py-0.5 rounded bg-panel text-txtMuted">Checking...</span>
        </div>
        <p id="settingsSyncDesc" class="text-[11px] text-txtMuted leading-relaxed">
          Sign in with Lichess (zero scopes needed) to automatically sync your opening repertoire, spaced-repetition drill progress, and scouted player list between phone and desktop.
        </p>
        <div class="flex items-center gap-2 flex-wrap">
          <button id="btnSettingsSignIn" class="px-3 py-1.5 rounded bg-em hover:bg-emerald-400 text-[#041f15] font-semibold text-xs">Sign in with Lichess</button>
          <button id="btnSettingsSyncNow" class="hidden px-3 py-1.5 rounded bg-cy/20 hover:bg-cy/30 text-cy border border-cy/40 font-semibold text-xs">↻ Sync Now</button>
          <button id="btnSettingsSignOut" class="hidden px-2.5 py-1.5 rounded bg-ro/15 hover:bg-ro/25 text-ro border border-ro/30 text-xs">Sign out</button>
        </div>
      </div>

      <!-- Lichess Token -->
      <div class="p-3 rounded bg-surface/60 border border-borderSubtle flex flex-col gap-2">
        <div class="text-xs font-semibold text-em">1. Lichess Personal Access Token (Optional)</div>
        <p class="text-[11px] text-txtMuted">
          Unlocks full-depth Masters OTB &amp; Lichess Opening Explorer APIs (Live Broadcasts &amp; Cloud Eval work without a token).
          <span class="text-txt">Leave all scopes unchecked</span> — Explorer only needs an unscoped read token.
          <a href="https://lichess.org/account/oauth/token/create?description=tichess" target="_blank" rel="noopener noreferrer" class="text-cy hover:underline">Get free token ↗</a>
        </p>
        <div class="flex gap-2">
          <input id="inputLichessToken" type="password" placeholder="lip_xxxxxxxxxxxxxxxxxxxx" class="flex-1 px-2.5 py-1.5 rounded bg-panel border border-borderSubtle font-mono text-xs focus:outline-none focus:border-em" />
          <button id="btnSaveToken" class="px-3 py-1.5 rounded bg-em text-[#041f15] font-semibold text-xs">Save</button>
          <button id="btnClearToken" class="px-2.5 py-1.5 rounded bg-ro/15 text-ro border border-ro/30 text-xs">Clear</button>
        </div>
      </div>

      <!-- Local UCI WebSocket Bridge -->
      <div class="p-3 rounded bg-surface/60 border border-borderSubtle flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-vi">2. Local UCI WebSocket Bridge (Real GPU Lc0 / Native Stockfish)</span>
          <span id="bridgeStatusBadge" class="font-mono text-[10px] px-1.5 py-0.5 rounded bg-panel text-txtMuted">No Bridge Connected</span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <label class="text-[10.5px] text-txtMuted block mb-1">Lc0 WebSocket URL</label>
            <div class="flex gap-1">
              <input id="inputLc0WsUrl" type="text" placeholder="ws://localhost:8080" class="flex-1 min-w-0 px-2 py-1 rounded bg-panel border border-borderSubtle font-mono text-[11px]" />
              <button id="btnConnectLc0Ws" class="px-2 py-1 rounded bg-vi/20 hover:bg-vi/30 text-vi border border-vi/40 text-[11px] font-semibold">Connect</button>
              <button id="btnDisconnectLc0Ws" class="px-1.5 py-1 rounded bg-surface hover:bg-surfaceHover text-txtMuted border border-borderSubtle text-[11px]" title="Disconnect Lc0" aria-label="Disconnect Lc0">✕</button>
            </div>
          </div>
          <div>
            <label class="text-[10.5px] text-txtMuted block mb-1">Stockfish WebSocket URL</label>
            <div class="flex gap-1">
              <input id="inputSfWsUrl" type="text" placeholder="ws://localhost:8081" class="flex-1 min-w-0 px-2 py-1 rounded bg-panel border border-borderSubtle font-mono text-[11px]" />
              <button id="btnConnectSfWs" class="px-2 py-1 rounded bg-cy/20 hover:bg-cy/30 text-cy border border-cy/40 text-[11px] font-semibold">Connect</button>
              <button id="btnDisconnectSfWs" class="px-1.5 py-1 rounded bg-surface hover:bg-surfaceHover text-txtMuted border border-borderSubtle text-[11px]" title="Disconnect SF" aria-label="Disconnect Stockfish">✕</button>
            </div>
          </div>
        </div>
        <p class="text-[10.5px] text-txtMuted">
          Works from HTTPS deployments in Chrome and Firefox (<code class="font-mono text-txt/90">ws://localhost</code>); Safari may block mixed-content WebSockets on HTTPS pages. Only allows <code class="font-mono text-txt/90">tichess.vercel.app</code> and <code class="font-mono text-txt/90">localhost</code> origins.
        </p>
        <div>
          <div class="flex items-center justify-between mb-1">
            <span class="text-[10.5px] text-txtMuted font-semibold">Node.js UCI Bridge Script (tools/bridge.mjs)</span>
            <button id="btnCopyBridgeScript" class="text-[10.5px] text-cy hover:underline font-mono">Copy Script</button>
          </div>
          <pre id="bridgeScriptCode" class="p-2 rounded bg-[#0b0f17] border border-borderSubtle font-mono text-[10px] text-txtMuted overflow-x-auto leading-relaxed">// ENGINE=lc0 PORT=8080 node tools/bridge.mjs
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const OK = (o) =&gt; o === 'https://tichess.vercel.app' || /^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?$/.test(o || '');
const wss = new WebSocketServer({ host: '127.0.0.1', port: Number(process.env.PORT || 8080), verifyClient: ({ origin }, cb) =&gt; cb(OK(origin), 403, 'Forbidden') });
wss.on('connection', (ws) =&gt; {
  const proc = spawn(process.env.ENGINE || 'lc0', (process.env.ENGINE_ARGS || '').split(' ').filter(Boolean));
  readline.createInterface({ input: proc.stdout }).on('line', (l) =&gt; l &amp;&amp; ws.readyState === 1 &amp;&amp; ws.send(l));
  proc.on('exit', () =&gt; ws.close());
  ws.on('message', (m) =&gt; proc.stdin.write(m.toString().trim() + '\\n'));
  ws.on('close', () =&gt; proc.kill());
});</pre>
        </div>
      </div>

      <!-- IndexedDB Storage -->
      <div class="p-3 rounded bg-surface/60 border border-borderSubtle flex items-center justify-between">
        <div>
          <div class="text-xs font-semibold">3. Local Player Databases (IndexedDB)</div>
          <div id="settingsDbInfo" class="text-[11px] text-txtMuted mt-0.5">Checking local storage...</div>
        </div>
        <button id="btnWipeDb" class="px-3 py-1.5 rounded bg-ro/15 hover:bg-ro/25 text-ro border border-ro/30 text-xs font-medium">Clear All DBs</button>
      </div>

      <!-- About & Open Source Licenses -->
      <div class="p-3 rounded bg-surface/60 border border-borderSubtle flex flex-col gap-1">
        <div class="text-xs font-semibold">4. About &amp; Licenses</div>
        <p class="text-[11px] text-txtMuted leading-relaxed">
          Bundles <span class="text-txt">Stockfish 19 Lite WASM</span> under the
          <a href="/stockfish/LICENSE.txt" target="_blank" rel="noopener noreferrer" class="text-cy hover:underline">GNU GPLv3</a>
          (<a href="https://github.com/official-stockfish/Stockfish" target="_blank" rel="noopener noreferrer" class="text-cy hover:underline">Stockfish source ↗</a> ·
          <a href="https://github.com/nmrugg/stockfish.js" target="_blank" rel="noopener noreferrer" class="text-cy hover:underline">stockfish.js ↗</a>).
          Studio UI source is licensed under MIT.
        </p>
      </div>
    </div>
  </div>
`;

export function mountModals(container = document.getElementById('modalsRoot')) {
  if (!container) return;
  container.innerHTML = MODALS_HTML;
}
