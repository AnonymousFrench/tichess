import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const srcDir = resolve(root, 'node_modules/onnxruntime-web/dist');
const outDir = resolve(root, 'public/ort');

const files = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];

mkdirSync(outDir, { recursive: true });

for (const file of files) {
  const from = resolve(srcDir, file);
  const to = resolve(outDir, file);
  if (!existsSync(from)) {
    console.error(`[copy-ort] Missing source file: ${from}`);
    process.exit(1);
  }
  copyFileSync(from, to);
}

console.log('[copy-ort] Copied ONNX Runtime Web WASM assets to public/ort/');
