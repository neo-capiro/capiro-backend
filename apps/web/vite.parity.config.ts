import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Phase 7 — the visual-parity harness dev server. DEV/QA ONLY.
 *
 * `pnpm --filter @capiro/web parity` serves `parity.html`, which mounts the REAL
 * Strategy Planner components (header, timeline, Meri panel, Watch panel,
 * library) through the REAL `api.ts` hooks and a real QueryClient, with only the
 * axios transport and Clerk aliased to deterministic stubs. That is what makes a
 * screenshot comparison against the prototype meaningful: the components, the
 * design-system CSS, the antd theme and the fonts are production's, and only the
 * DATA is fixed.
 *
 * It is a separate config on purpose — `index.html` (the product entry) is
 * untouched, `vite build` never sees `parity.html`, and nothing here ships.
 *
 * The two aliases:
 *  · `../../lib/use-api.js` — every strategy hook gets its axios-like client
 *    from here, so replacing this one module makes the whole data layer
 *    deterministic without stubbing a single hook.
 *  · `@clerk/clerk-react` — the editor reads the signed-in user; the real
 *    provider would need a publishable key and a live session.
 *
 * The relative-specifier alias matches importers exactly two levels below
 * `src/` (`src/pages/strategy/*`), which is every strategy module that fetches.
 */
const stub = (p: string) => fileURLToPath(new URL(`./src/parity/stubs/${p}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Every depth the strategy tree (and lib/me.ts, which sits NEXT to it)
      // reaches this module from.
      { find: /^\.\/use-api\.js$/, replacement: stub('use-api.ts') },
      { find: /^\.\.\/lib\/use-api\.js$/, replacement: stub('use-api.ts') },
      { find: /^\.\.\/\.\.\/lib\/use-api\.js$/, replacement: stub('use-api.ts') },
      { find: /^\.\.\/\.\.\/\.\.\/lib\/use-api\.js$/, replacement: stub('use-api.ts') },
      { find: '@clerk/clerk-react', replacement: stub('clerk.ts') },
    ],
  },
  // src/env.ts THROWS at import time without a runtime config or a publishable
  // key, and the strategy tree reaches it transitively. A dummy key keeps the
  // harness self-contained (nothing here talks to Clerk — see stubs/clerk.ts).
  define: {
    'import.meta.env.VITE_CLERK_PUBLISHABLE_KEY': JSON.stringify('pk_test_parity_harness'),
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify('http://127.0.0.1:0'),
  },
  optimizeDeps: {
    include: ['@capiro/shared'],
    // Scan ONLY the harness entry. Vite's default is every *.html in the root,
    // which would pull index.html -> App.tsx -> the full product tree through
    // the Clerk stub and fail on exports the harness has no use for.
    entries: ['parity.html'],
  },
  server: {
    port: 5199,
    host: '127.0.0.1',
    open: false,
    fs: { strict: false },
  },
});
