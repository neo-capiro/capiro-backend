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
    },
  },
});
