const path = require('node:path');

/**
 * Absolute path to @clerk/backend's node CJS crypto runtime.
 *
 * Resolving it by package specifier does NOT work: the package's `exports`
 * field only publishes '.', './errors', './internal', './jwt', './webhooks'
 * and './package.json', so a deep specifier like
 * '@clerk/backend/dist/runtime/node/crypto.js' is refused by the resolver even
 * though the file is right there on disk. A moduleNameMapper entry pointing at
 * that specifier therefore matches and then fails with
 * "Could not locate module", which is what silently killed the AppModule DI
 * smoke test.
 *
 * './package.json' IS exported, so resolve that and walk to the file. This
 * also survives pnpm's content-hashed store paths, which a <rootDir>-relative
 * literal would not.
 */
const clerkNodeCrypto = path.join(
  path.dirname(require.resolve('@clerk/backend/package.json')),
  'dist',
  'runtime',
  'node',
  'crypto.js',
);

/**
 * Absolute path to the MCP SDK's CJS build directory.
 *
 * Same class of problem as clerkNodeCrypto, with two extra wrinkles:
 *
 *  - The SDK does NOT export './package.json', so the resolve-the-manifest
 *    trick is unavailable.
 *  - Its '.' export maps `require` to './dist/cjs/index.js', and that file
 *    DOES NOT EXIST in the published package — dist/cjs has no index. So
 *    require.resolve('@modelcontextprotocol/sdk') throws outright.
 *
 * './client' is exported and does resolve, to dist/cjs/client/index.js, so
 * anchor on that and step up one directory. Content-hash safe under pnpm.
 */
const mcpCjsDir = path.resolve(
  path.dirname(require.resolve('@modelcontextprotocol/sdk/client')),
  '..',
);

/**
 * zod's package root. The MCP SDK's zod-compat requires zod/v3 and zod/v4
 * subpaths whose `require` condition jest ignores, so they must be pinned to
 * the CJS builds — and, once again, the deep specifiers are blocked by zod's
 * `exports` map, so the pins have to be absolute paths rather than specifiers.
 */
const zodRoot = path.dirname(require.resolve('zod/package.json'));
const zodCjs = (subpath) => path.join(zodRoot, subpath);

/**
 * pkce-challenge's CJS build, required by the MCP SDK's client/auth.
 *
 * It is a TRANSITIVE dependency of the SDK, so under pnpm's strict node_modules
 * it is not resolvable from apps/api at all — resolve it relative to the SDK's
 * own directory, which is where it is actually installed.
 */
const pkceChallengeCjs = require.resolve('pkce-challenge', {
  paths: [path.dirname(require.resolve('@modelcontextprotocol/sdk/client'))],
});

module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/**/*.spec.ts',
    '<rootDir>/scripts/**/*.spec.ts',
    // Step 4.2 — slower end-to-end acceptance specs live under test/e2e/.
    '<rootDir>/test/**/*.e2e.spec.ts',
  ],
  setupFiles: ['<rootDir>/jest.setup.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', diagnostics: { ignoreCodes: [151002] } }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Jest cannot resolve package-`imports` subpaths; map @clerk/backend's
    // #crypto to its node CJS runtime (needed by the AppModule DI smoke test).
    // Must be an ABSOLUTE path — see clerkNodeCrypto above for why the obvious
    // '@clerk/backend/dist/...' specifier silently fails to resolve.
    '^#crypto$': clerkNodeCrypto,
    // Jest also cannot resolve the MCP SDK's `exports`-mapped subpaths; point
    // them at the CJS build directly (needed by clio-mcp-transport + the
    // AppModule DI smoke test).
    // Absolute for the same reason as #crypto: the deep specifier is refused
    // by the package's `exports` map even though the file exists.
    '^@modelcontextprotocol/sdk/(.*)\\.js$': `${mcpCjsDir}/$1.js`,
    // Same problem one layer down: the MCP SDK requires zod/v3 + zod/v4
    // subpaths whose `require` condition jest ignores, landing on the ESM
    // build. Pin them to the CJS files.
    '^zod/v3$': zodCjs('v3/index.cjs'),
    '^zod/v4$': zodCjs('v4/index.cjs'),
    '^zod/v4/core$': zodCjs('v4/core/index.cjs'),
    '^zod/v4-mini$': zodCjs('v4-mini/index.cjs'),
    '^zod/v4/mini$': zodCjs('v4/mini/index.cjs'),
    '^pkce-challenge$': pkceChallengeCjs,
  },
};
