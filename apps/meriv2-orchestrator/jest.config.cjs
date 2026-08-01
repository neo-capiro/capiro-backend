module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/**/*.spec.ts',
    '<rootDir>/test/**/*.spec.ts',
    '<rootDir>/test/**/*.e2e-spec.ts',
    '<rootDir>/test/**/*.int-spec.ts',
  ],
  setupFiles: ['<rootDir>/jest.setup.ts'],
  setupFilesAfterEnv: ['<rootDir>/jest.chat-assurance-rollout.setup.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: '<rootDir>/tsconfig.json', diagnostics: { ignoreCodes: [151002] } },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Jest cannot resolve package-`imports` subpaths; map @clerk/backend's
    // #crypto to its node CJS runtime. This MUST be a <rootDir>-anchored FILE
    // PATH, not the bare specifier `@clerk/backend/dist/runtime/node/crypto.js`:
    // @clerk/backend's `exports` map does not expose `./dist/*`, so the bare
    // form throws ERR_PACKAGE_PATH_NOT_EXPORTED the moment the mapper fires —
    // and the e2e harness (health / scoping-parity) boots the real ClerkService,
    // which eagerly imports #crypto at module load. A file path is resolved
    // directly by jest, bypassing `exports`. (apps/api's identical bare mapping
    // survives only because its compile()-only DI smoke test never triggers the
    // lazy #crypto require.)
    '^#crypto$': '<rootDir>/node_modules/@clerk/backend/dist/runtime/node/crypto.js',
  },
};
