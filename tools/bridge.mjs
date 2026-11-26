// npm i ws && ENGINE=lc0 PORT=8080 node tools/bridge.mjs
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const host = '127.0.0.1';
const port = Number(process.env.PORT || 8080);
const engineBin = process.env.ENGINE || 'lc0';
const engineArgs = (process.env.ENGINE_ARGS || '').split(' ').filter(Boolean);

const wss = new WebSocketServer({ host, port });
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
