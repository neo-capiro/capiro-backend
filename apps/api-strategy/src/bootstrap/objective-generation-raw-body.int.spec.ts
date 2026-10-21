import 'reflect-metadata';
import { Body, Controller, Get, Inject, Module, Post, Req, ServiceUnavailableException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { constants, createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest, IncomingMessage, type IncomingHttpHeaders, type Server } from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Request, Response, NextFunction } from 'express';
import { ObjectiveCanonicalProducerController } from '../meri/objective-canonical-producer.controller.js';
import { ObjectiveCanonicalProducerService } from '../meri/objective-canonical-producer.service.js';
import { ObjectiveCanonicalWorkloadAuthority } from '../planner/objective-canonical-authority.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { configureStrategyBodyParsers } from './configure-strategy-body-parsers.js';
import { objectiveGenerationRawBody } from './objective-generation-raw-body.js';

/** Local parser/transport qualification only. Synthetic consumers require the
 * captured bytes while retaining actual Nest @Body parsing. Their success is
 * not native caller authority, an issuance or Meri acceptance. The final test
 * uses the actual producer controller/service and unavailable-by-default native
 * authority, with a synthetic Prisma port that must never execute. No keys,
 * credentials, SQL, AppModule, shared listeners or deployed services are used.
 */
const PREFIX = '/strategy-api/internal/objective-canonical/';
const POST_PATHS = ['generation-admissions', 'generation-requests', 'generation-acceptances',
  'generation-completions', 'generation-terminals'];
const READ_PATHS = ['generation-admissions', 'generation-requests', 'generation-completions', 'generation-terminals'];
const JOB_ID = '12345678-90ab-4cde-8f01-23456789abcd';
const LIMIT = 8 * 1024 * 1024;
const OBSERVER = Symbol('SYNTHETIC_STRATEGY_BYTE_OBSERVER');
type Observation = { request: Request; parsed: unknown; rawBody: Buffer; descriptor: PropertyDescriptor };
type Observe = (request: Request, parsed: unknown) => unknown;

@Controller('internal/objective-canonical')
class SyntheticCanonicalConsumer {
  constructor(@Inject(OBSERVER) private readonly observe: Observe) {}
  @Post(POST_PATHS)
  post(@Req() request: Request, @Body() body: unknown) { return this.consume(request, body); }
  @Get(READ_PATHS.map(path => `${path}/:generationJobId`))
  read(@Req() request: Request, @Body() body: unknown) { return this.consume(request, body); }
  private consume(request: Request, body: unknown) {
    const descriptor = Object.getOwnPropertyDescriptor(request, 'rawBody');
    if (!descriptor || !('value' in descriptor) || !Buffer.isBuffer(descriptor.value))
      throw new ServiceUnavailableException('Synthetic consumer needs actual entity bytes');
    return this.observe(request, body);
  }
  @Post('generation-producer/admit')
  unregisteredProducer(@Req() request: Request, @Body() body: unknown) { return summary(request, body); }
  @Post('planner-applications')
  unregisteredApplication(@Req() request: Request, @Body() body: unknown) { return summary(request, body); }
  @Get('planner-applications/:applicationRequestId')
  unregisteredApplicationRead(@Req() request: Request, @Body() body: unknown) { return summary(request, body); }
}
function summary(request: Request, body: any) {
  return { rawBodyPresent: !!Object.getOwnPropertyDescriptor(request, 'rawBody'), parsedIsBuffer: Buffer.isBuffer(body),
    value: body?.value ?? null, nested: body?.nested ?? null, payloadLength: typeof body?.payload === 'string' ? body.payload.length : null };
}
@Controller('parser-probe')
class OrdinaryParserConsumer {
  @Post('json') json(@Req() request: Request, @Body() body: unknown) { return summary(request, body); }
  @Post('form') form(@Req() request: Request, @Body() body: unknown) { return summary(request, body); }
}
type Fixture = { app: INestApplication; port: number; observe: ReturnType<typeof jest.fn>;
  captured: Observation[]; nativeRequests: Request[]; io: ReturnType<typeof jest.fn> };
const fixtures: Fixture[] = [];
async function fixture(production = false, beforeConfigure?: (app: INestApplication) => void): Promise<Fixture> {
  const captured: Observation[] = [], nativeRequests: Request[] = [];
  const observe = jest.fn((request: Request, parsed: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(request, 'rawBody')!;
    captured.push({ request, parsed, descriptor, rawBody: descriptor.value });
    return { syntheticParserCaptureOnly: true };
  });
  const io = jest.fn(() => { throw Error('SYNTHETIC_PRISMA_MUST_NOT_EXECUTE'); });
  @Module({ controllers: [SyntheticCanonicalConsumer, OrdinaryParserConsumer],
    providers: [{ provide: OBSERVER, useValue: observe }] })
  class SyntheticConsumersModule {}
  @Module({ controllers: [ObjectiveCanonicalProducerController], providers: [ObjectiveCanonicalProducerService,
    ObjectiveCanonicalWorkloadAuthority, { provide: PrismaService, useValue: { withTenant: io } }] })
  class ActualClosedProducerModule {}
  const app = await NestFactory.create(production ? ActualClosedProducerModule : SyntheticConsumersModule, { logger: false });
  try {
    app.setGlobalPrefix('strategy-api');
    app.use((request: Request, _response: Response, next: NextFunction) => { nativeRequests.push(request); next(); });
    beforeConfigure?.(app);
    // This is the actual pre-init production parser composition, retaining
    // normal Nest bodyParser registration and its URL-encoded form parser.
    configureStrategyBodyParsers(app);
    await app.init(); await app.listen(0, '127.0.0.1');
    const port = ((app.getHttpServer() as Server).address() as AddressInfo).port;
    const value = { app, port, observe, captured, nativeRequests, io }; fixtures.push(value); return value;
  } catch (error) { await app.close(); throw error; }
}
type HttpResult = { status: number; headers: IncomingHttpHeaders; bytes: Buffer; json: any };
function send(f: Fixture, path: string, body: Buffer, options: { method?: string; contentType?: string | null;
  encoding?: string; chunks?: Buffer[]; unframed?: boolean; extraHeaders?: string[] } = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
    const headers = ['Host', `127.0.0.1:${f.port}`, 'Connection', 'close',
      ...(contentType === null ? [] : ['Content-Type', contentType]),
      ...(options.encoding ? ['Content-Encoding', options.encoding] : []),
      ...(options.extraHeaders ?? []), ...(options.unframed ? [] : options.chunks
        ? ['Transfer-Encoding', 'chunked'] : ['Content-Length', String(body.length)])];
    const request = httpRequest({ host: '127.0.0.1', port: f.port, path, method: options.method ?? 'POST', headers, agent: false }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('error', reject);
      response.on('end', () => {
        const bytes = Buffer.concat(chunks); let json: unknown = null;
        try { json = JSON.parse(bytes.toString('utf8')); } catch { /* Preserve non-JSON/HEAD responses. */ }
        resolve({ status: response.statusCode!, headers: response.headers, bytes, json });
      });
    });
    request.on('error', reject); request.setTimeout(5000, () => request.destroy(Error('Local Strategy parser timeout')));
    if (options.chunks) { for (const chunk of options.chunks) request.write(chunk); request.end(); }
    else request.end(body);
  });
}

describe('Strategy generation entity capture through actual Nest pre-init body parsers', () => {
  let f: Fixture;
  beforeAll(async () => { f = await fixture(); }, 15000);
  afterEach(() => { for (const value of fixtures) { value.observe.mockClear(); value.io.mockClear(); value.captured.length = 0; value.nativeRequests.length = 0; } });
  afterAll(async () => { for (const value of fixtures.splice(0).reverse()) await value.app.close(); });

  test.each(POST_PATHS)('exact POST %s captures bytes while preserving parsed @Body', async path => {
    const body = Buffer.from('{ "value": "source-only parser fixture", "count": 1 }');
    const response = await send(f, PREFIX + path, body);
    expect(response.status).toBe(201); expect(response.json).toEqual({ syntheticParserCaptureOnly: true });
    expect(f.observe).toHaveBeenCalledTimes(1); const observed = f.captured[0]!;
    expect(observed.parsed).toEqual({ value: 'source-only parser fixture', count: 1 });
    expect(observed.rawBody).toEqual(body); expect(Buffer.isBuffer(observed.parsed)).toBe(false);
    expect(observed.descriptor).toEqual({ value: body, enumerable: false, writable: false, configurable: false });
    expect(Object.keys(observed.request)).not.toContain('rawBody');
    expect(Reflect.set(observed.request, 'rawBody', Buffer.from('replacement'))).toBe(false);
    expect(Reflect.deleteProperty(observed.request, 'rawBody')).toBe(false);
  });

  test.each([
    ['literal Unicode, whitespace and key order', Buffer.from('{ "z": "ação 東京 🧭", "a": 1 }\n', 'utf8'), { z: 'ação 東京 🧭', a: 1 }],
    ['UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"value":"bom"}')]), { value: 'bom' }],
    ['duplicate JSON keys', Buffer.from('{"value":"original", "value":"replacement"}'), { value: 'replacement' }],
  ])('preserves %s exact bytes without replacing them with parsed JSON', async (_label, raw, parsed) => {
    const body = raw as Buffer, response = await send(f, PREFIX + 'generation-requests', body);
    expect(response.status).toBe(201); expect(f.captured[0]!.rawBody).toEqual(body); expect(f.captured[0]!.parsed).toEqual(parsed);
    expect(f.captured[0]!.rawBody.equals(Buffer.from(JSON.stringify(parsed)))).toBe(false);
  });

  test('chunked POST preserves multibyte UTF-8 split across entity chunks', async () => {
    const body = Buffer.from('{ "value": "ação 東京 🧭" }', 'utf8');
    const response = await send(f, PREFIX + 'generation-completions', body, { chunks: [...body].map(byte => Buffer.from([byte])) });
    expect(response.status).toBe(201); expect(f.captured[0]!.rawBody).toEqual(body); expect(f.captured[0]!.parsed).toEqual({ value: 'ação 東京 🧭' });
  });

  test('reused public offline RSA fixture authenticates captured byte digest, never a parsed-JSON reconstruction', async () => {
    // This tracked token has a DIFFERENT retained-read purpose/audience/path;
    // it is never sent as Strategy authorization. Reusing its public signature
    // here proves body-digest transport interoperability only, not positive
    // Strategy auth, currentness or acceptance. No key/credential is generated.
    const manifest = JSON.parse(readFileSync(resolve(__dirname,
      '../../../../docs/objective-workload-authority-20261015/CORE-MERI-RETAINED-READ-SIGNED-FIXTURES-20261016.json'), 'utf8')) as
      { publicKeyPem: string; cases: { id: string; token: string; rawBodyBase64: string }[] };
    const baseline = manifest.cases[0]!; expect(baseline.id).toBe('current-baseline');
    const [header, payload, signature] = baseline.token.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString('utf8')).alg).toBe('RS256');
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`, 'ascii'),
      { key: createPublicKey(manifest.publicKeyPem), padding: constants.RSA_PKCS1_PADDING }, Buffer.from(signature!, 'base64url'))).toBe(true);
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    expect(claims.aud).toBe('capiro:objective-meri-retained-result:v1'); expect(claims.phase).toBe('retained-result-read');
    expect(claims.path).toBe('/v1/internal/objective-generation/retained-result/read');
    const body = Buffer.from(baseline.rawBodyBase64, 'base64');
    expect((await send(f, PREFIX + 'generation-requests', body)).status).toBe(201);
    expect(createHash('sha256').update(f.captured[0]!.rawBody).digest('hex')).toBe(claims.bodySha256);
    const changed = Buffer.concat([body, Buffer.from('\n')]);
    expect((await send(f, PREFIX + 'generation-requests', changed)).status).toBe(201);
    expect(f.captured[1]!.parsed).toEqual(f.captured[0]!.parsed);
    expect(createHash('sha256').update(f.captured[1]!.rawBody).digest('hex')).not.toBe(claims.bodySha256);
  });

  test('capture preserves the existing JSON media/charset grammar rather than adding an UTF-8-only policy', async () => {
    const text = '{ "value": "existing UTF-16 JSON grammar" }', body = Buffer.from(text, 'utf16le');
    const response = await send(f, PREFIX + 'generation-requests', body, { contentType: 'application/json; charset=utf-16le' });
    expect(response.status).toBe(201); expect(f.captured[0]!.rawBody).toEqual(body);
    expect(f.captured[0]!.parsed).toEqual({ value: 'existing UTF-16 JSON grammar' });
  });

  test.each(['{"value": invalid JSON}', '{"value":', 'not a JSON object'])('invalid JSON %s never reaches a byte consumer', async text => {
    expect((await send(f, PREFIX + 'generation-admissions', Buffer.from(text))).status).toBe(400);
    expect(f.observe).not.toHaveBeenCalled(); expect(f.captured).toEqual([]);
  });

  test.each([false, true])('empty POST is denied before consumer with chunked=%s', async chunked => {
    expect((await send(f, PREFIX + 'generation-acceptances', Buffer.alloc(0), chunked ? { chunks: [] } : {})).status).toBe(400);
    expect(f.observe).not.toHaveBeenCalled();
  });

  test('unsupported JSON media leaves no usable captured entity or consumer call', async () => {
    expect((await send(f, PREFIX + 'generation-terminals', Buffer.from('{}'), { contentType: 'text/plain' })).status).toBe(400);
    expect(f.observe).not.toHaveBeenCalled(); expect(Object.getOwnPropertyDescriptor(f.nativeRequests[0]!, 'rawBody')).toBeUndefined();
  });

  test('matched POST refuses compressed entity bytes without changing ordinary JSON decompression', async () => {
    expect((await send(f, PREFIX + 'generation-requests', gzipSync(Buffer.from('{}')), { encoding: 'gzip' })).status).toBe(415);
    expect(f.observe).not.toHaveBeenCalled();
  });

  test.each([false, true])('valid JSON at exactly 8 MiB is accepted with chunked=%s', async chunked => {
    const body = Buffer.from('{"payload":"' + 'x'.repeat(LIMIT - 14) + '"}'); expect(body.length).toBe(LIMIT);
    const response = await send(f, PREFIX + 'generation-requests', body,
      chunked ? { chunks: [body.subarray(0, LIMIT / 2), body.subarray(LIMIT / 2)] } : {});
    expect(response.status).toBe(201); expect(f.captured[0]!.rawBody.length).toBe(LIMIT);
    expect((f.captured[0]!.parsed as { payload: string }).payload.length).toBe(LIMIT - 14);
  }, 15000);

  test.each([false, true])('valid JSON above 8 MiB is denied before consumer with chunked=%s', async chunked => {
    const body = Buffer.from('{"payload":"' + 'x'.repeat(LIMIT - 13) + '"}'); expect(body.length).toBe(LIMIT + 1);
    const response = await send(f, PREFIX + 'generation-requests', body,
      chunked ? { chunks: [body.subarray(0, LIMIT), body.subarray(LIMIT)] } : {});
    expect(response.status).toBe(413); expect(f.observe).not.toHaveBeenCalled();
  }, 15000);

  test.each(READ_PATHS)('exact GET %s with a canonical lowercase UUID captures actual empty entity after stream end', async path => {
    const response = await send(f, `${PREFIX}${path}/${JOB_ID}`, Buffer.alloc(0), { method: 'GET', unframed: true, contentType: null });
    expect(response.status).toBe(200); expect(f.captured[0]!.rawBody).toEqual(Buffer.alloc(0));
    expect(f.captured[0]!.request.complete).toBe(true); expect(f.captured[0]!.descriptor).toEqual({ value: Buffer.alloc(0), enumerable: false, writable: false, configurable: false });
  });

  test.each(['content-length-zero', 'chunked-zero'] as const)('GET %s observes the empty wire entity without synthesizing a nonempty body', async framing => {
    const response = await send(f, `${PREFIX}generation-requests/${JOB_ID}`, Buffer.alloc(0),
      { method: 'GET', ...(framing === 'chunked-zero' ? { chunks: [] } : {}) });
    expect(response.status).toBe(200); expect(f.captured[0]!.rawBody.length).toBe(0); expect(f.captured[0]!.request.complete).toBe(true);
  });

  test.each([false, true])('GET any nonzero entity is denied regardless of media type with chunked=%s', async chunked => {
    const body = Buffer.from('x'), response = await send(f, `${PREFIX}generation-completions/${JOB_ID}`, body,
      { method: 'GET', contentType: 'text/plain', ...(chunked ? { chunks: [body] } : {}) });
    expect(response.status).toBe(413); expect(f.observe).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(f.nativeRequests[0]!, 'rawBody')).toBeUndefined();
  });

  test('GET compressed entity coding is denied rather than transformed into an apparent empty body', async () => {
    const response = await send(f, `${PREFIX}generation-terminals/${JOB_ID}`, gzipSync(Buffer.alloc(0)), { method: 'GET', encoding: 'gzip' });
    expect(response.status).toBe(415); expect(f.observe).not.toHaveBeenCalled();
  });

  test('an already-consumed GET stream remains unavailable instead of fabricating an empty signed entity', async () => {
    let observedEnd = false;
    const consumed = await fixture(false, app => app.use((request: Request, _response: Response, next: NextFunction) => {
      request.once('end', () => { observedEnd = true; next(); }); request.resume();
    }));
    const response = await send(consumed, `${PREFIX}generation-requests/${JOB_ID}`, Buffer.alloc(0),
      { method: 'GET', unframed: true, contentType: null });
    expect(observedEnd).toBe(true); expect(consumed.nativeRequests[0]!.readableEnded).toBe(true);
    expect(response.status).toBe(400); expect(consumed.observe).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(consumed.nativeRequests[0]!, 'rawBody')).toBeUndefined();
  });

  test.each(['aborted', 'destroyed', 'socket-destroyed'] as const)('initial native GET %s is closed without installing stream listeners', state => {
    const request = new IncomingMessage(new Socket()) as Request;
    request.method = 'GET'; request.originalUrl = `${PREFIX}generation-requests/${JOB_ID}`;
    if (state === 'aborted') request.aborted = true;
    if (state === 'destroyed') request.destroy();
    if (state === 'socket-destroyed') request.socket.destroy();
    const events = ['data', 'end', 'aborted', 'error', 'close'], before = events.map(event => request.listenerCount(event));
    const next = jest.fn();
    try {
      // Native lifecycle adjunct, deliberately no fake HTTP success: these
      // already-closed requests cannot be delivered normally over loopback.
      objectiveGenerationRawBody()(request, {} as Response, next);
      expect(next).toHaveBeenCalledTimes(1); expect(next.mock.calls[0]![0]).toMatchObject({ status: 400 });
      expect(Object.getOwnPropertyDescriptor(request, 'rawBody')).toBeUndefined();
      expect(events.map(event => request.listenerCount(event))).toEqual(before);
    } finally { request.destroy(); request.socket.destroy(); }
  });

  test.each(['aborted', 'close'] as const)('native GET %s without end stays closed and removes every owned stream listener', event => {
    const request = new IncomingMessage(new Socket()) as Request;
    request.method = 'GET'; request.originalUrl = `${PREFIX}generation-requests/${JOB_ID}`;
    const events = ['data', 'end', 'aborted', 'error', 'close'], before = events.map(name => request.listenerCount(name));
    const next = jest.fn();
    try {
      objectiveGenerationRawBody()(request, {} as Response, next); expect(next).not.toHaveBeenCalled();
      request.emit(event); expect(next).toHaveBeenCalledTimes(1); expect(next.mock.calls[0]![0]).toMatchObject({ status: 400 });
      expect(Object.getOwnPropertyDescriptor(request, 'rawBody')).toBeUndefined();
      expect(events.map(name => request.listenerCount(name))).toEqual(before);
      request.emit('close'); request.emit('end');
      expect(next).toHaveBeenCalledTimes(1); expect(Object.getOwnPropertyDescriptor(request, 'rawBody')).toBeUndefined();
    } finally { request.destroy(); request.socket.destroy(); }
  });

  test.each(['?alias=1', '?', '/', '/child'])('POST route suffix %s never receives capture', async suffix => {
    const response = await send(f, PREFIX + 'generation-admissions' + suffix, Buffer.from('{}'));
    expect(response.status).toBeGreaterThanOrEqual(400); expect(f.observe).not.toHaveBeenCalled();
    expect(f.nativeRequests.every(request => !Object.getOwnPropertyDescriptor(request, 'rawBody'))).toBe(true);
  });

  test.each([JOB_ID.toUpperCase(), '00000000-0000-0000-0000-000000000000', JOB_ID + '?alias=1', JOB_ID + '/', '%31' + JOB_ID.slice(1)])('GET id/path alias %s receives no empty capture', async id => {
    const response = await send(f, `${PREFIX}generation-requests/${id}`, Buffer.alloc(0), { method: 'GET', unframed: true });
    expect(response.status).toBeGreaterThanOrEqual(400); expect(f.observe).not.toHaveBeenCalled();
    expect(f.nativeRequests.every(request => !Object.getOwnPropertyDescriptor(request, 'rawBody'))).toBe(true);
  });

  test('case aliases and absolute-form targets never become exact capture routes', async () => {
    for (const path of [(PREFIX + 'generation-requests').toUpperCase(), `http://127.0.0.1:${f.port}${PREFIX}generation-requests`]) {
      expect((await send(f, path, Buffer.from('{}'))).status).toBeGreaterThanOrEqual(400);
    }
    expect(f.observe).not.toHaveBeenCalled(); expect(f.nativeRequests.every(request => !Object.getOwnPropertyDescriptor(request, 'rawBody'))).toBe(true);
  });

  test.each(['generation-producer/admit', 'planner-applications'])('unregistered %s retains ordinary JSON parsing without capture', async path => {
    const response = await send(f, PREFIX + path, Buffer.from('{"value":"unchanged"}'));
    expect(response.status).toBe(201); expect(response.json).toMatchObject({ rawBodyPresent: false, parsedIsBuffer: false, value: 'unchanged' });
    expect(f.observe).not.toHaveBeenCalled();
  });

  test('unregistered Planner application GET remains outside zero-entity capture rules', async () => {
    const response = await send(f, `${PREFIX}planner-applications/${JOB_ID}`, Buffer.from('{"value":"ordinary GET JSON"}'), { method: 'GET' });
    expect(response.status).toBe(200); expect(response.json).toMatchObject({ rawBodyPresent: false, value: 'ordinary GET JSON' });
  });

  test('ordinary JSON, gzip and Nest URL-encoded forms retain existing behavior with no rawBody capture', async () => {
    const ordinary = await send(f, '/strategy-api/parser-probe/json', Buffer.from('{"value":"ordinary JSON"}'));
    expect(ordinary.status).toBe(201); expect(ordinary.json).toMatchObject({ rawBodyPresent: false, parsedIsBuffer: false, value: 'ordinary JSON' });
    const compressed = await send(f, '/strategy-api/parser-probe/json', gzipSync(Buffer.from('{"value":"ordinary gzip"}')), { encoding: 'gzip' });
    expect(compressed.status).toBe(201); expect(compressed.json).toMatchObject({ rawBodyPresent: false, value: 'ordinary gzip' });
    const form = await send(f, '/strategy-api/parser-probe/form', Buffer.from('value=ordinary+form&nested%5Bx%5D=yes'), { contentType: 'application/x-www-form-urlencoded' });
    expect(form.status).toBe(201); expect(form.json).toMatchObject({ rawBodyPresent: false, value: 'ordinary form', nested: { x: 'yes' } });
    expect(f.observe).not.toHaveBeenCalled();
  });

  test('ordinary JSON retains its existing 8 MiB ceiling independently of capture', async () => {
    const body = Buffer.from('{"payload":"' + 'x'.repeat(LIMIT - 14) + '"}');
    const accepted = await send(f, '/strategy-api/parser-probe/json', body);
    expect(accepted.status).toBe(201); expect(accepted.json).toMatchObject({ rawBodyPresent: false, payloadLength: LIMIT - 14 });
    const rejected = await send(f, '/strategy-api/parser-probe/json', Buffer.concat([body, Buffer.from(' ')]));
    expect(rejected.status).toBe(413); expect(f.observe).not.toHaveBeenCalled();
  }, 15000);

  test('actual producer controller/service remains authority-unavailable after successful POST capture and before Prisma I/O', async () => {
    const production = await fixture(true), response = await send(production, PREFIX + 'generation-admissions',
      Buffer.from(JSON.stringify({ schemaVersion: 1, generationJobId: JOB_ID })));
    expect(response.status).toBe(503); expect(response.json.code).toBe('AUTHORITY_UNAVAILABLE');
    expect(Buffer.isBuffer(Object.getOwnPropertyDescriptor(production.nativeRequests[0]!, 'rawBody')!.value)).toBe(true);
    expect(production.io).not.toHaveBeenCalled(); expect(production.observe).not.toHaveBeenCalled();
  }, 15000);
});
