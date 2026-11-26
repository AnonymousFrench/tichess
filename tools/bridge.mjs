// Run from repo root after `npm install`:
// ENGINE=lc0 PORT=8080 node tools/bridge.mjs
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const DEFAULT_ALLOWED_ORIGINS = ['https://tichess.vercel.app'];
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function isAllowedOrigin(origin, extraOrigins = []) {
  if (!origin || typeof origin !== 'string') return false;
  if (LOCALHOST_ORIGIN_RE.test(origin)) return true;
  const allowSet = new Set([...DEFAULT_ALLOWED_ORIGINS, ...extraOrigins]);
  return allowSet.has(origin);
}

export function startBridge() {
  const host = '127.0.0.1';
  const port = Number(process.env.PORT || 8080);
  const engineBin = process.env.ENGINE || 'lc0';
  const engineArgs = (process.env.ENGINE_ARGS || '').split(' ').filter(Boolean);
  const extraOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const wss = new WebSocketServer({
    host,
    port,
    verifyClient: ({ origin }, done) => {
      if (isAllowedOrigin(origin, extraOrigins)) {
        done(true);
      } else {
        console.warn(`[uci-bridge] Rejected connection from origin: ${origin || '(none)'}`);
        done(false, 403, 'Forbidden origin');
      }
    },
  });

  console.log(`[uci-bridge] Listening on ws://${host}:${port} -> ${engineBin} ${engineArgs.join(' ')}`);

  wss.on('connection', (ws) => {
    const proc = spawn(engineBin, engineArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
    const rl = readline.createInterface({ input: proc.stdout });

    rl.on('line', (line) => {
      if (line && ws.readyState === 1) {
        ws.send(line);
      }
    });

    proc.on('exit', () => {
      rl.close();
      if (ws.readyState === 1) ws.close();
    });

    proc.on('error', (err) => {
      console.error(`[uci-bridge] Failed to start ${engineBin}:`, err.message);
      if (ws.readyState === 1) ws.close();
    });

    ws.on('message', (msg) => {
      if (!proc.killed && proc.stdin.writable) {
        proc.stdin.write(msg.toString().trim() + '\n');
      }
    });

    ws.on('close', () => {
      rl.close();
      if (!proc.killed) proc.kill();
    });
  });

  return wss;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startBridge();
}
