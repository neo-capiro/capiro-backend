const path = require('node:path');
const root = path.resolve(__dirname, '../../../..');
const app = path.join(root, 'apps/api-strategy');
const base = require(path.join(app, 'jest.config.cjs'));
const config = {
  ...base, rootDir: root, setupFiles: [path.join(app, 'jest.setup.ts')],
  testMatch: ['<rootDir>/docs/objective-strategy-planner-destinations-20261012/evidence/independent-review/independent.spec.ts'],
  moduleDirectories: [path.join(app, 'node_modules'), path.join(root, 'apps/api/node_modules'), path.join(root, 'node_modules'), 'node_modules'],
  moduleNameMapper: { ...base.moduleNameMapper, '^#crypto$': path.join(app, 'test/clerk-crypto-shim.cjs'), '^@capiro/shared$': path.join(root, 'packages/shared/src/index.ts') },
  transform: { '^.+\\.ts$': [require.resolve('ts-jest', { paths: [app] }), { diagnostics: false, isolatedModules: true, tsconfig: { ...require(path.join(app, 'tsconfig.json')).compilerOptions, module: 'commonjs', moduleResolution: 'node', incremental: false } }] },
};
if (process.env.OBJECTIVE_REVIEW_SHARED_SOURCE) config.moduleNameMapper['^(?:\\.\\./){4}packages/shared/src/client-objective-destination$'] = process.env.OBJECTIVE_REVIEW_SHARED_SOURCE;
if (process.env.OBJECTIVE_REVIEW_INCLUDE_AUTHOR) config.testMatch.push(
  '<rootDir>/apps/api-strategy/src/strategy/objective-destination.service.spec.ts',
  '<rootDir>/apps/api-strategy/src/strategy/objective-destination.controller.spec.ts',
  '<rootDir>/apps/api/src/clients/objectives/objective-destination.shared.spec.ts',
  '<rootDir>/apps/api/src/clients/objectives/objective-destination.spec.ts',
  '<rootDir>/apps/api/src/clients/objectives/objective-destination.privileges.spec.ts',
  '<rootDir>/apps/api/src/outreach-v3/services/outreach-objective-destination.spec.ts',
);
module.exports = config;
