const path = require('node:path');
const repo = path.resolve(__dirname, '../../..');
module.exports = {
  rootDir: path.join(repo, 'apps/api'),
  roots: ['<rootDir>/src/engagement'],
  cache: false,
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': [require.resolve('ts-jest', { paths: [repo] }), {
      tsconfig: { target: 'ES2022', module: 'commonjs', esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true },
      diagnostics: false, isolatedModules: true,
    }],
  },
  moduleNameMapper: {
    '^@capiro/shared/(.*)$': path.join(repo, 'packages/shared/src/$1.ts'),
    '^@capiro/shared$': path.join(repo, 'packages/shared/src/index.ts'),
    '^@azure/msal-node$': path.join(__dirname, 'msal-unavailable.cjs'),
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  moduleDirectories: ['node_modules', path.join(repo, 'node_modules')],
  testMatch: ['**/*.spec.ts'],
};
