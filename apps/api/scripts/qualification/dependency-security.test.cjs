const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const zlib = require('node:zlib');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const path = require('node:path');

const api = createRequire(path.resolve(__dirname, '../../package.json'));
const nest = createRequire(api.resolve('@nestjs/platform-express/package.json'));
const express5 = createRequire(createRequire(api.resolve('@modelcontextprotocol/sdk/server/mcp.js')).resolve('express/package.json'));
const cheerio = createRequire(api.resolve('cheerio/package.json'));

async function server(t, handler) {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); });
  return `http://127.0.0.1:${instance.address().port}`;
}
function request(url, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { ...headers, 'content-length': body.length } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('actual production parents resolve the fixed dependency releases', () => {
  assert.equal(nest('body-parser/package.json').version, '1.20.9');
  assert.equal(express5('body-parser/package.json').version, '2.4.0');
  assert.equal(nest('multer/package.json').version, '2.5.0');
  assert.equal(api('undici/package.json').version, '6.29.1');
  assert.equal(cheerio('undici/package.json').version, '7.30.1');
  assert.equal(api('zod/package.json').version, '4.6.7');
});

test('bounded Zod arrays refuse over-limit input before visiting attacker-controlled entries', () => {
  const { z } = api('zod'); let visited = 0;
  const schema = z.array(z.custom(value => { visited++; return typeof value === 'string'; })).max(2);
  assert.equal(schema.safeParse(['a', 'b', 'c']).success, false);
  assert.equal(visited, 0);
  assert.deepEqual(schema.parse(['a', 'b']), ['a', 'b']);
  assert.equal(visited, 2);
  assert.equal(schema.safeParse([42]).success, false);
});

for (const [label, owner] of [['Nest/Express4', nest], ['MCP/Express5', express5]]) {
  test(`${label} rejects compressed overflow/trailing corruption and serves the next request`, { timeout: 5000 }, async t => {
    const parse = owner('body-parser').json({ limit: 32 });
    const url = await server(t, (req, res) => parse(req, res, error => {
      res.statusCode = error ? error.statusCode || error.status || 400 : 200;
      res.end(error ? 'refused' : JSON.stringify(req.body));
    }));
    const headers = { 'content-type': 'application/json', 'content-encoding': 'gzip' };
    const bad = Buffer.concat([zlib.gzipSync(JSON.stringify({ text: 'x'.repeat(100) })), Buffer.from('invalid trailing data')]);
    assert([400, 413].includes((await request(url, bad, headers)).status));
    assert.deepEqual(await request(url, zlib.gzipSync('{"ok":true}'), headers), { status: 200, body: '{"ok":true}' });
  });
}

for (const [label, owner] of [['API Undici6', api], ['Cheerio Undici7', cheerio]]) {
  test(`${label} bounds response decoding and remains usable after refusal`, { timeout: 5000 }, async t => {
    const url = await server(t, (req, res) => {
      if (req.url === '/bad') res.setHeader('content-encoding', Array(6).fill('gzip').join(', '));
      res.end('ok');
    });
    const { fetch, Agent } = owner('undici'); const dispatcher = new Agent(); t.after(() => dispatcher.close());
    await assert.rejects(async () => { const reply = await fetch(url + '/bad', { dispatcher }); await reply.text(); });
    assert.equal(await (await fetch(url + '/good', { dispatcher })).text(), 'ok');
  });
}

test('Multer does not start storage after an aborted request releases its async file filter', { timeout: 5000 }, async t => {
  let startFilter, releaseFilter, aborted, writes = 0, acceptImmediately = false;
  const entered = new Promise(resolve => { startFilter = resolve; });
  const stopped = new Promise(resolve => { aborted = resolve; });
  const upload = nest('multer')({
    storage: { _handleFile(req, file, done) { writes++; file.stream.resume(); file.stream.on('end', () => done(null, { size: 1 })); }, _removeFile(req, file, done) { done(null); } },
    fileFilter(req, file, done) { if (acceptImmediately) return done(null, true); releaseFilter = done; startFilter(); },
  }).single('file');
  const url = await server(t, (req, res) => { req.once('aborted', aborted); upload(req, res, () => res.end('done')); });
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=bounded', 'content-length': 1000 } });
  req.on('error', () => {});
  req.write('--bounded\r\nContent-Disposition: form-data; name="file"; filename="small.txt"\r\nContent-Type: text/plain\r\n\r\nx');
  await entered; req.destroy(); await stopped;
  await new Promise(resolve => setImmediate(resolve)); releaseFilter(null, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 0);
  acceptImmediately = true;
  const body = Buffer.from('--bounded\r\nContent-Disposition: form-data; name="file"; filename="small.txt"\r\nContent-Type: text/plain\r\n\r\nx\r\n--bounded--\r\n');
  assert.equal((await request(url, body, { 'content-type': 'multipart/form-data; boundary=bounded' })).status, 200);
  assert.equal(writes, 1);
});
