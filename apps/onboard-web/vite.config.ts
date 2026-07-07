import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
    // Local dev: the API runs on :4400; same-origin in prod (one container).
    proxy: {
      '/onboard-api': {
        target: 'http://localhost:4400',
        changeOrigin: false,
      },
    },
  },
  optimizeDeps: {
    include: ['@capiro/shared'],
  },
  build: {
    commonjsOptions: {
      include: [/packages\/shared\/dist/, /node_modules/],
      transformMixedEsModules: true,
    },
  },
});
