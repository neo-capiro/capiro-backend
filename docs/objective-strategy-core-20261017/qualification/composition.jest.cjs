const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
module.exports = {
  rootDir: root, testEnvironment: 'node', cache: false, maxWorkers: 1,
  testMatch: [
    '<rootDir>/apps/api/src/auth/workload-authority/objective-workload-admission-runtime.spec.ts',
    '<rootDir>/apps/api/src/auth/workload-authority/objective-workload-admission.mount.spec.ts',
    '<rootDir>/apps/api/src/auth/workload-authority/objective-workload-admission-ingress.spec.ts',
    '<rootDir>/apps/api/src/auth/workload-authority/objective-workload-admission-source.spec.ts',
    '<rootDir>/apps/api/src/auth/workload-authority/objective-workload-issuance.spec.ts',
    '<rootDir>/apps/api/src/auth/workload-authority/objective-workload-issuance-prisma.spec.ts',
    '<rootDir>/apps/api/src/clients/objectives/work/objective-planner-work-owner.mount.spec.ts',
  ],
  transform: { '^.+\\.ts$': [require.resolve('ts-jest', { paths: [path.join(root, 'apps/api')] }), {
    tsconfig: path.join(__dirname, 'composition.tsconfig.json'), diagnostics: true,
  }] },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^#crypto$': path.join(root, 'apps/api-strategy/test/clerk-crypto-shim.cjs'),
    '^@capiro/shared$': path.join(root, 'packages/shared/src/index.ts'),
    '^@capiro/shared/objective-strategy-intake$': path.join(root, 'packages/shared/src/objective-strategy-intake.ts'),
    '^@capiro/shared/objective-planner-owner-codec$': path.join(root, 'packages/shared/src/objective-planner-owner-codec.ts'),
  },
};
