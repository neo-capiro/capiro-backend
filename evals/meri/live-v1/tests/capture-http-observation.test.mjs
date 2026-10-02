// OFFLINE only. Execute actual private collector/transport bodies in an isolated
// VM with fake sockets and spending assertions; no production injection seam.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeCaptureHttpObservation } from '../capture-http-observation.mjs';
import { sha256Bytes } from '../artifact-collector.mjs';
import { parseCaptureSse } from '../capture-transport.mjs';
import { nativeMeriCaptureHeaders } from '../lib/native-http.mjs';

const id = '12345678-1234-4234-8234-123456789012';
const bearer = 'OFFLINE_ONLY_NOT_A_VALID_BEARER';
function collector() {
  const root = mkdtempSync(join(tmpdir(), 'meri-response-unit-'));
  return {
    root,
    async writeBytes(ref, bytes) {
      const file = join(root, ref);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, bytes, { flag: 'wx' });
      return { ref, sha256: sha256Bytes(bytes) };
    },
    async writeJson(ref, value) {
      return this.writeBytes(ref, Buffer.from(JSON.stringify(value)));
    },
    async finalize(value) {
      this.finalized = value;
    },
    read(ref) {
      return JSON.parse(readFileSync(join(root, ref), 'utf8'));
    },
  };
}
function need(value, code) {
  if (!value) throw new Error(code);
}
function body(source, start, end) {
  const a = source.indexOf(start),
    b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b).replace(/^export /u, '');
}
function harness(caseId, failure) {
  const memory = ['01', '14'].includes(caseId);
  const source = readFileSync(
    new URL(
      memory ? '../case01-live-capture.mjs' : '../controlled-read-live-capture.mjs',
      import.meta.url,
    ),
    'utf8',
  );
  const store = collector();
  const scope = {
    bearer,
    tenant: { slug: 'meri-foundation-20260928-t1' },
    expected: { caseId, conversationId: id },
  };
  const config = { caseId, conversationId: id, captureRunId: id };
  let posts = 0,
    gets = 0,
    settles = 0;
  const citation = {
    source: memory
      ? { kind: 'memory' }
      : {
          kind: 'controlled_read',
          recordId: id,
          clientId: undefined,
          conversationId: id,
          version: 'v1',
          section: 'page 14',
        },
  };
  scope.source = { physicalId: id };
  const events = [
    { type: 'turn_accepted' },
    { type: 'text', text: 'Actual offline answer' },
    ...(['citation', 'http', 'encoding'].includes(failure) || caseId === '72'
      ? []
      : [{ type: 'citations', citations: [citation] }]),
    { type: 'done', messageId: id },
  ];
  const stream = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const https = {
    request(url, options, callback) {
      assert.equal(url.origin, 'https://os.capiro.ai');
      assert.equal(options.rejectUnauthorized, true);
      const req = new EventEmitter();
      req.write = () => {};
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.end = () =>
        queueMicrotask(() => {
          const post = options.method === 'POST';
          if (post) posts++;
          else gets++;
          const raw = post
            ? failure === 'encoding'
              ? Buffer.from([0xff])
              : Buffer.from(stream)
            : Buffer.from(
                JSON.stringify(
                  url.pathname.endsWith('/messages')
                    ? posts
                      ? [{ id, role: 'assistant', body: 'Different persisted answer' }]
                      : []
                    : {},
                ),
              );
          const response = new EventEmitter();
          response.statusCode = post && failure === 'http' ? 503 : 200;
          response.headers = { 'x-capiro-release-sha': 'a'.repeat(40), 'set-cookie': 'NEVER_SAVE' };
          callback(response);
          response.emit('data', raw);
          response.emit('end');
        });
      return req;
    },
  };
  const admission = { fixture: {}, providerBudget: {}, expiresAt: Date.now() + 60000 };
  const sessions = new WeakMap(),
    capability = {};
  const context = vm.createContext({
    https,
    URL,
    URLSearchParams,
    Buffer,
    TextDecoder,
    Date,
    Math,
    JSON,
    Error,
    Promise,
    setTimeout,
    clearTimeout,
    need,
    ORIGIN: 'https://os.capiro.ai',
    nativeMeriCaptureHeaders,
    writeCaptureHttpObservation,
    isDeepStrictEqual,
    parseCaptureSse,
    sha256Bytes,
    sessions,
    fixedCases: { [caseId]: { prompt: 'OFFLINE_ONLY' } },
    selectedCase: () => ({ prompt: 'OFFLINE_ONLY' }),
    currentAdmission: async () => ({ admission }),
    assertCaptureSpendReservation: () => {},
    settleCaptureSpendReservation: () => {
      settles++;
      throw new Error('SHOULD_NOT_SETTLE');
    },
    assertCase01ReceiptJoins: () => {
      throw new Error('SHOULD_NOT_GRANT_AUTHORITY');
    },
    assertCase14ReceiptJoins: () => {
      throw new Error('SHOULD_NOT_GRANT_AUTHORITY');
    },
    assertControlledReadReceiptJoins: () => {
      throw new Error('SHOULD_NOT_GRANT_AUTHORITY');
    },
  });
  const transport = vm.runInContext(
    `(${body(source, 'function nativeTransport(', '\nasync function currentAdmission')})`,
    context,
  )(scope, 10000, store);
  sessions.set(capability, {
    scope,
    config,
    collector: store,
    transport,
    before: { admission },
    builds: { observedAt: Date.now() },
    spendReservation: {},
    consumed: false,
  });
  const start = memory
    ? 'async function executeMemoryLiveCapture('
    : 'export async function executeControlledReadLiveCapture(';
  const execute = vm.runInContext(`(${body(source, start, '\n/** Only this process')})`, context);
  return {
    store,
    stream,
    execute: () => execute(capability),
    counts: () => ({ posts, gets, settles }),
  };
}

for (const caseId of ['01', '14', '20', '72']) {
  const failures =
    caseId === '72' ? ['row', 'http', 'encoding'] : ['citation', 'row', 'http', 'encoding'];
  for (const failure of failures)
    test(`case${caseId} preserves the actual response before ${failure} rejection`, async () => {
      const h = harness(caseId, failure),
        result = await h.execute();
      assert.equal(result.status, 'CAPTURE_UNCERTAIN');
      const saved = h.store.read('stream-response-observation.json');
      assert.equal(saved.captureAuthority, false);
      assert.equal(saved.acceptanceStatus, 'NOT_RUN');
      assert.equal(saved.status, failure === 'http' ? 503 : 200);
      assert.equal(
        saved.bodySha256,
        sha256Bytes(failure === 'encoding' ? Buffer.from([0xff]) : h.stream),
      );
      if (failure !== 'encoding') assert.equal(saved.text, h.stream);
      assert.equal(JSON.stringify(saved).includes('NEVER_SAVE'), false);
      if (failure === 'citation') assert.match(result.reason, /CITATION_MISSING/u);
      if (failure === 'row') {
        assert.match(result.reason, /PERSISTENCE_MISMATCH/u);
        assert.match(
          h.store.read('saved-messages-observation.json').text,
          /Different persisted answer/u,
        );
      }
      assert.equal(h.counts().posts, 1);
      assert.equal(h.counts().settles, 0);
      await assert.rejects(h.execute(), /CAPABILITY_REQUIRED/u);
    });
}

test('redacts nested JSON/SSE credentials and exact bearer while retaining original hash', async () => {
  const store = collector();
  const raw = `data: ${JSON.stringify({ type: 'error', access_token: 'PRIVATE_TOKEN', nested: { secret: { data: 'PRIVATE_OBJECT' } }, message: `Bearer ${bearer}` })}\n\n`;
  await writeCaptureHttpObservation(
    store,
    'response.json',
    { status: 403, text: raw, releaseSha: bearer },
    bearer,
  );
  const saved = store.read('response.json');
  assert.equal(saved.bodySha256, sha256Bytes(raw));
  assert.equal(saved.redacted, true);
  assert.equal(saved.releaseSha, null);
  for (const secret of [bearer, 'PRIVATE_TOKEN', 'PRIVATE_OBJECT'])
    assert.equal(JSON.stringify(saved).includes(secret), false);
  await assert.rejects(
    writeCaptureHttpObservation(
      store,
      'large.json',
      { bytes: Buffer.alloc(8 * 1024 * 1024 + 1) },
      bearer,
    ),
    /OBSERVATION_LIMIT/u,
  );
});

test('case14 approval saves a redacted rejected acknowledgement before its unchanged HTTP assertion', async () => {
  const source = readFileSync(new URL('../case14-approval-capture.mjs', import.meta.url), 'utf8');
  const actual = body(source, '    const response = await pending;', '    await section\n');
  const store = collector();
  const raw = Buffer.from('{"error":"approval rejected","access_token":"PRIVATE_ACK"}');
  const context = vm.createContext({
    pending: Promise.resolve({
      status: () => 503,
      body: async () => raw,
      headers: () => ({ 'x-capiro-release-sha': 'a'.repeat(40) }),
    }),
    armed: true,
    bearer,
    need,
    writeCaptureHttpObservation,
    artifactStorage: store,
    Buffer,
  });
  await assert.rejects(vm.runInContext(`(async () => {${actual}})()`, context), /APPROVAL_HTTP/u);
  const saved = store.read('case14-approval/approval-response-observation.json');
  assert.equal(saved.status, 503);
  assert.match(saved.text, /approval rejected/u);
  assert.equal(saved.text.includes('PRIVATE_ACK'), false);
  assert.equal(saved.captureAuthority, false);
});
