import { assertSingleMailAuthority } from './single-mail-authority.js';
import { SingleMailLedger, singleMailHash } from './single-mail-ledger.js';
import type { TenantContext } from '@capiro/shared';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
} as TenantContext;
const input = {
  clientId: 'client',
  personIds: ['person'],
  threadId: 'thread',
  senderConnectionId: 'mailbox',
  to: [{ email: 'person@example.test' }],
};
function authorityFixture() {
  const tx = {
    tenantMembership: { findFirst: jest.fn().mockResolvedValue({ id: 'membership' }) },
    integrationConnection: { findFirst: jest.fn().mockResolvedValue({ id: 'mailbox' }) },
    client: { findFirst: jest.fn().mockResolvedValue({ id: 'client' }) },
    clientPerson: {
      findMany: jest.fn().mockResolvedValue([{ id: 'person', email: 'person@example.test' }]),
    },
    mailThread: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'thread', clientId: 'client', connectionId: 'mailbox' }),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
  };
  const association = jest.fn().mockResolvedValue({ id: 'thread' });
  return {
    tx,
    association,
    run: (value = input) => assertSingleMailAuthority(tx as never, ctx, value, association),
  };
}

describe('ML-07 current single-mail admission', () => {
  test.each([
    'removed-member',
    'foreign-mailbox',
    'absent-client',
    'revoked-wall',
    'foreign-person',
    'foreign-thread',
    'wrong-mailbox',
    'different-client',
  ])('%s refuses before dispatch', async (scenario) => {
    const h = authorityFixture();
    if (scenario === 'removed-member') h.tx.tenantMembership.findFirst.mockResolvedValue(null);
    if (scenario === 'foreign-mailbox')
      h.tx.integrationConnection.findFirst.mockResolvedValue(null);
    if (scenario === 'absent-client') h.tx.client.findFirst.mockResolvedValue(null);
    if (scenario === 'revoked-wall') h.tx.$queryRawUnsafe.mockResolvedValue([{ allowed: false }]);
    if (scenario === 'foreign-person') h.tx.clientPerson.findMany.mockResolvedValue([]);
    if (scenario === 'foreign-thread') h.tx.mailThread.findFirst.mockResolvedValue(null);
    if (scenario === 'wrong-mailbox')
      h.tx.mailThread.findFirst.mockResolvedValue({
        id: 'thread',
        clientId: 'client',
        connectionId: 'other',
      });
    if (scenario === 'different-client')
      h.tx.mailThread.findFirst.mockResolvedValue({
        id: 'thread',
        clientId: 'other',
        connectionId: 'mailbox',
      });
    const provider = jest.fn();
    await expect(h.run().then(provider)).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
  });

  test('null-client history needs existing recipient association and retains owner predicates', async () => {
    const h = authorityFixture();
    h.tx.mailThread.findFirst
      .mockResolvedValueOnce({ id: 'thread', clientId: null, connectionId: 'mailbox' })
      .mockResolvedValueOnce(null);
    await expect(h.run()).rejects.toThrow('Mail thread not found');
    expect(h.association).toHaveBeenCalledWith('client');
    expect(h.tx.mailThread.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            expect.objectContaining({
              tenantId: ctx.tenantId,
              connection: { createdByUserId: ctx.userId },
            }),
            { id: 'thread' },
          ],
        },
      }),
    );
  });
});

describe('ML-03 durable claim and request identity', () => {
  test('changed Bcc, mailbox, reply, signature policy and attachments change the frozen request hash', () => {
    const original = {
      ...input,
      bcc: [{ email: 'private@example.test' }],
      appendSignature: true,
      attachmentIds: ['a'],
      bodyHtml: '<p>body</p>',
    };
    const hash = singleMailHash(original);
    for (const change of [
      { bcc: [] },
      { senderConnectionId: 'other' },
      { threadId: 'other' },
      { appendSignature: false },
      { attachmentIds: ['b'] },
      { bodyHtml: '<p>changed</p>' },
    ]) {
      expect(singleMailHash({ ...original, ...change })).not.toBe(hash);
    }
  });

  test('current authority rejection prevents the pending-to-sending write', async () => {
    const execute = jest.fn();
    const prisma = { withTenant: async (_: string, run: any) => run({ $executeRaw: execute }) };
    const ledger = new SingleMailLedger(prisma as never);
    const reject = async () => {
      throw new Error('revoked');
    };
    await expect(ledger.claim(ctx, { id: 'intent' } as never, reject)).rejects.toThrow('revoked');
    expect(execute).not.toHaveBeenCalled();
  });

  test('a non-winning claim cannot dispatch and outcome writes remain actor-scoped without re-admission', async () => {
    const execute = jest.fn().mockResolvedValue(0);
    const prisma = { withTenant: async (_: string, run: any) => run({ $executeRaw: execute }) };
    const ledger = new SingleMailLedger(prisma as never);
    expect(await ledger.claim(ctx, { id: 'intent' } as never, async () => {})).toBe(false);
    const query = execute.mock.calls[0][0];
    expect(query.sql).toContain("state='pending'");
    expect(query.values).toContain(ctx.tenantId);
    expect(query.values).toContain(ctx.userId);
    execute.mockResolvedValue(1);
    await ledger.outcome(ctx, { id: 'intent' } as never, 'accepted', {
      providerMessageId: 'accepted',
    });
    expect(execute.mock.calls[1][0].sql).toContain("state='sending'");
  });
});
