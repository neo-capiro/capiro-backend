import { GoogleSyncService } from './google/google-sync.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';

const TENANT = 'tenant-collision';
const CONNECTION = { id: 're-added-mailbox' };
const FLOWS = ['graph', 'gmail-backfill', 'gmail-incremental'] as const;
type Flow = (typeof FLOWS)[number];
type Collision = 'message-null' | 'message-other' | 'thread-null' | 'thread-other'
  | 'thread-only-null' | 'thread-only-other' | 'late-removal'
  | 'missing-relation' | 'missing-summary';
type Row = {
  id: string;
  externalId: string;
  connectionId: string | null;
  threadId?: string;
  [field: string]: unknown;
};
type Where = {
  id?: string;
  connectionId?: string;
  tenantId_source_externalId?: { externalId: string };
};
type Write = { where: Where; data: Partial<Row> };
type Stats = { held: number; matched: number; removed: number; scanned: number; hasMore: boolean };
type SyncService = {
  syncMail(tenantId: string, connection: { id: string }, state: Record<string, unknown>,
    accessToken: string, input: object): Promise<Record<string, Stats>>;
};

function graphMessage(id: string, removal: boolean) {
  return removal
    ? { id, '@removed': { reason: 'deleted' } }
    : { id, conversationId: id === 'old-message' ? 'old-thread' : 'new-thread',
      subject: 'Private subject', body: { contentType: 'text', content: 'Private body' },
      from: { emailAddress: { address: 'private@example.com' } } };
}

function gmailMessage(id: string, removal: boolean) {
  return {
    id, threadId: id === 'old-message' ? 'old-thread' : 'new-thread',
    labelIds: removal ? ['TRASH'] : ['INBOX'],
    snippet: 'Private body',
    payload: { headers: [{ name: 'From', value: 'private@example.com' }] },
  };
}

/** Uses real persistence/guard/removal code; only provider and transaction ports are fixtures. */
function harness(flow: Flow, collision: Collision, removal: boolean, failure?: Error,
  failureAt: 'read' | 'write' = 'read') {
  const identity = collision.endsWith('-null') ? null : 'different-mailbox';
  let threads = new Map<string, Row>([['old-thread', {
    id: 'old-thread', externalId: 'old-thread',
    connectionId: collision.startsWith('thread') ? identity : CONNECTION.id,
    clientId: null, associationSignals: {}, lastMessageAt: null,
    metadata: { retained: true }, snippet: 'Original snippet',
  }]]);
  let messages = new Map<string, Row>(collision.startsWith('thread-only') ? [] : [['old-message', {
    id: 'old-message', externalId: 'old-message', threadId: 'old-thread',
    connectionId: collision.startsWith('message') ? identity : CONNECTION.id,
    metadata: { retained: true }, bodyText: 'Original body', removedAt: null,
  }]]);
  const before = { thread: structuredClone(threads.get('old-thread')),
    message: structuredClone(messages.get('old-message')) };
  const events: string[] = [];
  let transactionWrites: string[] = [];
  const committedWrites: string[] = [];
  const lookup = (rows: Map<string, Row>, where: Where) =>
    rows.get(where.id ?? where.tenantId_source_externalId?.externalId ?? '');
  function update(rows: Map<string, Row>, { where, data }: Write) {
    if (failure && failureAt === 'write' && where.id === 'old-thread') throw failure;
    const row = lookup(rows, where);
    if (!row || (where.connectionId && row.connectionId !== where.connectionId))
      throw new Error('Conditional mailbox write refused');
    const changed = { ...row, ...data };
    rows.set(row.id, changed);
    transactionWrites.push(row.id);
    return changed;
  }
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    mailMessage: {
      findUnique: jest.fn(async ({ where }: { where: Where }) => {
        if (failure && failureAt === 'read' && where.tenantId_source_externalId?.externalId === 'old-message')
          throw failure;
        const row = lookup(messages, where);
        return row ? { ...row, thread: collision === 'missing-relation'
          ? null : threads.get(row.threadId ?? '') } : null;
      }),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(async (input: Write) => update(messages, input)),
      upsert: jest.fn(async ({ where, update: data, create }: {
        where: Where; update: Partial<Row>; create: Row;
      }) => {
        if (lookup(messages, where)) return update(messages, { where, data });
        const row = { ...create, id: create.externalId };
        messages.set(row.id, row);
        transactionWrites.push(row.id);
        return row;
      }),
    },
    mailThread: {
      findUnique: jest.fn(async ({ where }: { where: Where }) => {
        // Exercise both positive mismatch evidence and ambiguous disappearance
        // after a removal's first attempted update.
        if (where.id === 'old-thread' && collision === 'missing-summary') return null;
        if (where.id === 'old-thread' && collision === 'late-removal')
          return { ...threads.get('old-thread'), connectionId: null };
        return lookup(threads, where) ?? null;
      }),
      update: jest.fn(async (input: Write) => update(threads, input)),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { ...data, id: data.externalId };
        threads.set(row.id, row);
        transactionWrites.push(row.id);
        return row;
      }),
    },
    clientAssociationOverride: { findFirst: jest.fn().mockResolvedValue(null) },
    engagementContact: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const withTenant = async (_tenant: string, run: (value: typeof tx) => Promise<unknown>) => run(tx);
  const withTenantRetry = async (_tenant: string, run: (value: typeof tx) => Promise<unknown>) => {
    const snapshot = { messages: structuredClone(messages), threads: structuredClone(threads) };
    transactionWrites = [];
    try {
      const result = await run(tx);
      committedWrites.push(...transactionWrites);
      events.push('commit');
      return result;
    } catch (error) {
      messages = snapshot.messages;
      threads = snapshot.threads;
      events.push('rollback');
      throw error;
    }
  };
  const logger = { warn: jest.fn((_message: string) => events.push('held')), log: jest.fn() };
  const oldGraph = graphMessage('old-message', removal);
  const newGraph = graphMessage('new-message', false);
  const service = Object.assign(Object.create(
    flow === 'graph' ? MicrosoftGraphSyncService.prototype : GoogleSyncService.prototype,
  ), {
    prisma: { withTenant, withTenantRetry }, logger,
    association: { associate: jest.fn().mockResolvedValue({
      clientId: null, score: 0, reason: null, signals: {},
    }) },
    listSyncableMailFolders: jest.fn().mockResolvedValue({
      folders: [], enumerated: true, coverageComplete: true,
    }),
    hydrateGraphMessageBody: jest.fn(async (_token: string, message: unknown) => message),
    graphGet: jest.fn(async (url: string) => {
      if (url === 'inbox-before') return { value: [oldGraph, newGraph], '@odata.deltaLink': 'inbox-after' };
      if (url === 'sent-before') return { value: [], '@odata.deltaLink': 'sent-after' };
      throw new Error('Unexpected Graph cursor');
    }),
    gmailGet: jest.fn(async (_token: string, id: string) => gmailMessage(id, id === 'old-message' && removal)),
    gmailList: jest.fn().mockResolvedValue({ messages: [{ id: 'old-message' }, { id: 'new-message' }] }),
    gmailProfile: jest.fn().mockResolvedValue({ historyId: 'history-after' }),
    gmailHistory: jest.fn().mockResolvedValue({ historyId: 'history-after', history: [
      removal ? { messagesDeleted: [{ message: { id: 'old-message' } }] }
        : { messagesAdded: [{ message: { id: 'old-message' } }] },
      { messagesAdded: [{ message: { id: 'new-message' } }] },
    ] }),
  }) as SyncService;
  const state: Record<string, unknown> = flow === 'graph'
    ? { mail: { captureVersion: 1, folders: {
      inbox: { deltaLink: 'inbox-before', syncMode: 'incremental' },
      sentitems: { deltaLink: 'sent-before', syncMode: 'incremental' },
    } } }
    : flow === 'gmail-incremental'
      ? { mail: { captureVersion: 1, historyId: 'history-before', labels: { ALL: { backfillDone: true } } } }
      : { mail: { captureVersion: 1, labels: { ALL: {
        backfillDone: false, backfillPageToken: 'list-before', backfillQuery: 'saved-query',
      } } } };
  // Persisted state predates held statistics. The current run must not derive NaN
  // or treat those historical counts as newly processed provider references.
  Object.assign(state.mail as object, {
    lastStats: { scanned: 9, matched: 9, skipped: 0, removed: 0, failed: 0, pages: 1, hasMore: false },
  });
  const originalState = structuredClone(state);
  return {
    run: () => service.syncMail(TENANT, CONNECTION, state, 'token-not-logged', {}),
    state, originalState, before, logger, events, committedWrites, tx,
    rows: () => ({ thread: threads.get('old-thread'), message: messages.get('old-message'),
      next: messages.get('new-message') }),
  };
}

function expectAdvanced(flow: Flow, state: Record<string, unknown>) {
  if (flow === 'graph') {
    expect(state).toEqual(expect.objectContaining({ mail: expect.objectContaining({
      folders: expect.objectContaining({ inbox: expect.objectContaining({
        cursor: 'inbox-after', deltaLink: 'inbox-after', nextLink: null,
      }) }),
      lastStats: expect.objectContaining({ held: 1 }),
    }) }));
  } else if (flow === 'gmail-incremental') {
    expect(state).toEqual(expect.objectContaining({ mail: expect.objectContaining({
      historyId: 'history-after', incrementalPageToken: null,
      lastStats: expect.objectContaining({ held: 1 }),
    }) }));
  } else {
    expect(state).toEqual(expect.objectContaining({ mail: expect.objectContaining({
      historyId: 'history-after', labels: expect.objectContaining({ ALL: expect.objectContaining({
        backfillDone: true, backfillPageToken: null, backfillPendingRefs: [],
      }) }),
      lastStats: expect.objectContaining({ held: 1 }),
    }) }));
  }
}

describe.each(FLOWS)('%s mailbox collision progress', (flow) => {
  test.each(['message-null', 'message-other', 'thread-null', 'thread-other',
    'thread-only-null', 'thread-only-other'] as const)(
    'holds %s upsert without changing old rows and continues after reconnect', async (collision) => {
      const h = harness(flow, collision, false);
      const result = await h.run();
      expect(result[flow === 'graph' ? 'inbox' : flow === 'gmail-backfill' ? 'ALL' : 'incremental'])
        .toEqual(expect.objectContaining({ held: 1, matched: 1, removed: 0, scanned: 2, hasMore: false }));
      expect(h.rows()).toEqual(expect.objectContaining(h.before));
      expect(h.rows().next?.connectionId).toBe(CONNECTION.id);
      expect(h.committedWrites).toEqual(['new-thread', 'new-message']);
      expect(h.tx.engagementContact.createMany).toHaveBeenCalledTimes(1);
      expect(h.events).toContain('rollback');
      expect(h.events.indexOf('rollback')).toBeLessThan(h.events.indexOf('held'));
      expect(h.logger.warn.mock.calls).toEqual([[flow === 'graph'
        ? 'Graph mail message held: mailbox identity mismatch'
        : 'Gmail mail message held: mailbox identity mismatch']]);
      expectAdvanced(flow, h.state);
    },
  );

  test.each(['message-null', 'message-other', 'thread-null', 'thread-other', 'late-removal'] as const)(
    'holds %s removal with rollback before advancing the cursor', async (collision) => {
      const h = harness(flow, collision, true);
      const result = await h.run();
      expect(result[flow === 'graph' ? 'inbox' : flow === 'gmail-backfill' ? 'ALL' : 'incremental'])
        .toEqual(expect.objectContaining({ held: 1, matched: 1, removed: 0, scanned: 2 }));
      expect(h.rows()).toEqual(expect.objectContaining(h.before));
      expect(h.rows().next?.connectionId).toBe(CONNECTION.id);
      expect(h.committedWrites).toEqual(['new-thread', 'new-message']);
      expect(h.tx.engagementContact.createMany).toHaveBeenCalledTimes(1);
      expect(h.events).toContain('rollback');
      expect(h.events.indexOf('rollback')).toBeLessThan(h.events.indexOf('held'));
      if (collision === 'late-removal') expect(h.tx.mailMessage.update).toHaveBeenCalledTimes(1);
      else expect(h.tx.mailMessage.update).not.toHaveBeenCalled();
      expectAdvanced(flow, h.state);
    },
  );

  test.each(['database unavailable', 'Mail mailbox identity mismatch'])(
    'does not swallow an unclassified error (%s) or advance its cursor', async (message) => {
      const failure = new Error(message);
      const h = harness(flow, 'message-null', false, failure);
      await expect(h.run()).rejects.toBe(failure);
      expect(h.state).toEqual(h.originalState);
      expect(h.rows()).toEqual({ ...h.before, next: undefined });
      expect(h.committedWrites).toEqual([]);
      expect(h.logger.warn).not.toHaveBeenCalled();
    },
  );

  test('a conditional-write race aborts and retains the cursor', async () => {
    const failure = Object.assign(new Error('Conditional mailbox write refused'), { code: 'P2025' });
    const h = harness(flow, 'late-removal', false, failure, 'write');
    await expect(h.run()).rejects.toBe(failure);
    expect(h.state).toEqual(h.originalState);
    expect(h.rows()).toEqual({ ...h.before, next: undefined });
    expect(h.committedWrites).toEqual([]);
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  test.each(['missing-relation', 'missing-summary'] as const)(
    'does not classify %s as an observed mailbox collision', async (collision) => {
      const h = harness(flow, collision, true);
      await expect(h.run()).rejects.toThrow(collision === 'missing-relation'
        ? 'Mail mailbox identity unavailable' : 'Mail thread unavailable');
      expect(h.state).toEqual(h.originalState);
      expect(h.rows()).toEqual({ ...h.before, next: undefined });
      expect(h.committedWrites).toEqual([]);
      expect(h.events).toContain('rollback');
      expect(h.logger.warn).not.toHaveBeenCalled();
      if (collision === 'missing-summary') expect(h.tx.mailMessage.update).toHaveBeenCalledTimes(1);
      else expect(h.tx.mailMessage.update).not.toHaveBeenCalled();
    },
  );
});
