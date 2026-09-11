import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
// QA only: production components and tokens; deterministic transport.
const stub = fileURLToPath(new URL('./src/parity-legiwatch-reports/transport.ts', import.meta.url));
export default defineConfig({
  plugins: [react()],
  resolve: { alias: [{ find: /^(?:\.\.\/)+lib\/use-api(?:-scope)?\.js$/, replacement: stub }] },
  optimizeDeps: { entries: ['legiwatch-reports-parity.html'] },
  server: { host: '127.0.0.1', port: 5262, strictPort: true, open: false },
});
