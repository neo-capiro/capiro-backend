const path = require('node:path');
const root = path.resolve(__dirname, '../../../..');
const base = require(path.join(root, 'apps/api/jest.config.cjs'));
module.exports = { ...base, rootDir: path.join(root, 'apps/api'),
  transform: { ...base.transform, '^.+\\.ts$': ['ts-jest', { diagnostics: false, isolatedModules: true,
    tsconfig: { target: 'ES2022', module: 'commonjs', esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true } }] },
  moduleNameMapper: { ...base.moduleNameMapper, '^@capiro/shared$': path.join(root, 'packages/shared/src/index.ts') },
  testMatch: require('./core-regression-selection.json').selected.map(file => path.join(root, file)),
};
