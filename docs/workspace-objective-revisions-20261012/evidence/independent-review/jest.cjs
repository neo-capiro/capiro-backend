const path = require('node:path');
const root = path.resolve(__dirname, '../../../..');
const app = path.join(root, 'apps/workspace');
const base = require(path.join(app, 'jest.config.cjs'));
const mapper = { ...base.moduleNameMapper };
for (const key of Object.keys(mapper)) if (mapper[key] === '$1') delete mapper[key];
mapper['^(\\.{1,2}/.*)\\.js$'] = '$1';
mapper['^@capiro/shared$'] = path.join(root, 'packages/shared/src/index.ts');
for (const key of Object.keys(mapper)) if (typeof mapper[key] === 'string') mapper[key] = mapper[key].replace('<rootDir>', app);
const config = {
  ...base, rootDir: root, setupFiles: [path.join(app, 'jest.setup.ts')],
  moduleDirectories: [path.join(app, 'node_modules'), path.join(root, 'node_modules'), 'node_modules'],
  moduleNameMapper: mapper,
  testMatch: ['<rootDir>/docs/workspace-objective-revisions-20261012/evidence/independent-review/independent.spec.ts'],
  transform: { '^.+\\.ts$': [require.resolve('ts-jest', { paths: [app] }), { tsconfig: path.join(app, 'tsconfig.json'), diagnostics: false, isolatedModules: true }] },
};
if (process.env.WORKSPACE_REVIEW_INCLUDE_AUTHOR) config.testMatch.push('<rootDir>/apps/workspace/src/versions/objective-destination.spec.ts');
module.exports = config;
