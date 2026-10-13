const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
module.exports = {
  rootDir: root, roots: ['<rootDir>/apps/api/src'],
  testEnvironment: path.join(root, 'apps/api/jest.native-runtime-environment.cjs'),
  setupFiles: [path.join(__dirname, 'network-fence.cjs')], setupFilesAfterEnv: [], cache: false,
  testMatch: ['**/preview-readonly/*.spec.ts', '**/prisma/prisma.service.spec.ts', '**/auth/clerk-role.util.spec.ts', '**/users/users.controller.spec.ts'],
  transform: { '^.+\\.tsx?$': ['/workspace/capirov2/apps/api/node_modules/ts-jest', { diagnostics: false, isolatedModules: true,
    tsconfig: { target: 'ES2022', module: 'CommonJS', esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true } }] },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1', '^@capiro/shared$': '<rootDir>/packages/shared/dist/index.js',
    '^sanitize-html$': '<rootDir>/apps/api/jest.native-sanitize-html.cjs',
    '^@prisma/client$': '/tmp/capirov2-local-native-prerequisite-20261012/core-client',
    '^#crypto$': path.join(path.dirname(require.resolve('@clerk/backend/package.json', { paths: [path.join(root, 'apps/api')] })), 'dist/runtime/node/crypto.js') },
};
