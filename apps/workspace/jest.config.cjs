const path = require('node:path');

/**
 * Absolute path to @clerk/backend's node CJS crypto runtime.
 *
 * Resolving it by package specifier does NOT work: the package's `exports`
 * field only publishes '.', './errors', './internal', './jwt', './webhooks'
 * and './package.json', so a deep specifier like
 * '@clerk/backend/dist/runtime/node/crypto.js' is refused by the resolver even
 * though the file is right there on disk. A moduleNameMapper entry pointing at
 * that specifier therefore matches and then fails with "Could not locate
 * module", which is what silently killed test/tenant-guard.spec.ts (the guard
 * imports @capiro/auth, which imports @clerk/backend, which imports #crypto).
 *
 * './package.json' IS exported, so resolve that and walk to the file. This
 * also survives pnpm's content-hashed store paths, which a <rootDir>-relative
 * literal would not. Mirrors apps/api/jest.config.cjs.
 */
const clerkNodeCrypto = path.join(
  path.dirname(require.resolve('@clerk/backend/package.json')),
  'dist',
  'runtime',
  'node',
  'crypto.js',
);

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
    // #crypto to its node CJS runtime. Must be an ABSOLUTE path — see
    // clerkNodeCrypto above for why the obvious '@clerk/backend/dist/...'
    // specifier silently fails to resolve.
    '^#crypto$': clerkNodeCrypto,
    // Jest's resolver doesn't honor @capiro/meriv2-core's `exports` SUBPATHS
    // (node + nest-build DO, at runtime/build). Map the two the workspace uses
    // (Phase 3.1 grounding auditor) to their SOURCE so ts-jest compiles them on
    // the fly — no dist-build dependency, and (unlike the package barrel) this
    // pulls in ONLY auditor+evidence, keeping zod out of the jest module graph.
    '^@capiro/meriv2-core/grounding/auditor$':
      '<rootDir>/../../packages/meriv2-core/src/grounding/auditor.ts',
    '^@capiro/meriv2-core/grounding/evidence$':
      '<rootDir>/../../packages/meriv2-core/src/grounding/evidence.ts',
    // G1-c: the Context Compiler subpaths (same zod-free rationale).
    '^@capiro/meriv2-core/context/contract$':
      '<rootDir>/../../packages/meriv2-core/src/context/contract.ts',
    '^@capiro/meriv2-core/context/compiler$':
      '<rootDir>/../../packages/meriv2-core/src/context/compiler.ts',
  },
};
