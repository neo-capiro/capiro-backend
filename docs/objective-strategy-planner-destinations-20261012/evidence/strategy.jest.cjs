const path = require('node:path');
const root = path.resolve(__dirname, '../../../apps/api-strategy');
const base = require(path.join(root, 'jest.config.cjs'));
module.exports = { ...base, rootDir: root,
  transform: { '^.+\\.ts$': ['ts-jest', { diagnostics: false, isolatedModules: true,
    tsconfig: { ...require(path.join(root, 'tsconfig.json')).compilerOptions, module: 'commonjs', moduleResolution: 'node', incremental: false } }] } };
