import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createMemoryReadHttp } from '../memory-read-http.mjs';

test('same operator session refreshes each bounded native request without changing authority', async () => {
  const calls = [];
  const previous = https.request;
  https.request = (url, options, respond) => {
    calls.push({ url: String(url), options });
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () =>
      queueMicrotask(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = { 'x-capiro-release-sha': 'UNIT' };
        respond(res);
        res.emit('data', Buffer.from('[]'));
        res.emit('end');
      });
    req.destroy = (error) => req.emit('error', error);
    return req;
  };
  try {
    let refreshes = 0;
    const id = '11111111-1111-4111-8111-111111111111';
    const h = createMemoryReadHttp({
      bearer: async () => `UNIT_ROTATION_${++refreshes}`,
      conversationId: id,
      timeoutMs: 5000,
    });
    await h.request('/api/me');
    await h.request('/api/clio/status');
    assert.deepEqual(
      calls.map((x) => x.options.headers.authorization),
      ['Bearer UNIT_ROTATION_1', 'Bearer UNIT_ROTATION_2'],
    );
    assert.ok(
      calls.every(
        (x) =>
          x.url.startsWith('https://os.capiro.ai/') &&
          x.options.rejectUnauthorized === true &&
          x.options.headers['x-capiro-tenant'] === 'meri-foundation-20260928-t1',
      ),
    );
    await h.request(`/api/clio/conversations/${id}/stream`, { body: 'UNIT' });
    assert.throws(
      () => h.request(`/api/clio/conversations/${id}/stream`, { body: 'UNIT' }),
      /TRANSPORT_BOUND/,
    );
    assert.equal(refreshes, 3);
  } finally {
    https.request = previous;
  }
});
test('invalid refresh is refused before native network creation', async () => {
  const h = createMemoryReadHttp({
    bearer: async () => null,
    conversationId: '11111111-1111-4111-8111-111111111111',
    timeoutMs: 1000,
  });
  await assert.rejects(h.request('/api/me'), /HTTP_IDENTITY_INVALID/);
});
test('unresolved refresh consumes the existing total deadline', async () => {
  const h = createMemoryReadHttp({
    bearer: () => new Promise(() => {}),
    conversationId: '11111111-1111-4111-8111-111111111111',
    timeoutMs: 1000,
  });
  await assert.rejects(h.request('/api/me'), /MEMORY_READ_DEADLINE/);
});
