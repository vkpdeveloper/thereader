import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = 'http://127.0.0.1:8787';
const extract = fileURLToPath(new URL('../../packages/extract', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@thereader/extract': `${extract}/src/index.ts` },
  },
  server: {
    port: 5173,
    fs: { allow: ['.', extract] },
    proxy: {
      '/v1': { target: api, changeOrigin: true },
      '/health': { target: api, changeOrigin: true },
      '/cdn': { target: api, changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/v1': { target: api, changeOrigin: true },
      '/health': { target: api, changeOrigin: true },
      '/cdn': { target: api, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2020',
  },
});
