'use strict';

/**
 * Test-only CommonJS bridge for the `'@makegov/tango-node'` specifier.
 *
 * This module is the target of the exact `moduleNameMapper` entry
 * `'^@makegov/tango-node$'` in jest.config.cjs. It is loaded INSIDE the
 * per-suite test VM (unlike the environment), so it does not - and must not -
 * try to `require('@makegov/tango-node')` itself: the SDK declares
 * `"type": "module"` and ships no CJS build, and that is exactly the require
 * jest-runtime refuses under --experimental-vm-modules with "Must use import to
 * load ES Module".
 *
 * Instead it re-exports the REAL `@makegov/tango-node` namespace that
 * `jest.native-runtime-environment.cjs` loaded with native Node require in the
 * host realm and published on the sandbox global under this exact string key.
 * The value IS the same module namespace the real installed package exports
 * (real TangoClient, real URL building, real header handling, real error
 * taxonomy) - not a mock or stub. Product code (tango.client.ts) and probe code
 * (tango-capability-probe.service.ts) both reach it through their dynamic
 * `import('@makegov/tango-node')`, which ts-jest down-compiles to a require of
 * this specifier.
 *
 * If the global is absent or does not carry a `TangoClient` class we THROW. We
 * never fall back to a fake, a stub, or the ESM-broken specifier.
 */

const TANGO_GLOBAL_KEY = '__CAPIRO_JEST_NATIVE_TANGO_NODE__';

const implementation = globalThis[TANGO_GLOBAL_KEY];

if (!implementation || typeof implementation.TangoClient !== 'function') {
  throw new Error(
    'jest.native-tango bridge: the native @makegov/tango-node namespace was not found on the '
      + `sandbox global ("${TANGO_GLOBAL_KEY}"), or it did not expose a TangoClient class. This bridge `
      + 'only works when the suite runs under jest.native-runtime-environment.cjs, which publishes the '
      + 'real installed SDK there. Refusing to fall back to a mock, stub, or the ESM-broken specifier.',
  );
}

module.exports = implementation;
