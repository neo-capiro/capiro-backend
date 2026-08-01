import { ReadableStream, TransformStream } from 'node:stream/web';
import { webcrypto } from 'node:crypto';
import { Blob, File } from 'node:buffer';
import { MessagePort } from 'node:worker_threads';

if (!(globalThis as any).TransformStream) {
  (globalThis as any).TransformStream = TransformStream;
}
// cheerio v1 (Phase 1 M3.2, FL FAR client) requires undici at import time
// (even though this codebase only calls cheerio.load, never cheerio.fromURL),
// and undici's webidl module reads globalThis.ReadableStream unconditionally
// — jest's node environment doesn't forward it, same class of gap as
// TransformStream above.
if (!(globalThis as any).ReadableStream) {
  (globalThis as any).ReadableStream = ReadableStream;
}
if (!(globalThis as any).Blob) {
  (globalThis as any).Blob = Blob;
}
if (!(globalThis as any).File) {
  (globalThis as any).File = File;
}
if (!(globalThis as any).MessagePort) {
  (globalThis as any).MessagePort = MessagePort;
}
// Real Node exposes DOMException as a bare realm global since v17 (no
// `node:*` export to import it from) — jest's node environment doesn't
// forward it either. A minimal Error subclass is enough: undici's webidl
// module only needs the symbol to exist to build a type-assertion function,
// it never runs through these unit tests' actual code paths.
if (!(globalThis as any).DOMException) {
  (globalThis as any).DOMException = class DOMException extends Error {};
}
if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = webcrypto;
}

// @clerk/backend references the global fetch family as bare identifiers at
// import time (`fetch.bind(...)`, `Request`, ...), which the AppModule DI
// smoke test triggers; jest 29's node environment does not forward Node's
// fetch globals into the sandbox. Binding-compatible stubs are enough — unit
// tests never perform real HTTP.
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

// Existing suites exercise governed behavior directly without the HTTP tenant
// interceptor. Select all tenants inside Jest only. Dedicated rollout tests
// delete/override these values to prove fail-closed production semantics.
process.env.MEMORY_GOVERNANCE_TENANTS ??= 'all';
process.env.MERI_POLICY_PACK_TENANTS ??= 'all';
