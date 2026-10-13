module.exports = {
  rootDir: '../..', roots: ['<rootDir>/apps/api/src/auth'],
  testMatch: ['**/application-authority.spec.ts'],
  testEnvironment: '/workspace/capirov2/node_modules/.pnpm/jest-environment-node@29.7.0/node_modules/jest-environment-node/build/index.js',
  setupFiles: [], setupFilesAfterEnv: [], cache: false,
  transform: { '^.+\\.tsx?$': ['/workspace/capirov2/apps/api/node_modules/ts-jest', { diagnostics: false, isolatedModules: true,
    tsconfig: { target: 'ES2022', module: 'CommonJS', esModuleInterop: true } }] },
};
