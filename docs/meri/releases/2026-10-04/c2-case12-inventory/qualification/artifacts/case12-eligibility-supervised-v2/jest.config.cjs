const { createRequire } = require('node:module');
const api = createRequire('C:/dev/main/meri-c1-20261002/apps/api/package.json');
module.exports = {
  rootDir: __dirname + '/scratch/apps/api',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/retrieval/adapters/governed-memory-eligibility.helpers.spec.ts','<rootDir>/src/retrieval/adapters/institutional-knowledge-retrieval.adapter.spec.ts'],
  transform: { '^.+\\.ts$': [api.resolve('ts-jest'), {tsconfig:'C:/dev/main/meri-c1-20261002/apps/api/tsconfig.json',diagnostics:false,isolatedModules:true}] },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
};
