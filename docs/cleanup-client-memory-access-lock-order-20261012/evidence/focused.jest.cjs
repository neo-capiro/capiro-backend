const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const api = path.join(root, 'apps/api');
const jest = path.dirname(require.resolve('jest/package.json', { paths: [api] }));
module.exports = {
  rootDir: root,
  roots: [path.join(api, 'src/clients')],
  testEnvironment: require.resolve('jest-environment-node', { paths: [jest] }),
  testMatch: ['<rootDir>/apps/api/src/clients/clients.memory-access-lock-order.spec.ts'],
  maxWorkers: 1,
  cache: false,
  transform: {
    '^.+\\.ts$': [require.resolve('ts-jest', { paths: [api] }), {
      diagnostics: false,
      tsconfig: { module: 'commonjs', target: 'ES2022', esModuleInterop: true, isolatedModules: true },
    }],
  },
};
