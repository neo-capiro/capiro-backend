// Isolated source-fragment checks: deliberately no application imports or DB setup hooks.
module.exports = {
  rootDir: '../../', testEnvironment: 'node',
  testMatch: ['<rootDir>/apps/api/src/meri/meri-local-dispatch.equivalence.spec.ts'],
  transform: { '^.+\\.tsx?$': ['/workspace/capirov2/apps/api/node_modules/ts-jest', {
    tsconfig: { target: 'ES2022', module: 'CommonJS', esModuleInterop: true, isolatedModules: true },
    diagnostics: false,
  }] },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  moduleDirectories: ['node_modules', '/workspace/capirov2/node_modules', '/workspace/capirov2/apps/api/node_modules'],
  cacheDirectory: '/tmp/capiro-meri-local-dispatch-jest-cache',
};
