// @clerk/backend references web-platform globals at import time; jest 29's
// node environment doesn't forward them into the sandbox. Binding-compatible
// stubs are enough — unit tests never perform real HTTP. (Mirrors the
// orchestrator's jest.setup.ts, the proven consumer of the same import.)
import { webcrypto } from 'node:crypto';

if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = webcrypto;
}
if (!(globalThis as any).fetch) {
  (globalThis as any).fetch = () =>
    Promise.reject(new Error('global fetch is not available in the jest sandbox'));
}
for (const name of ['Request', 'Response', 'Headers', 'FormData', 'TransformStream']) {
  if (!(globalThis as any)[name]) {
    (globalThis as any)[name] = class {
      static stubbedForJest = true;
    };
  }
}
