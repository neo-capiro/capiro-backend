import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from './vite.config.js';

/**
 * Vite config for the Clerk-free vNext visual harnesses
 * (`vnext-shell.html`, `vnext-workshop.html`) ONLY.
 *
 * It is the app config plus one alias: `@clerk/clerk-react` resolves to a local
 * stub. Keeping this in a separate file is the point — `vite.config.ts` builds
 * the deployed bundle and must keep resolving the real SDK. Nothing here is
 * reachable from a production build.
 *
 * Run it with `--config vite.harness.config.ts` (the session-root
 * `.claude/launch.json` `web-vnext-harness` entry already does).
 */
export default mergeConfig(base, {
  resolve: {
    alias: {
      '@clerk/clerk-react': fileURLToPath(
        new URL('./src/vnext/testing/visual/clerk-stub.tsx', import.meta.url),
      ),
      // Strategies is a container component (calls its data hooks directly,
      // no fixture-injection prop) — alias matches the literal relative
      // specifier every file in pages/strategies/ imports it by (Vite alias
      // matching is a raw-specifier string match, not a resolved-path one),
      // so the 'strategies' screen renders without touching production code.
      './strategies-api.js': fileURLToPath(
        new URL('./src/vnext/testing/visual/strategies-api-stub.ts', import.meta.url),
      ),
    },
  },
  // The Meri surfaces import the CJS subpath @capiro/shared/meri-skills. The
  // base config pre-bundles only the package root ('@capiro/shared'), and the
  // optimizer does not discover the subpath before the harness page requests
  // it — vite then serves dist/meri-skills.js raw over /@fs/ and the browser
  // dies on `exports.X = ...` (no named ESM exports). Include it explicitly.
  optimizeDeps: {
    include: ['@capiro/shared', '@capiro/shared/meri-skills'],
  },
});
