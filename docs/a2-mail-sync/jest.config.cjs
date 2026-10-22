const path = require('node:path');
const repo = path.resolve(__dirname, '../..');
const api = path.join(repo, 'apps/api');

// Source-only qualification: intentionally excludes the ordinary database setup.
module.exports = {
  rootDir: api,
  roots: ['<rootDir>/src/engagement'],
  cache: false,
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': [require.resolve('ts-jest', { paths: [api] }), {
      tsconfig: {
        target: 'ES2022', module: 'commonjs', esModuleInterop: true,
        experimentalDecorators: true, emitDecoratorMetadata: true,
        isolatedModules: true,
      },
      diagnostics: false,
    }],
  },
  moduleNameMapper: {
    '^@capiro/shared/(.*)$': path.join(repo, 'packages/shared/src/$1.ts'),
    '^@capiro/shared$': path.join(repo, 'packages/shared/src/index.ts'),
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  moduleDirectories: ['node_modules', path.join(api, 'node_modules')],
  testMatch: [
    '**/mail-sync-reconnect.a2.spec.ts', '**/mailbox-oauth.a1.spec.ts',
    '**/microsoft-graph-sync.retry.spec.ts', '**/google-sync.retry.spec.ts',
    '**/google-sync.quota-budget.spec.ts', '**/engagement-sync-scheduler.service.spec.ts',
  ],
};
