import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    // src/env.ts hard-throws ("No runtime config found and
    // VITE_CLERK_PUBLISHABLE_KEY is not set") when neither a runtime config nor
    // this var is present. In the browser the value is injected at container
    // start by apps/web/nginx/entrypoint.sh; under vitest there is no such
    // injection and no .env file in the repo, so any suite whose import graph
    // reaches src/env.ts (e.g. App.auth-gate.test.tsx via src/App.tsx, and
    // src/lib/api-client.test.ts via src/lib/api-client.ts) fails to COLLECT —
    // zero tests run, which reads as a code failure but is purely environment.
    // A dummy publishable key is enough: nothing in the test suite calls Clerk.
    env: { VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_dummy' },
  },
});
