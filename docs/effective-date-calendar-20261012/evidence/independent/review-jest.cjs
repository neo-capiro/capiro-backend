const path = require('node:path');
const rootDir = path.resolve(__dirname, '../../../../apps/api');
const base = require(path.join(rootDir, 'jest.config.cjs'));
module.exports = {
  ...base, rootDir,
  transform: {
    ...base.transform,
    '^.+\\.ts$': ['ts-jest', { tsconfig: path.join(rootDir, 'tsconfig.json'), diagnostics: false, isolatedModules: true }],
  },
};
