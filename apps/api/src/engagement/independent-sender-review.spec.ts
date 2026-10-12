import { EngagementService } from './engagement.service.js';
import { EngagementMailSender } from './mail-sender.service.js';
import type { TenantContext } from '@capiro/shared';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'standard_user',
} as TenantContext;
const B = '44444444-4444-4444-8444-444444444444';
const input = {
  to: [{ email: 'recipient@example.test' }],
  subject: 'Synthetic independent review',
  bodyHtml: '<p>Body</p>',
  senderConnectionId: B,
};
function harness() {
  let saved = { touched: false };
  const selected = {
    id: B,
    provider: 'google_workspace',
    accountEmail: 'b@example.test',
    displayName: 'Mailbox B',
  };
  const tx = {
    integrationConnection: { findFirst: jest.fn().mockResolvedValue(selected) },
    user: { findUnique: jest.fn().mockResolvedValue({ emailSignatureEnabled: false }) },
    mailThread: {
      findFirst: jest.fn().mockResolvedValue({ id: 'local-thread', connectionId: B }),
      update: jest.fn().mockImplementation(async () => {
        saved.touched = true;
        return { id: 'local-thread', connectionId: B };
      }),
      upsert: jest.fn().mockImplementation(async () => {
        saved.touched = true;
        return { id: 'local-thread', connectionId: B };
      }),
    },
    mailMessage: {
      upsert: jest
        .fn()
        .mockImplementation(async ({ create }) => ({ ...create, id: 'sent-message' })),
    },
    engagementAttachment: { updateMany: jest.fn() },
  };
  const provider = {
    sendMail: jest
      .fn()
      .mockResolvedValue({
        ok: true,
        provider: 'gmail',
        providerMessageId: 'provider-message',
        providerThreadId: 'provider-thread',
        correlationId: '',
      }),
  };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  Object.assign(service, {
    prisma: {
      withTenant: jest.fn(async (tenant, fn) => {
        expect(tenant).toBe(ctx.tenantId);
        const before = { ...saved };
        try {
          return await fn(tx);
        } catch (error) {
          saved = before;
          throw error;
        }
      }),
    },
    mailSender: new EngagementMailSender(
      { sendMail: jest.fn() } as never,
      provider as never,
      { assertExternalAction: jest.fn() } as never,
    ),
  });
  return { service, tx, provider, state: () => saved };
}

describe('independent sender review: persisted receipt identity', () => {
  it('retains existing sync content for matching mailbox and matching thread', async () => {
    const h = harness();
    h.tx.mailMessage.upsert.mockResolvedValue({
      id: 'sync-message',
      connectionId: B,
      threadId: 'local-thread',
      metadata: { mailboxSyncMode: 'incremental' },
    });
    const receipt = await h.service.sendSingleMail(ctx, input);
    expect(receipt).toMatchObject({
      ok: true,
      threadId: 'local-thread',
      messageId: 'sync-message',
      senderConnectionId: B,
    });
    expect(h.tx.mailMessage.upsert.mock.calls[0][0].update).toEqual({});
    expect(h.provider.sendMail).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, 'local-thread'])(
    'does not claim a receipt for a same-mailbox message in another persisted thread (reply=%s)',
    async (threadId) => {
      const h = harness();
      h.tx.mailMessage.upsert.mockResolvedValue({
        id: 'sync-message',
        connectionId: B,
        threadId: 'different-sync-thread',
        metadata: { mailboxSyncMode: 'incremental' },
      });
      await expect(h.service.sendSingleMail(ctx, { ...input, threadId })).rejects.toMatchObject({
        response: {
          error: 'MAIL_SEND_RECEIPT_UNAVAILABLE',
          retryable: false,
          senderConnectionId: B,
        },
      });
      expect(h.provider.sendMail).toHaveBeenCalledTimes(1);
      expect(h.state()).toEqual({ touched: false });
      expect(h.tx.engagementAttachment.updateMany).not.toHaveBeenCalled();
    },
  );
  it('rolls back the thread touch for a cross-mailbox message collision', async () => {
    const h = harness();
    h.tx.mailMessage.upsert.mockResolvedValue({
      id: 'other-message',
      connectionId: 'foreign-mailbox',
      threadId: 'local-thread',
    });
    await expect(h.service.sendSingleMail(ctx, input)).rejects.toMatchObject({
      response: { error: 'MAIL_SEND_RECEIPT_UNAVAILABLE', retryable: false },
    });
    expect(h.provider.sendMail).toHaveBeenCalledTimes(1);
    expect(h.state()).toEqual({ touched: false });
  });
});
