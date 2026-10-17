const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const resolve = name => require.resolve(name, { paths: [path.join(root, 'apps/api')] });
module.exports = {
  rootDir: root, testEnvironment: 'node', cache: false, maxWorkers: 1,
  testMatch: [
    '<rootDir>/apps/api-strategy/src/meri/objective-canonical-reader-v2-native-owner.spec.ts',
    '<rootDir>/apps/api-strategy/src/meri/objective-canonical-reader-v2-runtime.spec.ts',
    '<rootDir>/apps/api-strategy/src/meri/objective-canonical-reader-v2-receiving.spec.ts',
    '<rootDir>/apps/api/src/clients/objectives/work/objective-strategy-recovery-gate.spec.ts',
    '<rootDir>/apps/api/src/clients/objectives/work/objective-strategy-work-owner.spec.ts',
    '<rootDir>/apps/api/src/clients/objectives/work/objective-work-owner.router.spec.ts',
    '<rootDir>/apps/api/src/clients/objectives/work/objective-strategy-selection-prisma.spec.ts',
  ],
  transform: { '^.+\\.ts$': [resolve('ts-jest'), { tsconfig: {
    target: 'ES2022', module: 'CommonJS', esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true, isolatedModules: true,
  }, diagnostics: false }] },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@capiro/shared$': '<rootDir>/packages/shared/src/index.ts',
    '^@capiro/shared/objective-planner-owner-codec$': '<rootDir>/packages/shared/src/objective-planner-owner-codec.ts',
    '^@capiro/shared/objective-strategy-intake$': '<rootDir>/packages/shared/src/objective-strategy-intake.ts',
  },
};
