const path = require('node:path');
const root = path.resolve(__dirname, '../../../..');
const app = path.join(root, 'apps/workspace');
const base = require(path.join(app, 'jest.config.cjs'));
const mapper = { ...base.moduleNameMapper };
for (const key of Object.keys(mapper)) if (mapper[key] === '$1') delete mapper[key];
mapper['^(\\.{1,2}/.*)\\.js$'] = '$1';
mapper['^@capiro/shared$'] = path.join(root, 'packages/shared/src/index.ts');
for (const key of Object.keys(mapper)) if (typeof mapper[key] === 'string') mapper[key] = mapper[key].replace('<rootDir>', app);
module.exports = {
  ...base, rootDir: root, setupFiles: [path.join(app, 'jest.setup.ts')],
  moduleDirectories: [path.join(app, 'node_modules'), path.join(root, 'node_modules'), 'node_modules'],
  moduleNameMapper: mapper,
  transform: { '^.+\\.ts$': [require.resolve('ts-jest', { paths: [app] }), { diagnostics: false, isolatedModules: true,
    tsconfig: { target: 'ES2022', module: 'commonjs', esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true } }] },
  testMatch: [
    '<rootDir>/apps/workspace/src/prospect-resources/*.spec.ts',
    '<rootDir>/apps/workspace/src/versions/objective-destination.spec.ts',
    '<rootDir>/apps/workspace/src/documents/documents.service.spec.ts',
    '<rootDir>/docs/cleanup-source-gates-20261012/evidence/independent-review/workspace-independent-current-allocation.spec.ts',
  ],
};
