const path = require('node:path');
const { createRequire } = require('node:module');

const rootDir = path.resolve(__dirname, '../..');
const apiRequire = createRequire(path.join(rootDir, 'apps/api/package.json'));
// Resolve the formatter paired with Jest, including installations where another
// top-level consumer brings a different pretty-format major version. Follow
// declared dependencies so this also works with pnpm's isolated package layout.
const globalsRequire = createRequire(apiRequire.resolve('@jest/globals'));
const jestExpectRequire = createRequire(globalsRequire.resolve('@jest/expect'));
const expectRequire = createRequire(jestExpectRequire.resolve('expect'));
const prettyFormat = require.resolve('pretty-format', {
  paths: [path.dirname(expectRequire.resolve('jest-matcher-utils'))],
});

module.exports = {
  rootDir,
  testEnvironment: 'node',
  roots: ['<rootDir>/apps/api/src/engagement'],
  testMatch: [
    '<rootDir>/apps/api/src/engagement/portfolio-a1.safety.spec.ts',
    '<rootDir>/apps/api/src/engagement/meeting-client-reassignment.spec.ts',
  ],
  setupFilesAfterEnv: ['<rootDir>/docs/a1/portfolio-test-dependencies.cjs'],
  maxWorkers: 1,
  moduleDirectories: [
    'node_modules',
    path.join(rootDir, 'apps/api/node_modules'),
    path.join(rootDir, 'node_modules'),
  ],
  transform: {
    '^.+\\.ts$': [apiRequire.resolve('ts-jest'), {
      tsconfig: {
        module: 'commonjs',
        target: 'ES2022',
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        esModuleInterop: true,
      },
      diagnostics: false,
      isolatedModules: true,
    }],
  },
  moduleNameMapper: {
    '^pretty-format$': prettyFormat,
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@capiro/shared$': '<rootDir>/packages/shared/src/index.ts',
    '^@capiro/shared/(.*)$': '<rootDir>/packages/shared/src/$1.ts',
  },
};
