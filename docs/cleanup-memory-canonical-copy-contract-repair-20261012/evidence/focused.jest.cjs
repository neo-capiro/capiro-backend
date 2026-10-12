const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const api = path.join(root, 'apps/api');
const jest = path.dirname(require.resolve('jest/package.json', { paths: [api] }));
module.exports = {
  rootDir: root,
  roots: [api, path.join(root, 'packages/shared')],
  modulePathIgnorePatterns: ['<rootDir>/apps/api/src/engagement/engagement\\.service\\.ts$'],
  testEnvironment: require.resolve('jest-environment-node', { paths: [jest] }),
  testMatch: ['<rootDir>/apps/**/*.spec.ts'],
  maxWorkers: 1,
  cache: false,
  transform: {
    '^.+\\.ts$': [require.resolve('ts-jest', { paths: [api] }), {
      diagnostics: false,
      tsconfig: { module: 'commonjs', target: 'ES2022', esModuleInterop: true, resolveJsonModule: true, isolatedModules: true, experimentalDecorators: true },
    }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@capiro/shared$': path.join(root, 'packages/shared/src/index.ts'),
  },
};
