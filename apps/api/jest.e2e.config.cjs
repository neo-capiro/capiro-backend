/**
 * The PROVISIONED e2e tier for apps/api.
 *
 * The default config ignores every `*.e2e.spec.ts`; this config collects only
 * that provisioned tier.
 *
 * Invoke it explicitly — nothing runs it implicitly:
 *
 *   pnpm --filter @capiro/api test:e2e

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
   * These specs boot real services and share fixture resources, so they must
   * not overlap.
   */
  maxWorkers: 1,
};
