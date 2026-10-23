#!/usr/bin/env node
'use strict';

// Run from a service directory in the exact frozen source or runtime closure.
// Only synthetic data and loopback sockets; no database or provider access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const Module = require('node:module');
const { test } = require('node:test');
const local = Module.createRequire(path.join(process.cwd(), 'package.json'));
const service = process.argv[2];
assert(['intel-api', 'api-strategy', 'workspace', 'engagement-api'].includes(service));
const from = (name) => Module.createRequire(local.resolve(name));
const version = (req, name, expected) => assert.equal(req(`${name}/package.json`).version, expected);

test('exact parent-scoped dependency closure', () => {
  version(from('express'), 'proxy-addr', '2.0.8');
  version(from('@nestjs/platform-express'), 'multer', '2.3.0');
  version(from('@nestjs/config'), 'lodash', '4.18.1');
  const clerk = from('@clerk/backend');
  const shared = Module.createRequire(clerk.resolve('@clerk/shared'));
  version(shared, 'js-cookie', '3.0.7');
  assert.equal(typeof local('@clerk/backend').createClerkClient, 'function');
  if (service === 'intel-api') version(from('@nestjs/platform-ws'), 'ws', '8.21.0');
  if (service === 'api-strategy' || service === 'engagement-api') {
    version(local, 'pptxgenjs', '3.12.0');
    assert.throws(() => from('pptxgenjs').resolve('image-size'), { code: 'MODULE_NOT_FOUND' });
  }
});

test('Express proxy address selection preserves trusted and untrusted hops', () => {
  const express = local('express');
  const app = express();
  app.set('trust proxy', ['loopback']);
  const request = Object.create(app.request);
  request.app = app;
  request.socket = { remoteAddress: '127.0.0.1' };
  request.headers = { 'x-forwarded-for': '192.0.2.10, 198.51.100.7' };
  assert.equal(request.ip, '198.51.100.7');
  assert.deepEqual(request.ips, ['198.51.100.7']);
  // A client-supplied earlier hop cannot bypass the first untrusted proxy.
  request.headers['x-forwarded-for'] = '127.0.0.1, 198.51.100.7';
  assert.equal(request.ip, '198.51.100.7');
  request.socket.remoteAddress = '203.0.113.9';
  assert.equal(request.ip, '203.0.113.9');
  assert.deepEqual(request.ips, []);
  const proxyAddr = from('express')('proxy-addr');
  assert.throws(() => proxyAddr.compile('not-an-ip-range'), /invalid IP address/);
});

test('Nest config dotted lookup, merge and prototype protection', async () => {
  const configRequire = from('@nestjs/config');
  const lodash = configRequire('lodash');
  const merged = lodash.merge({}, { nested: { first: 'kept' } }, { nested: { second: 'added' } });
  const { ConfigService, ConfigModule } = local('@nestjs/config');
  const config = new ConfigService(merged);
  assert.equal(config.get('nested.first'), 'kept');
  assert.equal(config.get('nested.second'), 'added');
  assert.equal(config.get('absent', 'fallback'), 'fallback');
  assert.throws(() => config.getOrThrow('absent'), /does not exist/);
  assert.equal((await ConfigModule.forRoot({ ignoreEnvFile: true, ignoreEnvVars: true,
    load: [() => ({ nested: { fixture: true } })] })).module, ConfigModule);
  const target = {};
  lodash.set(target, '__proto__.capiroSyntheticPolluted', true);
  lodash.merge(target, JSON.parse('{"__proto__":{"capiroSyntheticPolluted":true}}'));
  assert.equal({}.capiroSyntheticPolluted, undefined);
});

test('Clerk cookie dependency round trips delimiters without adding a cookie', () => {
  const clerk = from('@clerk/backend');
  const cookies = Module.createRequire(clerk.resolve('@clerk/shared'))('js-cookie');
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const document = { cookie: '' };
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true });
  try {
    cookies.set('synthetic', 'one; forged=two', { path: '/', sameSite: 'strict' });
    assert.equal(cookies.get('synthetic'), 'one; forged=two');
    assert.equal(cookies.get('forged'), undefined);
    assert.match(document.cookie, /sameSite=strict/i);
  } finally {
    if (prior) Object.defineProperty(globalThis, 'document', prior);
    else delete globalThis.document;
  }
});

test('actual Nest upload interceptor: bytes, limit, malformed body and abort', { timeout: 12_000 }, async () => {
  const { FileInterceptor } = local('@nestjs/platform-express');
  const Interceptor = FileInterceptor('file', { limits: { fileSize: 8, files: 1 } });
  const interceptor = new Interceptor();
  let onStarted;
  let onFinished;
  const server = http.createServer(async (req, res) => {
    const started = onStarted;
    const finished = onFinished;
    if (started) started();
    try {
      await interceptor.intercept({ switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) },
        { handle: () => null });
      if (finished) finished(null);
      res.end(JSON.stringify({ bytes: req.file.buffer.toString(), name: req.file.originalname }));
    } catch (error) {
      if (finished) finished(error);
      res.statusCode = error.getStatus?.() || 400;
      res.end('rejected');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const request = (body, closeBoundary = true) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=synthetic-boundary' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.end('--synthetic-boundary\r\nContent-Disposition: form-data; name="file"; filename="synthetic.txt"\r\n' +
      'Content-Type: text/plain\r\n\r\n' + body + (closeBoundary ? '\r\n--synthetic-boundary--\r\n' : ''));
  });
  try {
    const normal = await request('fixture');
    assert.equal(normal.status, 200);
    assert.deepEqual(JSON.parse(normal.data), { bytes: 'fixture', name: 'synthetic.txt' });
    assert.equal((await request('too-many-bytes')).status, 413);
    assert.equal((await request('broken', false)).status, 400);
    const started = new Promise((resolve) => { onStarted = resolve; });
    const finished = new Promise((resolve) => { onFinished = resolve; });
    const aborted = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=synthetic-boundary' } });
    aborted.on('error', () => {});
    aborted.write('--synthetic-boundary\r\nContent-Disposition: form-data; name="file"; filename="synthetic.txt"\r\n\r\nx');
    await started;
    aborted.destroy();
    const error = await Promise.race([finished, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('aborted upload did not terminate')), 3_000);
      timer.unref();
    })]);
    assert(error, 'aborted upload must reject');
    assert.equal((await request('after')).status, 200, 'server survives rejected uploads');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

if (service === 'intel-api') test('Nest WebSocket dependency performs real handshake, message and close', { timeout: 8_000 }, async () => {
  const WebSocket = from('@nestjs/platform-ws')('ws');
  const server = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', (socket) => socket.on('message', (bytes) => socket.send(bytes)));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  try {
    await once(client, 'open');
    const received = once(client, 'message');
    client.send('synthetic-echo');
    assert.equal((await received)[0].toString(), 'synthetic-echo');
    const closed = once(client, 'close');
    client.close(1000, 'complete');
    assert.equal((await closed)[0], 1000);
  } finally {
    client.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

if (service === 'api-strategy' || service === 'engagement-api') test('PPTX PNG, SVG and file images retain bytes, geometry and relationships without image-size', async () => {
  const pptxRequire = from('pptxgenjs');
  const originalLoad = Module._load;
  let attempts = 0;
  Module._load = function (name, ...args) {
    if (name === 'image-size') {
      attempts += 1;
      throw new Error('UNUSED_IMAGE_SIZE_IMPORTED');
    }
    return originalLoad.call(this, name, ...args);
  };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-pptx-'));
  try {
    // Negative control proves the import trap is active before rendering.
    assert.throws(() => pptxRequire('image-size'), /UNUSED_IMAGE_SIZE_IMPORTED/);
    attempts = 0;
    const PptxGenJS = local('pptxgenjs');
    const JSZip = pptxRequire('jszip');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>';
    const pngPath = path.join(scratch, 'synthetic.png');
    fs.writeFileSync(pngPath, png);
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    const slide = pptx.addSlide();
    slide.addText('Synthetic compatibility fixture', { x: 0.5, y: 0.2, w: 5, h: 0.4 });
    slide.addImage({ data: `image/png;base64,${png.toString('base64')}`, x: 1, y: 1, w: 2, h: 1 });
    slide.addImage({ path: pngPath, x: 4, y: 1, w: 2, h: 1 });
    slide.addImage({ data: `image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, x: 7, y: 1, w: 2, h: 1 });
    const zip = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }));
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.match(xml, /Synthetic compatibility fixture/);
    assert.equal((xml.match(/<p:pic>/g) || []).length, 3);
    assert.equal((xml.match(/<a:ext cx="1828800" cy="914400"\/>/g) || []).length, 3);
    const relations = await zip.file('ppt/slides/_rels/slide1.xml.rels').async('string');
    for (const target of [...relations.matchAll(/Target="\.\.\/(media\/[^"<>]+)"/g)].map((match) => `ppt/${match[1]}`)) {
      assert(zip.file(target), `missing image relationship ${target}`);
    }
    const media = await Promise.all(Object.values(zip.files).filter((entry) => !entry.dir && entry.name.startsWith('ppt/media/'))
      .map((entry) => entry.async('nodebuffer')));
    assert(media.some((bytes) => bytes.equals(png)), 'original PNG bytes retained');
    assert(media.some((bytes) => bytes.toString() === svg), 'original SVG bytes retained');
    assert.equal(attempts, 0, 'PptxGenJS must not request the removed dependency');
  } finally {
    Module._load = originalLoad;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
