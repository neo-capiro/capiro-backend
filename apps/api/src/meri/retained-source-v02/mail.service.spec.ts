// Unrelated injected program-element readers are never used by this mail fixture.
jest.mock('../../program-element/program-element-read.service.js', () => ({
  ProgramElementReadService: class {},
}));
jest.mock('../meri-defense-budget-tool.helpers.js', () => ({}));
// These read fixtures must never enter HTML sanitization. Throw if reached;
// production sanitizer ESM import compatibility is qualified separately.
jest.mock('sanitize-html', () => {
  const fail = () => { throw new Error('Unexpected sanitizer in a mail read'); };
  return Object.assign(fail, { simpleTransform: () => fail });
});
import { ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from '../../engagement/engagement.service.js';
import { MeriToolsService } from '../meri-tools.service.js';
import { withMeriToolExecutionControl } from '../meri-tool-request-control.js';
import type { RetainedSourceV02Admission } from './admission.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const mailboxId = '44444444-4444-4444-8444-444444444444';
const otherMailboxId = '55555555-5555-4555-8555-555555555555';
const threadId = '66666666-6666-4666-8666-666666666666';
const ctx = { tenantId, userId: actorId } as TenantContext;

function admitted(id: string): RetainedSourceV02Admission {
  return {
    operation: { id, version: '0.2.0' },
    binding: {
      tenantId, actorId, conversationId: '77777777-7777-4777-8777-777777777777',
      runId: '88888888-8888-4888-8888-888888888888',
      attemptId: '99999999-9999-4999-8999-999999999999',
      workerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', writerFence: 1,
    },
    subject: {
      kind: 'client', entityType: 'client', entityIds: [clientId], tenantId, actorId,
      policyRevision: 'policy-1', rosterVersionId: null,
      scopes: [{ kind: 'mailbox', resourceId: mailboxId, tenantId, policyRevision: 'policy-1' }],
    },
    input: { subject: { kind: 'client', entityId: clientId }, threadId },
    metadata: null, normalizationContext: null, policyRevision: 'policy-1',
    argumentsSha256: 'a'.repeat(64), requestSha256: 'b'.repeat(64),
    clientId, hardExpiryMs: Date.now() + 30_000,
  };
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return withMeriToolExecutionControl(
    { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 }, fn,
  );
}

describe('retained mail owner mailbox fence', () => {
  it('passes only the authenticated mailbox scope to count, page and inventory owner', async () => {
    const searchMailMessages = jest.fn(async () => ({ messages: [] }));
    const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    Object.assign(service, { engagement: { searchMailMessages } });
    await run(() => service.readRetainedMailSourceV02(ctx, admitted('mail.list_messages')));
    expect(searchMailMessages).toHaveBeenCalledWith(ctx, expect.objectContaining({ clientId }), {
      allowUnfiltered: true, authorizedMailboxIds: [mailboxId],
    });
  });

  it('refuses absent or malformed mailbox scopes before any owner read', async () => {
    const searchMailMessages = jest.fn();
    const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    Object.assign(service, { engagement: { searchMailMessages } });
    const request = admitted('mail.list_messages');
    request.subject.scopes = [{ kind: 'mailbox', resourceId: otherMailboxId,
      tenantId: 'different-tenant', policyRevision: 'policy-1' }];
    await expect(run(() => service.readRetainedMailSourceV02(ctx, request)))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(searchMailMessages).not.toHaveBeenCalled();
  });

  it('restricts thread and message loading in the canonical owner query', async () => {
    const findFirst = jest.fn(async () => ({ id: threadId, connectionId: mailboxId, updatedAt: new Date('2026-10-01'), connection: {
      id: mailboxId, tenantId, createdByUserId: actorId,
      accountEmail: 'owner@example.test', status: 'connected',
    }, messages: [] }));
    const service = Object.create(EngagementService.prototype) as EngagementService;
    Object.assign(service, { prisma: { withTenant: async (_tenant: string,
      read: (tx: unknown) => Promise<unknown>) => read({
        $executeRaw: jest.fn(async () => 1), $queryRawUnsafe: jest.fn(async () => [{ allowed: true }]),
        tenantMembership: { findFirst: jest.fn(async () => ({ id: 'member' })) },
        client: { findFirst: jest.fn(async () => ({ id: clientId })) },
        mailMessage: { count: jest.fn(async () => 0), findMany: jest.fn(async () => []) },
        mailThread: { findFirst } }) } });
    await service.getMailThread(ctx, threadId, clientId, [mailboxId]);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: threadId, tenantId, clientId, connectionId: { in: [mailboxId] },
      }),
    }));
  });
});
