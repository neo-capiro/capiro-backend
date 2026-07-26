import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// onboard-web had NO vitest config and NO tests: `vitest run --passWithNoTests`
// meant the package could never fail. The registration-draft logic it owns is
// the shared-browser identity boundary, so it is now covered.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // jsdom supplies localStorage/sessionStorage, which the draft store uses.
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
