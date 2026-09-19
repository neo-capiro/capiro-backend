import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config.js';

export default defineConfig(({ command }) => {
  if (command !== 'serve') throw new Error('LegiWatch QA harness is serve-only');
  return mergeConfig(base, {
    server: { host: '127.0.0.1', port: 5176, strictPort: true },
    appType: 'mpa',
    plugins: [
      {
        name: 'legiwatch-qa-entry',
        configureServer(server) {
          server.middlewares.use((request, _response, next) => {
            if (request.url?.split('?')[0] === '/legiwatch') {
              request.url = `/legiwatch-qa.html${request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''}`;
            }
            next();
          });
        },
      },
    ],
    resolve: {
      alias: [
        { find: /^@clerk\/clerk-react$/, replacement: fileURLToPath(new URL('./src/vnext/testing/visual/legiwatch-qa-auth.tsx', import.meta.url)) },
        { find: /^.*[\/]use-api(?:\.js|\.ts)?$/, replacement: fileURLToPath(new URL('./src/vnext/testing/visual/legiwatch-qa-api.ts', import.meta.url)) },
      ],
    },
  });
});
