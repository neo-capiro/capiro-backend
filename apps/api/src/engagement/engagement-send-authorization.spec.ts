import { describe, expect, jest, test } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'test-user',
  role: 'standard_user',
};
const resolving = <T>(value: T) =>
  jest.fn<(...args: unknown[]) => Promise<T>>().mockResolvedValue(value);
function harness(thread: { id: string; connectionId: string } | null) {
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  const findFirst = resolving(thread);
  const connect = resolving({
    id: 'connection-test',
    provider: 'microsoft_365',
    accountEmail: 'sender@example.test',
    displayName: 'Test',
  });
  const attachments = resolving(undefined);
  const send = jest
    .fn<(...args: unknown[]) => Promise<never>>()
    .mockRejectedValue(new Error('Synthetic provider failure'));
  const withTenant = jest
    .fn<(tenantId: string, run: (tx: unknown) => Promise<unknown>) => Promise<unknown>>()
    .mockImplementation((_tenantId, run) => run({ mailThread: { findFirst } }));
  patch.prisma = { withTenant };
  patch.findCampaignSendConnection = connect;
  patch.resolveSenderSignatureHtml = resolving({
    signatureHtml: null,
    senderEmail: 'sender@example.test',
    senderFirstName: 'Test',
  });
  patch.loadGraphAttachments = attachments;
  patch.mailSender = { sendMail: send };
  return { service, findFirst, withTenant, connect, attachments, send };
}
const input = {
  to: [{ email: 'recipient@example.test' }],
  subject: 'Synthetic test',
  bodyHtml: '<p>Test</p>',
};
describe('sendSingleMail pre-send reply authorization', () => {
  test('rejects an inaccessible thread before resolving attachments or calling a provider', async () => {
    const h = harness(null);
    await expect(
      h.service.sendSingleMail(ctx, { ...input, threadId: 'private-thread' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.withTenant).toHaveBeenCalledWith(ctx.tenantId, expect.any(Function));
    expect(h.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'private-thread',
        tenantId: ctx.tenantId,
        connection: { createdByUserId: ctx.userId },
        messages: { some: { removedAt: null } },
      },
      select: { id: true, connectionId: true },
    });
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.attachments).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
  test('an accessible reply reaches the provider only after the ownership read', async () => {
    const h = harness({ id: 'owned-thread', connectionId: 'connection-test' });
    await expect(
      h.service.sendSingleMail(ctx, { ...input, threadId: 'owned-thread' }),
    ).rejects.toThrow();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      h.send.mock.invocationCallOrder[0]!,
    );
  });
  test('a new email does not require or fabricate a reply thread', async () => {
    const h = harness(null);
    await expect(h.service.sendSingleMail(ctx, input)).rejects.toThrow();
    expect(h.findFirst).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});
