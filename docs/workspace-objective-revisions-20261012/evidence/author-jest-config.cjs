const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const app = path.join(root, 'apps/workspace');
const c = require(path.join(app, 'jest.config.cjs'));
c.rootDir = app;
for (const key of Object.keys(c.transform)) c.transform[key] = [require.resolve('ts-jest', { paths: [app] }), { tsconfig: path.join(app, 'tsconfig.json'), diagnostics: false, isolatedModules: true }];
for (const key of Object.keys(c.moduleNameMapper)) if (c.moduleNameMapper[key] === '$1') delete c.moduleNameMapper[key];
c.moduleNameMapper['^(\\.{1,2}/.*)\\.js$'] = '$1';
module.exports = c;
