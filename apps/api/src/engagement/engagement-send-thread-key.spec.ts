// Thread-level dedup with the inbound sync pipeline.
//
// Both sync jobs key a MailThread on the provider's own CONVERSATION id —
// microsoft-graph-sync uses `conversationId || internetMessageId || id`,
// google-sync uses `threadId || internetMessageId || id`. A send that wrote its
// thread as `(manual, manual:<uuid>)` could never match, so the next sync cycle
// opened a SECOND thread for the same conversation: an extra Timeline row per
// send on Outlook, and a conversation that split on the first reply on Gmail.
//
// These tests pin the key the send now writes, per provider, and pin the
// fallback when a provider supplies nothing.

import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';
import type { EngagementMailSendResult } from './mail-send-result.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const CONNECTION = '33333333-3333-3333-3333-333333333333';

const ctx: TenantContext = {
  tenantId: TENANT,
  tenantSlug: 'acme',
  userId: USER,
  clerkUserId: 'clerk-1',
  role: 'user' as TenantContext['role'],
};

/** jest.fn() with no generic infers `never` for mockResolvedValue under this
 *  repo's strictness; this keeps each stub's resolved type explicit. */
const resolving = <T>(value: T) =>
  jest.fn<(...args: unknown[]) => Promise<T>>().mockResolvedValue(value);

type UpsertArgs = {
  where: { tenantId_source_externalId: { tenantId: string; source: string; externalId: string } };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};

/**
 * `sendSingleMail` with everything around the thread write stubbed out. The
 * assertions below only read the `mailThread.upsert` argument, so the message
 * write and the attachment back-link are stubbed to whatever shape the code
 * needs to keep running.
 */
function makeService(
  provider: 'microsoft_365' | 'google_workspace',
  sendResult: EngagementMailSendResult,
) {
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;

  const threadUpsert = jest
    .fn<(args: UpsertArgs) => Promise<{ id: string; connectionId: string }>>()
    .mockResolvedValue({ id: 'thread-1', connectionId: CONNECTION });
  const messageUpsert = resolving({ id: 'message-1', connectionId: CONNECTION });
  const attachmentUpdateMany = resolving({ count: 0 });

  patch.findCampaignSendConnection = resolving({
    id: CONNECTION,
    provider,
    accountEmail: 'jordan@capiro.ai',
    displayName: 'Jordan',
  });
  patch.resolveSenderSignatureHtml = resolving({
    signatureHtml: null,
    senderEmail: 'jordan@capiro.ai',
    senderFirstName: 'Jordan',
  });
  patch.loadGraphAttachments = resolving(undefined);
  patch.mailSender = { sendMail: resolving(sendResult) };
  patch.recomputeMailThreadSummaryInTx = resolving(undefined);
  patch.prisma = {
    withTenant: (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({
        mailThread: { upsert: threadUpsert, update: jest.fn(), findFirst: jest.fn() },
        mailMessage: { upsert: messageUpsert },
        engagementAttachment: { updateMany: attachmentUpdateMany },
      }),
  };

  return { service, threadUpsert };
}

const input = {
  clientId: '44444444-4444-4444-4444-444444444444',
  to: [{ email: 'pat@example.com', name: 'Pat Client' }],
  subject: 'Following up',
  bodyHtml: '<p>Hello.</p>',
};

describe('sendSingleMail — thread key', () => {
  test("Outlook threads on Graph's conversationId, the key the sync job uses", async () => {
    const { service, threadUpsert } = makeService('microsoft_365', {
      ok: true,
      provider: 'microsoft_graph',
      providerDraftId: 'draft-abc',
      providerInternetMessageId: '<abc@contoso.example.com>',
      providerConversationId: 'AAQkAGConversationKey',
      correlationId: 'corr-1',
    });

    await service.sendSingleMail(ctx, input);

    expect(threadUpsert.mock.calls[0]![0].where.tenantId_source_externalId).toEqual({
      tenantId: TENANT,
      source: 'outlook',
      externalId: 'AAQkAGConversationKey',
    });
  });

  test('the RFC 5322 Message-ID is NOT used as the thread key', async () => {
    const { service, threadUpsert } = makeService('microsoft_365', {
      ok: true,
      provider: 'microsoft_graph',
      providerDraftId: 'draft-abc',
      providerInternetMessageId: '<abc@contoso.example.com>',
      providerConversationId: 'AAQkAGConversationKey',
      correlationId: 'corr-1',
    });

    await service.sendSingleMail(ctx, input);

    const key = threadUpsert.mock.calls[0]![0].where.tenantId_source_externalId;
    expect(key.externalId).not.toContain('@');
  });

  test("Gmail threads on the send response's threadId", async () => {
    const { service, threadUpsert } = makeService('google_workspace', {
      ok: true,
      provider: 'gmail',
      providerMessageId: 'gmail-msg-1',
      providerThreadId: 'gmail-thread-1',
      correlationId: 'corr-2',
    });

    await service.sendSingleMail(ctx, input);

    expect(threadUpsert.mock.calls[0]![0].where.tenantId_source_externalId).toEqual({
      tenantId: TENANT,
      source: 'google',
      externalId: 'gmail-thread-1',
    });
  });

  test('falls back to a synthetic manual key when the provider supplies none', async () => {
    const { service, threadUpsert } = makeService('microsoft_365', {
      ok: true,
      provider: 'microsoft_graph',
      providerDraftId: 'draft-abc',
      correlationId: 'corr-3',
    });

    await service.sendSingleMail(ctx, input);

    const key = threadUpsert.mock.calls[0]![0].where.tenantId_source_externalId;
    expect(key.source).toBe('manual');
    expect(key.externalId).toMatch(/^manual:[0-9a-f-]{36}$/);
  });

  test('an existing thread on the same conversation is appended to, not overwritten', async () => {
    const { service, threadUpsert } = makeService('microsoft_365', {
      ok: true,
      provider: 'microsoft_graph',
      providerDraftId: 'draft-abc',
      providerConversationId: 'AAQkAGConversationKey',
      correlationId: 'corr-4',
    });

    await service.sendSingleMail(ctx, input);

    // Sync owns the conversation's own metadata, and a manual client
    // association must survive a send — so the update touches only what this
    // send genuinely knows.
    const update = threadUpsert.mock.calls[0]![0].update;
    expect(Object.keys(update).sort()).toEqual(['lastMessageAt', 'snippet']);
    expect(update).not.toHaveProperty('clientId');
    expect(update).not.toHaveProperty('participants');
    expect(update).not.toHaveProperty('subject');
  });
});
