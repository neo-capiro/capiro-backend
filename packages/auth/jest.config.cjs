module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  setupFiles: ['<rootDir>/jest.setup.ts'],
  transform: {
    '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', diagnostics: { ignoreCodes: [151002] } }],
  },
  moduleNameMapper: {
    '^(\.{1,2}/.*)\.js$': '$1',
    // @clerk/backend's package-`imports` #crypto subpath — jest can't resolve
    // it, and the bare-specifier form throws ERR_PACKAGE_PATH_NOT_EXPORTED
    // (exports doesn't expose ./dist/*). File path, resolved directly.
    '^#crypto$': '<rootDir>/node_modules/@clerk/backend/dist/runtime/node/crypto.js',
  },
};
