import type { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma-client/index.js';
import { SESv2Client } from '@aws-sdk/client-sesv2';

jest.mock('@aws-sdk/client-sesv2', () => ({
  ...jest.requireActual('@aws-sdk/client-sesv2'),
  SESv2Client: jest.fn().mockImplementation(() => ({ send: jest.fn(), destroy: jest.fn() })),
}));

function makeService(): EmailService {
  const prisma = {} as unknown as PrismaService;
  const config = {
    get: (key: string) => (key === 'ONBOARD_EMAIL_FROM' ? 'onboarding@capiro.ai' : undefined),
  } as unknown as ConfigService;
  return new EmailService(prisma, config);
}

describe('EmailService.buildRawMime', () => {
  it('assembles multipart/mixed with an attachment and RFC-2047 subject', () => {
    const svc = makeService();
    // buildRawMime is private — exercised directly for the attachment path.
    const raw: Buffer = (
      svc as unknown as { buildRawMime: (o: unknown) => Buffer }
    ).buildRawMime({
      to: 'jane@firm.example',
      kind: 'signed_terms',
      dedupeKey: 'k',
      subject: 'Your signed agreements — café ☕',
      html: '<p>hi</p>',
      text: 'hi',
      attachments: [
        {
          filename: 'Capiro-Terms-of-Service-signed.pdf',
          content: Buffer.from('%PDF-1.7 test'),
          contentType: 'application/pdf',
        },
      ],
    });
    const s = raw.toString('utf8');
    expect(s).toContain('From: onboarding@capiro.ai');
    expect(s).toContain('To: jane@firm.example');
    expect(s).toContain('Content-Type: multipart/mixed; boundary="mixed_');
    expect(s).toContain('Content-Type: multipart/alternative; boundary="alt_');
    expect(s).toContain('Content-Type: application/pdf; name="Capiro-Terms-of-Service-signed.pdf"');
    expect(s).toContain(
      'Content-Disposition: attachment; filename="Capiro-Terms-of-Service-signed.pdf"',
    );
    expect(s).toMatch(/Subject: =\?UTF-8\?B\?/); // non-ASCII subject encoded
    expect(s).toContain(Buffer.from('%PDF-1.7 test').toString('base64'));
  });
});

const message = {
  to: 'recipient@example.test', kind: 'receipt', dedupeKey: 'synthetic-receipt',
  subject: 'Receipt', html: '<p>Receipt</p>', text: 'Receipt',
};
function deliveryFixture(enabled = true) {
  const rows = new Map<string, any>();
  let failFinish = false;
  const log = {
    create: jest.fn(async ({ data }) => {
      if (rows.has(data.dedupeKey)) throw new Prisma.PrismaClientKnownRequestError(
        'Unique claim', { code: 'P2002', clientVersion: '5.22.0' },
      );
      const row = { id: 'claim', sentAt: new Date(), ...data };
      rows.set(data.dedupeKey, row);
      return row;
    }),
    findUniqueOrThrow: jest.fn(async ({ where }) => {
      const row = rows.get(where.dedupeKey);
      if (!row) throw new Error('Missing claim');
      return { ...row };
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      if (failFinish) throw new Error('Receipt write unavailable');
      const row = [...rows.values()].find(r => Object.entries(where).every(([key, value]) => r[key] === value));
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
  };
  const make = (active: boolean) => {
    const service = new EmailService({ onboardEmailLog: log } as never, {
      get: (key: string) => key === 'ONBOARD_EMAIL_ENABLED' ? String(active) :
        key === 'ONBOARD_EMAIL_FROM' ? 'sender@example.test' : undefined,
    } as never);
    const client = (service as any).ses;
    const send = jest.spyOn(client, 'send').mockImplementation(async () => {
      expect(rows.get(message.dedupeKey)?.status).toBe('sending');
      return { MessageId: 'synthetic-acceptance' };
    });
    return { service, send, client };
  };
  return { ...make(enabled), make, rows, log, failFinish: () => { failFinish = true; } };
}

describe('EmailService durable delivery claim', () => {
  it('commits one claim before two simultaneous callers can attempt SES', async () => {
    const f = deliveryFixture();
    const results = await Promise.all([f.service.send(message), f.service.send(message)]);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(results.filter(result => result.sent)).toHaveLength(1);
    expect(results.filter(result => result.skipped)).toHaveLength(1);
    expect(f.rows.get(message.dedupeKey)).toMatchObject({ status: 'sent', sesMessageId: 'synthetic-acceptance' });
    expect(SESv2Client).toHaveBeenLastCalledWith(expect.objectContaining({ maxAttempts: 1 }));
    f.service.onModuleDestroy();
  });
  it('never retries after SES acceptance followed by a receipt write failure', async () => {
    const f = deliveryFixture();
    f.failFinish();
    await expect(f.service.send(message)).rejects.toThrow('Receipt write unavailable');
    await expect(f.service.send(message)).resolves.toMatchObject({ sent: false, skipped: true, status: 'sending' });
    expect(f.send).toHaveBeenCalledTimes(1);
    f.service.onModuleDestroy();
  });
  it.each([
    [{ name: 'TimeoutError' }, 'outcome_unknown'],
    [{ $metadata: { httpStatusCode: 503 } }, 'outcome_unknown'],
    [{ $metadata: { httpStatusCode: 408 } }, 'outcome_unknown'],
    [{ $metadata: { httpStatusCode: 400 } }, 'failed'],
  ])('keeps provider failure terminal and bounded: %j', async (failure, status) => {
    const f = deliveryFixture();
    f.send.mockRejectedValue(failure);
    await expect(f.service.send(message)).resolves.toMatchObject({ sent: false, skipped: false, status });
    await expect(f.service.send(message)).resolves.toMatchObject({ sent: false, skipped: true, status });
    expect(f.send).toHaveBeenCalledTimes(1);
    f.service.onModuleDestroy();
  });
  it('records a missing provider message ID as unknown, never sent', async () => {
    const f = deliveryFixture();
    f.send.mockResolvedValue({});
    await expect(f.service.send(message)).resolves.toMatchObject({ sent: false, status: 'outcome_unknown', sesMessageId: null });
    await f.service.send(message);
    expect(f.send).toHaveBeenCalledTimes(1);
    f.service.onModuleDestroy();
  });
  it('retains a disabled receipt when the same request is later enabled', async () => {
    const f = deliveryFixture(false);
    await expect(f.service.send(message)).resolves.toMatchObject({ sent: false, status: 'disabled', sesMessageId: null });
    const later = f.make(true);
    await expect(later.service.send(message)).resolves.toMatchObject({ sent: false, skipped: true, status: 'disabled' });
    expect(f.send).not.toHaveBeenCalled();
    expect(later.send).not.toHaveBeenCalled();
    f.service.onModuleDestroy(); later.service.onModuleDestroy();
  });
  it('rejects changed recipients or content under an existing request identity', async () => {
    const f = deliveryFixture();
    await f.service.send(message);
    await expect(f.service.send({ ...message, to: 'other@example.test' })).rejects.toThrow('different inputs');
    await expect(f.service.send({ ...message, text: 'Different content' })).rejects.toThrow('different inputs');
    expect(f.send).toHaveBeenCalledTimes(1);
    f.service.onModuleDestroy();
  });
  it('turns a stale interrupted claim into unknown without another provider attempt', async () => {
    const f = deliveryFixture();
    await f.service.send(message);
    Object.assign(f.rows.get(message.dedupeKey), { status: 'sending', sesMessageId: null, sentAt: new Date(0) });
    await expect(f.service.send(message)).resolves.toMatchObject({ sent: false, skipped: true, status: 'outcome_unknown' });
    expect(f.rows.get(message.dedupeKey).status).toBe('outcome_unknown');
    expect(f.send).toHaveBeenCalledTimes(1);
    f.service.onModuleDestroy();
  });
});
