import { defineConfig, devices } from './lib/playwright-bridge.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROMIUM_ARGS, PROJECTS, LOCALE, TIMEZONE, COMPARISON } from './lib/projects.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * CleanUp1 offline visual-regression runner.
 *
 * Drives the REAL web entry served by the offline route-capture Vite config
 * (signed-in auth stub + fail-closed fixture API — no live network/auth/API)
 * through the shared Chromium at the three plan viewports. Test identities are
 * one per concrete route (from routes.inventory.json). Which routes are pages
 * vs redirects is decided from the ACTUAL navigation (landed != requested), not
 * from a static guess, so a moved/added redirect can never masquerade as a
 * passing page baseline. Playwright's own screenshot matcher enforces the plan
 * comparison policy (maxDiffPixelRatio 0.002, threshold 0.2).
 *
 * Playwright is the SHARED external runtime (C:/dev/node_modules, v1.63.0) —
 * never a dependency of this or any monorepo manifest.
 */
const BASELINES = process.env.CAPIRO_BASELINE_ROOT
  ? path.resolve(process.env.CAPIRO_BASELINE_ROOT)
  : path.join(HERE, 'baselines');

export default defineConfig({
  testDir: path.join(HERE, 'tests'),
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: path.join(HERE, 'reports', 'playwright-report.json') }]],
  timeout: 180_000,
  expect: {
    timeout: 20_000,
    toHaveScreenshot: {
      maxDiffPixelRatio: COMPARISON.maxDiffPixelRatio,
      threshold: COMPARISON.threshold,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  snapshotPathTemplate: path.join(BASELINES, '{projectName}', '{arg}{ext}'),
  use: {
    baseURL: 'http://127.0.0.1:4190',
    locale: LOCALE,
    timezoneId: TIMEZONE,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    screenshot: 'off',
    trace: 'off',
    video: 'off',
    // No service worker may sit between us and the fixture layer.
    serviceWorkers: 'block',
    // Determinism launch options (force DPR 1, hide scrollbars, direct proxy).
    launchOptions: { args: [...CHROMIUM_ARGS] },
  },
  projects: PROJECTS.map((p) => ({
    name: p.name,
    use: { ...devices['Desktop Chrome'], viewport: p.viewport, deviceScaleFactor: 1 },
  })),
  webServer: {
    command: `"${process.execPath}" "${path.join(path.resolve(HERE, '..', 'web'), 'node_modules', 'vite', 'bin', 'vite.js')}" --config src/vnext/testing/visual/vite.routes-visual.config.ts --host 127.0.0.1 --port 4190 --strictPort`,
    cwd: path.resolve(HERE, '..', 'web'),
    env: {
      VITE_WEB_SURFACE: 'vnext',
      VITE_BUILD_WEB_SURFACE: 'vnext',
      VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_visual_fixture',
    },
    url: 'http://127.0.0.1:4190/',
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
