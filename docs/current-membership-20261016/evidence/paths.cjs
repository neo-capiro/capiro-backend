const path = require('node:path');
const { createRequire } = require('node:module');

const taskRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(taskRoot, 'backend-current-authority');
const dependencyRoot = path.join(taskRoot, 'implementation-runtime', 'workspace');
const apiNodeModules = path.join(dependencyRoot, 'apps', 'api', 'node_modules');
const workspaceNodeModules = path.join(dependencyRoot, 'node_modules');
const dependencyRequire = createRequire(path.join(dependencyRoot, 'apps', 'api', 'package.json'));
const jestRequire = createRequire(dependencyRequire.resolve('jest/package.json'));
const jestCoreRequire = createRequire(jestRequire.resolve('@jest/core/package.json'));
const jestConfigRequire = createRequire(jestCoreRequire.resolve('jest-config/package.json'));
const authRoot = path.join(sourceRoot, 'apps', 'api', 'src', 'auth');
const primaryTests = ['application-membership.spec.ts', 'application-authority.module.spec.ts'].map(name => path.join(authRoot, name));
const supportingTests = ['application-authority.spec.ts', 'application-authority-boundary.spec.ts'].map(name => path.join(authRoot, name));

module.exports = { taskRoot, sourceRoot, dependencyRoot, apiNodeModules, workspaceNodeModules, dependencyRequire, jestConfigRequire, authRoot, primaryTests, supportingTests };
