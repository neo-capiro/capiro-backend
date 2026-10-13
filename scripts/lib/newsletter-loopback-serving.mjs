/** Explicit loopback HTTP qualification; imports never read files/env or connect. */
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import {
  NEWSLETTER_PINS, canonicalNewsletterManifest, validateNewsletterManifest,
  newsletterByteIdentity, qualifyNewsletterResponse,
} from './newsletter-static-release-contract.mjs';

const HOST = 'app.capiro.ai';
const METHODS = ['GET', 'HEAD'];
const CANONICAL_PATHS = new Set(canonicalNewsletterManifest().map(entry => entry.publicPath));
export const HISTORICAL_NEWSLETTER_STATIC_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN',
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
});
const OBSERVED_HEADERS = ['content-type', 'x-content-type-options', 'cache-control',
  'content-length', 'content-encoding', 'etag', 'last-modified', 'referrer-policy',
  'x-frame-options', 'strict-transport-security', 'permissions-policy', 'content-security-policy'];
const fail = message => { throw new Error('Newsletter loopback: ' + message); };
const sha256 = text => createHash('sha256').update(text).digest('hex');
const integer = (value, low, high, label) => {
  if (!Number.isInteger(value) || value < low || value > high) fail(label);
  return value;
};
function pins(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'commit,repository,sha256'
      || ['repository', 'commit', 'sha256'].some(key => typeof value[key] !== 'string' || value[key] !== value[key].trim())
      || typeof value.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)
      || typeof value.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.commit)
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) fail('explicit exact artifact pins required');
  return { repository: value.repository, commit: value.commit, sha256: value.sha256 };
}
function bindPins(expected, actual) {
  const expectedPins = pins(expected), actualPins = pins(actual);
  if (JSON.stringify(expectedPins) !== JSON.stringify(actualPins)) fail('source/artifact pin mismatch');
  return { expectedArtifact: expectedPins, artifactPins: actualPins };
}
export function parseNewsletterLoopbackOrigin(value) {
  if (typeof value !== 'string') fail('literal http://127.0.0.1:<port> required');
  if (value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value)) fail('literal http://127.0.0.1:<port> required');
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(value);
  if (!match) fail('literal http://127.0.0.1:<port> required');
  const port = integer(Number(match[1]), 1, 65535, 'loopback port');
  return { input: value, origin: new URL(value).origin, hostname: '127.0.0.1', port };
}
function normalizeHeaders(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('response headers');
  const headers = {};
  for (const [name, value] of Object.entries(input)) {
    const lower = name.toLowerCase();
    if (Object.hasOwn(headers, lower) || typeof value !== 'string') fail('ambiguous response header');
    headers[lower] = value;
  }
  if (['set-cookie', 'www-authenticate', 'proxy-authenticate', 'authentication-info'].some(name => Object.hasOwn(headers, name)))
    fail('auth/cookie fallback');
  return headers;
}
function observed(headers) {
  return Object.fromEntries(OBSERVED_HEADERS.filter(name => Object.hasOwn(headers, name))
    .map(name => [name, headers[name]]));
}
function responseIdentity(spec, frame) {
  if (!frame || frame.hostname !== spec.hostname || frame.port !== spec.port
      || frame.hostHeader !== HOST || frame.path !== spec.path || frame.method !== spec.method
      || frame.url !== new URL(spec.path, spec.origin).href) fail('request host/path/address mismatch');
}
function decodedBody(body, encoding, method, limit) {
  if (!Buffer.isBuffer(body)) fail('raw response Buffer required');
  if (method === 'HEAD') return body;
  if (!encoding || encoding === 'identity') {
    if (body.length > limit) fail('decoded body limit');
    return body;
  }
  const decoders = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync };
  if (!Object.hasOwn(decoders, encoding)) fail('unsupported content encoding');
  try { return decoders[encoding](body, { maxOutputLength: limit }); }
  catch { fail('content decode/decoded body limit'); }
}

function headHeaders(buffer) {
  const [statusLine, ...lines] = buffer.toString('latin1').split('\r\n');
  const status = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: [\x20-\x7e]*)?$/.exec(statusLine);
  if (!status) fail('malformed HEAD status');
  const headers = Object.create(null);
  for (const line of lines) {
    const match = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+):[ \t]*([^\x00-\x08\x0a-\x1f\x7f]*)$/.exec(line);
    if (!match) fail('malformed HEAD header');
    const name = match[1].toLowerCase();
    if (Object.hasOwn(headers, name)) fail('ambiguous response header');
    headers[name] = match[2].replace(/[ \t]+$/, '');
  }
  if (Object.hasOwn(headers, 'content-length') && (!/^[0-9]+$/.test(headers['content-length'])
      || Object.hasOwn(headers, 'transfer-encoding'))) fail('malformed HEAD framing headers');
  return { status: Number(status[1]), headers };
}
function responseFrame(spec, socket, status, headers, body) {
  return { hostname: socket.remoteAddress, port: socket.remotePort,
    hostHeader: HOST, path: spec.path, method: spec.method,
    url: new URL(spec.path, spec.origin).href, status, headers, body, headWireBodyBytes: 0 };
}
function requestHeadLoopback(spec) {
  return new Promise((resolve, reject) => {
    let settled = false, eof = false, prefix = Buffer.alloc(0), parsed, peer;
    const socket = net.createConnection({ host: '127.0.0.1', port: spec.port, family: 4,
      allowHalfOpen: true });
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      spec.signal?.removeEventListener('abort', abort);
      if (error) { socket.destroy(); reject(error); }
      else resolve(responseFrame(spec, peer, parsed.status, parsed.headers, Buffer.alloc(0)));
    };
    const abort = () => finish(new Error('request aborted'));
    const timer = setTimeout(() => finish(new Error('request timeout')), spec.timeoutMs);
    socket.on('error', finish);
    socket.on('connect', () => {
      if (settled) return;
      if (socket.remoteAddress !== '127.0.0.1' || socket.remotePort !== spec.port)
        return finish(new Error('non-loopback peer refused'));
      peer = { remoteAddress: socket.remoteAddress, remotePort: socket.remotePort };
      socket.write(`HEAD ${spec.path} HTTP/1.1\r\nHost: ${HOST}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', chunk => {
      if (settled) return;
      if (parsed) return finish(new Error('HEAD wire body must be empty'));
      const received = prefix.length + chunk.length;
      prefix = Buffer.concat([prefix, chunk.subarray(0, Math.max(0, 16384 - prefix.length))]);
      const boundary = prefix.indexOf('\r\n\r\n');
      if (boundary < 0) {
        if (received >= 16384) finish(new Error('HEAD header limit'));
        return;
      }
      if (received !== boundary + 4) return finish(new Error('HEAD wire body must be empty'));
      try { parsed = headHeaders(prefix.subarray(0, boundary)); prefix = Buffer.alloc(0); }
      catch (error) { finish(error); }
    });
    // HTTP parsers finish HEAD at headers; only peer EOF proves the wire body empty.
    socket.on('end', () => { eof = true; socket.end(); });
    socket.on('close', () => finish(!eof || !parsed ? new Error('HEAD response closed before complete EOF') : null));
    spec.signal?.addEventListener('abort', abort, { once: true });
    if (spec.signal?.aborted) abort();
  });
}
function requestGetLoopback(spec) {
  return new Promise((resolve, reject) => {
    let settled = false, timer, request;
    const finish = (error, frame) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { request?.destroy(); reject(error); } else resolve(frame);
    };
    request = http.request({ hostname: '127.0.0.1', port: spec.port, path: spec.path,
      method: spec.method, agent: false, maxHeaderSize: 16384,
      signal: spec.signal,
      headers: { Host: HOST, 'Accept-Encoding': 'gzip, deflate, br' },
      lookup() { finish(new Error('DNS resolution refused')); },
    });
    timer = setTimeout(() => finish(new Error('request timeout')), spec.timeoutMs);
    request.on('error', error => finish(error));
    request.on('response', response => {
      response.on('aborted', () => finish(new Error('response aborted')));
      response.on('error', error => finish(error));
      const headers = {};
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        const name = response.rawHeaders[index].toLowerCase();
        if (Object.hasOwn(headers, name)) return finish(new Error('ambiguous response header'));
        headers[name] = response.rawHeaders[index + 1];
      }
      const socket = request.socket;
      if (socket?.remoteAddress !== '127.0.0.1' || socket.remotePort !== spec.port)
        return finish(new Error('non-loopback peer refused'));
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > spec.maxWireBodyBytes) return finish(new Error('wire body limit'));
        chunks.push(chunk);
      });
      response.on('end', () => finish(null,
        responseFrame(spec, socket, response.statusCode, headers, Buffer.concat(chunks))));
    });
    request.end();
  });
}
/** Direct literal IPv4 connection: no fetch, proxy environment, DNS or redirects. */
export function requestNewsletterLoopback(spec) {
  const target = parseNewsletterLoopbackOrigin(spec?.input ?? spec?.origin);
  if (spec.hostname !== target.hostname || spec.port !== target.port || spec.origin !== target.origin
      || !CANONICAL_PATHS.has(spec.path) || !METHODS.includes(spec.method)
      || (spec.hostHeader !== undefined && spec.hostHeader !== HOST)) fail('transport target/path/Host');
  integer(spec.timeoutMs, 1, 10000, 'transport timeout limit');
  integer(spec.maxWireBodyBytes, 1, 1048576, 'transport wire limit');
  if (spec.signal != null && !(spec.signal instanceof AbortSignal)) fail('transport abort signal');
  return spec.method === 'HEAD' ? requestHeadLoopback(spec) : requestGetLoopback(spec);
}

async function boundedRequest(request, spec) {
  let timer;
  const controller = new AbortController();
  const requestSpec = Object.freeze({ ...spec, signal: controller.signal });
  try {
    return await Promise.race([Promise.resolve().then(() => request(requestSpec)),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new Error('request timeout'));
      }, spec.timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(name => [name, canonical(value[name])]));
  return value;
};
export function newsletterLoopbackReceiptSha256(receipt) {
  return sha256(JSON.stringify(canonical(receipt)));
}
function historicalHeaders(records) {
  const headers = Object.fromEntries(Object.entries(HISTORICAL_NEWSLETTER_STATIC_HEADERS)
    .map(([name, expected]) => [name, { expected,
      observedValues: [...new Set(records.map(record => record.headers?.[name] ?? null))],
      equivalent: records.every(record => record.headers?.[name] === expected),
    }]));
  return { headers, equivalent: Object.values(headers).every(header => header.equivalent) };
}

export async function verifyNewsletterLoopbackServing(options = {}) {
  const allowed = ['origin', 'manifest', 'expectedArtifact', 'artifactPins', 'concurrency',
    'timeoutMs', 'totalTimeoutMs', 'maxWireBodyBytes', 'maxDecodedBodyBytes', 'request', 'identity', 'fixtureLabel'];
  if (Object.keys(options).some(name => !allowed.includes(name))) fail('unknown verifier option');
  const { origin, manifest = canonicalNewsletterManifest(), expectedArtifact, artifactPins,
    concurrency = 4, timeoutMs = 3000, totalTimeoutMs = 60000,
    maxWireBodyBytes = 1048576, maxDecodedBodyBytes = 65536,
    request = requestNewsletterLoopback, identity = newsletterByteIdentity, fixtureLabel } = options;
  const target = parseNewsletterLoopbackOrigin(origin);
  const binding = bindPins(expectedArtifact, artifactPins);
  validateNewsletterManifest(manifest);
  integer(concurrency, 1, 8, 'concurrency limit'); integer(timeoutMs, 1, 10000, 'request timeout limit');
  integer(totalTimeoutMs, 1, 120000, 'total timeout limit');
  integer(maxWireBodyBytes, 1, 1048576, 'wire body limit'); integer(maxDecodedBodyBytes, 1, 1048576, 'decoded body limit');
  if (typeof request !== 'function' || typeof identity !== 'function') fail('request/identity ports');
  if (fixtureLabel !== undefined && (typeof fixtureLabel !== 'string' || !/^[A-Za-z0-9 ._-]{1,80}$/.test(fixtureLabel))) fail('fixture label');
  const realHttp = request === requestNewsletterLoopback;
  const actualIdentity = identity === newsletterByteIdentity;
  const synthetic = !realHttp || !actualIdentity || fixtureLabel !== undefined;
  const started = performance.now(), deadline = started + totalTimeoutMs;
  const jobs = canonicalNewsletterManifest().flatMap(entry => METHODS.map(method => ({ entry, method })));
  const records = Array(jobs.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const index = cursor++, { entry, method } = jobs[index];
      const remaining = deadline - performance.now();
      const spec = Object.freeze({ ...target, path: entry.publicPath, method, hostHeader: HOST,
        timeoutMs: Math.max(1, Math.min(timeoutMs, Math.ceil(remaining))), maxWireBodyBytes });
      const record = { method, publicPath: entry.publicPath, url: new URL(entry.publicPath, target.origin).href,
        hostname: target.hostname, port: target.port, hostHeader: HOST, status: 'FAIL' };
      try {
        if (remaining <= 0) fail('total deadline before request');
        const frame = await boundedRequest(request, spec);
        responseIdentity(spec, frame);
        const headers = normalizeHeaders(frame.headers);
        record.httpStatus = frame.status; record.headers = observed(headers);
        record.wireBodyBytes = Buffer.isBuffer(frame.body) ? frame.body.length : null;
        if (frame.status !== 200 || Object.hasOwn(headers, 'location')) fail('status/redirect fallback: ' + frame.status);
        if (!Buffer.isBuffer(frame.body) || frame.body.length > maxWireBodyBytes) fail('wire body limit');
        if (method === 'HEAD' && frame.headWireBodyBytes !== 0) fail('HEAD wire body must be empty');
        const body = decodedBody(frame.body, headers['content-encoding'], method, Math.min(entry.bytes, maxDecodedBodyBytes));
        const bodyIdentity = method === 'HEAD' ? newsletterByteIdentity(body) : await identity(body, entry.publicPath);
        record.decodedIdentity = {
          bytes: bodyIdentity.bytes, sha256: bodyIdentity.sha256, gitBlob: bodyIdentity.gitBlob,
        };
        qualifyNewsletterResponse({ kind: 'static', url: record.url, expectedOrigin: target.origin,
          method, status: frame.status, headers, body, identity });
        record.status = 'PASS';
      } catch (error) {
        record.error = String(error?.message ?? 'request failed').slice(0, 300);
      }
      records[index] = record;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const failures = records.filter(record => record.status !== 'PASS');
  const headerComparison = historicalHeaders(records);
  return {
    schemaVersion: 1, status: failures.length ? 'FAIL' : 'PASS',
    evidenceKind: synthetic ? (realHttp ? 'synthetic-loopback-http' : 'synthetic-inert-ports') : 'local-loopback-http-serving',
    synthetic, fixtureLabel: fixtureLabel ?? null, loopbackInput: target.input, loopbackOrigin: target.origin,
    hostHeader: HOST, ...binding, sourcePins: { ...NEWSLETTER_PINS },
    artifactBindingAuthority: 'caller-pinned artifact metadata; server-process source identity not independently attested',
    plannedRequests: 358, passedRequests: records.length - failures.length, failedRequests: failures.length,
    localHttpPerformed: realHttp, localServingVerified: !synthetic && failures.length === 0,
    actualAssetBytesVerified: actualIdentity && failures.length === 0,
    publicOriginVerified: false, publicDnsTlsVerified: false, deployedServingVerified: false,
    dynamicUploadsCapabilitiesUiVerified: false, conditionalArchiveOriginVerified: false,
    legacyHeaderParityVerified: false,
    historicalHeadersEquivalent: headerComparison.equivalent, historicalHeaderComparison: headerComparison.headers,
    elapsedMs: Math.ceil(performance.now() - started), limits: { concurrency, timeoutMs, totalTimeoutMs, maxWireBodyBytes, maxDecodedBodyBytes },
    holds: ['Public DNS/TLS/deployed continuity unqualified', 'Conditional API_PUBLIC_URL archive-origin coverage unqualified',
      'Dynamic uploads, public capabilities and UI acceptance unqualified',
      ...(!headerComparison.equivalent ? ['Measured five-header historical equality not established'] : [])], records,
  };
}

/** Caller-pinned measurement consistency, not authenticity or deployment proof. */
export function validateNewsletterLoopbackServingReceipt(receipt, { expectedArtifact, expectedReceiptSha256 } = {}) {
  if (typeof expectedReceiptSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedReceiptSha256)
      || newsletterLoopbackReceiptSha256(receipt) !== expectedReceiptSha256) fail('serving receipt pin mismatch');
  const expected = pins(expectedArtifact);
  bindPins(expected, receipt?.expectedArtifact); bindPins(expected, receipt?.artifactPins);
  const target = parseNewsletterLoopbackOrigin(receipt.loopbackInput);
  if (receipt.schemaVersion !== 1 || receipt.status !== 'PASS' || receipt.synthetic !== false
      || receipt.evidenceKind !== 'local-loopback-http-serving' || receipt.fixtureLabel !== null
      || receipt.localHttpPerformed !== true || receipt.localServingVerified !== true
      || receipt.actualAssetBytesVerified !== true || receipt.hostHeader !== HOST
      || receipt.loopbackOrigin !== target.origin || receipt.plannedRequests !== 358
      || receipt.passedRequests !== 358 || receipt.failedRequests !== 0
      || newsletterLoopbackReceiptSha256(receipt.sourcePins) !== newsletterLoopbackReceiptSha256(NEWSLETTER_PINS)
      || !Array.isArray(receipt.records) || receipt.records.length !== 358) fail('actual successful local serving receipt required');
  for (const flag of ['publicOriginVerified', 'publicDnsTlsVerified', 'deployedServingVerified',
    'dynamicUploadsCapabilitiesUiVerified', 'conditionalArchiveOriginVerified',
    'legacyHeaderParityVerified']) if (receipt[flag] !== false) fail('unsupported serving scope claim');
  const byPath = new Map(canonicalNewsletterManifest().map(entry => [entry.publicPath, entry]));
  const headerComparison = historicalHeaders(receipt.records);
  if (receipt.historicalHeadersEquivalent !== headerComparison.equivalent
      || newsletterLoopbackReceiptSha256(receipt.historicalHeaderComparison)
      !== newsletterLoopbackReceiptSha256(headerComparison.headers)) fail('historical header comparison mismatch');
  const limits = receipt.limits;
  if (!limits) fail('serving limits required');
  integer(limits.concurrency, 1, 8, 'receipt concurrency limit');
  integer(limits.timeoutMs, 1, 10000, 'receipt request timeout limit');
  integer(limits.totalTimeoutMs, 1, 120000, 'receipt total timeout limit');
  integer(limits.maxWireBodyBytes, 1, 1048576, 'receipt wire body limit');
  integer(limits.maxDecodedBodyBytes, 1, 1048576, 'receipt decoded body limit');
  const seen = new Set();
  for (const record of receipt.records) {
    const entry = byPath.get(record.publicPath), key = record.method + ' ' + record.publicPath;
    if (!entry || !METHODS.includes(record.method) || seen.has(key) || record.status !== 'PASS'
        || record.httpStatus !== 200 || record.hostname !== '127.0.0.1' || record.port !== target.port
        || record.hostHeader !== HOST || record.url !== new URL(entry.publicPath, target.origin).href) fail('serving measurement identity');
    seen.add(key);
    const headers = normalizeHeaders(record.headers);
    const identity = record.decodedIdentity;
    qualifyNewsletterResponse({ kind: 'static', url: record.url, expectedOrigin: target.origin,
      method: record.method, status: 200, headers, body: Buffer.alloc(0),
      identity: () => identity });
    if (!Number.isInteger(record.wireBodyBytes) || record.wireBodyBytes < 0
        || record.wireBodyBytes > limits.maxWireBodyBytes || identity?.bytes > limits.maxDecodedBodyBytes) fail('serving wire measurement');
    if (record.method === 'GET') {
      const encoding = headers['content-encoding'];
      if ((!encoding || encoding === 'identity') && record.wireBodyBytes !== identity.bytes) fail('wire/decoded identity mismatch');
      if (encoding && !['identity', 'gzip', 'deflate', 'br'].includes(encoding)) fail('receipt content encoding');
      if (headers['content-length'] !== undefined && headers['content-length'] !== String(record.wireBodyBytes)) fail('GET wire length');
    }
    const empty = newsletterByteIdentity(Buffer.alloc(0));
    if (record.method === 'HEAD' && (record.wireBodyBytes !== 0 || identity?.bytes !== empty.bytes
        || identity?.sha256 !== empty.sha256 || identity?.gitBlob !== empty.gitBlob)) fail('HEAD receipt body identity');
  }
  return { localServingReceiptConsistent: true, staticPaths: 179, requests: 358,
    expectedArtifact: expected, expectedReceiptSha256, publicOriginVerified: false,
    deployedServingVerified: false, fullReplacementQualified: false,
    historicalHeadersEquivalent: headerComparison.equivalent,
    serverProcessSourceBindingIndependentlyAttested: false };
}
