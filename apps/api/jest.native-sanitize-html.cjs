'use strict';

/**
 * Test-only CommonJS bridge for the `'sanitize-html'` specifier.
 *
 * This module is the target of the exact `moduleNameMapper` entry
 * `'^sanitize-html$'` in jest.config.cjs. It is loaded INSIDE the per-suite
 * test VM (unlike the environment), so it does not - and must not - try to
 * `require('sanitize-html')` itself: that is exactly the require that
 * jest-runtime refuses with ERR_REQUIRE_ESM under --experimental-vm-modules.
 *
 * Instead it re-exports the REAL sanitize-html export that
 * `jest.native-runtime-environment.cjs` loaded with native Node require in the
 * host realm and published on the sandbox global under this exact string key.
 * The value IS the same function object the real installed package exports
 * (real parser, real allowlist/transform behavior), not a mock or stub.
 *
 * If the global is absent or is not a function we THROW. We never fall back to
 * a fake, a stub, or the real package (which the runtime would refuse anyway).
 */

const SANITIZE_GLOBAL_KEY = '__CAPIRO_JEST_NATIVE_SANITIZE_HTML__';

const implementation = globalThis[SANITIZE_GLOBAL_KEY];

if (typeof implementation !== 'function') {
  throw new Error(
    'jest.native-sanitize-html bridge: the native sanitize-html export was not found on the '
      + `sandbox global ("${SANITIZE_GLOBAL_KEY}"). This bridge only works when the suite runs `
      + 'under jest.native-runtime-environment.cjs, which publishes the real installed sanitize-html '
      + 'there. Refusing to fall back to a mock, stub, or the ESM-broken specifier.',
  );
}

module.exports = implementation;
