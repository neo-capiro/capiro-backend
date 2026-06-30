module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', diagnostics: { ignoreCodes: [151002] } }],
  },
  moduleNameMapper: {
    // Match the api/workspace convention: strip `.js` from relative ESM-style
    // imports so ts-jest can resolve the `.ts` source. (Harmless here since
    // this package builds CJS without `.js` suffixes, but kept for parity.)
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
