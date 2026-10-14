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
  transform: { '^.+\\.ts$': path.join(__dirname, 'typescript-transformer.cjs') },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1', '^sanitize-html$': path.join(__dirname, 'native-sanitize.cjs') },
};
