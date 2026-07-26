const path = require('node:path');

// @clerk/backend's `exports` map refuses the deep specifier
// '@clerk/backend/dist/runtime/node/crypto.js' even though the file exists, so a
// moduleNameMapper entry pointing at it MATCHES and then fails with "Could not
// locate module". './package.json' IS exported — resolve that and walk to the
// file. Absolute, and safe against pnpm's content-hashed store paths.
// Mirrors apps/api and apps/workspace.
const clerkNodeCrypto = path.join(
  path.dirname(require.resolve('@clerk/backend/package.json')),
  'dist',
  'runtime',
  'node',
  'crypto.js',
);

module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/**/*.spec.ts',
    '<rootDir>/test/**/*.spec.ts',
    '<rootDir>/test/**/*.e2e-spec.ts',
    '<rootDir>/test/**/*.int-spec.ts',
  ],
  setupFiles: ['<rootDir>/jest.setup.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', isolatedModules: true, diagnostics: { ignoreCodes: [151002] } }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^#crypto$': clerkNodeCrypto,
  },
};
