const base = require('../../../apps/api/jest.config.cjs');
module.exports = {
  ...base,
  rootDir: require('node:path').resolve(__dirname, '../../../apps/api'),
  transform: {
    ...base.transform,
    '^.+\\.ts$': ['ts-jest', {
      diagnostics: false,
      isolatedModules: true,
      tsconfig: { ...require('../../../apps/api/tsconfig.json').compilerOptions,
        module: 'commonjs', moduleResolution: 'node', incremental: false },
    }],
  },
};
