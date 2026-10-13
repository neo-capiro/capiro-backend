import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { defaultNewsletterConfig, governmentAffairsNewsletter } from '@capiro/shared/newsletter';
import {
  NewsletterOutreachService,
  normalizeNewsletterDestinations,
  sanitizeNewsletterFragment,
} from './newsletter-outreach.service.js';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_owner',
  tenantSlug: 'fixture',
  role: 'standard_user',
} as TenantContext;
const stageId = '33333333-3333-4333-8333-333333333333';
const recordId = '44444444-4444-4444-8444-444444444444';
function harness() {
  const stage = {
    id: stageId,
    documentId: recordId,
    revision: 4,
    name: 'Weekly briefing',
    design: governmentAffairsNewsletter(),
    config: {
      ...defaultNewsletterConfig(),
      company: 'Example policy firm',
      mailingAddress: 'Illustrative office address',
    },
  };
  const row = {
    id: recordId,
    type: 'outbound_campaign',
    clientId: null,
    status: 'draft',
    metadata: { newsletterStageId: stageId },
    subject: 'Weekly briefing',
  };
  const tx = {
    $queryRaw: jest.fn(async (sql: TemplateStringsArray): Promise<unknown[]> =>
      sql.join(' ').includes('pg_try_advisory_xact_lock') ? [{ locked: true }] : [stage],
    ),
    outreachSendIntent: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    newsletterSubscription: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
    },
    newsletterRecipientAccess: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'access-1' }),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({
        id: 'access-1',
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        email: 'client@example.test',
        html: '<p>Private briefing</p>',
        draftVersionId: 'version-1',
      }),
    },
    outreachDelivery: { count: jest.fn().mockResolvedValue(0) },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant, fn) => fn(tx)),
    withSystem: jest.fn(async (fn) => fn(tx)),
  };
  const engagement = {
    getOutreachRecord: jest.fn().mockResolvedValue(row),
    findCampaignSendConnection: jest.fn().mockResolvedValue({ id: 'mailbox' }),
    updateOutreachRecord: jest.fn().mockResolvedValue(row),
  };
  const drafts = {
    importNewsletterVersion: jest.fn().mockResolvedValue({ id: 'version-1', sendable: true }),
    listForOutreach: jest.fn().mockResolvedValue([]),
  };
  const intents = { createIntent: jest.fn().mockResolvedValue({ intentId: 'intent-1' }) };
  const runtime = { assertExternalAction: jest.fn() };
  const service = new NewsletterOutreachService(
    prisma as never,
    engagement as never,
    drafts as never,
    intents as never,
    runtime as never,
  );
  const input = {
    recipients: [{ email: 'client@example.test', name: 'Avery Client' }],
    targets: [],
    senderConnectionId: 'mailbox',
    subject: 'Weekly briefing',
  };
  return { service, stage, row, tx, prisma, engagement, drafts, intents, runtime, input };
}
describe('Workspace newsletter Outreach handoff', () => {
  test('reads a stage with verified tenant and Clerk owner rather than browser content', async () => {
    const h = harness();
    await h.service.stage(ctx, stageId);
    const args = h.tx.$queryRaw.mock.calls[0]!;
    expect(args.slice(1)).toEqual([stageId, ctx.tenantId, ctx.clerkUserId]);
    expect(args[0].join('')).toContain('owner_id =');
    h.tx.$queryRaw.mockResolvedValue([]);
    await expect(h.service.stage(ctx, stageId)).rejects.toBeInstanceOf(NotFoundException);
  });
  test('rechecks the ethical wall before importing a client-scoped source', async () => {
    const h = harness();
    h.stage.config.clientId = recordId;
    h.tx.$queryRaw.mockResolvedValueOnce([h.stage]).mockResolvedValueOnce([{ allowed: false }]);
    await expect(h.service.prepare(ctx, recordId, h.input)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.drafts.importNewsletterVersion).not.toHaveBeenCalled();
  });
  test('personalizes authoritative saved content and records recipient capabilities', async () => {
    const h = harness();
    const result = await h.service.prepare(ctx, recordId, h.input);
    const imported = h.drafts.importNewsletterVersion.mock.calls[0]![1];
    expect(imported.newsletterStageId).toBe(stageId);
    expect(imported.recipientSnapshot.email).toBe('client@example.test');
    expect(imported.body).toContain('The week in policy.');
    expect(imported.body).toContain('/newsletter-public/');
    expect(imported.body).toContain('/unsubscribe');
    expect(imported.body).not.toMatch(/\*\|[^|]+\|\*/);
    expect(imported.body).toContain('capitol.png');
    expect(result.versions[0]?.recipientEmail).toBe('client@example.test');
    expect(h.intents.createIntent).not.toHaveBeenCalled();
  });
  test('excludes an unsubscribed destination before creating any delivery draft', async () => {
    const h = harness();
    h.tx.newsletterSubscription.findMany.mockResolvedValue([{ email: 'client@example.test' }]);
    const result = await h.service.prepare(ctx, recordId, h.input);
    expect(result).toEqual({ versions: [], excluded: ['client@example.test'] });
    expect(h.drafts.importNewsletterVersion).not.toHaveBeenCalled();
  });
  test('refuses concurrent preparation or sending before importing or queuing content', async () => {
    const h = harness();
    h.tx.$queryRaw.mockImplementation(async (sql: TemplateStringsArray) =>
      sql.join(' ').includes('pg_try_advisory_xact_lock') ? [{ locked: false }] : [h.stage],
    );
    await expect(h.service.prepare(ctx, recordId, h.input)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(
      h.service.send(ctx, recordId, {
        requestKey: 'request-1',
        senderConnectionId: 'mailbox',
        versionIds: ['version-1'],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.drafts.importNewsletterVersion).not.toHaveBeenCalled();
    expect(h.intents.createIntent).not.toHaveBeenCalled();
  });
  test('checks Cc and Bcc opt-outs when preparing the preview', async () => {
    const h = harness();
    await h.service.prepare(ctx, recordId, {
      ...h.input,
      recipients: [
        { email: 'client@example.test', cc: ['copy@example.test'], bcc: ['private@example.test'] },
      ],
    });
    expect(h.tx.newsletterSubscription.findMany.mock.calls[0]![0].where.email.in).toEqual([
      'client@example.test',
      'copy@example.test',
      'private@example.test',
    ]);
  });
  test('cannot send a stale or browser-chosen draft version', async () => {
    const h = harness();
    await expect(
      h.service.send(ctx, recordId, {
        requestKey: 'request-1',
        senderConnectionId: 'mailbox',
        versionIds: ['foreign-version'],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.intents.createIntent).not.toHaveBeenCalled();
  });
  test('requires the complete reviewed destination set and the same sending mailbox', async () => {
    const h = harness();
    Object.assign(h.row.metadata, {
      newsletterVersionIds: ['version-1', 'version-2'],
      newsletterSenderId: 'mailbox',
    });
    const send = {
      requestKey: 'request-1',
      senderConnectionId: 'mailbox',
      versionIds: ['version-1', 'version-2'],
    };
    await expect(
      h.service.send(ctx, recordId, { ...send, versionIds: ['version-1'] }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      h.service.send(ctx, recordId, { ...send, versionIds: ['version-1', 'version-1'] }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      h.service.send(ctx, recordId, { ...send, senderConnectionId: 'changed-mailbox' }),
    ).rejects.toThrow(/sending mailbox/);
    expect(h.intents.createIntent).not.toHaveBeenCalled();
    await h.service.send(ctx, recordId, send);
    expect(h.intents.createIntent).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        draftVersionIds: ['version-1', 'version-2'],
        senderConnectionId: 'mailbox',
        testMode: false,
      }),
    );
  });
  test('a test uses one current reviewed version and never sets the real send intent', async () => {
    const h = harness();
    Object.assign(h.row.metadata, {
      newsletterVersionIds: ['version-1', 'version-2'],
      newsletterSenderId: 'mailbox',
    });
    const send = {
      requestKey: 'test-request',
      senderConnectionId: 'mailbox',
      versionIds: ['version-1', 'version-2'],
    };
    await expect(h.service.send(ctx, recordId, send, true)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await h.service.send(ctx, recordId, { ...send, versionIds: ['version-2'] }, true);
    expect(h.intents.createIntent).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        draftVersionIds: ['version-2'],
        testMode: true,
        appendSignature: false,
      }),
    );
    expect(h.engagement.updateOutreachRecord).not.toHaveBeenCalled();
  });
  test('a lost send receipt can be recovered by the original request without creating deliveries', async () => {
    const h = harness();
    h.tx.outreachSendIntent.findFirst.mockResolvedValue({
      id: 'existing-test',
      outreachRecordId: recordId,
      senderConnectionId: 'mailbox',
      testMode: true,
      deliveries: [{ draftVersionId: 'version-1' }],
    });
    const send = {
      requestKey: 'original-request',
      senderConnectionId: 'mailbox',
      versionIds: ['version-1'],
    };
    expect(await h.service.send(ctx, recordId, send, true)).toEqual({
      intentId: 'existing-test',
      deduped: true,
    });
    expect(h.intents.createIntent).not.toHaveBeenCalled();
    await expect(
      h.service.send(ctx, recordId, { ...send, senderConnectionId: 'changed-mailbox' }, true),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  test('restores only current tests belonging to the campaign owner and reviewed mailbox', async () => {
    const h = harness();
    Object.assign(h.row.metadata, {
      newsletterVersionIds: ['version-1'],
      newsletterSenderId: 'mailbox',
      newsletterExcluded: ['former@example.test'],
    });
    h.drafts.listForOutreach.mockResolvedValue([{ current: { id: 'version-1' } }]);
    h.tx.newsletterRecipientAccess.findMany.mockResolvedValue([
      { draftVersionId: 'version-1', email: 'client@example.test' },
    ]);
    h.tx.outreachSendIntent.findMany.mockResolvedValue([
      {
        id: 'test-1',
        requestKey: 'original-request',
        senderConnectionId: 'mailbox',
        deliveries: [{ draftVersionId: 'version-1' }, { draftVersionId: 'stale-version' }],
      },
    ]);
    const result = await h.service.get(ctx, recordId);
    expect(h.tx.outreachSendIntent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          outreachRecordId: recordId,
          senderConnectionId: 'mailbox',
          testMode: true,
          deliveries: { some: { draftVersionId: { in: ['version-1'] } } },
        },
      }),
    );
    expect(result.tests).toEqual([
      {
        id: 'test-1',
        requestKey: 'original-request',
        senderConnectionId: 'mailbox',
        versionId: 'version-1',
      },
    ]);
    expect(result.excluded).toEqual(['former@example.test']);
    expect(result.versions[0]?.recipientEmail).toBe('client@example.test');
  });
  test('previewing never publishes a private recipient archive', async () => {
    const h = harness();
    await expect(h.service.publicArchive('a'.repeat(64))).rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.outreachDelivery.count.mock.calls[0]![0].where.sendIntent.testMode).toBe(false);
  });
  test('unsubscribe GET is read-only and the confirmed POST suppresses only that sender', async () => {
    const h = harness();
    h.tx.outreachDelivery.count.mockResolvedValue(1);
    await h.service.preferences('a'.repeat(64));
    expect(h.tx.newsletterSubscription.upsert).not.toHaveBeenCalled();
    await h.service.preferences('a'.repeat(64), true);
    expect(
      h.tx.newsletterSubscription.upsert.mock.calls[0]![0].where.tenantId_userId_email,
    ).toEqual({ tenantId: ctx.tenantId, userId: ctx.userId, email: 'client@example.test' });
  });
  test('invalid headers and incomplete firm details fail before draft import', async () => {
    const h = harness();
    await expect(
      h.service.prepare(ctx, recordId, {
        ...h.input,
        subject: 'Weekly\r\nBcc: another@example.test',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    h.stage.config.mailingAddress = '';
    await expect(h.service.prepare(ctx, recordId, h.input)).rejects.toThrow(/mailing address/);
    expect(h.drafts.importNewsletterVersion).not.toHaveBeenCalled();
  });
});
describe('newsletter destination and HTML boundaries', () => {
  test('normalizes addresses, rejects duplicates and shared recipient capabilities', () => {
    expect(
      normalizeNewsletterDestinations([
        { email: ' Avery@Example.test ', cc: ['Copy@example.test', 'copy@example.test'] },
      ])[0],
    ).toMatchObject({ email: 'avery@example.test', cc: ['copy@example.test'] });
    expect(() =>
      normalizeNewsletterDestinations([{ email: 'a@example.test' }, { email: 'A@example.test' }]),
    ).toThrow(/duplicate/);
    expect(() =>
      normalizeNewsletterDestinations([
        { email: 'a@example.test', groupMembers: [{ email: 'b@example.test' }] },
      ]),
    ).toThrow(/individual/);
  });
  test('scripts, event handlers, embedded pages and unsafe URLs cannot enter a delivered fragment', () => {
    const html = sanitizeNewsletterFragment(
      '<script>alert(1)</script><iframe src="https://evil.test"></iframe><img src="https://example.test/a.png" onerror="alert(1)"><a href="javascript:alert(1)">Read</a>',
    );
    expect(html).not.toMatch(/script|iframe|onerror|javascript/);
    expect(html).toContain('href="#"');
    expect(html).toContain('https://example.test/a.png');
  });
});
