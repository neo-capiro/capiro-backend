const path = require('node:path');
const base = require('../objective.jest.cjs');
const tsJest = require.resolve('ts-jest', { paths: [path.resolve(__dirname, '../../../../apps/api')] });
module.exports = {
  ...base,
  transform: Object.fromEntries(Object.entries(base.transform).map(([pattern, [name, options]]) =>
    [pattern, [name === 'ts-jest' ? tsJest : name, options]])),
  rootDir: path.resolve(__dirname, '../../../..'),
  roots: [path.resolve(__dirname), path.resolve(__dirname, '../../../../apps/api/src')],
  setupFiles: [path.resolve(__dirname, '../../../../apps/api/jest.setup.ts')],
  moduleDirectories: [path.resolve(__dirname, '../../../../apps/api/node_modules'), 'node_modules'],
  testMatch: ['**/*.spec.ts'],
};
