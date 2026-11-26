import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const srcDir = resolve(root, 'node_modules/stockfish/bin');
const outDir = resolve(root, 'public/stockfish');

const files = [
  'stockfish-19-lite-single.js',
  'stockfish-19-lite-single.wasm',
];

mkdirSync(outDir, { recursive: true });

for (const file of files) {
  const from = resolve(srcDir, file);
  const to = resolve(outDir, file);
  if (!existsSync(from)) {
    console.error(`[copy-stockfish] Missing source file: ${from}`);
    process.exit(1);
  }
  copyFileSync(from, to);
}

const licenseFrom = resolve(root, 'node_modules/stockfish/Copying.txt');
if (existsSync(licenseFrom)) {
  copyFileSync(licenseFrom, resolve(outDir, 'LICENSE.txt'));
}

console.log('[copy-stockfish] Copied Stockfish 19 lite-single WASM and LICENSE.txt to public/stockfish/');
