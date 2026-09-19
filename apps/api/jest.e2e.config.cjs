/**
 * The PROVISIONED e2e tier for apps/api.
 *
 * Meri/Hermes Phase 1, required fix 6a. The default config
 * (jest.config.cjs) now ignores every `*.e2e.spec.ts`, so the ordinary suite
 * — including the broad `jest src/meri/hermes` command — is hermetic apart
 * from the local fixture Postgres that the DB-integration specs already
 * need. This config is the other half of that split: it collects ONLY the
 * e2e specs, and it is the only config whose specs require provisioned
 * infrastructure (docker, the pinned Hermes worker image, the reference
 * container that supplies the gateway/model credentials, a free host port).
 *
 * Invoke it explicitly — nothing runs it implicitly:
 *
 *   pnpm --filter @capiro/api test:e2e
 *   pnpm --filter @capiro/api test:e2e:meri-hermes
 *
 * Everything else (transform, moduleNameMapper, setupFiles, the ESM carve-out)
 * is inherited verbatim from jest.config.cjs so the two tiers cannot drift.
 */
const base = require('./jest.config.cjs');

module.exports = {
  ...base,

  testMatch: ['<rootDir>/src/**/*.e2e.spec.ts', '<rootDir>/test/**/*.e2e.spec.ts'],

  // Undo the default config's e2e exclusion — that is the whole point here.
  testPathIgnorePatterns: ['/node_modules/'],

  /**
   * Prerequisite preflight. Runs BEFORE the spec module is evaluated, so a
   * missing worker container aborts with one actionable message instead of
   * hanging on a docker call or dying inside fixture setup.
   *
   * setupFilesAfterEnv (not globalSetup) on purpose: it is per test file, so
   * it can read `expect.getState().testPath` and demand only the
   * prerequisites that THAT spec actually has. globalSetup cannot see which
   * files were selected.
   */
  setupFilesAfterEnv: [...(base.setupFilesAfterEnv ?? []), '<rootDir>/jest.e2e.preflight.cjs'],

  /**
   * These specs boot a real Nest app, a real Postgres fixture and (for the
   * Hermes gate) a real container running a real model turn. Parallel workers
   * against one shared Postgres are flaky, and the specs bind fixed host
   * ports, so they must not overlap.
   */
  maxWorkers: 1,
};
