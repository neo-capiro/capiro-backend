const path = require('node:path');
const root = path.resolve(__dirname, '../..');
module.exports = {
  rootDir: root,
  roots: [path.join(root, 'apps/api-strategy/src'), path.join(root, 'apps/api/src/context')],
  cacheDirectory: path.resolve(root, '../.fixture-jest-cache'),
  testEnvironment: 'node',
  maxWorkers: 1,
  setupFiles: [path.join(root, 'apps/api-strategy/jest.setup.ts')],
  transform: {
    '^.+\\.ts$': [
      require.resolve('ts-jest', { paths: [path.join(root, 'apps/api-strategy')] }),
      {
        tsconfig: {
          module: 'commonjs',
          target: 'ES2022',
          esModuleInterop: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          useDefineForClassFields: false,
          isolatedModules: true,
          resolveJsonModule: true,
        },
        diagnostics: false,
      },
    ],
  },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testMatch: [
    '<rootDir>/apps/api-strategy/src/meri/*.spec.ts',
    '<rootDir>/apps/api/src/context/*strategy*.spec.ts',
    '<rootDir>/apps/api/src/context/objective-generation*.spec.ts',
  ],
};
