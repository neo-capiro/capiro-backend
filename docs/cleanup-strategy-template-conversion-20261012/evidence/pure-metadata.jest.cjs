const path = require('node:path');
const rootDir = path.resolve(__dirname, '../../../apps/api-strategy');
const existing = require(path.join(rootDir, 'jest.config.cjs'));
module.exports = {
  ...existing,
  rootDir,
  // These three pure modules need no Nest/Clerk environment setup. The
  // production config is untouched; all existing resolver/transform settings
  // and every original test in both existing specs are retained.
  setupFiles: [],
  cacheDirectory: '/tmp/capirov2-strategy-template-conversion-jest-cache-20261012',
  testMatch: [
    '<rootDir>/src/context/frontmatter.spec.ts',
    '<rootDir>/src/context/template-registry.spec.ts',
    '<rootDir>/src/reports/report-context.spec.ts',
  ],
};
