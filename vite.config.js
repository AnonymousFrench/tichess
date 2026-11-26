import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const COOP_COEP_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    headers: COOP_COEP_HEADERS,
  },
  preview: {
    headers: COOP_COEP_HEADERS,
  },
  build: {
    target: 'es2022',
  },
  test: {
    include: ['tests/**/*.test.js'],
  },
});
