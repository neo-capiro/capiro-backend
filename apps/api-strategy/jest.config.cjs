module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/**/*.spec.ts',
    '<rootDir>/test/**/*.spec.ts',
    '<rootDir>/test/**/*.e2e-spec.ts',
    '<rootDir>/test/**/*.int-spec.ts',
    '<rootDir>/eval/**/*.spec.ts',
  ],
  setupFiles: ['<rootDir>/jest.setup.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: '<rootDir>/tsconfig.json', diagnostics: { ignoreCodes: [151002] } },
    ],
  },
  moduleNameMapper: {
    // tsconfig is Node16 (ESM-style `.js` import specifiers); strip the suffix
    // so jest's resolver finds the emitted/source module.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Jest cannot resolve @clerk/backend's package-`imports` subpath (#crypto)
    // — jest-resolve enforces the package's public `exports` map even for
    // moduleNameMapper substitution targets, and that deep path isn't exported
    // (only reachable via Node's private-imports resolution). Point at a local
    // one-line shim instead of the real file. Only exercised if a test boots
    // the Clerk client (via @capiro/auth); harmless otherwise.
    '^#crypto$': '<rootDir>/test/clerk-crypto-shim.cjs',
  },
};
