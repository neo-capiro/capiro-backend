const path = require('node:path');
const root = path.resolve(__dirname, '../..');
module.exports = {
  rootDir: root,
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/apps/api/src/engagement/plans/**/*.spec.ts',
    '<rootDir>/apps/api/src/engagement/report-targets.spec.ts',
    '<rootDir>/apps/api/src/auth/roles.guard.spec.ts',
    '<rootDir>/apps/api/src/engagement/runtime/engagement-route-controller-coverage.spec.ts',
    '<rootDir>/apps/api/src/engagement/engagement-route-manifest.spec.ts',
  ],
  transform: {
    '^.+\\.ts$': [
      require.resolve('ts-jest'),
      {
        tsconfig: {
          target: 'ES2022',
          module: 'CommonJS',
          moduleResolution: 'Node',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          strict: true,
          skipLibCheck: true,
        },
        isolatedModules: true,
        diagnostics: true,
      },
    ],
  },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  moduleDirectories: ['node_modules'],
  cache: false,
  cacheDirectory:
    process.env.CAPIRO_ENGAGEMENT_TEST_CACHE ||
    path.join(root, '.qualification-cache/engagement-plans'),
  maxWorkers: 1,
  testTimeout: 15000,
};
