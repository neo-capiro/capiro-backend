module.exports = {
  rootDir: '../../apps/api',
  testEnvironment: 'node',
  setupFiles: [],
  maxWorkers: 1,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', diagnostics: false, isolatedModules: true }],
  },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
};
