import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const appSource = await readFile(new URL('../src/planner/objective-canonical-application.ts', import.meta.url), 'utf8');
const appUrl = data(stripTypeScriptTypes(appSource));
const generationSource = await readFile(new URL('../src/meri/objective-canonical-generation.ts', import.meta.url), 'utf8');
const generationUrl = data(stripTypeScriptTypes(generationSource
  .replace("'../planner/objective-canonical-application.js'", JSON.stringify(appUrl))));
const bridgeSource = await readFile(new URL('../src/meri/objective-canonical-retained-http-bridge.ts', import.meta.url), 'utf8');
const bridgeUrl = data(stripTypeScriptTypes(bridgeSource
  .replace("'../planner/objective-canonical-application.js'", JSON.stringify(appUrl))
  .replace("'./objective-canonical-generation.js'", JSON.stringify(generationUrl))));
const { ObjectiveCanonicalRetainedHttpBridge, RETAINED_RESULT_READ_PATH,
  CORE_RETAINED_RESULT_READER_SUBJECT,
  RETAINED_RESULT_READ_MAX_BYTES } = await import(bridgeUrl);

const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const source = Object.freeze({ generationJobId: id(1),
  binding: Object.freeze({ tenantId: id(2), actorId: 'clerk_original', conversationId: id(3),
    runId: id(4), attemptId: id(5), workerId: id(6), writerFence: 7 }),
  sourceAdmissionSha256: 'a'.repeat(64) });
const owner = (overrides = {}) => ({ name: CORE_RETAINED_RESULT_READER_SUBJECT,
  authorize: async request => ({ authorization: 'Bearer signed-request-token', expiresAtMs: request.expiresAtMs }),
  recheck: async () => true, ...overrides });
const options = (overrides = {}) => ({ origin: 'https://meri.example.test',
  credentialOwner: owner(),
  fetchImpl: async () => Response.json({ generationJobId: source.generationJobId,
    binding: source.binding, sourceAdmissionSha256: source.sourceAdmissionSha256 }), ...overrides });
const unavailable = error => error?.code === 'AUTHORITY_UNAVAILABLE';

test('sends exact UTF-8 body bytes to fixed HTTPS endpoint with a named rechecked credential', async () => {
  const requests = [];
  const credentials = [];
  let seenUrl;
  let seenInit;
  const bridge = new ObjectiveCanonicalRetainedHttpBridge(options({
    credentialOwner: owner({
      authorize: async request => { requests.push(request);
        return { authorization: 'Bearer signed-request-token', expiresAtMs: request.expiresAtMs }; },
      recheck: async (request, credential) => { requests.push(request); credentials.push(credential); return true; },
    }),
    fetchImpl: async (url, init) => { seenUrl = url; seenInit = init;
      return Response.json({ generationJobId: source.generationJobId,
        binding: source.binding, sourceAdmissionSha256: source.sourceAdmissionSha256 }); },
  }));
  assert.equal(bridge.available(), true);
  const signal = new AbortController().signal;
  const result = await bridge.read(source, { signal });
  assert.equal(result.generationJobId, source.generationJobId);
  assert.equal(seenUrl, `https://meri.example.test${RETAINED_RESULT_READ_PATH}`);
  assert.equal(seenInit.method, 'POST');
  assert.equal(seenInit.redirect, 'error');
  assert.equal(seenInit.credentials, 'omit');
  assert.equal(seenInit.headers['cache-control'], 'no-store');
  assert.equal(seenInit.headers.authorization, 'Bearer signed-request-token');
  assert.equal(seenInit.headers['content-type'], 'application/json');
  const bytes = Buffer.from(seenInit.body, 'utf8');
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), { schemaVersion: 1, source });
  assert.equal(requests.length, 3);
  assert.equal(credentials.length, 2);
  assert.strictEqual(requests[0], requests[1]);
  assert.strictEqual(requests[1], requests[2]);
  assert.equal(Object.isFrozen(requests[0]), true);
  assert.equal(Object.isFrozen(requests[0].source), true);
  assert.equal(Object.isFrozen(requests[0].source.binding), true);
  assert.deepEqual(requests[0].source, source);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].subject, CORE_RETAINED_RESULT_READER_SUBJECT);
  assert.equal(requests[0].path, RETAINED_RESULT_READ_PATH);
  assert.equal(requests[0].bodySha256, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(requests[0].expiresAtMs > Date.now());
  assert.equal(credentials[0].expiresAtMs, requests[0].expiresAtMs);
});

test('rejects an unfixed origin or wrong credential-owner name before sending', async () => {
  for (const origin of ['http://meri.example.test', 'https://meri.example.test/other',
    'https://user:pass@meri.example.test', 'https://meri.example.test/?read=1']) {
    let called = false;
    const bridge = new ObjectiveCanonicalRetainedHttpBridge(options({ origin,
      fetchImpl: async () => { called = true; return Response.json({}); } }));
    assert.equal(bridge.available(), false);
    await assert.rejects(bridge.read(source, { signal: new AbortController().signal }), unavailable);
    assert.equal(called, false);
  }
  const wrong = new ObjectiveCanonicalRetainedHttpBridge(options({ credentialOwner: owner({ name: 'other-workload' }) }));
  assert.equal(wrong.available(), false);
  await assert.rejects(wrong.read(source, { signal: new AbortController().signal }), unavailable);
});

test('rejects redirects and response bodies beyond the transport cap', async () => {
  const redirected = new ObjectiveCanonicalRetainedHttpBridge(options({
    fetchImpl: async () => Response.redirect('https://unexpected.example.test', 302),
  }));
  await assert.rejects(redirected.read(source, { signal: new AbortController().signal }), unavailable);
  const oversized = new ObjectiveCanonicalRetainedHttpBridge(options({
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(RETAINED_RESULT_READ_MAX_BYTES + 1)); controller.close();
    } }), { headers: { 'content-type': 'application/json' } }),
  }));
  await assert.rejects(oversized.read(source, { signal: new AbortController().signal }), unavailable);
});

test('caller abort and three-second deadline close an in-flight read', async () => {
  const controller = new AbortController();
  let fetchSignal;
  const bridge = new ObjectiveCanonicalRetainedHttpBridge(options({ fetchImpl: async (_url, init) => {
    fetchSignal = init.signal;
    return new Promise(() => {});
  } }));
  const pending = bridge.read(source, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, unavailable);
  assert.equal(fetchSignal.aborted, true);

  const timed = new ObjectiveCanonicalRetainedHttpBridge(options({ fetchImpl: async () => new Promise(() => {}) }));
  const start = Date.now();
  await assert.rejects(timed.read(source, { signal: new AbortController().signal }), unavailable);
  assert.ok(Date.now() - start >= 2_900 && Date.now() - start < 4_500);
});

test('credential issuance, expiry, and both rechecks fail closed', async () => {
  let sent = 0;
  const transport = async () => { sent++; return Response.json({}); };
  for (const credentialOwner of [
    owner({ authorize: async () => { throw new Error('secret error'); } }),
    owner({ authorize: async () => ({ authorization: 'Bearer token', expiresAtMs: Date.now() - 1 }) }),
    owner({ authorize: async request => ({ authorization: 'Basic dG9rZW4=', expiresAtMs: request.expiresAtMs }) }),
    owner({ recheck: async () => false }),
  ]) {
    const bridge = new ObjectiveCanonicalRetainedHttpBridge(options({ credentialOwner, fetchImpl: transport }));
    await assert.rejects(bridge.read(source, { signal: new AbortController().signal }), unavailable);
  }
  assert.equal(sent, 0);
  let checks = 0;
  const bridge = new ObjectiveCanonicalRetainedHttpBridge(options({
    credentialOwner: owner({ recheck: async () => ++checks === 1 }), fetchImpl: transport,
  }));
  await assert.rejects(bridge.read(source, { signal: new AbortController().signal }), unavailable);
  assert.equal(sent, 1);
  assert.equal(checks, 2);
});
