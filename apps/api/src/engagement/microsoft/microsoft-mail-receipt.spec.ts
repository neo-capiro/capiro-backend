import { MicrosoftGraphSyncService } from './microsoft-graph-sync.service.js';
import {
  graphObservedIdentity,
  graphSendIdentity,
  GRAPH_IMMUTABLE_ID_HEADERS,
} from './microsoft-mail-receipt.js';
import { SingleMailLedger } from '../single-mail-ledger.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const INTENT = '44444444-4444-4444-8444-444444444444';
const result = {
  ok: true as const,
  provider: 'microsoft_graph' as const,
  providerImmutableMessageId: 'Immutable-A',
  providerDraftId: 'legacy-draft',
  providerConversationId: 'conversation',
  correlationId: INTENT,
};
const detail = {
  id: 'Immutable-A',
  conversationId: 'conversation',
  isDraft: false,
  internetMessageHeaders: [{ name: 'X-Capiro-Delivery-Id', value: INTENT }],
  body: { contentType: 'text', content: 'Authoritative full body' },
};

function fixture(
  options: { state?: string; receipt?: boolean; identity?: boolean; failCommit?: boolean } = {},
) {
  const thread: any = {
    id: 'thread-local',
    tenantId: TENANT,
    connectionId: CONNECTION,
    source: 'outlook',
    externalId: 'conversation',
    clientId: null,
    associationSignals: {},
    lastMessageAt: null,
    metadata: {},
  };
  let rows: any[] =
    options.receipt === false
      ? []
      : [
          {
            id: 'message-local',
            tenantId: TENANT,
            connectionId: CONNECTION,
            threadId: thread.id,
            source: 'manual',
            externalId: 'manual:local',
            bodyText: 'Weaker receipt',
            metadata:
              options.identity === false
                ? {}
                : {
                    graphMailIdentity: graphSendIdentity(result),
                    personIds: ['synthetic-person'],
                    signatureAppended: true,
                  },
            removedAt: null,
          },
        ];
  const intent: any = {
    id: INTENT,
    actor_id: ACTOR,
    state: options.state ?? 'accepted',
    connection_id: CONNECTION,
    provider_evidence: { ...result },
    snapshot: {
      senderEmail: 'sender@example.test',
      threadId: null,
    },
    receipt:
      options.receipt === false
        ? null
        : {
            ok: true,
            messageId: 'message-local',
            threadId: thread.id,
            mailboxConfirmation: 'pending',
          },
  };
  const files = [{ id: 'attachment', mailMessageId: 'message-local' }];
  const jobs = [{ id: 'knowledge-job', mailMessageId: 'message-local' }];
  const connection: any = {
    id: CONNECTION,
    tenantId: TENANT,
    createdByUserId: ACTOR,
    provider: 'microsoft_365',
    status: 'connected',
    accountEmail: 'sender@example.test',
  };
  const lookup = (where: any) =>
    rows.find((row) =>
      where.id
        ? row.id === where.id
        : row.source === where.tenantId_source_externalId?.source &&
          row.externalId === where.tenantId_source_externalId?.externalId,
    );
  const withThread = (row: any) => (row ? { ...row, thread } : null);
  const tx: any = {
    $executeRaw: jest.fn(async (sql: any) => {
      if (sql?.text?.includes('SET receipt=')) intent.receipt = JSON.parse(sql.values[0]);
      return 1;
    }),
    $queryRaw: jest.fn(async (sql: any) =>
      sql?.text?.includes('FROM single_mail_intents')
        ? intent.state === 'accepted'
          ? [structuredClone(intent)]
          : []
        : [{ id: CONNECTION }],
    ),
    integrationConnection: { findFirst: jest.fn(async () => connection) },
    mailMessage: {
      findFirst: jest.fn(
        async ({ where }: any) =>
          rows.find(
            (r) =>
              r.source === where.source &&
              r.externalId === where.externalId &&
              r.connectionId === where.connectionId,
          ) ?? null,
      ),
      findUnique: jest.fn(async ({ where }: any) => withThread(lookup(where))),
      findMany: jest.fn(async ({ where }: any) =>
        rows
          .filter(
            (row) =>
              row.tenantId === where.tenantId &&
              row.connectionId === where.connectionId &&
              where.AND.every(
                ({ metadata }: any) =>
                  row.metadata?.graphMailIdentity?.[metadata.path[1]] === metadata.equals,
              ),
          )
          .map(withThread)
          .slice(0, 2),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = lookup(where);
        if (!row || row.connectionId !== where.connectionId)
          throw Error('Conditional write refused');
        Object.assign(row, data);
        return row;
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        let row = lookup(where);
        if (row) Object.assign(row, update);
        else {
          row = { id: 'provider-local', ...create };
          rows.push(row);
        }
        return row;
      }),
    },
    mailThread: {
      findUnique: jest.fn(async () => thread),
      update: jest.fn(async ({ data }: any) => {
        Object.assign(thread, data);
        return thread;
      }),
      create: jest.fn(async () => {
        throw Error('Unexpected new thread');
      }),
    },
    clientAssociationOverride: { findFirst: jest.fn().mockResolvedValue(null) },
    engagementContact: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const transaction = async (_: string, run: any) => {
    const before = structuredClone({ rows, thread, receipt: intent.receipt });
    try {
      const out = await run(tx);
      if (options.failCommit) throw Error('Commit unavailable');
      return out;
    } catch (error) {
      rows = before.rows;
      Object.assign(thread, before.thread);
      intent.receipt = before.receipt;
      throw error;
    }
  };
  const service = Object.create(MicrosoftGraphSyncService.prototype) as any;
  service.prisma = { withTenant: transaction, withTenantRetry: transaction };
  service.association = {
    associate: jest.fn().mockResolvedValue({ clientId: null, score: 0, reason: null, signals: {} }),
  };
  service.graphGet = jest.fn().mockResolvedValue(detail);
  service.graphPost = jest.fn(() => {
    throw Error('Reconciliation attempted provider write');
  });
  service.graphPostNoContent = service.graphPost;
  const ingest = async (defaultId = 'default-sent', beforePersist?: () => void) => {
    const hydrated = await service.hydrateGraphMessageBody(
      'synthetic-token',
      {
        id: defaultId,
        conversationId: 'conversation',
        subject: 'Same subject',
        from: { emailAddress: { address: 'sender@example.test' } },
        body: { contentType: 'text', content: 'Delta body' },
        internetMessageId: '<same@example.test>',
        hasAttachments: true,
      },
      { tenantId: TENANT, connectionId: CONNECTION },
    );
    beforePersist?.();
    return service.persistGraphMessage(TENANT, CONNECTION, 'sentitems', hydrated, 'incremental');
  };
  return { service, tx, intent, connection, files, jobs, thread, ingest, rows: () => rows };
}

describe('ML-04 exact Graph receipt identity', () => {
  test('legacy draft and RFC identifiers are not immutable proof', () => {
    expect(graphSendIdentity({ ...result, providerImmutableMessageId: undefined })).toBeNull();
    expect(graphObservedIdentity(detail)).toMatchObject({
      immutableId: 'Immutable-A',
      observed: true,
    });
  });
  test.each([
    { isDraft: true },
    { isDraft: undefined },
    { id: '' },
    { conversationId: null },
    { internetMessageHeaders: [] },
    {
      internetMessageHeaders: [...detail.internetMessageHeaders, ...detail.internetMessageHeaders],
    },
    { internetMessageHeaders: [{ name: 'X-Capiro-Delivery-Id', value: 'not-an-intent' }] },
  ])('refuses incomplete or ambiguous observation %j', (change) => {
    expect(graphObservedIdentity({ ...detail, ...change })).toBeNull();
  });
  test('receipt before sync produces one message and retains local URLs and FKs', async () => {
    const h = fixture();
    await h.ingest();
    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0]).toMatchObject({
      id: 'message-local',
      threadId: 'thread-local',
      source: 'outlook',
      externalId: 'default-sent',
      bodyText: 'Authoritative full body',
      metadata: {
        graphMailIdentity: { observed: true },
        mailboxSyncMode: 'incremental',
        bodyCompleteness: 'full',
        personIds: ['synthetic-person'],
        signatureAppended: true,
      },
    });
    expect(h.files[0]!.mailMessageId).toBe('message-local');
    expect(h.jobs[0]!.mailMessageId).toBe('message-local');
    expect(h.intent.receipt.mailboxConfirmation).toBe('confirmed');
    expect(h.service.graphGet).toHaveBeenCalledWith(
      expect.stringContaining('internetMessageHeaders'),
      'synthetic-token',
      GRAPH_IMMUTABLE_ID_HEADERS,
    );
    expect(h.service.graphPost).not.toHaveBeenCalled();
    await h.ingest();
    expect(h.rows()).toHaveLength(1);
    expect(h.service.graphGet).toHaveBeenCalledTimes(1);
  });
  test('sync before acceptance retains observation without inventing a receipt or accepting sending', async () => {
    const h = fixture({ receipt: false, state: 'sending' });
    await h.ingest();
    expect(h.rows()[0].metadata.graphMailIdentity).toMatchObject({
      immutableId: 'Immutable-A',
      observed: true,
    });
    expect(h.intent.state).toBe('sending');
    expect(h.intent.receipt).toBeNull();
    expect(h.service.graphPost).not.toHaveBeenCalled();
  });
  test.each(['unknown', 'sending'])(
    '%s never reconciles acceptance or dispatches',
    async (state) => {
      const h = fixture({ state });
      await h.ingest();
      expect(h.intent.state).toBe(state);
      expect(h.intent.receipt.mailboxConfirmation).toBe('pending');
      expect(h.rows().find((row) => row.id === 'message-local').source).toBe('manual');
      expect(h.service.graphPost).not.toHaveBeenCalled();
    },
  );
  test.each(['immutable', 'correlation', 'legacy'])(
    '%s mismatch cannot adopt the receipt',
    async (mismatch) => {
      const h = fixture();
      if (mismatch === 'immutable')
        h.intent.provider_evidence.providerImmutableMessageId = 'immutable-a';
      if (mismatch === 'correlation') h.intent.provider_evidence.correlationId = ACTOR;
      if (mismatch === 'legacy') delete h.intent.provider_evidence.providerImmutableMessageId;
      await h.ingest();
      expect(h.rows().find((row) => row.id === 'message-local').source).toBe('manual');
      expect(h.intent.receipt.mailboxConfirmation).toBe('pending');
    },
  );
  test.each(['disconnected', 'actor', 'account'])(
    'current mailbox %s mismatch rolls back',
    async (change) => {
      const h = fixture();
      if (change === 'disconnected') h.connection.status = 'disabled';
      if (change === 'actor') h.connection.createdByUserId = TENANT;
      if (change === 'account') h.connection.accountEmail = 'other@example.test';
      await expect(h.ingest()).rejects.toThrow();
      expect(h.rows()).toHaveLength(1);
      expect(h.rows()[0].source).toBe('manual');
      expect(h.intent.receipt.mailboxConfirmation).toBe('pending');
    },
  );
  test.each(['duplicate', 'occupied-key'])(
    '%s is held without deleting ambiguous rows',
    async (kind) => {
      const h = fixture();
      const collide = () => h.rows().push({
        ...structuredClone(h.rows()[0]),
        id: 'another-local',
        ...(kind === 'occupied-key'
          ? { source: 'outlook', externalId: 'default-sent', metadata: {} }
          : {}),
      });
      if (kind === 'duplicate') collide();
      // The default key appears after the read observation but before adoption.
      await expect(h.ingest('default-sent', kind === 'occupied-key' ? collide : undefined)).rejects.toThrow();
      expect(h.rows()).toHaveLength(2);
      expect(h.intent.receipt.mailboxConfirmation).toBe('pending');
      expect(h.rows().find((row) => row.id === 'message-local').source).toBe('manual');
    },
  );
  test('a transient read failure cannot confirm or mutate a receipt', async () => {
    const h = fixture();
    h.service.graphGet.mockRejectedValue(Error('Synthetic read timeout'));
    await expect(h.ingest()).rejects.toThrow('Synthetic read timeout');
    expect(h.rows()).toHaveLength(1);
    expect(h.intent.receipt.mailboxConfirmation).toBe('pending');
    expect(h.service.graphPost).not.toHaveBeenCalled();
  });
  test('folder move rekeys in place; a late old-ID removal cannot tombstone it', async () => {
    const h = fixture();
    await h.ingest();
    await h.ingest('moved-default');
    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0].id).toBe('message-local');
    await h.service.persistGraphMessage(
      TENANT,
      CONNECTION,
      'sentitems',
      { id: 'default-sent', '@removed': { reason: 'deleted' } },
      'incremental',
    );
    expect(h.rows()[0].removedAt).toBeNull();
    await h.service.persistGraphMessage(
      TENANT,
      CONNECTION,
      'archive',
      { id: 'moved-default', '@removed': { reason: 'deleted' } },
      'incremental',
    );
    expect(h.rows()[0].removedReason).toBe('provider_removed');
    expect(h.rows()[0].bodyText).toBe('Authoritative full body');
    expect(h.intent.receipt.mailboxConfirmation).toBe('confirmed');
  });
  test('lost local commit cannot publish confirmed receipt', async () => {
    const h = fixture();
    h.tx.mailMessage.upsert.mockImplementation(async () => {
      throw Error('Commit unavailable');
    });
    await expect(h.ingest()).rejects.toThrow('Commit unavailable');
    expect(h.rows()[0].source).toBe('manual');
    expect(h.intent.receipt.mailboxConfirmation).toBe('pending');
  });
  test('readback reports only the durable confirmation, with retry forbidden', () => {
    const ledger = new SingleMailLedger({} as never);
    expect(
      ledger.view({ state: 'accepted', receipt: { mailboxConfirmation: 'confirmed' } } as never),
    ).toMatchObject({ state: 'accepted', mailboxConfirmation: 'confirmed', retryable: false });
    expect(
      ledger.view({ state: 'unknown', receipt: { mailboxConfirmation: 'confirmed' } } as never),
    ).not.toHaveProperty('mailboxConfirmation');
  });
});
