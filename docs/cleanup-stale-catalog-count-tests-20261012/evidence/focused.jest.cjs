const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const api = path.join(root, 'apps/api');
module.exports = {
  rootDir: root,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/apps/**/*.spec.ts'],
  maxWorkers: 1,
  transform: {
    '^.+\\.ts$': [require.resolve('ts-jest', { paths: [api] }), {
      diagnostics: false,
      tsconfig: { module: 'commonjs', target: 'ES2022', esModuleInterop: true, resolveJsonModule: true, isolatedModules: true, experimentalDecorators: true },
    }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@nestjs/common$': require.resolve('@nestjs/common', { paths: [api] }),
    '^@capiro/shared$': path.join(root, 'packages/shared/src/index.ts'),
  },
};
