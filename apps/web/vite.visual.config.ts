import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from './vite.config.js';

// Explicitly selected by the offline screenshot job. Normal development and
// production builds use vite.config.ts and the real authentication/API modules.
export default defineConfig(({ command }) => {
  if (command !== 'serve') throw new Error('The visual fixture config is serve-only');
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
            new URL('./src/vnext/testing/visual/api-fixture.ts', import.meta.url),
          ),
        },
      ],
    },
  });
});
