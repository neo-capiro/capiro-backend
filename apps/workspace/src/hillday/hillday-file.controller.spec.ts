import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HillDayExportService } from './hillday-export.service.js';
import { HillDayFileController } from './hillday-file.controller.js';

/**
 * The signed-URL file route must stream the stored PDF bytes as
 * application/pdf with a Content-Disposition — not a JSON-serialised body.
 * (Seen live 2026-09-02: the response came back as a JSON string.)
 */
describe('HillDayFileController', () => {
  let app: INestApplication;
  const pdf = Buffer.from('%PDF-1.3\n%\xe2\xe3\xcf\xd3\nfake body', 'latin1');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HillDayFileController],
      providers: [
        {
          provide: HillDayExportService,
          useValue: {
            file: async () => ({ buffer: pdf, filename: 'Kela-Hill-Day.pdf' }),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the PDF bytes inline with the right headers', async () => {
    const res = await request(app.getHttpServer())
      .get('/hillday/files/doc-1/exp-1?exp=1&sig=abc')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline; filename="Kela-Hill-Day.pdf"');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect((res.body as Buffer).equals(pdf)).toBe(true);
  });

  it('switches to attachment when download=1', async () => {
    const res = await request(app.getHttpServer()).get('/hillday/files/doc-1/exp-1?exp=1&sig=abc&download=1');
    expect(res.headers['content-disposition']).toBe('attachment; filename="Kela-Hill-Day.pdf"');
  });
});
