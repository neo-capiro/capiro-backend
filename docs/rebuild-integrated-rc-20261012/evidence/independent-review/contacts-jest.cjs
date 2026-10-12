const path = require('node:path');
const root = path.resolve(__dirname, '../../../..');
const base = require(path.join(root, 'apps/api/jest.config.cjs'));
module.exports = {
  ...base,
  rootDir: root,
  setupFiles: [path.join(root, 'apps/api/jest.setup.ts')],
  testMatch: [path.join(__dirname, 'contacts-composition.spec.ts')],
  transform: { ...base.transform, '^.+\\.ts$': ['ts-jest', { diagnostics: false, isolatedModules: true,
    tsconfig: { target: 'ES2022', module: 'commonjs', esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true } }] },
  moduleNameMapper: { ...base.moduleNameMapper, '^@capiro/shared$': path.join(root, 'packages/shared/src/index.ts') },
};
