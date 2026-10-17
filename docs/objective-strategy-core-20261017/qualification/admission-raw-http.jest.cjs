const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const resolve = name => require.resolve(name, { paths: [path.join(root, 'apps/api')] });
module.exports = {
  rootDir: root, testEnvironment: 'node', cache: false, maxWorkers: 1,
  testMatch: [
    '<rootDir>/apps/api/src/bootstrap/configure-api-http-app.spec.ts',
    '<rootDir>/apps/api/src/bootstrap/objective-admission-raw-body.int.spec.ts',
    '<rootDir>/apps/api/src/auth/workload-authority/objective-workload-admission-ingress.spec.ts',
    '<rootDir>/apps/api/src/auth/workload-authority/objective-workload-admission-runtime.spec.ts',
    '<rootDir>/apps/api/src/auth/workload-authority/objective-workload-admission.mount.spec.ts',
  ],
  transform: { '^.+\\.ts$': [resolve('ts-jest'), { tsconfig: {
    target: 'ES2022', module: 'CommonJS', experimentalDecorators: true,
    emitDecoratorMetadata: true, esModuleInterop: true, isolatedModules: true,
  }, diagnostics: false }] },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@capiro/shared$': '<rootDir>/packages/shared/src/index.ts',
    '^@capiro/shared/objective-planner-owner-codec$': '<rootDir>/packages/shared/src/objective-planner-owner-codec.ts',
    '^@capiro/shared/objective-strategy-intake$': '<rootDir>/packages/shared/src/objective-strategy-intake.ts',
  },
};
