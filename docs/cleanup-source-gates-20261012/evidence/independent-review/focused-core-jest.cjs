const path = require('node:path');
const root = path.resolve(__dirname, '../../../..');
const api = path.join(root, 'apps/api');
const base = require(path.join(api, 'jest.config.cjs'));
module.exports = {
  ...base, rootDir: root, setupFiles: [path.join(api, 'jest.setup.ts')],
  moduleDirectories: [path.join(api, 'node_modules'), path.join(root, 'node_modules'), 'node_modules'],
  transform: { ...base.transform, '^.+\\.ts$': [require.resolve('ts-jest', { paths: [api] }), { diagnostics: false, isolatedModules: true,
    tsconfig: { target: 'ES2022', module: 'commonjs', esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true } }] },
  moduleNameMapper: { ...base.moduleNameMapper, '^@capiro/shared$': path.join(root, 'packages/shared/src/index.ts') },
  testMatch: [
    '<rootDir>/apps/api/src/clients/objectives/objective-destination.spec.ts',
    '<rootDir>/apps/api/src/clients/objectives/objective-destination.privileges.spec.ts',
    '<rootDir>/apps/api/src/clients/objectives/objective-destination.shared.spec.ts',
    '<rootDir>/apps/api/src/outreach-v3/services/outreach-newsletter-staging.spec.ts',
    '<rootDir>/apps/api/src/outreach-v3/services/outreach-objective-destination.spec.ts',
    '<rootDir>/apps/api/src/outreach-v3/api/outreach-objective-destination.controller.spec.ts',
    '<rootDir>/docs/newsletter-staging-20261012/evidence/independent-review/adversarial.spec.ts',
  ],
};
