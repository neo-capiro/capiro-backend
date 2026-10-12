const path = require('node:path');
const app = path.resolve(__dirname, '../../../apps/api-strategy');
const base = require(path.join(app, 'jest.config.cjs'));
module.exports = {
  ...base,
  rootDir: app,
  moduleNameMapper: {
    '^(?:\\.\\./)+generated/prisma-client(?:/index\\.js)?$': path.join(app, 'generated/prisma-client/index.js'),
    ...base.moduleNameMapper,
    '^@capiro/shared$': path.resolve(process.env.CLEANUP_CLOCK_SHARED_SOURCE ?? path.join(__dirname, '../../../packages/shared/src/index.ts')),
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      diagnostics: false,
      isolatedModules: true,
      tsconfig: { ...require(path.join(app, 'tsconfig.json')).compilerOptions,
        module: 'commonjs', moduleResolution: 'node', incremental: false },
    }],
  },
};
