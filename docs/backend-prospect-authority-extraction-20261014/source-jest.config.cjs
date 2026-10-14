const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const base = require(path.join(root, 'apps/api/jest.config.cjs'));
module.exports = {
  ...base, rootDir: path.join(root, 'apps/api'), roots: [path.join(root, 'apps/api')],
  setupFiles: [], setupFilesAfterEnv: [path.join(root, 'docs/backend-cleanup-receiving-20261014/source-only-fence.cjs')],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs', target: 'ES2022', experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true, useDefineForClassFields: false }, diagnostics: false, isolatedModules: true }] },
  cache: false, cacheDirectory: path.join(root, '.qualification-cache/prospect-authority'), collectCoverage: false,
};
