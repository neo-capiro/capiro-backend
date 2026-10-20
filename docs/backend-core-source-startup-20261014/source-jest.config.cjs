const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const base = require(path.join(root, 'docs/backend-feature-flags-20261014/source-jest.config.cjs'));
module.exports = { ...base, cache: false, collectCoverage: false,
  cacheDirectory: path.join(root, '.qualification-cache/core-unit'),
  testMatch: ['<rootDir>/src/context/meetings-context-plane.runtime.spec.ts'] };
