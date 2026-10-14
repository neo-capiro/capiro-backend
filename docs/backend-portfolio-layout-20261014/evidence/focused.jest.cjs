const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const api = path.join(root, 'apps/api');
module.exports = {
  rootDir: root,
  roots: [path.join(api, 'src/users'), path.join(api, 'src/prisma')],
  testEnvironment: 'node',
  testMatch: ['**/portfolio-layout*.spec.ts', '**/prisma.service.spec.ts', '**/prisma-tenant-scope.spec.ts'],
  setupFiles: [],
  cache: false,
  maxWorkers: 1,
  transform: { '^.+\\.ts$': [require.resolve('ts-jest', { paths: [api] }), {
    diagnostics: false, tsconfig: { target: 'ES2022', module: 'CommonJS', esModuleInterop: true,
      isolatedModules: true, experimentalDecorators: true, emitDecoratorMetadata: true, useDefineForClassFields: false },
  }] },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
};
