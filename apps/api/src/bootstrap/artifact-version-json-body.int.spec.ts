import 'reflect-metadata';
import {
  Controller, Module, Post, Req, UseGuards,
  type CanActivate, type ExecutionContext, type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import request from 'supertest';
import { configureApiHttpApp } from './configure-api-http-app.js';

// Real Nest/Express parser boundary over loopback HTTP. This fixture has no
// AppModule, database or tenant session; its guard is not product authority.
const PATH = '/api/clio/artifacts/00000000-0000-4000-8000-000000000001/version';
const LIMIT = 3_100_000;
const ORIGIN = 'https://os.capiro.ai';
const IMPORT_PATH = '/api/research-portfolios/00000000-0000-4000-8000-000000000002/imports';
const IMPORT_LIMIT = 7_100_000;

class ParserProbeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return context.switchToHttp().getRequest<Request>().headers['x-parser-test-auth'] === 'allowed';
  }
}

function summary(req: Request) {
  return Buffer.isBuffer(req.body)
    ? { buffer: true, bodyHex: req.body.toString('hex') }
    : { buffer: false, textLength: req.body.bodyText.length, bodyText: req.body.bodyText };
}

@Controller()
class ParserProbeController {
  @Post('clio/artifacts/:id/version')
  @UseGuards(ParserProbeGuard)
  version(@Req() req: Request) { return summary(req); }

  @Post('research-portfolios/:id/imports')
  @UseGuards(ParserProbeGuard)
  upload(@Req() req: Request) {
    const decoded = Buffer.from(req.body.contentBase64, 'base64');
    return {
      base64Length: req.body.contentBase64.length,
      decodedBytes: decoded.length,
      decodedSha256: createHash('sha256').update(decoded).digest('hex'),
    };
  }

  @Post('parser-probe/json')
  ordinary(@Req() req: Request) { return summary(req); }

  @Post('webhooks/clerk') clerk(@Req() req: Request) { return summary(req); }
  @Post('webhooks/recall') recall(@Req() req: Request) { return summary(req); }
  @Post('webhooks/tango') tango(@Req() req: Request) { return summary(req); }
}

@Module({ controllers: [ParserProbeController] })
class ParserProbeModule {}

describe('canonical artifact-version and import JSON parsers', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Keep Nest's default body parser enabled, as in the real bootstrap.
    app = await NestFactory.create(ParserProbeModule, { logger: false });
    configureApiHttpApp(app, {
      includeClerkRawBody: true,
      includeRecallRawBody: true,
      includeTangoRawBody: true,
      includeEmailSignatureLargeBody: true,
      defaultJsonLimit: '1mb',
    });
    await app.init();
  }, 15_000);

  afterAll(async () => { if (app) await app.close(); });

  function post(body: string, path = PATH) {
    return request(app.getHttpServer()).post(path)
      .set('Content-Type', 'application/json')
      .set('Origin', ORIGIN)
      .set('x-parser-test-auth', 'allowed')
      .send(body);
  }

  it.each([
    ['CJK', '\u754c'.repeat(500_000), 1_500_015],
    ['escaped control characters', '\u0001'.repeat(500_000), 3_000_015],
  ])('accepts the writer limit with %s without changing the text', async (_label, text, bytes) => {
    const body = JSON.stringify({ bodyText: text });
    expect(Buffer.byteLength(body)).toBe(bytes);
    const res = await post(body);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ buffer: false, textLength: 500_000, bodyText: text });
  });

  it('accepts exactly 3,100,000 bytes and refuses the next byte', async () => {
    const body = JSON.stringify({ bodyText: 'small' });
    const atLimit = body + ' '.repeat(LIMIT - Buffer.byteLength(body));
    expect(Buffer.byteLength(atLimit)).toBe(LIMIT);
    expect((await post(atLimit)).status).toBe(201);
    const over = await post(atLimit + ' ');
    expect(over.status).toBe(413);
    expect(over.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it.each([
    '/api/parser-probe/json',
    `${PATH}/extra`,
    `${PATH}/`,
    PATH.replace('/version', '/versions'),
    PATH.replace('/artifacts/', '/artifacts/extra/'),
  ])('keeps the 1 MiB default for %s', async (path) => {
    const res = await post(JSON.stringify({ bodyText: 'x'.repeat(1024 * 1024) }), path);
    expect(res.status).toBe(413);
  });

  it('keeps the default byte boundary on an ordinary route', async () => {
    const body = JSON.stringify({ bodyText: 'small' });
    const atLimit = body + ' '.repeat(1024 * 1024 - Buffer.byteLength(body));
    expect((await post(atLimit, '/api/parser-probe/json')).status).toBe(201);
    expect((await post(atLimit + ' ', '/api/parser-probe/json')).status).toBe(413);
  });

  it('does not widen another method on the same path', async () => {
    const res = await request(app.getHttpServer()).put(PATH)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ bodyText: 'x'.repeat(1024 * 1024) }));
    expect(res.status).toBe(413);
  });

  it('still reaches route guards after parsing a valid large body', async () => {
    const res = await request(app.getHttpServer()).post(PATH)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ bodyText: '\u754c'.repeat(500_000) }));
    expect(res.status).toBe(403);
  });

  it('keeps malformed JSON rejected', async () => {
    expect((await post('{"bodyText":')).status).toBe(400);
  });

  it('accepts a 5 MiB CSV base64 envelope without changing its bytes', async () => {
    const header = Buffer.from('subject_id,label\nsubject-1,');
    const csv = Buffer.concat([
      header, Buffer.alloc(5 * 1024 * 1024 - header.length - 1, 'a'), Buffer.from('\n'),
    ]);
    const contentBase64 = csv.toString('base64');
    expect(contentBase64.length).toBe(6_990_508);
    const body = JSON.stringify({
      contentBase64, fileName: 'synthetic.csv', mediaType: 'text/csv',
      worksheetKind: 'membership', schemaVersion: 1, expectedRevision: 1,
      operationKey: 'synthetic-parser-only',
    });
    expect(Buffer.byteLength(body)).toBeLessThan(IMPORT_LIMIT);
    const res = await post(body, IMPORT_PATH);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      base64Length: 6_990_508, decodedBytes: 5 * 1024 * 1024,
      decodedSha256: createHash('sha256').update(csv).digest('hex'),
    });
  });

  it('accepts exactly 7,100,000 import JSON bytes and refuses the next byte', async () => {
    const body = JSON.stringify({ contentBase64: Buffer.from('header\nrow\n').toString('base64') });
    const atLimit = body + ' '.repeat(IMPORT_LIMIT - Buffer.byteLength(body));
    expect(Buffer.byteLength(atLimit)).toBe(IMPORT_LIMIT);
    expect((await post(atLimit, IMPORT_PATH)).status).toBe(201);
    const over = await post(atLimit + ' ', IMPORT_PATH);
    expect(over.status).toBe(413);
    expect(over.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it.each([
    `${IMPORT_PATH}/`, `${IMPORT_PATH}/job/apply`, `${IMPORT_PATH}/extra`,
    IMPORT_PATH.replace('/imports', '/import'),
    IMPORT_PATH.replace('/imports', '/members'),
  ])('keeps the 1 MiB default for import neighbor %s', async (path) => {
    expect((await post(JSON.stringify({ contentBase64: 'A'.repeat(1024 * 1024) }), path)).status).toBe(413);
  });

  it('does not widen another method or skip the upload route guard', async () => {
    const body = JSON.stringify({ contentBase64: 'A'.repeat(1024 * 1024) });
    const wrongMethod = await request(app.getHttpServer()).put(IMPORT_PATH)
      .set('Content-Type', 'application/json').send(body);
    expect(wrongMethod.status).toBe(413);
    const refused = await request(app.getHttpServer()).post(IMPORT_PATH)
      .set('Content-Type', 'application/json').send(body);
    expect(refused.status).toBe(403);
  });

  it.each(['clerk', 'recall', 'tango'])('preserves exact raw %s webhook bytes and their 1 MiB bound', async (receiver) => {
    const body = '{ "bodyText" : "raw\\u0001" }\n';
    const res = await post(body, `/webhooks/${receiver}`);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ buffer: true, bodyHex: Buffer.from(body).toString('hex') });
    expect((await post(' '.repeat(1024 * 1024 + 1), `/webhooks/${receiver}`)).status).toBe(413);
  });
});
