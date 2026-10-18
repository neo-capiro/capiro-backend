const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const strategy = path.join(root, 'apps/api-strategy');
module.exports = {
  rootDir: root, testEnvironment: 'node', cache: false, maxWorkers: 1,
  setupFiles: [path.join(strategy, 'jest.setup.ts')],
  testMatch: [
    '<rootDir>/apps/api/src/clients/objectives/work/objective-strategy-selection.spec.ts',
    '<rootDir>/apps/api/src/clients/objectives/work/objective-strategy-selection-prisma.spec.ts',
    '<rootDir>/apps/api/src/clients/objectives/work/objective-strategy-work-owner.spec.ts',
    '<rootDir>/apps/api/src/clients/objectives/work/objective-work-owner.router.spec.ts',
    '<rootDir>/apps/api/src/clients/objectives/work/objective-planner-work-owner.mount.spec.ts',
    '<rootDir>/apps/api/src/clients/objectives/work/objective-strategy-job-reservation.spec.ts',
    '<rootDir>/apps/api-strategy/src/meri/objective-canonical-reservation.spec.ts',
    '<rootDir>/apps/api-strategy/src/meri/draft-job-worker.service.spec.ts',
    '<rootDir>/apps/api-strategy/src/meri/draft-job.service.spec.ts',
    '<rootDir>/apps/api-strategy/src/meri/objective-generation.spec.ts',
  ],
  transform: { '^.+\\.ts$': [require.resolve('ts-jest', { paths: [strategy] }), {
    tsconfig: path.join(__dirname, 'intake.tsconfig.json'), diagnostics: true,
  }] },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^#crypto$': path.join(strategy, 'test/clerk-crypto-shim.cjs'),
    '^@capiro/shared$': path.join(root, 'packages/shared/src/index.ts'),
    '^@capiro/shared/objective-strategy-intake$': path.join(root, 'packages/shared/src/objective-strategy-intake.ts'),
    '^@capiro/shared/objective-planner-owner-codec$': path.join(root, 'packages/shared/src/objective-planner-owner-codec.ts'),
  },
};
