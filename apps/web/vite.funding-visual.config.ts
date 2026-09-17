import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import baseConfig from './vite.config.js';

export default defineConfig(({ command }) => {
  if (command !== 'serve') throw new Error('The funding visual fixture config is serve-only');
  return mergeConfig(baseConfig, {
    appType: 'spa',
    plugins: [{
      name: 'funding-opportunities-v2-preview-fallback',
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          if (request.url?.startsWith('/intelligence/opportunities')) {
            const query = request.url.indexOf('?');
            request.url = `/funding-opportunities-v2-preview.html${query >= 0 ? request.url.slice(query) : ''}`;
          }
          next();
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use((request, _response, next) => {
          if (request.url?.startsWith('/intelligence/opportunities')) {
            const query = request.url.indexOf('?');
            request.url = `/funding-opportunities-v2-preview.html${query >= 0 ? request.url.slice(query) : ''}`;
          }
          next();
        });
      },
    }],
    optimizeDeps: {
      entries: ['./funding-opportunities-v2-preview.html'],
      include: ['@capiro/shared', '@capiro/shared/funding-claim', '@capiro/strategy-verifier'],
    },
    resolve: {
      alias: [
        { find: /^@clerk\/clerk-react$/, replacement: fileURLToPath(new URL('./src/vnext/testing/visual/auth-fixture.tsx', import.meta.url)) },
        { find: /^(?:.*\/)?use-api(?:\.js|\.ts)?$/, replacement: fileURLToPath(new URL('./src/vnext/testing/visual/funding-opportunities-v2-fixture-api.ts', import.meta.url)) },
      ],
    },
  });
});