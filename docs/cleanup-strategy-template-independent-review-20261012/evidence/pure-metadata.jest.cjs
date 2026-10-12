const path = require('node:path');
const rootDir = path.resolve(__dirname, '../../../apps/api-strategy');
const original = require(path.join(rootDir, 'jest.config.cjs'));
module.exports = {
  ...original,
  rootDir,
  setupFiles: [],
  moduleDirectories: ['/workspace/capirov2/apps/api/node_modules', 'node_modules'],
  cacheDirectory: '/tmp/capirov2-strategy-template-independent-review-jest-cache',
  testMatch: [
    '<rootDir>/src/context/frontmatter.spec.ts',
    '<rootDir>/src/context/template-registry.spec.ts',
    '<rootDir>/src/reports/report-context.spec.ts',
  ],
};
