const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const base = require(path.join(root, 'apps/api-strategy/jest.config.cjs'));
module.exports = { ...base, rootDir: path.join(root, 'apps/api-strategy'),
  transform: { '^.+\\.ts$': ['ts-jest', { diagnostics: false, isolatedModules: true,
    tsconfig: { target: 'ES2022', module: 'commonjs', esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true } }] },
  moduleNameMapper: { ...base.moduleNameMapper, '^@capiro/shared$': path.join(root, 'packages/shared/src/index.ts') },
  testMatch: ['<rootDir>/src/strategy/objective-destination*.spec.ts', '<rootDir>/src/planner/planner-task-create-command*.spec.ts',
    '<rootDir>/src/planner/planner-command-scope.spec.ts', '<rootDir>/src/planner/planner-links.spec.ts', '<rootDir>/src/prisma/*.spec.ts'],
};
