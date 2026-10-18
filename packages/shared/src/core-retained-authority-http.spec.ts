import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import canonicalize from 'canonicalize';
import {
  createCoreRetainedAuthorityProbeSigner, createCoreRetainedAuthorityProbeCryptographicVerifier,
  CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH,
} from './core-retained-authority-probe.js';
import { createCoreRetainedPrincipalSigner } from './core-retained-principal.js';
import {
  createCoreFloridaAuthorityPort, createIntelCoreAuthorityClient,
  CoreRetainedAuthorityHttpError, CORE_RETAINED_FLORIDA_NATIVE_CURRENT_PATH,
  CORE_RETAINED_FLORIDA_CURRENT_PATH, CORE_RETAINED_FLORIDA_DATA_PATH,
  type CoreRetainedAuthorityFetch, type CoreRetainedAuthorityHttpControl,
} from './core-retained-authority-http.js';

// Ephemeral synthetic keys and injected in-memory fetch only; no socket/server.
const keys = generateKeyPairSync('ed25519');
const origins = { coreOrigin: 'https://core.invalid', intelOrigin: 'https://intel.invalid' };
const principal = { tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  actorId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', clerkUserId: 'synthetic-clerk-subject' };
const selector = { schemaVersion: 1 as const, sessionKey: '', folderId: null, clientSelector: null };
const identityRevision = '1'.repeat(64), resourceRevision = '2'.repeat(64);
const pins = { keyId: 'synthetic-test', issuer: 'synthetic-core', audienceOrigin: origins.intelOrigin,
  operation: 'get_florida_budget_project' as const };
const probeSigner = createCoreRetainedAuthorityProbeSigner({ ...pins, privateKey: keys.privateKey,
  recipientPath: CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH, canonicalize });
const probeVerifier = createCoreRetainedAuthorityProbeCryptographicVerifier({ ...pins, publicKey: keys.publicKey,
  recipientPath: CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH, canonicalize });
const dataSigner = createCoreRetainedPrincipalSigner({ ...pins, privateKey: keys.privateKey,
  recipientPath: CORE_RETAINED_FLORIDA_DATA_PATH, canonicalize });
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), {
  ...init, headers: { 'content-type': 'application/json', ...init?.headers },
});
const decode = (header: string) => JSON.parse(Buffer.from(header.slice(header.indexOf(' ') + 1), 'base64url').toString('utf8'));
const control = (milliseconds = 10_000): CoreRetainedAuthorityHttpControl => ({ deadlineMs: Date.now() + milliseconds, assertActive() {} });
const native = (expiry = Date.now() + 10_000) => ({ principal, identityRevision,
  currentAuthority: '{"schemaVersion":1,"synthetic":true}', originalExpiresAtMs: expiry });
const input = (c = control(), n = native()) => ({ principal, selector, nativeAuthority: n, control: c });
const status = (expected: number) => (error: unknown) => error instanceof CoreRetainedAuthorityHttpError && error.status === expected;
const scope = { jurisdiction: 'FL', sessionKey: '', folderId: null, clientId: null };
const authorityReceipt = (header: string, changes: Record<string, unknown> = {}) => ({
  schemaVersion: 1, principal, identityRevision, resourceRevision, effectiveScope: scope, clientResolution: null,
  checkedAtMs: Date.now(), originalExpiresAtMs: decode(header).originalExpiresAtMs, ...changes,
});
const currentReceipt = (header: string, resource = false, changes: Record<string, unknown> = {}) => ({
  principal, identityRevision, ...(resource ? { resourceRevision } : {}), checkedAtMs: Date.now(),
  originalExpiresAtMs: decode(header).originalExpiresAtMs, ...changes,
});
const corePort = (fetch: CoreRetainedAuthorityFetch) => createCoreFloridaAuthorityPort({ ...origins, fetch, canonicalize, probeSigner });
const client = (fetch: CoreRetainedAuthorityFetch) => createIntelCoreAuthorityClient({ ...origins, fetch, canonicalize });
function probeHeader(expires = Date.now() + 10_000): string {
  const now = Date.now();
  return probeSigner.sign({ ...native(expires), selector, issuedAtMs: now }, { nowMs: now, deadlineMs: expires });
}
function dataHeader(request: unknown = {}, context: unknown = {}, expires = Date.now() + 10_000): string {
  const now = Date.now();
  const digest = (value: unknown) => createHash('sha256').update(canonicalize(value)).digest('hex');
  return dataSigner.sign({ ...native(expires), issuedAtMs: now, resourceRevision,
    rawRequestSha256: digest(request), normalizedArgsSha256: '3'.repeat(64), normalizationContextSha256: digest(context),
  }, { nowMs: now, deadlineMs: expires });
}

test('unconfigured ports fail503 without inspecting untrusted input', async () => {
  let touched = 0;
  const trap = new Proxy({}, { get() { touched++; throw Error('touched'); }, ownKeys() { touched++; throw Error('touched'); } });
  await assert.rejects(createCoreFloridaAuthorityPort().read(trap as never), status(503));
  await assert.rejects(createIntelCoreAuthorityClient(null).verifyProbeCurrent(trap, trap as never, trap as never), status(503));
  await assert.rejects(createIntelCoreAuthorityClient().verifyFloridaDataCurrent(trap, trap, trap, trap as never), status(503));
  assert.equal(touched, 0);
});

for (const origin of ['http://core.invalid', 'https://core.invalid/', 'https://user:pass@core.invalid',
  'https://core.invalid/path', 'https://core.invalid?x=1', 'https://CORE.invalid', 'https://core.invalid:443']) {
  test(`rejects noncanonical pinned origin ${origin}`, () => {
    const fetch: CoreRetainedAuthorityFetch = async () => { assert.fail('no HTTP'); };
    assert.throws(() => createIntelCoreAuthorityClient({ ...origins, coreOrigin: origin, fetch, canonicalize }), status(503));
    assert.throws(() => createCoreFloridaAuthorityPort({ ...origins, intelOrigin: origin, fetch, canonicalize, probeSigner }), status(503));
  });
}

test('Core signs real distinct probe, uses only fixed Intel route, and copies authorized facts', async () => {
  let count = 0;
  const result = await corePort(async (url, init) => {
    count++;
    assert.equal(url, origins.intelOrigin + CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH);
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'omit'); assert.equal(init.headers.accept, 'application/json');
    assert.deepEqual(Object.keys(init.headers).sort(), ['accept', 'authorization', 'content-type', 'x-meri-deadline-at']);
    assert.deepEqual(JSON.parse(init.body), { schemaVersion: 1, selector });
    const verified = probeVerifier.verifyCryptographically(init.headers.authorization,
      { nowMs: Date.now(), deadlineMs: decode(init.headers.authorization).originalExpiresAtMs, selector });
    assert.equal(init.headers['x-meri-deadline-at'], String(verified.originalExpiresAtMs));
    assert.equal(verified.purpose, 'capiro-retained-florida-authority');
    assert.equal('resourceRevision' in verified, false);
    return json(authorityReceipt(init.headers.authorization));
  }).read(input());
  assert.equal(count, 1); assert.deepEqual(result, { resourceRevision, effectiveScope: scope, clientResolution: null });
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.effectiveScope));
});

test('probe cutoff clips native expiry, caller deadline and thirty-second maximum', async () => {
  for (const [nativeMs, callerMs, ceiling] of [[80_000, 70_000, 30_000], [7000, 8000, 7000], [8000, 6000, 6000]]) {
    const started = Date.now();
    await corePort(async (_url, init) => {
      const signed = decode(init.headers.authorization);
      assert.ok(signed.originalExpiresAtMs <= started + ceiling + 2);
      assert.ok(signed.originalExpiresAtMs <= signed.issuedAtMs + 30_000);
      return json(authorityReceipt(init.headers.authorization));
    }).read(input(control(callerMs), native(started + nativeMs)));
  }
});

test('Core refuses a mismatched captured principal before HTTP', async () => {
  let count = 0;
  await assert.rejects(corePort(async () => { count++; assert.fail('no HTTP'); }).read({ ...input(),
    principal: { ...principal, actorId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' } }), status(409));
  assert.equal(count, 0);
});

for (const [name, change, expected] of [
  ['principal drift', { principal: { ...principal, clerkUserId: 'changed' } }, 409],
  ['identity drift', { identityRevision: '4'.repeat(64) }, 409],
  ['scope drift', { effectiveScope: { ...scope, sessionKey: 'changed' } }, 409],
  ['unrequested client', { effectiveScope: { ...scope, clientId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' } }, 409],
  ['malformed resource vector', { resourceRevision: 'bad' }, 503],
  ['extra receipt field', { credential: 'forbidden' }, 503],
  ['old observation', { checkedAtMs: 0 }, 503],
  ['future observation', { checkedAtMs: Date.now() + 1_000_000 }, 503],
] as const) {
  test(`withholds authority result on ${name}`, async () => {
    await assert.rejects(corePort(async (_url, init) => json(authorityReceipt(init.headers.authorization, change))).read(input()), status(expected));
  });
}

test('response cannot extend the original signed cutoff', async () => {
  await assert.rejects(corePort(async (_url, init) => json(authorityReceipt(init.headers.authorization,
    { originalExpiresAtMs: decode(init.headers.authorization).originalExpiresAtMs + 1 }))).read(input()), status(503));
});

test('folder/client resolution must correlate exact selector and scope', async () => {
  const folderId = 'dddddddd-dddd-dddd-dddd-dddddddddddd', clientId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const selected = { ...selector, sessionKey: '  exact bytes  ', folderId, clientSelector: 'Exact Client' };
  const result = await corePort(async (_url, init) => json(authorityReceipt(init.headers.authorization, {
    effectiveScope: { jurisdiction: 'FL', sessionKey: selected.sessionKey, folderId, clientId },
    clientResolution: { selector: selected.clientSelector, clientId },
  }))).read({ ...input(), selector: selected });
  assert.equal(result.clientResolution?.clientId, clientId);
  await assert.rejects(corePort(async (_url, init) => json(authorityReceipt(init.headers.authorization, {
    effectiveScope: { jurisdiction: 'FL', sessionKey: selected.sessionKey, folderId, clientId },
    clientResolution: { selector: 'Different Client', clientId },
  }))).read({ ...input(), selector: selected }), status(409));
});

for (const httpStatus of [400, 401, 403, 404, 408, 409, 503]) {
  test(`preserves fixed receiving status${httpStatus} without reading a denial body`, async () => {
    await assert.rejects(corePort(async () => json({ never: 'expose' }, { status: httpStatus })).read(input()), status(httpStatus));
  });
}
test('maps unexpected HTTP status and fetch failure to503', async () => {
  await assert.rejects(corePort(async () => json({}, { status: 500 })).read(input()), status(503));
  await assert.rejects(corePort(async () => { throw Error('sensitive transport detail'); }).read(input()), status(503));
});

test('requires JSON content type and refuses redirected responses', async () => {
  await assert.rejects(corePort(async () => new Response('{}', { headers: { 'content-type': 'text/html' } })).read(input()), status(503));
  await assert.rejects(corePort(async () => ({ ...json({}), status: 200, redirected: true,
    headers: new Headers({ 'content-type': 'application/json' }), body: null })).read(input()), status(503));
});
test('rejects oversized declared or streamed response and invalid UTF8', async () => {
  await assert.rejects(corePort(async () => new Response('{}', { headers: {
    'content-type': 'application/json', 'content-length': '262145',
  } })).read(input()), status(503));
  await assert.rejects(corePort(async () => new Response(new Uint8Array(262145), { headers: { 'content-type': 'application/json' } })).read(input()), status(503));
  await assert.rejects(corePort(async () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } })).read(input()), status(503));
});

test('hard cutoff settles a fetch that ignores abort and aborts its signal', async () => {
  let signal: AbortSignal | undefined;
  const started = Date.now();
  await assert.rejects(corePort(async (_url, init) => {
    signal = init.signal; return new Promise(() => undefined);
  }).read(input(control(25))), status(408));
  assert.ok(signal?.aborted); assert.ok(Date.now() - started < 2000);
});
test('hard cutoff settles a stalled response reader', async () => {
  let cancelled = false;
  await assert.rejects(corePort(async () => new Response(new ReadableStream({
    pull() { return new Promise(() => undefined); }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } })).read(input(control(25))), status(408));
  assert.equal(cancelled, true);
});
test('rechecks cancellation after awaited fetch before reading body', async () => {
  let active = true, read = false;
  const c = { deadlineMs: Date.now() + 5000, assertActive() { if (!active) throw new CoreRetainedAuthorityHttpError(408); } };
  await assert.rejects(corePort(async () => {
    active = false;
    return { status: 200, redirected: false, headers: new Headers({ 'content-type': 'application/json' }),
      body: { getReader() { read = true; assert.fail('no read after cancellation'); } } as never };
  }).read(input(c)), status(408));
  assert.equal(read, false);
});
test('queued cancellation prevents a scheduled fetch from starting in its microtask', async () => {
  let active = true, armed = false, fetchCalls = 0;
  const c = { deadlineMs: Date.now() + 5000, assertActive() {
    if (!armed) { armed = true; queueMicrotask(() => { active = false; }); }
    if (!active) throw new CoreRetainedAuthorityHttpError(408);
  } };
  await assert.rejects(corePort(async (_url, init) => {
    fetchCalls++;
    return json(authorityReceipt(init.headers.authorization));
  }).read(input(c)), status(408));
  assert.equal(fetchCalls, 0);
});

test('Intel native-current uses only fixed Core route and exact original probe header/body', async () => {
  const header = probeHeader();
  const result = await client(async (url, init) => {
    assert.equal(url, origins.coreOrigin + CORE_RETAINED_FLORIDA_NATIVE_CURRENT_PATH);
    assert.equal(init.headers.authorization, header);
    assert.deepEqual(JSON.parse(init.body), { schemaVersion: 1, selector });
    return json(currentReceipt(header));
  }).verifyProbeCurrent(header, selector, control());
  assert.deepEqual(result.principal, principal); assert.equal(result.identityRevision, identityRevision);
  assert.ok(Object.isFrozen(result.principal));
});
test('Intel data-current forwards fixed data scheme and actual request/context', async () => {
  const request = { q: '', sessionKey: null }, context = { asOf: '2026-10-16T00:00:00.000Z',
    effectiveScope: scope, clientResolution: null };
  const header = dataHeader(request, context);
  const result = await client(async (url, init) => {
    assert.equal(url, origins.coreOrigin + CORE_RETAINED_FLORIDA_CURRENT_PATH);
    assert.equal(init.headers.authorization, header);
    assert.deepEqual(JSON.parse(init.body), { schemaVersion: 1, request, context });
    assert.deepEqual(Object.keys(init.headers).sort(), ['accept', 'authorization', 'content-type', 'x-meri-deadline-at']);
    return json(currentReceipt(header, true));
  }).verifyFloridaDataCurrent(header, request, context, control());
  assert.equal(result.resourceRevision, resourceRevision);
});
test('Intel rejects cross-purpose, Bearer and service-secret header aliases before HTTP', async () => {
  let calls = 0;
  const c = client(async () => { calls++; assert.fail('no HTTP'); });
  await assert.rejects(c.verifyProbeCurrent(dataHeader(), selector, control()), status(401));
  await assert.rejects(c.verifyFloridaDataCurrent(probeHeader(), {}, {}, control()), status(401));
  await assert.rejects(c.verifyProbeCurrent('Bearer synthetic', selector, control()), status(401));
  await assert.rejects(c.verifyFloridaDataCurrent('serviceSecret synthetic', {}, {}, control()), status(401));
  assert.equal(calls, 0);
});
test('caller deadline hint shortens both corroboration requests and their receipts', async () => {
  const c = client(async (_url, init) => {
    const cutoff = Number(init.headers['x-meri-deadline-at']);
    assert.ok(Number.isSafeInteger(cutoff));
    assert.ok(cutoff < decode(init.headers.authorization).originalExpiresAtMs);
    return json(currentReceipt(init.headers.authorization, _url.endsWith('/retained-florida-current'),
      { originalExpiresAtMs: cutoff }));
  });
  await c.verifyProbeCurrent(probeHeader(), selector, control(2000));
  await c.verifyFloridaDataCurrent(dataHeader(), {}, {}, control(2000));
});
test('Intel rejects wrong recipient, selector drift or resource drift', async () => {
  const header = probeHeader(), parsed = decode(header);
  const changed = 'CapiroRetainedAuthority ' + Buffer.from(canonicalize({ ...parsed, audienceOrigin: 'https://other.invalid' })).toString('base64url');
  await assert.rejects(client(async () => { assert.fail('no HTTP'); }).verifyProbeCurrent(changed, selector, control()), status(401));
  await assert.rejects(client(async () => { assert.fail('no HTTP'); }).verifyProbeCurrent(header, { ...selector, sessionKey: 'changed' }, control()), status(401));
  const data = dataHeader();
  await assert.rejects(client(async () => json(currentReceipt(data, true, { resourceRevision: '4'.repeat(64) })))
    .verifyFloridaDataCurrent(data, {}, {}, control()), status(409));
});
test('Intel rejects stale/extended receipt and closed-receipt extras', async () => {
  const header = probeHeader();
  for (const changes of [{ checkedAtMs: 0 }, { originalExpiresAtMs: decode(header).originalExpiresAtMs + 1 }, { extra: true }]) {
    await assert.rejects(client(async () => json(currentReceipt(header, false, changes))).verifyProbeCurrent(header, selector, control()), status(503));
  }
});
test('request getter/proxy is rejected without invoking it or doing HTTP', async () => {
  let touched = 0, calls = 0;
  const request = Object.defineProperty({}, 'q', { enumerable: true, get() { touched++; return 'bad'; } });
  const c = client(async () => { calls++; assert.fail('no HTTP'); });
  await assert.rejects(c.verifyFloridaDataCurrent(dataHeader(), request, {}, control()), status(400));
  await assert.rejects(c.verifyFloridaDataCurrent(dataHeader(), new Proxy({}, { ownKeys() { touched++; return []; } }), {}, control()), status(400));
  assert.equal(touched, 0); assert.equal(calls, 0);
});
test('request snapshot rejects oversized or deeply nested input before HTTP', async () => {
  let calls = 0;
  const c = client(async () => { calls++; assert.fail('no HTTP'); });
  await assert.rejects(c.verifyFloridaDataCurrent(dataHeader(), { q: 'x'.repeat(2 * 1024 * 1024) }, {}, control()), status(400));
  let deep: unknown = null;
  for (let level = 0; level < 34; level++) deep = { next: deep };
  await assert.rejects(c.verifyFloridaDataCurrent(dataHeader(), deep, {}, control()), status(400));
  assert.equal(calls, 0);
});
