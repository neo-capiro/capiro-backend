import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { GoogleSyncService } from './google/google-sync.service.js';

function harness(
  provider: 'outlook' | 'google',
  collision:
    | 'message'
    | 'thread'
    | 'removed'
    | 'message-race'
    | 'thread-race'
    | 'removed-race'
    | 'thread-lineage',
) {
  const thread = {
    id: 'thread',
    connectionId: collision.includes('race') ? 'mailbox-B' : 'mailbox-A',
    clientId: null,
    lastMessageAt: null,
    associationSignals: {},
  };
  const message = {
    id: 'message',
    connectionId:
      collision.includes('race') || collision === 'thread-lineage' ? 'mailbox-B' : 'mailbox-A',
    threadId: 'thread',
    metadata: {},
    thread,
  };
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    mailMessage: {
      findUnique: jest.fn().mockResolvedValue(collision === 'thread' ? null : message),
      upsert: jest.fn().mockResolvedValue(message),
      update: jest.fn().mockResolvedValue(message),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    mailThread: {
      findUnique: jest.fn().mockResolvedValue(thread),
      update: jest.fn().mockResolvedValue(thread),
      create: jest.fn().mockResolvedValue(thread),
    },
    clientAssociationOverride: { findFirst: jest.fn().mockResolvedValue(null) },
    engagementContact: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const service = Object.create(
    (provider === 'outlook' ? MicrosoftGraphSyncService : GoogleSyncService).prototype,
  ) as any;
  service.prisma = {
    withTenant: async (_: string, run: any) => run(tx),
    withTenantRetry: async (_: string, run: any) => run(tx),
  };
  service.association = {
    associate: jest.fn().mockResolvedValue({ clientId: null, score: 0, reason: null, signals: {} }),
  };
  const run = () =>
    collision.startsWith('removed') || collision === 'thread-lineage'
      ? provider === 'outlook'
        ? service.persistGraphMessage(
            'tenant',
            'mailbox-B',
            'inbox',
            { id: 'same-id', '@removed': {} },
            'incremental',
          )
        : service.markGmailMessageRemoved('tenant', 'same-id', 'deleted', 'mailbox-B')
      : provider === 'outlook'
        ? service.persistGraphMessage(
            'tenant',
            'mailbox-B',
            'inbox',
            {
              id: 'same-id',
              conversationId: 'same-thread',
              body: { contentType: 'text', content: 'private' },
            },
            'incremental',
          )
        : service.persistGmailMessage(
            'tenant',
            'mailbox-B',
            {
              id: 'same-id',
              threadId: 'same-thread',
              labelIds: ['INBOX'],
              payload: { headers: [] },
            },
            'incremental',
          );
  let committed = false;
  const rejectRace = async ({ where }: any) => {
    if (where.connectionId === 'mailbox-B') throw new Error('Mailbox race refused');
    committed = true;
    return message;
  };
  if (collision === 'message-race') tx.mailMessage.upsert.mockImplementation(rejectRace);
  if (collision === 'thread-race') tx.mailThread.update.mockImplementation(rejectRace);
  if (collision === 'removed-race') tx.mailMessage.update.mockImplementation(rejectRace);
  return { tx, run, committed: () => committed };
}

describe('ML-09 mailbox collision fence', () => {
  test.each(['outlook', 'google'] as const)(
    '%s rejects same provider ID from another mailbox before any write',
    async (provider) => {
      for (const collision of ['message', 'thread', 'removed', 'thread-lineage'] as const) {
        const h = harness(provider, collision);
        await expect(h.run()).rejects.toThrow('Mail mailbox identity mismatch');
        expect(h.tx.mailMessage.upsert).not.toHaveBeenCalled();
        expect(h.tx.mailMessage.update).not.toHaveBeenCalled();
        expect(h.tx.mailThread.update).not.toHaveBeenCalled();
        expect(h.tx.mailThread.create).not.toHaveBeenCalled();
        expect(h.tx.engagementContact.createMany).not.toHaveBeenCalled();
      }
    },
  );
});

// Simulate another transaction replacing/nulling lineage between lookup and write.
test.each(['outlook', 'google'] as const)(
  '%s mailbox predicates refuse concurrent collision writes',
  async (provider) => {
    for (const collision of ['message-race', 'thread-race', 'removed-race'] as const) {
      const h = harness(provider, collision);
      await expect(h.run()).rejects.toThrow('Mailbox race refused');
      expect(h.committed()).toBe(false);
      expect(h.tx.engagementContact.createMany).not.toHaveBeenCalled();
    }
  },
);
