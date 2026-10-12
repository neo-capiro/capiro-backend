'use strict';

/**
 * Jest's VM cannot require sanitize-html's ESM parser graph with VM modules
 * enabled. The runner loads this environment through native Node resolution,
 * so publish the real installed sanitizer into each suite's sandbox. The
 * exact mapper returns that same function; PDF imports keep their VM support.
 */

const path = require('node:path');

// Dedicated sandbox-global key. Kept in sync with
// jest.native-sanitize-html.cjs (the two files are intentionally the only two
// that know this key).
const SANITIZE_GLOBAL_KEY = '__CAPIRO_JEST_NATIVE_SANITIZE_HTML__';

// Dedicated sandbox-global key for the REAL installed @makegov/tango-node
// namespace. Kept in sync with jest.native-tango.cjs (the two files are
// intentionally the only two that know this key).
const TANGO_GLOBAL_KEY = '__CAPIRO_JEST_NATIVE_TANGO_NODE__';

/**
 * Load the REAL installed `@makegov/tango-node` with native Node require in
 * the host realm.
 *
 * The SDK is ESM-only (`"type": "module"`, no CJS build). The runner loads this
 * environment through native Node resolution, and Node >= 22.12 can
 * `require()` an ESM package synchronously — but jest's per-suite VM cannot:
 * with `--experimental-vm-modules` set, jest-runtime refuses the require with
 * "Must use import to load ES Module" before any transform can help. So the
 * host realm loads the namespace once and publishes it on the sandbox global;
 * the exact-specifier mapper (`^@makegov/tango-node$`) returns that same
 * namespace to product and probe code.
 *
 * If the package is missing or does not export a `TangoClient` we must fail
 * loudly — never fall back to a stub or mock.
 */
let cachedTangoNamespace;
function loadNativeTangoNamespace() {
  if (cachedTangoNamespace !== undefined) {
    return cachedTangoNamespace;
  }
  let namespace;
  try {
    namespace = require('@makegov/tango-node');
  } catch (error) {
    throw new Error(
      'jest.native-runtime-environment: failed to load the installed "@makegov/tango-node" '
        + 'with native Node require. ' + (error && error.message ? error.message : String(error)),
    );
  }
  if (!namespace || typeof namespace.TangoClient !== 'function') {
    throw new Error(
      'jest.native-runtime-environment: the installed "@makegov/tango-node" did not export a '
        + 'TangoClient class.',
    );
  }
  cachedTangoNamespace = namespace;
  return namespace;
}

/**
 * Locate the real installed `jest-environment-node`.
 *
 * It is a transitive dependency (jest -> jest-cli -> jest-config ->
 * jest-environment-node) and under pnpm's strict layout it is NOT resolvable
 * from apps/api by bare specifier. jest IS a direct devDependency of apps/api,
 * so anchor on jest's real install dir and let Node walk up into pnpm's
 * hoisted `node_modules/.pnpm/node_modules` store. The jest-config attempt is a
 * belt-and-braces fallback because jest-config's own pnpm directory is
 * peer-suffixed (it carries @types/node / ts-node peers).
 */
function resolveJestEnvironmentNode() {
  const attempts = [
    () => require.resolve('jest-environment-node'),
    () => {
      const jestDir = path.dirname(require.resolve('jest/package.json'));
      return require.resolve('jest-environment-node', { paths: [jestDir] });
    },
    () => {
      const jestDir = path.dirname(require.resolve('jest/package.json'));
      const jestConfigPkg = require.resolve('jest-config/package.json', { paths: [jestDir] });
      return require.resolve('jest-environment-node', { paths: [path.dirname(jestConfigPkg)] });
    },
  ];

  const failures = [];
  for (const attempt of attempts) {
    try {
      const resolved = attempt();
      if (resolved) {
        return resolved;
      }
    } catch (error) {
      failures.push(error && error.message ? error.message : String(error));
    }
  }
  throw new Error(
    'jest.native-runtime-environment: unable to locate the installed "jest-environment-node". '
      + 'Attempts failed:\n  ' + failures.join('\n  '),
  );
}

const jestEnvironmentNode = require(resolveJestEnvironmentNode());
const NodeEnvironment = jestEnvironmentNode.TestEnvironment || jestEnvironmentNode.default;
if (typeof NodeEnvironment !== 'function') {
  throw new Error(
    'jest.native-runtime-environment: jest-environment-node did not export a TestEnvironment class.',
  );
}

// The ACTUAL installed sanitize-html, loaded once per worker by native Node
// require in the host realm. If the package is missing or does not export a
// function we must fail loudly - never fall back to a stub or mock.
const nativeSanitizeHtml = require('sanitize-html');
if (typeof nativeSanitizeHtml !== 'function') {
  throw new Error(
    'jest.native-runtime-environment: the installed "sanitize-html" did not export a function.',
  );
}

class NativeRuntimeEnvironment extends NodeEnvironment {
  constructor(config, context) {
    super(config, context);

    const sandboxGlobal = this.global;
    if (!sandboxGlobal) {
      throw new Error('jest.native-runtime-environment: the sandbox global object is unavailable.');
    }
    Object.defineProperty(sandboxGlobal, SANITIZE_GLOBAL_KEY, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: nativeSanitizeHtml,
    });

    // Publish the REAL @makegov/tango-node namespace (loaded via native Node
    // require in the host realm) for the exact-specifier mapper. If the SDK
    // could not be loaded, defer the loud failure to the bridge instead of
    // breaking every suite that never touches tango.
    let tangoValue;
    try {
      tangoValue = loadNativeTangoNamespace();
    } catch (error) {
      tangoValue = error instanceof Error ? error : new Error(String(error));
    }
    if (tangoValue instanceof Error) {
      Object.defineProperty(sandboxGlobal, TANGO_GLOBAL_KEY, {
        configurable: true,
        enumerable: false,
        get() {
          throw tangoValue;
        },
      });
    } else {
      Object.defineProperty(sandboxGlobal, TANGO_GLOBAL_KEY, {
        configurable: true,
        enumerable: false,
        writable: false,
        value: tangoValue,
      });
    }
  }

  async teardown() {
    // Remove ONLY this bridge's own sandbox entry, then hand back to the
    // standard NodeEnvironment teardown so every usual behavior (fake timers
    // disposal, context release) is preserved.
    try {
      if (this.global) {
        delete this.global[SANITIZE_GLOBAL_KEY];
        delete this.global[TANGO_GLOBAL_KEY];
      }
    } finally {
      await super.teardown();
    }
  }
}

module.exports = NativeRuntimeEnvironment;
module.exports.default = NativeRuntimeEnvironment;

// Exposed for the sandbox bridge / diagnostics to assert the exact realm
// identity of the export without duplicating the key string.
module.exports.SANITIZE_GLOBAL_KEY = SANITIZE_GLOBAL_KEY;
module.exports.TANGO_GLOBAL_KEY = TANGO_GLOBAL_KEY;
