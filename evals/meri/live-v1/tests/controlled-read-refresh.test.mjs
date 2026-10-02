import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
const source = readFileSync(
  new URL('../controlled-read-live-capture.mjs', import.meta.url),
  'utf8',
);
function harness(supplier, deadlineMs = 1000) {
  const calls = [],
    saved = [],
    scope = {
      bearer: 'UNIT_INITIAL',
      tenant: { slug: 'meri-foundation-20260928-t1' },
      expected: { conversationId: '11111111-1111-4111-8111-111111111111' },
    };
  const https = {
    request(url, options, callback) {
      calls.push({ url: String(url), options });
      const req = new EventEmitter();
      req.write = () => {};
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.end = () =>
        queueMicrotask(() => {
          const res = new EventEmitter();
          res.statusCode = options.method === 'POST' ? 201 : 200;
          res.headers = { 'x-capiro-release-sha': 'UNIT_SOURCE' };
          callback(res);
          res.emit('data', Buffer.from('[]'));
          res.emit('end');
        });
      return req;
    },
  };
  const code = source.slice(
    source.indexOf('function nativeTransport('),
    source.indexOf('\nasync function currentAdmission'),
  );
  const factory = vm.runInNewContext('(' + code + ')', {
    https,
    Buffer,
    Date,
    Promise,
    URL,
    TextDecoder,
    setTimeout,
    clearTimeout,
    Error,
    JSON,
    Array,
    Math,
    ORIGIN: 'https://os.capiro.ai',
    need: (v, c) => {
      if (!v) throw new Error(c);
    },
    writeCaptureHttpObservation: async (_collector, _ref, _value, bearer) => saved.push(bearer),
  });
  const collector = { secretValues: ['UNIT_INITIAL'] };
  return {
    transport: factory(scope, deadlineMs, collector, supplier),
    calls,
    saved,
    collector,
    scope,
  };
}
test('fresh bearer per native call retains source header, TLS, tenant and exactly one POST', async () => {
  let n = 0;
  const h = harness(async () => `UNIT_FRESH_${++n}`);
  await h.transport.json('/api/me');
  const post = `/api/clio/conversations/${h.scope.expected.conversationId}/stream`;
  const stream = await h.transport.request(post, { message: 'UNIT' });
  assert.equal(stream.releaseSha, 'UNIT_SOURCE');
  await h.transport.json(`/api/clio/conversations/${h.scope.expected.conversationId}/messages`);
  await assert.rejects(
    h.transport.request(post, { message: 'UNIT' }),
    /DUPLICATE_OR_UNAPPROVED_WRITE/,
  );
  assert.equal(n, 3);
  assert.deepEqual(
    h.calls.map((c) => c.options.headers.authorization),
    ['Bearer UNIT_FRESH_1', 'Bearer UNIT_FRESH_2', 'Bearer UNIT_FRESH_3'],
  );
  assert.ok(
    h.calls.every(
      (c) =>
        c.url.startsWith('https://os.capiro.ai/') &&
        c.options.rejectUnauthorized === true &&
        c.options.headers['x-capiro-tenant'] === 'meri-foundation-20260928-t1' &&
        c.options.headers['user-agent'] === 'Capiro-Meri-Authorized-QA/1.0',
    ),
  );
  assert.deepEqual(h.saved, ['UNIT_FRESH_2']);
  assert.deepEqual(h.collector.secretValues, [
    'UNIT_INITIAL',
    'UNIT_FRESH_1',
    'UNIT_FRESH_2',
    'UNIT_FRESH_3',
  ]);
  assert.equal(h.transport.counts().synthesisSubmissionCount, 1);
});
test('scope violations are refused before refreshing or networking', async () => {
  let n = 0;
  const h = harness(() => {
    n++;
    return 'UNIT';
  });
  await assert.rejects(h.transport.request('//other.example/path'), /PATH_INVALID/);
  await assert.rejects(h.transport.request('/api/foreign', {}), /UNAPPROVED_WRITE/);
  assert.equal(n, 0);
  assert.equal(h.calls.length, 0);
});
test('empty and header-injecting bearers never reach network', async () => {
  for (const token of [null, '', 'bad\r\nheader']) {
    const h = harness(async () => token);
    await assert.rejects(h.transport.request('/api/me'), /AUTH_MISSING/);
    assert.equal(h.calls.length, 0);
  }
});
test('unresolved refresh uses existing deadline and performs no network/retry', async () => {
  let n = 0;
  const h = harness(() => {
    n++;
    return new Promise(() => {});
  }, 25);
  await assert.rejects(h.transport.request('/api/me'), /DEADLINE/);
  assert.equal(n, 1);
  assert.equal(h.calls.length, 0);
});
test('existing static bearer callers still work', async () => {
  const h = harness();
  await h.transport.request('/api/me');
  assert.equal(h.calls[0].options.headers.authorization, 'Bearer UNIT_INITIAL');
});
test('prepare exposes only optional trusted supplier and forwards it to private transport', () => {
  assert.match(source, /bearerSupplier === undefined \|\| typeof bearerSupplier === 'function'/u);
  assert.match(
    source,
    /nativeTransport\(scope, config\.limits\.deadlineMs, collector, bearerSupplier\)/u,
  );
});
