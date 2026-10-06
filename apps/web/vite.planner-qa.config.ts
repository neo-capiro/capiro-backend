import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(
  new URL('./src/vnext/testing/visual/planner-qa-api.ts', import.meta.url),
);
/** Dev-only synthetic transport. Production's index.html and build never load this fixture. */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^(?:\.\.\/)+lib\/use-api\.js$/, replacement: fixture },
      {
        find: '@clerk/clerk-react',
        replacement: fileURLToPath(new URL('./src/parity/stubs/clerk.ts', import.meta.url)),
      },
    ],
  },
  optimizeDeps: { entries: ['planner-qa.html'], include: ['@capiro/strategy-verifier'] },
  server: { host: '127.0.0.1', port: 4196, strictPort: true, fs: { strict: false } },
});
