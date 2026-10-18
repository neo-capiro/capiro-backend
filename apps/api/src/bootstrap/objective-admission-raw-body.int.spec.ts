import 'reflect-metadata';
import { Controller, Module, Post, Req, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import { createConnection, type AddressInfo, type Socket } from 'node:net';
import { gzipSync } from 'node:zlib';
import type { Request, Response, NextFunction } from 'express';
import { ObjectiveWorkloadAdmissionController, OBJECTIVE_ADMISSION_RUNTIME } from '../auth/workload-authority/objective-workload-admission.controller.js';
import type { ObjectiveAdmissionHttpRequest } from '../auth/workload-authority/objective-workload-admission-ingress.js';
import { ObjectiveWorkloadAdmissionModule } from '../auth/workload-authority/objective-workload-admission.module.js';
import { OBJECTIVE_WORKLOAD_PROOF_PATH } from '../auth/workload-authority/objective-workload-proof.js';
import { configureApiHttpApp, type ConfigureApiHttpAppOptions } from './configure-api-http-app.js';
import { OBJECTIVE_DECISION_RAW_BODY_LIMIT, OBJECTIVE_DECISION_RAW_BODY_PATH } from './objective-admission-raw-body.js';

/** Parser qualification only: the capture runtime below is explicitly SYNTHETIC
 * and returns no authority, credential, decision or issuance. The actual Nest
 * controller and shared pre-init parser chain run over loopback HTTP, including
 * Node's original raw header list and chunked entity bytes. Invalid JSON/BOM
 * capture success does not imply acceptance by the real canonical ingress.
 * No AppModule, Prisma connection, auth/session owner, Meri or live service runs.
 */
const PATH = '/api/internal/objective-workload-authority/decisions';
const ORIGIN = 'https://os.capiro.ai';
const MiB = 1024 * 1024;
const SYNTHETIC_AUTH = 'Bearer synthetic-parser-qualification-only';
const releaseSha = '7'.repeat(40);
const options: ConfigureApiHttpAppOptions = {
  serviceHeader: 'synthetic-parser-fixture', releaseShaHeader: releaseSha,
  includeClerkRawBody: true, includeRecallRawBody: true, includeTangoRawBody: true,
  includeEmailSignatureLargeBody: true, includeObjectiveDecisionRawBody: true, defaultJsonLimit: '1mb',
};

function summary(request: Request) {
  const body = request.body;
  return { buffer: Buffer.isBuffer(body), bytes: Buffer.isBuffer(body) ? body.length : null,
    rawBodyPresent: !!Object.getOwnPropertyDescriptor(request, 'rawBody'),
    value: body?.value ?? null, nested: body?.nested ?? null,
    payloadLength: typeof body?.payload === 'string' ? body.payload.length : null,
    htmlLength: typeof body?.html === 'string' ? body.html.length : null };
}
@Controller()
class ParserProbeController {
  @Post('parser-probe/json') json(@Req() request: Request) { return summary(request); }
  @Post('parser-probe/form') form(@Req() request: Request) { return summary(request); }
  @Post('me/email-signature') email(@Req() request: Request) { return summary(request); }
  @Post('webhooks/clerk') clerk(@Req() request: Request) { return summary(request); }
  @Post('webhooks/recall') recall(@Req() request: Request) { return summary(request); }
  @Post('webhooks/tango') tango(@Req() request: Request) { return summary(request); }
}

type ObservedRequest = { originalUrl: string; rawHeaders: string[]; descriptor?: PropertyDescriptor; body: unknown; request: Request };
type Fixture = { app: INestApplication; port: number; capture: ReturnType<typeof jest.fn>;
  captured: ObjectiveAdmissionHttpRequest[]; observed: ObservedRequest[] };
const fixtures: Fixture[] = [];
async function fixture(overrides: Partial<ConfigureApiHttpAppOptions> = {}, production = false,
  beforeConfigure?: (app: INestApplication) => void): Promise<Fixture> {
  const captured: ObjectiveAdmissionHttpRequest[] = [], observed: ObservedRequest[] = [];
  const capture = jest.fn(async (value: ObjectiveAdmissionHttpRequest) => {
    captured.push(value); return { syntheticParserCaptureOnly: true };
  });
  @Module({ controllers: [ObjectiveWorkloadAdmissionController, ParserProbeController],
    providers: [{ provide: OBJECTIVE_ADMISSION_RUNTIME, useValue: capture }] })
  class SyntheticCaptureModule {}
  @Module({ imports: [ObjectiveWorkloadAdmissionModule], controllers: [ParserProbeController] })
  class ProductionClosedModule {}
  // Keep Nest's own body-parser registration enabled. Installing the ACTUAL
  // shared chain before init must preserve raw bytes without bypassing it.
  const app = await NestFactory.create(production ? ProductionClosedModule : SyntheticCaptureModule, { logger: false });
  try {
    beforeConfigure?.(app);
    configureApiHttpApp(app, { ...options, ...overrides });
    app.use((request: Request, _response: Response, next: NextFunction) => {
      observed.push({ originalUrl: request.originalUrl, rawHeaders: [...request.rawHeaders],
        descriptor: Object.getOwnPropertyDescriptor(request, 'rawBody'), body: request.body, request });
      next();
    });
    await app.init(); await app.listen(0, '127.0.0.1');
    const address = (app.getHttpServer() as Server).address() as AddressInfo;
    const value = { app, port: address.port, capture, captured, observed }; fixtures.push(value); return value;
  } catch (error) { await app.close(); throw error; }
}
type HttpResult = { status: number; headers: IncomingHttpHeaders; bytes: Buffer; json: any };
function headers(contentType: string | undefined = 'application/json', encoding?: string): string[] {
  return ['Authorization', SYNTHETIC_AUTH, ...(contentType === undefined ? [] : ['Content-Type', contentType]),
    ...(encoding === undefined ? [] : ['Content-Encoding', encoding]), 'Origin', ORIGIN, 'Connection', 'close'];
}
function send(f: Fixture, body: Buffer, config: { path?: string; method?: string; headers?: string[]; chunks?: Buffer[] } = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const originalHeaders = config.headers ?? headers();
    // Node deliberately does not synthesize Host when supplied an original
    // header array. Send it explicitly so Node24's HTTP/1.1 parser admits the
    // request and the test reaches the actual application parser chain.
    const framed = ['Host', `127.0.0.1:${f.port}`, ...originalHeaders,
      ...(config.chunks ? ['Transfer-Encoding', 'chunked'] : ['Content-Length', String(body.length)])];
    const request = httpRequest({ host: '127.0.0.1', port: f.port, path: config.path ?? PATH,
      method: config.method ?? 'POST', headers: framed, agent: false }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject); response.on('end', () => {
        const bytes = Buffer.concat(chunks); let json: unknown = null;
        try { json = JSON.parse(bytes.toString('utf8')); } catch { /* Non-JSON/HEAD response is still recorded. */ }
        resolve({ status: response.statusCode!, headers: response.headers, bytes, json });
      });
    });
    request.on('error', reject); request.setTimeout(5000, () => request.destroy(Error('Local parser fixture timeout')));
    if (config.chunks) { for (const chunk of config.chunks) request.write(chunk); request.end(); }
    else request.end(body);
  });
}
function expectParserError(response: HttpResult, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers['x-capiro-service']).toBe('synthetic-parser-fixture');
  expect(response.headers['x-capiro-release-sha']).toBe(releaseSha);
  expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
  expect(response.headers['access-control-allow-credentials']).toBe('true');
  expect(response.headers['cache-control']).toBe('no-store'); expect(response.headers.pragma).toBe('no-cache');
}

describe('Objective decision raw bytes in actual Nest bootstrap parser ordering', () => {
  let f: Fixture;
  beforeAll(async () => { f = await fixture(); }, 15000);
  afterEach(() => { for (const value of fixtures) { value.capture.mockClear(); value.captured.length = 0; value.observed.length = 0; } });
  afterAll(async () => { for (const value of fixtures.splice(0).reverse()) await value.app.close(); });

  test('fixed parser path and binary limit agree with the actual admission proof contract', () => {
    expect(OBJECTIVE_DECISION_RAW_BODY_PATH).toBe(PATH); expect(OBJECTIVE_WORKLOAD_PROOF_PATH).toBe(PATH);
    expect(OBJECTIVE_DECISION_RAW_BODY_LIMIT).toBe(4096);
  });

  test.each([
    ['literal Unicode/whitespace', Buffer.from('{ "value": "ação 東京 🧭", "order": 1 }\n', 'utf8')],
    ['UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"value":"bom"}')])],
    ['duplicate JSON keys', Buffer.from('{ "value": "original", "value": "replacement" }')],
    ['invalid JSON', Buffer.from('{"value": this is intentionally not JSON}\n')],
    ['invalid UTF-8', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])],
  ])('preserves %s transport bytes without JSON decoding or reserialization', async (_label, bytes) => {
    const body = bytes as Buffer, response = await send(f, body);
    expect(response.status).toBe(201); expect(response.json).toEqual({ syntheticParserCaptureOnly: true });
    expect(f.capture).toHaveBeenCalledTimes(1); expect(f.captured[0]).toEqual({ method: 'POST', originalUrl: PATH,
      authorization: SYNTHETIC_AUTH, rawBody: body });
    const observed = f.observed.find(value => value.originalUrl === PATH)!;
    expect(observed.descriptor).toEqual({ value: body, enumerable: false, configurable: false, writable: false });
    expect(Buffer.isBuffer(observed.body)).toBe(true); expect(observed.descriptor!.value).not.toBe(observed.body);
    expect(observed.descriptor!.value).toBe(f.captured[0]!.rawBody);
    expect(Object.keys(observed.request)).not.toContain('rawBody');
    expect(Reflect.set(observed.request, 'rawBody', Buffer.from('replacement'))).toBe(false);
    expect(Reflect.deleteProperty(observed.request, 'rawBody')).toBe(false);
    expect(Buffer.from(f.captured[0]!.rawBody).equals(body)).toBe(true);
  });

  test('chunked transport preserves bytes when chunks split Unicode code points', async () => {
    const body = Buffer.from('{ "value": "🧭 ação 東京" }', 'utf8');
    const response = await send(f, body, { chunks: [...body].map(byte => Buffer.from([byte])) });
    expect(response.status).toBe(201); expect(Buffer.from(f.captured[0]!.rawBody).equals(body)).toBe(true);
    expect(f.observed[0]!.rawHeaders).toContain('chunked');
  });

  test.each([false, true])('accepts exactly 4096 binary bytes with chunked=%s', async chunked => {
    const body = Buffer.alloc(4096, 0xff), response = await send(f, body,
      chunked ? { chunks: [body.subarray(0, 2048), body.subarray(2048)] } : {});
    expect(response.status).toBe(201); expect(f.captured[0]!.rawBody.byteLength).toBe(4096);
    expect(Buffer.from(f.captured[0]!.rawBody).equals(body)).toBe(true);
  });

  test.each([false, true])('rejects 4097 entity bytes before runtime with chunked=%s and preserves parser-error provenance', async chunked => {
    const body = Buffer.alloc(4097, 0x20), response = await send(f, body,
      chunked ? { chunks: [body.subarray(0, 4096), body.subarray(4096)] } : {});
    expectParserError(response, 413); expect(f.capture).not.toHaveBeenCalled();
  });

  test.each(['application/json', 'application/json; charset=utf-8', 'application/json;charset=utf8',
    'APPLICATION/JSON; CHARSET="UTF-8"', 'application/json; charset="utf8"'])('accepts the closed UTF-8 JSON media type %s', async contentType => {
    const response = await send(f, Buffer.from('{}'), { headers: headers(contentType) });
    expect(response.status).toBe(201); expect(f.capture).toHaveBeenCalledTimes(1);
  });

  test.each([undefined, 'text/plain', 'application/problem+json', 'application/json; charset=utf-16',
    'application/json; charset=latin1', 'application/json; profile=unexpected',
    'application/json; charset=utf-8; charset=utf-8', 'application/json, application/json'])('rejects unsupported Content-Type %s before runtime', async contentType => {
    const response = await send(f, Buffer.from('{}'), { headers: contentType === undefined
      ? ['Authorization', SYNTHETIC_AUTH, 'Origin', ORIGIN, 'Connection', 'close'] : headers(contentType) });
    expectParserError(response, 415); expect(f.capture).not.toHaveBeenCalled();
  });

  test.each(['identity', 'IDENTITY'])('accepts one explicit %s content encoding without transforming bytes', async encoding => {
    const body = Buffer.from('{ "exact": true }'), response = await send(f, body, { headers: headers('application/json', encoding) });
    expect(response.status).toBe(201); expect(Buffer.from(f.captured[0]!.rawBody).equals(body)).toBe(true);
  });

  test.each(['gzip', 'deflate', 'br', 'identity, identity'])('rejects %s compression/encoding before parsing or runtime', async encoding => {
    const body = encoding === 'gzip' ? gzipSync(Buffer.from('{}')) : Buffer.from('{}');
    const response = await send(f, body, { headers: headers('application/json', encoding) });
    expectParserError(response, 415); expect(f.capture).not.toHaveBeenCalled();
  });

  test.each([
    ['Content-Type', 'application/json', 'content-type', 'application/json'],
    ['Content-Type', 'application/json', 'cOnTeNt-TyPe', 'text/plain'],
    ['Content-Encoding', 'identity', 'content-encoding', 'identity'],
    ['Content-Encoding', 'identity', 'cOnTeNt-EnCoDiNg', 'gzip'],
  ])('rejects repeated original %s fields even when Node normalizes them', async (name, first, secondName, second) => {
    const original = headers(name === 'Content-Type' ? undefined : 'application/json');
    // headers(undefined) defaults to JSON, so remove it explicitly for the CT
    // duplicate case and let the original raw-header array carry exactly two.
    if (name === 'Content-Type') original.splice(original.indexOf('Content-Type'), 2);
    original.push(name, first, secondName, second);
    const response = await send(f, Buffer.from('{}'), { headers: original });
    expectParserError(response, 400); expect(f.capture).not.toHaveBeenCalled();
  });

  test.each(['same', 'different'])('actual controller rejects %s duplicate original Authorization fields after capture', async kind => {
    const original = headers(); original.push('aUtHoRiZaTiOn', kind === 'same' ? SYNTHETIC_AUTH : 'Bearer different-synthetic-only');
    const response = await send(f, Buffer.from('{}'), { headers: original });
    expectParserError(response, 503); expect(f.capture).not.toHaveBeenCalled();
    const observed = f.observed[0]!; expect(observed.descriptor).toBeDefined();
    expect(observed.rawHeaders.filter(value => value.toLowerCase() === 'authorization')).toHaveLength(2);
  });

  test.each(['?alias=1', '?', '/', '/child'])('fixed-path suffix %s receives no signed capture or runtime call', async suffix => {
    const response = await send(f, Buffer.from('{}'), { path: PATH + suffix });
    expect(response.status).toBeGreaterThanOrEqual(400); expect(f.capture).not.toHaveBeenCalled();
    expect(f.observed.every(value => value.descriptor === undefined)).toBe(true);
  });

  test.each([PATH.toUpperCase(), PATH.replace('decisions', '%64ecisions'), '/api//internal/objective-workload-authority/decisions'])('path alias %s never receives signed capture', async path => {
    const response = await send(f, Buffer.from('{}'), { path });
    expect(response.status).toBeGreaterThanOrEqual(400); expect(f.capture).not.toHaveBeenCalled();
    expect(f.observed.every(value => value.descriptor === undefined)).toBe(true);
  });

  test('absolute-form request target is never normalized into the fixed signed path', async () => {
    const response = await send(f, Buffer.from('{}'), { path: `http://127.0.0.1:${f.port}${PATH}` });
    expect(response.status).toBeGreaterThanOrEqual(400); expect(f.capture).not.toHaveBeenCalled();
    expect(f.observed.every(value => value.descriptor === undefined)).toBe(true);
  });

  test.each(['GET', 'PUT', 'HEAD'])('%s method never receives signed capture', async method => {
    const response = await send(f, Buffer.from('{}'), { method });
    expect(response.status).toBeGreaterThanOrEqual(400); expect(f.capture).not.toHaveBeenCalled();
    expect(f.observed.every(value => value.descriptor === undefined)).toBe(true);
  });

  test.each([false, undefined])('optional capture flag %s remains off while ordinary JSON parsing is still enabled', async includeObjectiveDecisionRawBody => {
    const off = await fixture({ includeObjectiveDecisionRawBody });
    const response = await send(off, Buffer.from('{"value":"ordinary JSON"}'));
    expect(response.status).toBe(503); expect(off.capture).not.toHaveBeenCalled();
    expect(off.observed[0]!.descriptor).toBeUndefined(); expect(off.observed[0]!.body).toEqual({ value: 'ordinary JSON' });
  });

  test('an existing rawBody property is denied rather than adopted as transport custody', async () => {
    const poisoned = await fixture({}, false, app => app.use((request: Request, _response: Response, next: NextFunction) => {
      Object.defineProperty(request, 'rawBody', { value: Buffer.from('synthetic-preexisting-value') }); next();
    }));
    expectParserError(await send(poisoned, Buffer.from('{}')), 400); expect(poisoned.capture).not.toHaveBeenCalled();
  });

  test('actual production admission module stays default-off 503 after successful byte capture', async () => {
    const production = await fixture({}, true), response = await send(production, Buffer.from('{"schemaVersion":1}'));
    expectParserError(response, 503);
    expect(response.json).toEqual({ message: 'Objective workload admission unavailable', error: 'Service Unavailable', statusCode: 503 });
    expect(production.observed[0]!.descriptor!.value).toEqual(Buffer.from('{"schemaVersion":1}'));
    expect(production.capture).not.toHaveBeenCalled();
  });

  test('empty transport entity cannot produce authority from the actual default-off admission module', async () => {
    const production = await fixture({}, true), response = await send(production, Buffer.alloc(0));
    expectParserError(response, 503);
    expect(response.json).toEqual({ message: 'Objective workload admission unavailable', error: 'Service Unavailable', statusCode: 503 });
    expect(production.capture).not.toHaveBeenCalled();
  });

  test('a truncated native HTTP entity aborts before capture or runtime without waiting for a parser timeout', async () => {
    const server = f.app.getHttpServer() as Server, response: Buffer[] = [];
    let socket: Socket | undefined, incoming: IncomingMessage | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let onAborted = () => {}, onRequest = (_request: IncomingMessage) => {};
    try {
      await new Promise<void>((resolve, reject) => {
        let aborted = false, closed = false;
        const completed = () => { if (aborted && closed) resolve(); };
        onAborted = () => { aborted = true; completed(); };
        onRequest = request => { incoming = request; request.once('aborted', onAborted); };
        server.once('request', onRequest);
        // The write side sends FIN with fewer bytes than the advertised entity
        // length. Node therefore observes an incomplete actual IncomingMessage;
        // this does not depend on an arbitrary sleep or server timeout firing.
        socket = createConnection({ host: '127.0.0.1', port: f.port }, () => {
          const body = Buffer.from('{"value":"truncated"}');
          const start = `POST ${PATH} HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\n` +
            `Authorization: ${SYNTHETIC_AUTH}\r\nContent-Type: application/json\r\n` +
            `Content-Length: ${body.length + 10}\r\nConnection: close\r\n\r\n`;
          socket!.end(Buffer.concat([Buffer.from(start, 'ascii'), body]));
        });
        socket.on('data', chunk => response.push(Buffer.from(chunk))); socket.once('error', reject);
        socket.once('close', () => { closed = true; completed(); });
        timer = setTimeout(() => reject(Error('Truncated local entity did not reach native abort/close')), 2000);
      });
      expect(incoming).toBeDefined(); expect(incoming!.complete).toBe(false); expect(incoming!.aborted).toBe(true);
      expect(Object.getOwnPropertyDescriptor(incoming!, 'rawBody')).toBeUndefined();
      expect(f.capture).not.toHaveBeenCalled(); expect(f.captured).toEqual([]);
      expect(f.observed.filter(value => value.originalUrl === PATH)).toEqual([]);
      // Depending on which native close wins, HTTP emits 400 or closes before
      // an application response. Neither path can produce a positive decision.
      const received = Buffer.concat(response).toString('latin1');
      expect(received === '' || /^HTTP\/1\.1 400(?: |\r)/.test(received)).toBe(true);
    } finally {
      if (timer) clearTimeout(timer); server.removeListener('request', onRequest);
      incoming?.removeListener('aborted', onAborted); socket?.destroy(); incoming?.socket.destroy();
    }
  });

  test('ordinary JSON retains its existing 1 MiB ceiling and receives no Objective raw body', async () => {
    const exact = Buffer.from('{"payload":"' + 'x'.repeat(MiB - 14) + '"}'); expect(exact.length).toBe(MiB);
    const accepted = await send(f, exact, { path: '/api/parser-probe/json' });
    expect(accepted.status).toBe(201); expect(accepted.json.rawBodyPresent).toBe(false); expect(accepted.json.payloadLength).toBe(MiB - 14);
    const rejected = await send(f, Buffer.concat([exact, Buffer.from(' ')]), { path: '/api/parser-probe/json' });
    expect(rejected.status).toBe(413); expect(rejected.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(rejected.headers['x-capiro-release-sha']).toBe(releaseSha); expect(f.capture).not.toHaveBeenCalled();
  });

  test('ordinary JSON retains decompression and Nest URL-encoded form parsing remains unchanged', async () => {
    const compressed = await send(f, gzipSync(Buffer.from('{"value":"ordinary compressed JSON"}')),
      { path: '/api/parser-probe/json', headers: headers('application/json', 'gzip') });
    expect(compressed.status).toBe(201); expect(compressed.json.value).toBe('ordinary compressed JSON');
    const form = await send(f, Buffer.from('value=ordinary+form&nested%5Bx%5D=yes'),
      { path: '/api/parser-probe/form', headers: headers('application/x-www-form-urlencoded') });
    expect(form.status).toBe(201); expect(form.json.value).toBe('ordinary form'); expect(form.json.nested).toEqual({ x: 'yes' });
    expect(form.json.rawBodyPresent).toBe(false); expect(f.capture).not.toHaveBeenCalled();
  });

  test.each(['clerk', 'recall', 'tango'])('existing %s webhook keeps its raw buffer and 1 MiB ceiling independently', async webhook => {
    const exact = Buffer.alloc(MiB, 0xff), path = `/webhooks/${webhook}`;
    const accepted = await send(f, exact, { path, headers: headers('application/octet-stream') });
    expect(accepted.status).toBe(201); expect(accepted.json).toMatchObject({ buffer: true, bytes: MiB, rawBodyPresent: false });
    const rejected = await send(f, Buffer.alloc(MiB + 1, 0xff), { path, headers: headers('application/octet-stream') });
    expect(rejected.status).toBe(413); expect(f.capture).not.toHaveBeenCalled();
  });

  test('email signature retains its 32 MiB parser and the existing opt-out reverts to ordinary JSON limits', async () => {
    const body = Buffer.from(JSON.stringify({ html: 'x'.repeat(MiB + 1) }));
    const accepted = await send(f, body, { path: '/api/me/email-signature' });
    expect(accepted.status).toBe(201); expect(accepted.json.htmlLength).toBe(MiB + 1); expect(accepted.json.rawBodyPresent).toBe(false);
    const off = await fixture({ includeEmailSignatureLargeBody: false });
    expect((await send(off, body, { path: '/api/me/email-signature' })).status).toBe(413);
    const over32MiB = Buffer.from('{"html":"' + 'x'.repeat(32 * MiB - 11) + '"} '); expect(over32MiB.length).toBe(32 * MiB + 1);
    expect((await send(f, over32MiB, { path: '/api/me/email-signature' })).status).toBe(413);
    expect(f.capture).not.toHaveBeenCalled();
  }, 15000);
});
