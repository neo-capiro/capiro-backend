import { defineConfig, devices } from '../lib/playwright-bridge.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROMIUM_ARGS, LOCALE, TIMEZONE, ONBOARD_PROJECT } from '../lib/projects.mjs';

/**
 * SEPARATE native smoke gate for apps/onboard-web (round-14).
 *
 * onboard-web is its own Vite React app with its own server/source. This config
 * drives its REAL entry through the offline smoke Vite config (signed-out Clerk
 * stub + /onboard-api/public/config fixture) on its own port, at one desktop
 * viewport. It is deliberately NOT part of the apps/web route-capture runner:
 * the apps/web /onboarding/subscribe redirect is a different surface and is not
 * this app's smoke.
 *
 * Run from apps/e2e:
 *   node scripts/run-playwright.mjs test --config smoke-onboard/playwright.onboard.config.ts
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ONBOARD = path.resolve(HERE, '..', '..', 'onboard-web');

export default defineConfig({
  testDir: HERE,
  testMatch: /onboard-smoke\.spec\.ts/,
  // A DEDICATED output dir (NOT the shared apps/e2e/test-results the route
  // capture uses). Without this the onboard run's default output dir collided
  // with — and erased — the route-capture test-results diagnostics.
  outputDir: path.join(HERE, 'test-results'),
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: 'http://127.0.0.1:4192',
    locale: LOCALE,
    timezoneId: TIMEZONE,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    screenshot: 'off',
    trace: 'off',
    video: 'off',
    serviceWorkers: 'block',
    launchOptions: { args: [...CHROMIUM_ARGS] },
  },
  projects: [
    {
      name: ONBOARD_PROJECT.name,
      use: { ...devices['Desktop Chrome'], viewport: { ...ONBOARD_PROJECT.viewport }, deviceScaleFactor: 1 },
    },
  ],
  webServer: {
    command: `"${process.execPath}" "${path.join(ONBOARD, 'node_modules', 'vite', 'bin', 'vite.js')}" --config smoke/vite.onboard-smoke.config.ts --host 127.0.0.1 --port 4192 --strictPort`,
    cwd: ONBOARD,
    url: 'http://127.0.0.1:4192/',
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
