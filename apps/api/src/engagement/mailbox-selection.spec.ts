import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';
import { EngagementMailSender } from './mail-sender.service.js';
import { AmbiguousMailSendError } from './mail-send-result.js';
import { ownedSendingMailboxWhere, sendingMailboxSelect } from './mailbox-selection.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'synthetic',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'synthetic-actor',
  role: 'standard_user',
};
const A = '33333333-3333-4333-8333-333333333333';
const B = '44444444-4444-4444-8444-444444444444';
const input = {
  to: [{ email: 'recipient@example.test' }],
  subject: 'Synthetic only',
  bodyHtml: '<p>Hello</p>',
};
const connection = (
  id = B,
  provider: 'google_workspace' | 'microsoft_365' = 'google_workspace',
) => ({
  id,
  provider,
  accountEmail: id === A ? 'mailbox-a@example.test' : 'mailbox-b@example.test',
  displayName: 'Selected mailbox',
});
function harness(provider: 'google_workspace' | 'microsoft_365' = 'google_workspace') {
  const tx = {
    integrationConnection: {
      findFirst: jest
        .fn()
        .mockImplementation(async ({ where }) => connection(where.id ?? B, provider)),
      findMany: jest.fn().mockResolvedValue([connection(A), connection(B)]),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        email: 'actor-profile@example.test',
        firstName: 'Actor',
        emailSignatureEnabled: true,
        emailSignatureHtml: '<p>Actor signature</p><script>bad()</script>',
      }),
    },
    mailThread: {
      findFirst: jest.fn().mockResolvedValue({ id: 'thread-a', connectionId: A }),
      update: jest.fn().mockResolvedValue({ id: 'thread-a', connectionId: A }),
      upsert: jest.fn().mockResolvedValue({ id: 'thread-b', connectionId: B }),
    },
    mailMessage: {
      upsert: jest.fn().mockImplementation(async ({ create }) => ({ ...create, id: 'message-b' })),
    },
    engagementAttachment: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
  };
  const google = {
    sendMail: jest.fn().mockResolvedValue({
      ok: true,
      provider: 'gmail',
      providerMessageId: 'gmail-b',
      providerThreadId: 'gmail-thread-b',
      correlationId: '',
    }),
  };
  const microsoft = {
    sendMail: jest.fn().mockResolvedValue({
      ok: true,
      provider: 'microsoft_graph',
      providerConversationId: 'graph-thread-b',
      correlationId: '',
    }),
  };
  const runtime = { assertExternalAction: jest.fn() };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  Object.assign(service, {
    prisma: {
      withTenant: jest.fn(async (tenant: string, fn: (tx: unknown) => unknown) => {
        expect(tenant).toBe(ctx.tenantId);
        return fn(tx);
      }),
    },
    mailSender: new EngagementMailSender(microsoft as never, google as never, runtime as never),
    readAttachmentBytes: jest.fn(),
  });
  return { service, tx, google, microsoft, runtime };
}

// Real resolver, sanitizer, service and provider dispatcher; only persistence and
// remote provider adapters are synthetic. No OAuth, network or database sessions.
describe('exact single-mail selection', () => {
  it.each(['google_workspace', 'microsoft_365'] as const)(
    'dispatches mailbox B via %s and persists B in From, provenance and receipt',
    async (provider) => {
      const h = harness(provider);
      const receipt = await h.service.sendSingleMail(ctx, { ...input, senderConnectionId: B });
      const selected = provider === 'google_workspace' ? h.google : h.microsoft;
      const other = provider === 'google_workspace' ? h.microsoft : h.google;
      expect(selected.sendMail).toHaveBeenCalledWith(
        ctx,
        B,
        expect.objectContaining({ runtimeAction: 'outreach_send' }),
      );
      expect(other.sendMail).not.toHaveBeenCalled();
      expect(h.runtime.assertExternalAction).toHaveBeenCalledWith('outreach_send', {
        testMode: false,
      });
      const body = selected.sendMail.mock.calls[0]![2].body;
      expect(body).toContain('Actor signature');
      expect(body).not.toContain('<script>');
      expect(h.tx.integrationConnection.findFirst).toHaveBeenCalledWith({
        where: { ...ownedSendingMailboxWhere(ctx), id: B },
        select: sendingMailboxSelect,
      });
      expect(h.tx.mailMessage.upsert.mock.calls[0]![0].create).toMatchObject({
        connectionId: B,
        fromEmail: 'mailbox-b@example.test',
        fromName: 'Selected mailbox',
        metadata: { senderConnectionId: B, signaturePolicy: 'actor', signatureAppended: true },
      });
      expect(h.tx.mailMessage.upsert.mock.calls[0]![0].update).toEqual({});
      expect(h.tx.mailThread.upsert.mock.calls[0]![0].create).toMatchObject({
        connectionId: B,
        participants: expect.arrayContaining([
          { email: 'mailbox-b@example.test', name: 'Selected mailbox', role: 'from' },
        ]),
      });
      expect(receipt).toMatchObject({
        ok: true,
        senderConnectionId: B,
        senderEmail: 'mailbox-b@example.test',
        signaturePolicy: 'actor',
        signatureAppended: true,
      });
    },
  );

  it.each([
    ['disconnected', { status: 'disconnected' }],
    ['foreign actor', { createdByUserId: 'another-actor' }],
    ['foreign tenant', { tenantId: 'another-tenant' }],
    ['tokenless', { token: null }],
    ['unsupported provider', { provider: 'imap_caldav' }],
  ])('refuses %s B without selecting A', async (_label, override) => {
    const h = harness();
    const row = {
      ...connection(),
      tenantId: ctx.tenantId,
      createdByUserId: ctx.userId,
      status: 'connected',
      token: {},
      ...(override as object),
    };
    // Model these Prisma predicates against a distinct invalid synthetic row.
    // This is query-shape qualification, not an actual Prisma/RLS execution.
    h.tx.integrationConnection.findFirst.mockImplementation(async ({ where }) =>
      row.id === where.id &&
      row.tenantId === where.tenantId &&
      row.createdByUserId === where.createdByUserId &&
      row.status === where.status &&
      (where.token?.isNot !== null || row.token !== null) &&
      where.provider.in.includes(row.provider)
        ? row
        : null,
    );
    await expect(
      h.service.sendSingleMail(ctx, { ...input, senderConnectionId: B }),
    ).rejects.toThrow('selected sending mailbox');
    expect(h.tx.integrationConnection.findFirst).toHaveBeenCalledTimes(1);
    expect(h.tx.integrationConnection.findFirst.mock.calls[0]![0].where).toEqual({
      id: B,
      tenantId: ctx.tenantId,
      createdByUserId: ctx.userId,
      status: 'connected',
      token: { isNot: null },
      provider: { in: ['microsoft_365', 'google_workspace'] },
    });
    expect(h.google.sendMail).not.toHaveBeenCalled();
    expect(h.microsoft.sendMail).not.toHaveBeenCalled();
    expect(h.tx.mailMessage.upsert).not.toHaveBeenCalled();
  });

  it('retains most-recent selection for a legacy new message without an ID', async () => {
    const h = harness();
    await expect(h.service.sendSingleMail(ctx, input)).resolves.toMatchObject({
      senderConnectionId: B,
    });
    expect(h.tx.integrationConnection.findFirst.mock.calls[0]![0].orderBy).toEqual({
      updatedAt: 'desc',
    });
  });
  it('never substitutes the actor profile for a missing mailbox address', async () => {
    const h = harness();
    h.tx.integrationConnection.findFirst.mockResolvedValue({ ...connection(), accountEmail: null });
    await expect(
      h.service.sendSingleMail(ctx, { ...input, senderConnectionId: B }),
    ).rejects.toThrow('confirm its address');
    expect(h.google.sendMail).not.toHaveBeenCalled();
  });
  it('honors signature opt-out without changing the selected sender', async () => {
    const h = harness();
    const receipt = await h.service.sendSingleMail(ctx, {
      ...input,
      senderConnectionId: B,
      appendSignature: false,
    });
    expect(h.google.sendMail.mock.calls[0]![2].body).not.toContain('Actor signature');
    expect(receipt).toMatchObject({
      senderEmail: 'mailbox-b@example.test',
      signatureAppended: false,
    });
  });
  it.each([undefined, A])(
    'pins reply A to its originating mailbox with selector %s',
    async (senderConnectionId) => {
      const h = harness();
      await expect(
        h.service.sendSingleMail(ctx, { ...input, threadId: 'thread-a', senderConnectionId }),
      ).resolves.toMatchObject({ senderConnectionId: A });
      expect(h.google.sendMail).toHaveBeenCalledWith(ctx, A, expect.any(Object));
      expect(h.tx.mailThread.findFirst).toHaveBeenLastCalledWith({
        where: {
          id: 'thread-a',
          tenantId: ctx.tenantId,
          connectionId: A,
          connection: { createdByUserId: ctx.userId },
          messages: { some: { removedAt: null } },
        },
        select: { id: true },
      });
    },
  );
  it('refuses thread A with explicit B before resolving a connection or attachments', async () => {
    const h = harness();
    await expect(
      h.service.sendSingleMail(ctx, {
        ...input,
        threadId: 'thread-a',
        senderConnectionId: B,
        attachmentIds: ['file'],
      }),
    ).rejects.toThrow('originating thread mailbox');
    expect(h.tx.integrationConnection.findFirst).not.toHaveBeenCalled();
    expect(h.tx.engagementAttachment.findMany).not.toHaveBeenCalled();
    expect(h.google.sendMail).not.toHaveBeenCalled();
  });
  it('refuses an unavailable originating A instead of falling back to B', async () => {
    const h = harness();
    h.tx.integrationConnection.findFirst.mockResolvedValue(null);
    await expect(h.service.sendSingleMail(ctx, { ...input, threadId: 'thread-a' })).rejects.toThrow(
      'selected sending mailbox',
    );
    expect(h.tx.integrationConnection.findFirst.mock.calls[0]![0].where.id).toBe(A);
    expect(h.google.sendMail).not.toHaveBeenCalled();
  });
  it('keeps reply authorization before any mailbox or provider work', async () => {
    const h = harness();
    h.tx.mailThread.findFirst.mockResolvedValue(null);
    await expect(
      h.service.sendSingleMail(ctx, {
        ...input,
        threadId: 'foreign-thread',
        senderConnectionId: B,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.integrationConnection.findFirst).not.toHaveBeenCalled();
    expect(h.google.sendMail).not.toHaveBeenCalled();
  });
  it('refuses a missing originating connection before provider work', async () => {
    const h = harness();
    h.tx.mailThread.findFirst.mockResolvedValue({ id: 'thread-a', connectionId: null });
    await expect(
      h.service.sendSingleMail(ctx, { ...input, threadId: 'thread-a' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.google.sendMail).not.toHaveBeenCalled();
  });
  it('preserves attachment refusal with exact B and does not fetch bytes or send', async () => {
    const h = harness();
    await expect(
      h.service.sendSingleMail(ctx, {
        ...input,
        senderConnectionId: B,
        attachmentIds: ['inaccessible'],
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ error: 'ATTACHMENT_MISSING' }) });
    expect((h.service as any).readAttachmentBytes).not.toHaveBeenCalled();
    expect(h.google.sendMail).not.toHaveBeenCalled();
    expect(h.tx.mailMessage.upsert).not.toHaveBeenCalled();
  });
  it('returns unknown outcome tied to B with no retry or success persistence', async () => {
    const h = harness();
    h.google.sendMail.mockRejectedValue(new AmbiguousMailSendError('Synthetic timeout', 'test'));
    await expect(
      h.service.sendSingleMail(ctx, { ...input, senderConnectionId: B }),
    ).rejects.toMatchObject({
      response: {
        error: 'MAIL_SEND_OUTCOME_UNKNOWN',
        senderConnectionId: B,
        senderEmail: 'mailbox-b@example.test',
        retryable: false,
      },
    });
    expect(h.google.sendMail).toHaveBeenCalledTimes(1);
    expect(h.tx.mailThread.upsert).not.toHaveBeenCalled();
    expect(h.tx.mailMessage.upsert).not.toHaveBeenCalled();
  });
  it('reports an unavailable local receipt after acceptance without retrying the send', async () => {
    const h = harness();
    h.tx.mailMessage.upsert.mockRejectedValue(new Error('Synthetic persistence failure'));
    await expect(
      h.service.sendSingleMail(ctx, { ...input, senderConnectionId: B }),
    ).rejects.toMatchObject({
      response: { error: 'MAIL_SEND_RECEIPT_UNAVAILABLE', senderConnectionId: B, retryable: false },
    });
    expect(h.google.sendMail).toHaveBeenCalledTimes(1);
  });
  it('preserves the transactional reply recheck and reports receipt uncertainty if ownership changed', async () => {
    const h = harness();
    h.tx.mailThread.findFirst
      .mockResolvedValueOnce({ id: 'thread-a', connectionId: A })
      .mockResolvedValueOnce(null);
    await expect(
      h.service.sendSingleMail(ctx, { ...input, threadId: 'thread-a' }),
    ).rejects.toMatchObject({
      response: { error: 'MAIL_SEND_RECEIPT_UNAVAILABLE', senderConnectionId: A, retryable: false },
    });
    expect(h.google.sendMail).toHaveBeenCalledTimes(1);
    expect(h.tx.mailThread.update).not.toHaveBeenCalled();
    expect(h.tx.mailMessage.upsert).not.toHaveBeenCalled();
  });
  it.each(['thread', 'message'])(
    'refuses a provider %s key collision on a different mailbox',
    async (kind) => {
      const h = harness();
      if (kind === 'thread')
        h.tx.mailThread.upsert.mockResolvedValue({ id: 'foreign-thread', connectionId: A });
      else h.tx.mailMessage.upsert.mockResolvedValue({ id: 'foreign-message', connectionId: A });
      await expect(
        h.service.sendSingleMail(ctx, { ...input, senderConnectionId: B }),
      ).rejects.toMatchObject({
        response: {
          error: 'MAIL_SEND_RECEIPT_UNAVAILABLE',
          senderConnectionId: B,
          retryable: false,
        },
      });
      expect(h.google.sendMail).toHaveBeenCalledTimes(1);
      if (kind === 'thread') expect(h.tx.mailMessage.upsert).not.toHaveBeenCalled();
      expect(h.tx.engagementAttachment.updateMany).not.toHaveBeenCalled();
    },
  );
});

describe('safe mailbox picker and wire input', () => {
  it('projects only minimal mailbox fields under the existing ownership and availability predicates', async () => {
    const h = harness();
    h.tx.integrationConnection.findMany.mockResolvedValue([
      {
        ...connection(A),
        token: { accessTokenCiphertext: 'must-never-escape' },
        syncState: { private: true },
        lastError: 'private',
        createdByUserId: ctx.userId,
      },
      connection(B),
      { ...connection(), accountEmail: ' ' },
    ]);
    const rows = await h.service.listSendingMailboxes(ctx);
    expect(rows).toEqual(
      [A, B].map((id) => ({
        ...connection(id),
        availability: 'available',
        signaturePolicy: 'actor',
      })),
    );
    expect(h.tx.integrationConnection.findMany).toHaveBeenCalledWith({
      where: { ...ownedSendingMailboxWhere(ctx), accountEmail: { not: null } },
      select: sendingMailboxSelect,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });
    expect(JSON.stringify(rows)).not.toContain('must-never-escape');
  });
});
