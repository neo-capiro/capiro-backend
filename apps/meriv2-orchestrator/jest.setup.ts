import { TransformStream } from 'node:stream/web';
import { webcrypto } from 'node:crypto';

if (!(globalThis as any).TransformStream) {
  (globalThis as any).TransformStream = TransformStream;
}
if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = webcrypto;
}

// @clerk/backend references the global fetch family as bare identifiers at
// import time. Jest 29's node environment does not forward Node's fetch globals
// into the sandbox. Binding-compatible stubs are enough — unit tests never
// perform real HTTP.
if (!(globalThis as any).fetch) {
  (globalThis as any).fetch = () =>
    Promise.reject(new Error('global fetch is not available in the jest sandbox'));
}
for (const name of ['Request', 'Response', 'Headers', 'FormData']) {
  if (!(globalThis as any)[name]) {
    (globalThis as any)[name] = class {
      static stubbedForJest = true;
    };
  }
}

// ClerkService boots a real @clerk/backend client at construction, which
// requires CLERK_SECRET_KEY. The e2e harness wires the full AppModule so the
// constructor runs even though no test hits the network. Provide a dummy
// secret so DI succeeds; tests that need verification mock the service.
if (!process.env.CLERK_SECRET_KEY) {
  process.env.CLERK_SECRET_KEY = 'sk_test_meriv2_jest_dummy';
}

// PrismaService instantiates a PrismaClient (lazy connect). Provide a dummy
// DATABASE_URL so construction never complains; no test opens a connection.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/capiro?schema=public';
}
