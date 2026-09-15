import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from './vite.config.js';

/**
 * Meri vNext visual harness config (serve-only, dev/test).
 *
 * Same shape as vite.visual.config.ts, but the use-api alias points at the
 * Meri fixture (meri-visual-api.ts) instead of the shared reject-everything
 * fixture, so the Meri rail/composer/context reads resolve to reference
 * fixture data. The shared vite.visual.config.ts and its other screens keep
 * their original behavior untouched.
 */
export default defineConfig(({ command }) => {
  if (command !== 'serve') throw new Error('The Meri visual fixture config is serve-only');
  return mergeConfig(baseConfig, {
    resolve: {
      alias: [
        {
          find: /^@clerk\/clerk-react$/,
          replacement: fileURLToPath(
            new URL('./src/vnext/testing/visual/auth-fixture.tsx', import.meta.url),
          ),
        },
        {
          find: /^(?:.*\/)?use-api(?:\.js|\.ts)?$/,
          replacement: fileURLToPath(
            new URL('./src/vnext/testing/visual/meri-visual-api.ts', import.meta.url),
          ),
        },
      ],
    },
  });
});
