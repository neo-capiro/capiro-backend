const path = require('node:path');
module.exports = {
  rootDir: process.env.MIGRATION_SOURCE_TEST_ROOT || path.resolve(__dirname, '../../../apps/api'),
  testEnvironment: '/workspace/capirov2/node_modules/.pnpm/jest-environment-node@29.7.0/node_modules/jest-environment-node/build/index.js',
  transform: { '^.+\\.ts$': ['/workspace/capirov2/apps/api/node_modules/ts-jest', {
    diagnostics: false,
    tsconfig: { target: 'ES2022', module: 'CommonJS', moduleResolution: 'Node',
      esModuleInterop: true, isolatedModules: true, strict: true, noUncheckedIndexedAccess: true },
  }] },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  moduleDirectories: ['/workspace/capirov2/apps/api/node_modules', 'node_modules'],
  testMatch: ['<rootDir>/scripts/lib/pe-migration-guards.spec.ts', '<rootDir>/scripts/lib/pe-phase-a-safety.spec.ts'],
};
