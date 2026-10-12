const path = require('node:path');

// Focused source characterization only: no app/database setup. Full project
// typechecking is separate; these inert suites compare frozen before sources.
module.exports = {
  rootDir: path.resolve(__dirname, '..'),
  testEnvironment: 'node',
  testMatch: ['<rootDir>/apps/**/*.spec.ts'],
  maxWorkers: 1,
  transform: {
    '^.+\\.ts$': [
      require.resolve('ts-jest', { paths: [path.resolve(__dirname, '../apps/api')] }),
      {
        tsconfig: {
          module: 'commonjs',
          target: 'ES2022',
          esModuleInterop: true,
          resolveJsonModule: true,
          isolatedModules: true,
        },
        diagnostics: false,
      },
    ],
  },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
};
