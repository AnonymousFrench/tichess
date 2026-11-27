import { resolve } from 'node:path';
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
    proxy: {
      '/api/humanfish': {
        target: process.env.HUMANFISH_API_URL || 'https://humanfish.vercel.app',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/humanfish/, '/api'),
      },
    },
  },
  preview: {
    headers: COOP_COEP_HEADERS,
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        repertoire: resolve(import.meta.dirname, 'repertoire.html'),
        insights: resolve(import.meta.dirname, 'insights.html'),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.js'],
  },
});
