const path = require('node:path');
module.exports = {
  rootDir: path.resolve(__dirname, '../..'),
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/a2-postgres/*.pg.spec.ts'],
  maxWorkers: 1,
  testTimeout: 15000,
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        diagnostics: false,
        isolatedModules: true,
        tsconfig: {
          module: 'commonjs',
          target: 'ES2022',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@capiro/shared$': '<rootDir>/../../packages/shared/src/index.ts',
  },
};
