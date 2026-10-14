const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
module.exports = { rootDir: root, roots: [path.join(root, 'apps/api/src/context')],
  testEnvironment: 'node', testMatch: ['**/meetings-context-plane.runtime.spec.ts'],
  setupFiles: [], cache: false, maxWorkers: 1,
  cacheDirectory: path.join(root, '.qualification-cache/meetings-unit'),
  transform: { '^.+\\.ts$': path.join(__dirname, 'typescript-transformer.cjs') },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
};
