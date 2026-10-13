import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
import {
  parseNewsletterLoopbackOrigin, requestNewsletterLoopback, verifyNewsletterLoopbackServing,
  validateNewsletterLoopbackServingReceipt, newsletterLoopbackReceiptSha256,
  HISTORICAL_NEWSLETTER_STATIC_HEADERS,
} from '../lib/newsletter-loopback-serving.mjs';
import { canonicalNewsletterManifest, newsletterByteIdentity, NEWSLETTER_PINS }
  from '../lib/newsletter-static-release-contract.mjs';
import { parseNewsletterLoopbackInvocation, runNewsletterLoopbackOperator }
  from '../verify-newsletter-loopback-serving.mjs';

const manifest = canonicalNewsletterManifest();
const byPath = new Map(manifest.map(entry => [entry.publicPath, entry]));
const artifact = { repository: NEWSLETTER_PINS.frontendRepository,
  commit: NEWSLETTER_PINS.frontendCode, sha256: NEWSLETTER_PINS.frontendManifestSha256 };
const mime = pathname => pathname.endsWith('.png') ? 'image/png'
  : pathname.endsWith('.svg') ? 'image/svg+xml' : 'text/plain';
const syntheticIdentity = (body, pathname) => body.equals(Buffer.from(pathname))
  ? byPath.get(pathname) : newsletterByteIdentity(body);
function frame(spec) {
  const entry = byPath.get(spec.path);
  return { hostname: spec.hostname, port: spec.port, hostHeader: spec.hostHeader,
    method: spec.method, path: spec.path, url: new URL(spec.path, spec.origin).href,
    status: 200, headers: { 'content-type': mime(spec.path), 'x-content-type-options': 'nosniff',
      ...(spec.method === 'HEAD' ? { 'content-length': String(entry.bytes) } : {}),
      'cache-control': 'public, max-age=0', etag: '"synthetic-fixed"' },
    body: spec.method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(spec.path), headWireBodyBytes: 0 };
}
const input = extra => ({ origin: 'http://127.0.0.1:43210', expectedArtifact: artifact,
  artifactPins: artifact, request: spec => frame(spec), identity: syntheticIdentity, ...extra });
const headHeaders = `HTTP/1.1 200 OK\r\nContent-Type: ${mime(manifest[0].publicPath)}\r\nX-Content-Type-Options: nosniff\r\nContent-Length: ${manifest[0].bytes}\r\nConnection: close\r\n\r\n`;
const headRequest = (target, extra = {}) => requestNewsletterLoopback({ ...target,
  path: manifest[0].publicPath, method: 'HEAD', timeoutMs: 500, maxWireBodyBytes: 1024, ...extra });
async function rawHeadFixture(onRequest, run) {
  const sockets = new Set(), timers = new Set();
  const later = (callback, delay = 20) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
  };
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.once('data', request => onRequest(socket, request.toString('latin1'), later));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await run(parseNewsletterLoopbackOrigin(`http://127.0.0.1:${server.address().port}`)); }
  finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

test('literal loopback origin refuses public DNS aliases auth paths normalization and missing/invalid ports', () => {
  assert.deepEqual(parseNewsletterLoopbackOrigin('http://127.0.0.1:80/'),
    { input: 'http://127.0.0.1:80/', origin: 'http://127.0.0.1', hostname: '127.0.0.1', port: 80 });
  for (const value of [undefined, 'https://127.0.0.1:80', 'http://app.capiro.ai:80', 'http://localhost:80',
    'http://127.1:80', 'http://2130706433:80', 'http://0177.0.0.1:80', 'http://[::1]:80',
    'http://127.0.0.2:80', 'http://user:password@127.0.0.1:80', 'http://127.0.0.1',
    'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:00080',
    'http://127.0.0.1:80/newsletter', 'http://127.0.0.1:80?x=y', 'http://127.0.0.1:80#hash',
    'http://127.0.0.1:80\n', 'http://127.0.0.1:80\u2028', { toString() { throw new Error('coercion'); } }]) {
    assert.throws(() => parseNewsletterLoopbackOrigin(value), /loopback|literal/);
  }
});

test('unqualified target artifact/source pins options and limits refuse before any request', async () => {
  let calls = 0;
  const request = () => { calls++; throw new Error('unexpected request'); };
  for (const extra of [
    { origin: 'https://app.capiro.ai' }, { artifactPins: undefined }, { expectedArtifact: undefined },
    { artifactPins: { ...artifact, commit: '0'.repeat(40) } }, { artifactPins: { ...artifact, sha256: '0'.repeat(64) } },
    { expectedArtifact: { ...artifact, commit: artifact.commit + '\n' } },
    { expectedArtifact: { ...artifact, repository: artifact.repository + '\u2028' } },
    { expectedArtifact: { ...artifact, headers: { Authorization: 'unsupported' } } },
    { headers: { Cookie: 'unsupported' } }, { concurrency: 9 }, { timeoutMs: 10001 },
    { totalTimeoutMs: 120001 }, { maxWireBodyBytes: 1048577 }, { maxDecodedBodyBytes: 0 },
  ]) await assert.rejects(verifyNewsletterLoopbackServing(input({ request, ...extra })), /Newsletter loopback/);
  assert.equal(calls, 0);
});

test('all179 GET+HEAD measurements use canonical paths and exact host with bounded concurrency', async () => {
  const calls = []; let active = 0, maximum = 0;
  const receipt = await verifyNewsletterLoopbackServing(input({ concurrency: 3, request: async spec => {
    calls.push(spec); active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return frame(spec);
  } }));
  assert.equal(receipt.status, 'PASS');
  assert.equal(calls.length, 358); assert.equal(maximum, 3);
  assert.deepEqual(receipt.records.map(record => record.method + ' ' + record.publicPath),
    manifest.flatMap(entry => ['GET ' + entry.publicPath, 'HEAD ' + entry.publicPath]));
  assert.ok(calls.every(spec => Object.isFrozen(spec) && spec.hostHeader === 'app.capiro.ai'
    && spec.hostname === '127.0.0.1' && spec.port === 43210 && byPath.has(spec.path)));
  assert.equal(receipt.evidenceKind, 'synthetic-inert-ports');
  assert.equal(receipt.localHttpPerformed, false); assert.equal(receipt.localServingVerified, false);
  assert.equal(receipt.actualAssetBytesVerified, false); assert.equal(receipt.publicDnsTlsVerified, false);
  assert.equal(receipt.records[0].headers['cache-control'], 'public, max-age=0');
  assert.equal(receipt.conditionalArchiveOriginVerified, false);
  assert.equal(receipt.historicalHeadersEquivalent, false);
});

test('five historical headers are separately measured without changing the required static floor', async () => {
  const successor = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' };
  const run = headers => verifyNewsletterLoopbackServing(input({ request: spec => {
    const response = frame(spec); Object.assign(response.headers, headers); return response;
  } }));
  const different = await run(successor);
  assert.equal(different.status, 'PASS'); assert.equal(different.historicalHeadersEquivalent, false);
  assert.deepEqual(different.historicalHeaderComparison['referrer-policy'].observedValues, ['same-origin']);
  assert.deepEqual(different.historicalHeaderComparison['strict-transport-security'].observedValues, [null]);
  assert.ok(different.holds.some(hold => hold.includes('five-header')));
  const equal = await run(HISTORICAL_NEWSLETTER_STATIC_HEADERS);
  assert.equal(equal.status, 'PASS'); assert.equal(equal.historicalHeadersEquivalent, true);
  assert.equal(equal.legacyHeaderParityVerified, false);
});

for (const [name, mutate, message] of [
  ['wrong Host', response => { response.hostHeader = 'another.example'; }, /host\/path\/address/],
  ['wrong path', response => { response.path += '/extra'; }, /host\/path\/address/],
  ['wrong address', response => { response.hostname = '192.0.2.1'; }, /host\/path\/address/],
  ['missing asset', response => { response.status = 404; }, /status\/redirect/],
  ['redirect', response => { response.status = 302; response.headers.location = 'https://app.capiro.ai/newsletter/capitol.png'; }, /status\/redirect/],
  ['HTML auth fallback', response => { response.body = Buffer.from('<html>login</html>'); response.headers['content-type'] = 'text/html'; }, /content-type/],
  ['corrupt asset', response => { response.body = Buffer.from('corrupt'); }, /byte identity/],
  ['wrong MIME', response => { response.headers['content-type'] = 'application/octet-stream'; }, /content-type/],
  ['missing nosniff', response => { delete response.headers['x-content-type-options']; }, /x-content-type-options/],
  ['cookie fallback', response => { response.headers['set-cookie'] = 'redacted-fixture'; }, /auth\/cookie/],
  ['auth challenge', response => { response.headers['www-authenticate'] = 'fixture'; }, /auth\/cookie/],
  ['duplicate header', response => { response.headers['Content-Type'] = response.headers['content-type']; }, /ambiguous/],
  ['HEAD payload', response => { response.body = Buffer.from('unexpected'); }, /HEAD body/],
  ['HEAD wire payload', response => { response.headWireBodyBytes = 1; }, /HEAD wire/],
  ['HEAD wrong length', response => { response.headers['content-length'] = '1'; }, /HEAD length/],
]) test(`serving preserves failed ${name} measurement and never grants local success`, async () => {
  const isHead = name.startsWith('HEAD');
  const receipt = await verifyNewsletterLoopbackServing(input({ request: spec => {
    const response = frame(spec);
    if (spec.path === manifest[0].publicPath && spec.method === (isHead ? 'HEAD' : 'GET')) mutate(response);
    return response;
  } }));
  assert.equal(receipt.status, 'FAIL'); assert.equal(receipt.failedRequests, 1);
  assert.match(receipt.records.find(record => record.status === 'FAIL').error, message);
  assert.equal(receipt.records.length, 358); assert.equal(receipt.localServingVerified, false);
});

test('content decoding is bounded and qualifier checks decoded identities rather than compressed buffers', async () => {
  const compressed = await verifyNewsletterLoopbackServing(input({ request: spec => {
    const response = frame(spec);
    if (spec.method === 'GET') { response.body = gzipSync(response.body); response.headers['content-encoding'] = 'gzip'; }
    return response;
  } }));
  assert.equal(compressed.status, 'PASS');
  for (const [encoding, body, limit, message] of [
    ['gzip', gzipSync(Buffer.alloc(100000, 1)), 1024, /decode\/decoded body limit/],
    ['unknown', Buffer.from('unknown'), 65536, /unsupported content encoding/],
    ['identity', Buffer.alloc(100000), 1024, /decoded body limit/],
  ]) {
    const receipt = await verifyNewsletterLoopbackServing(input({ maxDecodedBodyBytes: limit, request: spec => {
      const response = frame(spec);
      if (spec.method === 'GET' && spec.path === manifest[0].publicPath) {
        response.body = body; response.headers['content-encoding'] = encoding;
      }
      return response;
    } }));
    assert.equal(receipt.status, 'FAIL'); assert.match(receipt.records[0].error, message);
  }
});

test('wire limits request timeout and total deadline preserve failure evidence', async () => {
  const tooLarge = await verifyNewsletterLoopbackServing(input({ maxWireBodyBytes: 1024, request: spec => {
    const response = frame(spec); if (spec.path === manifest[0].publicPath && spec.method === 'GET') response.body = Buffer.alloc(1025);
    return response;
  } }));
  assert.match(tooLarge.records[0].error, /wire body limit/);
  const timeout = await verifyNewsletterLoopbackServing(input({ concurrency: 1, timeoutMs: 3, totalTimeoutMs: 8,
    request: () => new Promise(() => {}) }));
  assert.equal(timeout.status, 'FAIL'); assert.equal(timeout.failedRequests, 358);
  assert.ok(timeout.records.some(record => /request timeout/.test(record.error)));
  assert.ok(timeout.records.some(record => /total deadline/.test(record.error)));
});

test('receipt validator refuses synthetic booleans and verifies all pinned measurements independently', async () => {
  const synthetic = await verifyNewsletterLoopbackServing(input());
  assert.throws(() => validateNewsletterLoopbackServingReceipt(synthetic,
    { expectedArtifact: artifact, expectedReceiptSha256: newsletterLoopbackReceiptSha256(synthetic) }), /actual successful/);
  // A pure validator model only: no local-serving attestation is produced here.
  const model = structuredClone(synthetic);
  Object.assign(model, { evidenceKind: 'local-loopback-http-serving', synthetic: false,
    localHttpPerformed: true, localServingVerified: true, actualAssetBytesVerified: true });
  const validate = receipt => validateNewsletterLoopbackServingReceipt(receipt,
    { expectedArtifact: artifact, expectedReceiptSha256: newsletterLoopbackReceiptSha256(receipt) });
  assert.throws(() => validate(model), /wire\/decoded identity/);
  // Complete logical measurement model, explicitly not an operator receipt.
  for (const record of model.records) if (record.method === 'GET') record.wireBodyBytes = record.decodedIdentity.bytes;
  assert.equal(validate(model).localServingReceiptConsistent, true);
  assert.equal(validate(model).fullReplacementQualified, false);
  for (const mutate of [
    receipt => receipt.records.pop(), receipt => { receipt.records[0] = receipt.records[1]; },
    receipt => { receipt.records[0].decodedIdentity.sha256 = '0'.repeat(64); },
    receipt => { receipt.records[0].hostHeader = 'another.example'; },
    receipt => { receipt.records[1].decodedIdentity.bytes = 1; },
    receipt => { receipt.records[0].headers['x-content-type-options'] = 'wrong'; },
    receipt => { receipt.expectedArtifact.commit = '0'.repeat(40); },
    receipt => { receipt.publicDnsTlsVerified = true; },
    receipt => { receipt.legacyHeaderParityVerified = true; },
    receipt => { receipt.historicalHeadersEquivalent = true; },
  ]) { const receipt = structuredClone(model); mutate(receipt); assert.throws(() => validate(receipt)); }
  assert.throws(() => validateNewsletterLoopbackServingReceipt(model,
    { expectedArtifact: artifact, expectedReceiptSha256: '0'.repeat(64) }), /receipt pin mismatch/);
});

test('real ephemeral loopback fixture records Host and every canonical method while marked synthetic', async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push([request.method, request.url, request.headers.host, request.headers.authorization,
      request.headers.cookie, request.headers['accept-encoding']]);
    const entry = byPath.get(request.url);
    const body = request.method === 'HEAD' ? undefined : gzipSync(Buffer.from(request.url));
    response.writeHead(200, { 'Content-Type': mime(request.url), 'X-Content-Type-Options': 'nosniff',
      ...(request.method === 'HEAD' ? { 'Content-Length': String(entry.bytes) }
        : { 'Content-Encoding': 'gzip', 'Content-Length': String(body.length) }) });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const receipt = await verifyNewsletterLoopbackServing(input({ origin: `http://127.0.0.1:${server.address().port}`,
      request: requestNewsletterLoopback, fixtureLabel: 'synthetic ephemeral static fixture' }));
    assert.equal(receipt.status, 'PASS'); assert.equal(receipt.localHttpPerformed, true);
    assert.equal(receipt.evidenceKind, 'synthetic-loopback-http'); assert.equal(receipt.localServingVerified, false);
    assert.equal(requests.length, 358);
    assert.ok(requests.every(([method, pathname, host, auth, cookie, encoding]) => METHODS.includes(method)
      && byPath.has(pathname) && host === 'app.capiro.ai' && auth === undefined && cookie === undefined
      && encoding === (method === 'HEAD' ? 'identity' : 'gzip, deflate, br')));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
const METHODS = ['GET', 'HEAD'];

test('actual HEAD accepts canonical static metadata only after chunked headers and terminal EOF', async () => {
  let settled = false, settledBeforeEof, requestText;
  await rawHeadFixture((socket, request, later) => {
    requestText = request;
    socket.write(headHeaders.slice(0, -2));
    later(() => socket.write(headHeaders.slice(-2)), 5);
    later(() => { settledBeforeEof = settled; socket.end(); });
  }, async target => {
    const response = await headRequest(target).then(value => { settled = true; return value; });
    assert.equal(response.status, 200); assert.equal(response.headWireBodyBytes, 0);
    assert.equal(response.body.length, 0); assert.equal(response.port, target.port);
    assert.equal(response.headers['content-length'], String(manifest[0].bytes));
    assert.equal(response.headers['content-type'], mime(manifest[0].publicPath));
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(settledBeforeEof, false);
    assert.equal(requestText, `HEAD ${manifest[0].publicPath} HTTP/1.1\r\nHost: app.capiro.ai\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
  });
});

for (const [name, send] of [
  ['same-write body', socket => socket.end(headHeaders + 'x')],
  ['body after headers', (socket, _request, later) => {
    socket.write(headHeaders); later(() => socket.end('x'));
  }],
  ['body after split headers', (socket, _request, later) => {
    socket.write(headHeaders.slice(0, -2)); later(() => socket.write(headHeaders.slice(-2)), 5);
    later(() => socket.end('x'));
  }],
  ['chunk framing after headers', (socket, _request, later) => {
    socket.write(headHeaders.replace(/Content-Length: [0-9]+/, 'Transfer-Encoding: chunked'));
    later(() => socket.end('1\r\nx\r\n0\r\n\r\n'));
  }],
]) test(`actual HEAD rejects ${name} through terminal EOF`, async () => {
  await rawHeadFixture(send, target => assert.rejects(headRequest(target), /HEAD wire body/));
});

for (const [name, response, error] of [
  ['duplicate content-type', headHeaders.replace('Content-Type:', 'Content-Type: image/png\r\nContent-Type:'), /ambiguous/],
  ['mixed-case duplicate', headHeaders.replace('Content-Type:', 'content-type: image/png\r\nContent-Type:'), /ambiguous/],
  ['duplicate content-length', headHeaders.replace('Connection:', 'Content-Length: 1\r\nConnection:'), /ambiguous/],
  ['duplicate special-name header', headHeaders.replace('Connection:', '__proto__: one\r\n__proto__: two\r\nConnection:'), /ambiguous/],
  ['invalid content-length', headHeaders.replace(/Content-Length: [0-9]+/, 'Content-Length: invalid'), /malformed HEAD framing/],
  ['conflicting framing headers', headHeaders.replace('Connection:', 'Transfer-Encoding: chunked\r\nConnection:'), /malformed HEAD framing/],
  ['invalid header name', headHeaders.replace('Content-Type:', 'Content Type:'), /malformed HEAD header/],
  ['folded header', headHeaders.replace('Connection:', ' continuation\r\nConnection:'), /malformed HEAD header/],
  ['control character', headHeaders.replace('nosniff', 'no\u0000sniff'), /malformed HEAD header/],
  ['bare newline', headHeaders.replace('nosniff', 'no\nsniff'), /malformed HEAD header/],
  ['invalid status', headHeaders.replace('HTTP/1.1 200 OK', 'HTTP/1.1 two hundred'), /malformed HEAD status/],
  ['oversized header', headHeaders.replace('Connection:', `X-Large: ${'x'.repeat(16384)}\r\nConnection:`), /HEAD header limit/],
]) test(`actual HEAD rejects ${name} on the raw wire`, async () => {
  await rawHeadFixture(socket => socket.end(response), target => assert.rejects(headRequest(target), error));
});

for (const [name, response] of [['empty response', ''], ['truncated status', 'HTTP/1.1 200'],
  ['truncated headers', headHeaders.slice(0, -2)]]) test(`actual HEAD rejects EOF with ${name}`, async () => {
  await rawHeadFixture(socket => socket.end(response),
    target => assert.rejects(headRequest(target), /closed before complete EOF/));
});

test('actual HEAD rejects connection reset without terminal EOF', async () => {
  await rawHeadFixture((socket, _request, later) => {
    socket.write(headHeaders); later(() => socket.resetAndDestroy());
  }, target => assert.rejects(headRequest(target), /ECONNRESET|closed before complete EOF/));
});

test('actual HEAD times out complete headers whose peer never sends EOF and closes its socket', async () => {
  let closed;
  await rawHeadFixture(socket => {
    closed = new Promise(resolve => socket.once('close', resolve));
    socket.on('end', () => socket.end()); socket.write(headHeaders);
  }, async target => {
    await assert.rejects(headRequest(target, { timeoutMs: 40 }), /request timeout/);
    await closed;
  });
});

test('actual HEAD aborts after complete headers while waiting for EOF and closes its socket', async () => {
  const controller = new AbortController(); let closed;
  await rawHeadFixture((socket, _request, later) => {
    closed = new Promise(resolve => socket.once('close', resolve));
    socket.on('end', () => socket.end()); socket.write(headHeaders);
    later(() => controller.abort());
  }, async target => {
    await assert.rejects(headRequest(target, { signal: controller.signal }), /request aborted/);
    await closed;
  });
});

test('actual HEAD refuses an already aborted signal without sending its request', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await rawHeadFixture(() => { calls++; },
    target => assert.rejects(headRequest(target, { signal: controller.signal }), /request aborted/));
  assert.equal(calls, 0);
});

test('actual transport rejects invalid target path Host limits and abort signal before connecting', async () => {
  let calls = 0;
  await rawHeadFixture(() => { calls++; }, target => {
    for (const extra of [{ path: '/unknown' }, { method: 'POST' }, { hostHeader: 'other.example' },
      { hostname: 'localhost' }, { port: target.port + 1 }, { timeoutMs: 0 },
      { maxWireBodyBytes: 1048577 }, { signal: {} }]) assert.throws(() => headRequest(target, extra));
  });
  assert.equal(calls, 0);
});

test('verifier preserves the actual delayed HEAD wire failure among all canonical measurements', async () => {
  await rawHeadFixture((socket, request, later) => {
    const [method, pathname] = request.split(' '), entry = byPath.get(pathname);
    const body = method === 'HEAD' ? '' : pathname;
    const headers = `HTTP/1.1 200 OK\r\nContent-Type: ${mime(pathname)}\r\nX-Content-Type-Options: nosniff\r\nContent-Length: ${method === 'HEAD' ? entry.bytes : Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`;
    if (method === 'HEAD' && pathname === manifest[0].publicPath) {
      socket.write(headers); later(() => socket.end('x'));
    } else socket.end(headers + body);
  }, async target => {
    const receipt = await verifyNewsletterLoopbackServing(input({ origin: target.input,
      request: requestNewsletterLoopback, fixtureLabel: 'synthetic delayed HEAD wire fixture' }));
    assert.equal(receipt.status, 'FAIL'); assert.equal(receipt.failedRequests, 1);
    assert.equal(receipt.records.length, 358); assert.equal(receipt.localServingVerified, false);
    assert.equal(receipt.localHttpPerformed, true); assert.equal(receipt.synthetic, true);
    assert.equal(receipt.records[1].status, 'FAIL'); assert.match(receipt.records[1].error, /HEAD wire body/);
  });
});

test('operator accepts only explicit origin/pin JSON and preserves failed receipt exit status', async () => {
  const args = ['--loopback-origin', 'http://127.0.0.1:43210', '--expected-artifact', JSON.stringify(artifact),
    '--artifact-pins', JSON.stringify(artifact)];
  assert.deepEqual(parseNewsletterLoopbackInvocation(args), { origin: 'http://127.0.0.1:43210',
    expectedArtifact: artifact, artifactPins: artifact });
  for (const values of [[], args.slice(0, -2), [...args, '--headers', '{}'],
    ['--loopback-origin', 'one', '--loopback-origin', 'two', '--artifact-pins', '{}']])
    assert.throws(() => parseNewsletterLoopbackInvocation(values));
  const output = [];
  assert.equal(await runNewsletterLoopbackOperator(args, { verify: async () => ({ status: 'FAIL', localServingVerified: false }),
    output: text => output.push(JSON.parse(text)) }), 1);
  assert.deepEqual(output, [{ status: 'FAIL', localServingVerified: false }]);
});


test('raw GET refuses duplicate special-name data headers before accepting a response frame', async () => {
  await rawHeadFixture(socket => socket.end('HTTP/1.1 200 OK\r\n__proto__: one\r\n__Proto__: two\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'),
    target => assert.rejects(requestNewsletterLoopback({ ...target, path: manifest[0].publicPath,
      method: 'GET', timeoutMs: 500, maxWireBodyBytes: 1024 }), /ambiguous response header/));
});

test('raw GET retains a single special-name header as own data', async () => {
  await rawHeadFixture(socket => socket.end('HTTP/1.1 200 OK\r\n__proto__: one\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'), async target => {
    const response = await requestNewsletterLoopback({ ...target, path: manifest[0].publicPath,
      method: 'GET', timeoutMs: 500, maxWireBodyBytes: 1024 });
    assert.equal(Object.hasOwn(response.headers, '__proto__'), true);
    assert.equal(response.headers.__proto__, 'one');
    assert.equal(response.status, 200);
  });
});

test('normalized own mixed-case special-name duplicates preserve failed measurement and never grant serving', async () => {
  const receipt = await verifyNewsletterLoopbackServing(input({ request: spec => {
    const response = frame(spec);
    if (spec.path === manifest[0].publicPath && spec.method === 'GET') {
      response.headers = Object.fromEntries([...Object.entries(response.headers),
        ['__proto__', 'one'], ['__Proto__', 'two']]);
      assert.equal(Object.hasOwn(response.headers, '__proto__'), true);
      assert.equal(Object.hasOwn(response.headers, '__Proto__'), true);
    }
    return response;
  } }));
  assert.equal(receipt.status, 'FAIL');
  assert.equal(receipt.failedRequests, 1);
  assert.equal(receipt.records.length, 358);
  assert.match(receipt.records.find(record => record.status === 'FAIL').error, /ambiguous response header/);
  assert.equal(receipt.localServingVerified, false);
});
