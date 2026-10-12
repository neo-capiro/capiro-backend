const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const base = require(path.join(root, 'apps/workspace/jest.config.cjs'));
const mapper = Object.fromEntries(Object.entries(base.moduleNameMapper).filter(([key]) => !key.includes('{1,2}')));
module.exports = { ...base, rootDir: path.join(root, 'apps/workspace'),
  transform: { '^.+\\.ts$': ['ts-jest', { diagnostics: false, isolatedModules: true,
    tsconfig: { target: 'ES2022', module: 'commonjs', esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true } }] },
  moduleNameMapper: { ...mapper, '^(\\.{1,2}/.*)\\.js$': '$1', '^@capiro/shared$': path.join(root, 'packages/shared/src/index.ts') },
  testMatch: ['<rootDir>/src/prospect-resources/*.spec.ts', '<rootDir>/src/versions/objective-destination.spec.ts',
    '<rootDir>/src/documents/documents.service.spec.ts'],
};
