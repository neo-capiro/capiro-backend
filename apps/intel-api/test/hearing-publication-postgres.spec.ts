import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  SmsVerificationService,
  HEARING_SMS_CONSENT_VERSION,
} from '../src/tracker/sms/sms-verification.service.js';
import { SmsService } from '../src/tracker/sms/sms.service.js';
import { FolderSourceDataRepository } from '../src/sourcedata/folder-source-data.repository.js';
import { SourceDataRepository } from '../src/sourcedata/source-data.repository.js';
import { FolderTrackerService } from '../src/tracker/folders/folder-tracker.service.js';
import { ReportService } from '../src/tracker/reports/report.service.js';
import { ReportRecipientsService } from '../src/tracker/reports/recipients.service.js';
import { ReportDeliveryService } from '../src/tracker/reports/report-delivery.service.js';
import { HearingPublicationService } from '../src/hearing/hearing-publication.service.js';
import { HearingCryptoService } from '../src/hearing/hearing-crypto.service.js';
import { HearingSessionService } from '../src/hearing/hearing-session.service.js';

if (
  process.env.LEGIWATCH_RECORDING_TEST_DATABASE !== 'disposable' ||
  !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
)
  throw Error('Local disposable PostgreSQL required');

describe('hearing publications and SMS on PostgreSQL', () => {
  jest.setTimeout(30000);
  const p = new PrismaService({ transactionOptions: { maxWait: 10000, timeout: 10000 } });
  const tenantId = randomUUID(),
    clientId = randomUUID(),
    otherClient = randomUUID(),
    userId = randomUUID(),
    actor = 'p4_' + randomUUID();
  const ctx = { tenantId, clerkUserId: actor, role: 'org:admin' },
    phone = '+14155551234';
  const flags = { isEnabled: jest.fn(async () => true) };
  const folders = new FolderTrackerService(
    p,
    new FolderSourceDataRepository(p),
    new SourceDataRepository(p),
  );
  const reports = new ReportService(folders, flags as any),
    recipients = new ReportRecipientsService(reports);
  const crypto = new HearingCryptoService(
    new ConfigService({ HEARING_ENCRYPTION_KEY: '1'.repeat(64) }),
  );
  const publications = new HearingPublicationService(
    reports,
    recipients,
    new HearingSessionService(p),
    crypto,
  );
  const sendSms = jest.fn(async (_phone: string, _body: string) => ({
    sent: true,
    dormant: false,
    providerMessageId: 'synthetic-sns',
  }));
  const sms = { send: sendSms } as unknown as SmsService,
    verify = new SmsVerificationService(p, sms);
  const sendEmail = jest.fn(async () => ({ outcome: 'accepted', messageId: 'synthetic-ses' }));
  const delivery = new ReportDeliveryService(
    reports,
    recipients,
    { sendReport: sendEmail } as any,
    publications,
    sms,
  );
  let sessionId: string, segmentId: string, contactId: string;
  const environment = new Map<string, string | undefined>();
  let runtimeBefore: { enabled: boolean; schedule_enabled: boolean } | undefined;
  beforeAll(async () => {
    runtimeBefore = (
      await p.$queryRaw<
        Array<{ enabled: boolean; schedule_enabled: boolean }>
      >`SELECT enabled,schedule_enabled FROM legiwatch_runtime_heartbeat WHERE job_key='hearing-delivery-worker'`
    )[0];
    await p.$executeRaw`UPDATE legiwatch_runtime_heartbeat SET enabled=true,schedule_enabled=true WHERE job_key='hearing-delivery-worker'`;
    for (const key of [
      'LEGIWATCH_HEARING_EMAIL_ENABLED',
      'LEGIWATCH_HEARING_SMS_ENABLED',
      'HEARING_SMS_READINESS_APPROVED',
    ]) {
      environment.set(key, process.env[key]);
      process.env[key] = 'true';
    }
    await p.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenantId}::uuid,${'p4-' + tenantId},'Synthetic hearing fixture')`;
    await p.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${userId}::uuid,${actor},${actor + '@example.invalid'})`;
    await p.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenantId}::uuid,${userId}::uuid,'standard_user','active')`;
    for (const id of [clientId, otherClient])
      await p.$executeRaw`INSERT INTO clients(id,tenant_id,name) VALUES(${id}::uuid,${tenantId}::uuid,'Synthetic client')`;
    const session = await p.liveHearingSession.create({
      data: {
        tenantId,
        createdBy: actor,
        clientId,
        title: 'Owned hearing',
        sourceType: 'meeting',
        audioSource: 'browser_mic',
        sourceUrl: 'https://owned.example/' + tenantId,
        recordingPolicy: 'transcript_only',
        status: 'ended',
        consentStatus: 'confirmed',
        issueIds: [],
        billIds: [],
        programElementIds: [],
        agencyIds: [],
      },
    });
    sessionId = session.id;
    segmentId = (
      await p.transcriptSegment.create({
        data: {
          tenantId,
          sessionId,
          startMs: 1000,
          endMs: 5000,
          textPlain: 'A speaker recommended bridge inspections.',
          isFinal: true,
        },
      })
    ).id;
    await p.hearingMediaPermission.create({
      data: {
        tenantId,
        sourceUrl: session.sourceUrl!,
        mode: 'browser',
        operations: ['analysis', 'distribution'],
        evidence: 'Synthetic owned fixture only',
        reviewedBy: actor,
        retentionDays: 1,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    contactId = (
      await p.legiWatchReportContact.create({
        data: {
          tenantId,
          ownerClerkId: actor,
          name: 'Synthetic recipient',
          email: 'synthetic@example.invalid',
          verified: true,
        },
      })
    ).id;
  });
  beforeEach(async () => {
    sendSms.mockClear();
    sendEmail.mockClear();
    await p.hearingSmsConsent.deleteMany({ where: { tenantId } });
    await p.intelSmsVerification.deleteMany({ where: { tenantId } });
  });
  afterAll(async () => {
    if (runtimeBefore)
      await p.$executeRaw`UPDATE legiwatch_runtime_heartbeat SET enabled=${runtimeBefore.enabled},schedule_enabled=${runtimeBefore.schedule_enabled} WHERE job_key='hearing-delivery-worker'`;
    await p.legiWatchDeliveryRecipient.deleteMany({ where: { tenantId } });
    await p.legiWatchDelivery.deleteMany({ where: { tenantId } });
    await p.hearingSmsConsent.deleteMany({ where: { tenantId } });
    await p.intelSmsVerification.deleteMany({ where: { tenantId } });
    await p.hearingPublication.deleteMany({ where: { tenantId } });
    await p.legiWatchReportContact.deleteMany({ where: { tenantId } });
    await p.hearingMediaPermission.deleteMany({ where: { tenantId } });
    await p.liveHearingSession.deleteMany({ where: { tenantId } });
    await p.$executeRaw`DELETE FROM tenants WHERE id=${tenantId}::uuid`;
    await p.$executeRaw`DELETE FROM users WHERE id=${userId}::uuid`;
    for (const [key, value] of environment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await p.$disconnect();
  });
  function lastCode() {
    return sendSms.mock.calls.at(-1)![1].match(/code is (\d{6})/)![1]!;
  }
  async function consent() {
    await verify.startVerification(
      tenantId,
      actor,
      clientId,
      phone,
      'hearing_updates',
      HEARING_SMS_CONSENT_VERSION,
      contactId,
    );
    await verify.confirmVerification(
      tenantId,
      actor,
      phone,
      lastCode(),
      clientId,
      'hearing_updates',
    );
    return p.hearingSmsConsent.findFirstOrThrow({ where: { tenantId } });
  }
  async function approved() {
    const publication = await publications.create(ctx, sessionId, {
      kind: 'live_update',
      title: 'Bridge testimony',
      clientId,
      evidenceIds: [segmentId],
      claims: [
        {
          id: 'claim-1',
          kind: 'quote',
          text: 'A speaker recommended bridge inspections.',
          evidenceIds: [segmentId],
        },
      ],
    });
    await publications.approve(ctx, sessionId, publication.id, {
      contentHash: publication.contentHash,
      attestSupported: true,
    });
    return publication;
  }
  it('checks client ownership before invoking the provider and never returns an undelivered OTP', async () => {
    await expect(verify.startVerification(tenantId, actor, randomUUID(), phone)).rejects.toThrow(
      'Client not found',
    );
    expect(sendSms).not.toHaveBeenCalled();
    sendSms.mockResolvedValueOnce({ sent: false, dormant: true, providerMessageId: '' });
    const result = await verify.startVerification(tenantId, actor, clientId, phone);
    expect(result.devCode).toBeUndefined();
    await expect(
      verify.confirmVerification(tenantId, actor, phone, lastCode(), clientId),
    ).rejects.toThrow('unavailable');
  });
  it('binds the code to its client and purpose and consumes it once under concurrent requests', async () => {
    await verify.startVerification(tenantId, actor, clientId, phone);
    const code = lastCode();
    await expect(
      verify.confirmVerification(tenantId, actor, phone, code, otherClient),
    ).rejects.toThrow();
    await expect(
      verify.confirmVerification(tenantId, actor, phone, code, clientId, 'hearing_updates'),
    ).rejects.toThrow();
    const results = await Promise.allSettled([
      verify.confirmVerification(tenantId, actor, phone, code, clientId),
      verify.confirmVerification(tenantId, actor, phone, code, clientId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await p.hearingSmsConsent.count({ where: { tenantId } })).toBe(0);
  });
  it('commits concurrent failed attempts and prevents brute-force continuation', async () => {
    await verify.startVerification(tenantId, actor, clientId, phone);
    const code = lastCode(),
      wrong = code === '000000' ? '111111' : '000000';
    await Promise.allSettled(
      Array.from({ length: 7 }, () =>
        verify.confirmVerification(tenantId, actor, phone, wrong, clientId),
      ),
    );
    expect((await p.intelSmsVerification.findFirstOrThrow({ where: { tenantId } })).attempts).toBe(
      5,
    );
    await expect(
      verify.confirmVerification(tenantId, actor, phone, code, clientId),
    ).rejects.toThrow();
  });
  it('requires a purpose-specific consent statement and directory identity', async () => {
    await expect(
      verify.startVerification(tenantId, actor, clientId, phone, 'hearing_updates'),
    ).rejects.toThrow('consent');
    const row = await consent();
    expect(row).toMatchObject({
      clientId,
      userId: actor,
      contactId,
      consentVersion: HEARING_SMS_CONSENT_VERSION,
      revokedAt: null,
    });
    expect(
      (await p.legiWatchReportContact.findFirstOrThrow({ where: { tenantId, id: contactId } }))
        .phone,
    ).toBe(phone);
  });
  it('requires persisted final evidence and exact approval; approved payloads cannot be edited', async () => {
    const row = await approved();
    await expect(
      publications.approve(ctx, sessionId, row.id, { contentHash: 'wrong', attestSupported: true }),
    ).rejects.toThrow('EXACT_CONTENT');
    await expect(
      p.hearingPublication.update({ where: { id: row.id }, data: { contentHash: '0'.repeat(64) } }),
    ).rejects.toThrow('immutable');
    await expect(
      publications.create(ctx, sessionId, {
        kind: 'live_update',
        title: 'Invented',
        evidenceIds: [segmentId],
        claims: [{ id: '1', kind: 'quote', text: 'The bill passed.', evidenceIds: [segmentId] }],
      }),
    ).rejects.toThrow('QUOTE_MUST_MATCH');
    await expect(
      publications.list({ ...ctx, clerkUserId: 'another-user' }, sessionId, 'live_update'),
    ).rejects.toThrow();
  });
  it('freezes SMS review, deduplicates enqueue, and dispatches through the leased delivery worker once', async () => {
    const destination = await consent(),
      row = await approved();
    const selection = { channel: 'sms', consentIds: [destination.id] };
    const preview = await publications.previewDelivery(ctx, sessionId, row.id, selection);
    expect(preview.composition.smsSize?.segments).toBe(1);
    await expect(
      publications.enqueue(ctx, sessionId, row.id, { ...selection, approvalHash: 'wrong' }),
    ).rejects.toThrow('REVIEW_AGAIN');
    const request = { ...selection, approvalHash: preview.approvalHash };
    const first = await publications.enqueue(ctx, sessionId, row.id, request),
      second = await publications.enqueue(ctx, sessionId, row.id, request);
    expect(second.id).toBe(first.id);
    sendSms.mockClear();
    await Promise.all([
      delivery.drain(tenantId, 25, new Date(), 'live_update'),
      delivery.drain(tenantId, 25, new Date(), 'live_update'),
    ]);
    expect(
      await p.legiWatchDeliveryRecipient.findFirstOrThrow({
        where: { tenantId, deliveryId: first.id },
        select: { state: true, error: true },
      }),
    ).toMatchObject({ state: 'provider_accepted', error: null });
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendSms.mock.calls[0]![1]).toBe(preview.composition.smsText);
    expect(
      (
        await p.legiWatchDeliveryRecipient.findFirstOrThrow({
          where: { tenantId, deliveryId: first.id },
        })
      ).state,
    ).toBe('provider_accepted');
  });
  it('holds a queued SMS when consent is revoked before dispatch', async () => {
    const destination = await consent(),
      row = await approved(),
      selection = { channel: 'sms', consentIds: [destination.id] };
    const preview = await publications.previewDelivery(ctx, sessionId, row.id, selection);
    const queued = await publications.enqueue(ctx, sessionId, row.id, {
      ...selection,
      approvalHash: preview.approvalHash,
    });
    await p.hearingSmsConsent.update({
      where: { id: destination.id },
      data: { revokedAt: new Date() },
    });
    sendSms.mockClear();
    await delivery.drain(tenantId, 25, new Date(), 'live_update');
    expect(sendSms).not.toHaveBeenCalled();
    expect(
      (
        await p.legiWatchDeliveryRecipient.findFirstOrThrow({
          where: { tenantId, deliveryId: queued.id },
        })
      ).state,
    ).toBe('held');
  });
});
