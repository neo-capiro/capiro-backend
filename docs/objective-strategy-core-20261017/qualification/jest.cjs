const path = require('node:path');
const repo = path.resolve(__dirname, '../../..');
const api = path.join(repo, 'apps/api');
const resolve = name => require.resolve(name, { paths: [api] });

// Deliberately independent of the API-wide Jest database setup.
module.exports = {
  rootDir: api,
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/auth/workload-authority/objective-workload-admission-ingress.spec.ts',
    '<rootDir>/src/auth/workload-authority/objective-workload-admission-source.spec.ts',
    '<rootDir>/src/auth/workload-authority/objective-workload-issuance-prisma.spec.ts',
    '<rootDir>/src/auth/workload-authority/objective-workload-issuance.spec.ts',
  ],
  transform: { '^.+\\.ts$': [resolve('ts-jest'), {
    tsconfig: path.join(__dirname, 'tsconfig.json'),
    diagnostics: true,
  }] },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  cache: false,
  maxWorkers: 1,
};
