// Inert, narrowly scoped Settings safety tests. No worker database bootstrap,
// provider calls, or environment-derived credentials are used by these suites.
module.exports = {
  rootDir: __dirname,
  roots: ['<rootDir>/src/branding', '<rootDir>/src/tenant-admin'],
  testEnvironment: 'node',
  moduleDirectories: [
    'node_modules',
    require('node:path').resolve(__dirname, '../../node_modules'),
  ],
  testMatch: ['**/*.spec.ts'],
  maxWorkers: 1,
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        isolatedModules: true,
        diagnostics: false,
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
