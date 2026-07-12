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
  transform: {
    '^.+\.ts$': [
      'ts-jest',
      { tsconfig: '<rootDir>/tsconfig.json', diagnostics: { ignoreCodes: [151002] } },
    ],
  },
  moduleNameMapper: {
    '^(\.{1,2}/.*)\.js$': '$1',
    // Jest cannot resolve package-`imports` subpaths; map @clerk/backend's
    // #crypto to its node CJS runtime (needed by the AppModule DI smoke test).
    '^#crypto$': '@clerk/backend/dist/runtime/node/crypto.js',
    // Jest's resolver doesn't honor @capiro/meriv2-core's `exports` SUBPATHS
    // (node + nest-build DO, at runtime/build). Map the two the workspace uses
    // (Phase 3.1 grounding auditor) to their SOURCE so ts-jest compiles them on
    // the fly — no dist-build dependency, and (unlike the package barrel) this
    // pulls in ONLY auditor+evidence, keeping zod out of the jest module graph.
    '^@capiro/meriv2-core/grounding/auditor$':
      '<rootDir>/../../packages/meriv2-core/src/grounding/auditor.ts',
    '^@capiro/meriv2-core/grounding/evidence$':
      '<rootDir>/../../packages/meriv2-core/src/grounding/evidence.ts',
  },
};
