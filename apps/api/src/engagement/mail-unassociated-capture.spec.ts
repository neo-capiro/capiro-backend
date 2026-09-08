import { GoogleSyncService } from './google/google-sync.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';

const TENANT = 'tenant-1';
const CONNECTION = { id: 'connection-1' };
const WHEN = '2026-09-07T12:00:00.000Z';

function harness(provider: 'google' | 'microsoft', existingThread: unknown = null) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    mailThread: {
      findUnique: jest.fn().mockResolvedValue(existingThread),
      create: jest.fn().mockResolvedValue({ id: 'thread-1' }),
      update: jest.fn().mockResolvedValue({ id: 'thread-1' }),
    },
    mailMessage: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'message-1' }),
    },
    clientAssociationOverride: { findFirst: jest.fn().mockResolvedValue(null) },
    engagementContact: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const withTenant = jest.fn((_tenantId: string, fn: (value: typeof tx) => unknown) => fn(tx));
  const service = Object.assign(
    Object.create(
      provider === 'google' ? GoogleSyncService.prototype : MicrosoftGraphSyncService.prototype,
    ),
    {
      prisma: { withTenant, withTenantRetry: withTenant },
      association: {
        associate: jest
          .fn()
          .mockResolvedValue({ clientId: null, score: 0, reason: null, signals: {} }),
      },
      logger: { warn: jest.fn(), log: jest.fn() },
    },
  );
  return { service, tx, withTenant };
}

function graphMessage() {
  return {
    id: 'message-1',
    conversationId: 'conversation-1',
    subject: 'Coffee next week',
    from: { emailAddress: { address: 'friend@example.com', name: 'Friend' } },
    receivedDateTime: WHEN,
    body: { contentType: 'text', content: 'Can we meet on Tuesday?' },
    bodyPreview: 'Can we meet on Tuesday?',
  };
}

function gmailMessage() {
  return {
    id: 'message-1',
    threadId: 'conversation-1',
    labelIds: ['INBOX'],
    internalDate: String(new Date(WHEN).getTime()),
    snippet: 'Can we meet on Tuesday?',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Coffee next week' },
        { name: 'From', value: 'Friend <friend@example.com>' },
      ],
      body: { data: Buffer.from('Can we meet on Tuesday?').toString('base64url') },
    },
  };
}

describe.each(['google', 'microsoft'] as const)(
  '%s association-independent mail capture',
  (provider) => {
    const persist = (service: ReturnType<typeof harness>['service']) =>
      provider === 'google'
        ? service.persistGmailMessage(TENANT, CONNECTION.id, gmailMessage(), 'backfill')
        : service.persistGraphMessage(TENANT, CONNECTION.id, 'inbox', graphMessage(), 'backfill');

    it('stores a new unassociated message and harvests its correspondent in the canonical tenant/connection path', async () => {
      const { service, tx, withTenant } = harness(provider);
      await expect(persist(service)).resolves.toBe('matched');
      expect(withTenant.mock.calls.every(([tenant]) => tenant === TENANT)).toBe(true);
      expect(tx.mailThread.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT,
            connectionId: CONNECTION.id,
            clientId: null,
          }),
        }),
      );
      expect(tx.mailMessage.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            tenantId: TENANT,
            connectionId: CONNECTION.id,
            threadId: 'thread-1',
            bodyText: 'Can we meet on Tuesday?',
            removedAt: null,
            metadata: expect.objectContaining({ folder: 'inbox', mailboxSyncMode: 'backfill' }),
          }),
        }),
      );
      expect(tx.engagementContact.createMany).toHaveBeenCalledTimes(1);
    });

    it('preserves a manually assigned client when replaying an existing thread', async () => {
      const { service, tx } = harness(provider, {
        id: 'thread-1',
        clientId: 'manual-client',
        associationSignals: { manual: true },
        lastMessageAt: null,
      });
      service.association.associate.mockResolvedValue({
        clientId: 'other-client',
        score: 1,
        signals: {},
      });
      await persist(service);
      expect(tx.mailThread.create).not.toHaveBeenCalled();
      expect(tx.mailThread.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ clientId: 'manual-client' }) }),
      );
    });
  },
);

describe('Microsoft versioned mail replay', () => {
  function syncHarness() {
    const { service } = harness('microsoft');
    service.listSyncableMailFolders = jest.fn().mockResolvedValue({
      folders: [],
      enumerated: true,
      coverageComplete: true,
    });
    service.hydrateGraphMessageBody = jest.fn(async (_token: string, message: unknown) => message);
    service.persistGraphMessage = jest.fn().mockResolvedValue('matched');
    return service;
  }

  it('replays legacy cursors once, respects the page cap and resumes the exact backfill continuation', async () => {
    const service = syncHarness();
    const state = {
      calendar: { deltaLink: 'calendar-stays' },
      mail: {
        captureReplayReady: true,
        folders: { inbox: { deltaLink: 'old-inbox' }, sentitems: { deltaLink: 'old-sent' } },
      },
    };
    service.graphGet = jest.fn(async (url: string) =>
      url.includes('sentitems')
        ? { value: [], '@odata.deltaLink': 'sent-delta' }
        : {
            value: [graphMessage()],
            '@odata.nextLink': `inbox-next-${service.graphGet.mock.calls.length}`,
          },
    );
    const result = await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(result.inbox.pages).toBe(12);
    expect(result.inbox.hasMore).toBe(true);
    expect(service.graphGet.mock.calls[0][0]).toContain("mailFolders('inbox')/messages/delta?");
    expect(service.graphGet.mock.calls[0][0]).not.toBe('old-inbox');
    expect(state.calendar).toEqual({ deltaLink: 'calendar-stays' });
    expect(state.mail).toEqual(
      expect.objectContaining({ captureVersion: 1, folderEnumerationComplete: true }),
    );
    expect(state.mail.folders.inbox).toEqual(
      expect.objectContaining({ nextLink: 'inbox-next-12', syncMode: 'backfill' }),
    );

    service.graphGet = jest.fn(async (url: string) => ({
      value: [graphMessage()],
      '@odata.deltaLink': `${url}-done`,
    }));
    service.persistGraphMessage.mockClear();
    await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(service.graphGet.mock.calls[0][0]).toBe('inbox-next-12');
    expect(service.persistGraphMessage.mock.calls[0][4]).toBe('backfill');
    expect(service.graphGet.mock.calls[1][0]).toBe('sent-delta');
    expect(state.mail.folders.inbox).toEqual(
      expect.objectContaining({ nextLink: null, syncMode: 'incremental' }),
    );
  });

  it('does not publish partial repair state if a later folder fails', async () => {
    const service = syncHarness();
    const state = {
      mail: { folders: { inbox: { deltaLink: 'old-inbox' } }, updatedAt: 'old-time' },
    };
    const before = JSON.stringify(state);
    service.graphGet = jest
      .fn()
      .mockResolvedValueOnce({ value: [], '@odata.deltaLink': 'new-inbox' })
      .mockRejectedValueOnce(new Error('transient mail failure'));
    await expect(service.syncMail(TENANT, CONNECTION, state, 'test-token', {})).rejects.toThrow(
      'transient',
    );
    expect(JSON.stringify(state)).toBe(before);
  });

  it('drains pending old-delta removals before retiring the legacy baseline', async () => {
    const service = syncHarness();
    const state = {
      mail: {
        folders: { inbox: { deltaLink: 'old-inbox' }, sentitems: { deltaLink: 'old-sent' } },
      },
    };
    const removal = { id: 'removed-mail', '@removed': { reason: 'deleted' } };
    service.graphGet = jest.fn(async (url: string) => ({
      value: url === 'old-inbox' ? [removal] : [],
      '@odata.deltaLink': `${url}-caught-up`,
    }));
    service.persistGraphMessage.mockResolvedValue('removed');
    const preparation = await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(preparation.inbox.removed).toBe(1);
    expect(service.graphGet.mock.calls[0][0]).toBe('old-inbox');
    expect(service.persistGraphMessage).toHaveBeenCalledWith(
      TENANT,
      CONNECTION.id,
      'inbox',
      removal,
      'incremental',
    );
    expect(state.mail).toEqual(
      expect.objectContaining({ captureVersion: 0, captureReplayReady: true }),
    );
    service.graphGet.mockClear();
    await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(service.graphGet.mock.calls[0][0]).toContain("mailFolders('inbox')/messages/delta?");
    expect(state.mail).toEqual(
      expect.objectContaining({ captureVersion: 1, captureReplayCatchupPending: true }),
    );
    const duringReplayRemoval = { id: 'deleted-during-replay', '@removed': { reason: 'deleted' } };
    service.graphGet = jest.fn(async (url: string) => ({
      value: url === 'old-inbox-caught-up' ? [duringReplayRemoval] : [],
      '@odata.deltaLink': `${url}-final`,
    }));
    await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(service.graphGet.mock.calls[0][0]).toBe('old-inbox-caught-up');
    expect(service.persistGraphMessage).toHaveBeenCalledWith(
      TENANT,
      CONNECTION.id,
      'inbox',
      duringReplayRemoval,
      'incremental',
    );
    expect(state.mail).toEqual(expect.objectContaining({ captureReplayCatchupPending: false }));
  });

  it('resumes a capped preparation before starting capture replay', async () => {
    const service = syncHarness();
    const state = {
      mail: {
        folders: { inbox: { deltaLink: 'old-inbox' }, sentitems: { deltaLink: 'old-sent' } },
      },
    };
    service.graphGet = jest.fn(async (url: string) =>
      url === 'old-sent'
        ? { value: [], '@odata.deltaLink': 'old-sent' }
        : { value: [], '@odata.nextLink': 'preparation-page' },
    );
    await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(state.mail).toEqual(
      expect.objectContaining({ captureVersion: 0, captureReplayReady: false }),
    );
    service.graphGet.mockClear();
    await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(service.graphGet.mock.calls[0][0]).toBe('preparation-page');
  });

  it('resumes a capped final catch-up without restarting its prior delta', async () => {
    const service = syncHarness();
    const state = {
      mail: {
        captureVersion: 1,
        captureReplayCatchupPending: true,
        folders: { inbox: { deltaLink: 'new-inbox' }, sentitems: { deltaLink: 'new-sent' } },
        captureReplayPreviousFolders: {
          inbox: { deltaLink: 'old-inbox' },
          sentitems: { deltaLink: 'old-sent' },
        },
      },
    };
    service.graphGet = jest.fn(async (url: string) =>
      url === 'old-sent'
        ? { value: [], '@odata.deltaLink': 'old-sent' }
        : { value: [], '@odata.nextLink': `final-page-${service.graphGet.mock.calls.length}` },
    );
    await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(state.mail).toEqual(
      expect.objectContaining({ captureReplayCatchupPending: true, captureReplayFinishing: true }),
    );
    service.graphGet = jest.fn(async (url: string) => ({
      value: [],
      '@odata.deltaLink': `${url}-done`,
    }));
    await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(service.graphGet.mock.calls[0][0]).toBe('final-page-12');
    expect(state.mail).toEqual(
      expect.objectContaining({
        captureReplayCatchupPending: false,
        captureReplayFinishing: false,
      }),
    );
  });

  it('records incomplete folder coverage when enumeration falls back to inbox and sent', async () => {
    const service = syncHarness();
    const state = {};
    service.listSyncableMailFolders.mockResolvedValue({
      folders: [],
      enumerated: false,
      coverageComplete: false,
    });
    service.graphGet = jest.fn().mockResolvedValue({ value: [], '@odata.deltaLink': 'delta' });
    await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(state).toEqual(
      expect.objectContaining({
        mail: expect.objectContaining({ folderEnumerationComplete: false }),
      }),
    );
  });

  it('finishes other recovery work when a custom folder is confirmed deleted and retains the coverage gap', async () => {
    const service = syncHarness();
    const state = {
      mail: {
        folders: {
          inbox: { deltaLink: 'old-inbox' },
          sentitems: { deltaLink: 'old-sent' },
          'deleted-folder': { deltaLink: 'old-custom', displayName: 'Clients/Old' },
        },
      },
    };
    service.graphGet = jest.fn(async (url: string) => {
      if (url === 'old-custom' || url.includes('/mailFolders/deleted-folder?')) {
        throw new Error('Graph request failed (404): folder gone');
      }
      return { value: [], '@odata.deltaLink': `${url}-done` };
    });
    await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(service.graphGet).toHaveBeenCalledWith(
      '/me/mailFolders/deleted-folder?$select=id',
      'test-token',
    );
    expect(state.mail.folders).not.toHaveProperty('deleted-folder');
    expect(state.mail).toEqual(
      expect.objectContaining({
        captureReplayReady: true,
        captureReplayMissingFolders: ['deleted-folder'],
      }),
    );
    await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(state.mail).toEqual(
      expect.objectContaining({
        captureVersion: 1,
        captureReplayMissingFolders: ['deleted-folder'],
      }),
    );
  });

  it('does not discard a custom-folder cursor when the confirmation lookup fails transiently', async () => {
    const service = syncHarness();
    const state = { mail: { folders: { custom: { deltaLink: 'old-custom' } } } };
    const before = JSON.stringify(state);
    service.graphGet = jest.fn(async (url: string) => {
      if (url === 'old-custom') throw new Error('Graph request failed (404): invalid cursor');
      if (url.includes('/mailFolders/custom?'))
        throw new Error('Graph request failed (503): retry');
      return { value: [], '@odata.deltaLink': `${url}-done` };
    });
    await expect(service.syncMail(TENANT, CONNECTION, state, 'test-token', {})).rejects.toThrow(
      '(503)',
    );
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('Gmail versioned mail replay', () => {
  function syncHarness() {
    const { service } = harness('google');
    service.gmailGet = jest.fn().mockResolvedValue(gmailMessage());
    service.persistGmailMessage = jest.fn().mockResolvedValue('matched');
    service.gmailProfile = jest.fn().mockResolvedValue({ historyId: 'new-history' });
    service.syncMailIncremental = jest.fn().mockResolvedValue({ scanned: 0 });
    return service;
  }

  it('abandons legacy history once, then resumes the bounded replay query before returning to incremental sync', async () => {
    const service = syncHarness();
    const state = {
      calendar: { syncToken: 'calendar-stays' },
      mail: { historyId: 'old-history', captureReplayReady: true },
    };
    service.gmailList = jest.fn(async () => ({
      messages: [{ id: 'message-1' }],
      nextPageToken: `page-${service.gmailList.mock.calls.length}`,
    }));
    const result = await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(result.ALL.pages).toBe(12);
    expect(service.syncMailIncremental).not.toHaveBeenCalled();
    expect(service.gmailProfile).not.toHaveBeenCalled();
    expect(state.calendar).toEqual({ syncToken: 'calendar-stays' });
    expect(state.mail).toEqual(expect.objectContaining({ captureVersion: 1, historyId: null }));
    const firstQuery = service.gmailList.mock.calls[0][1].query;
    expect(firstQuery).toContain('-in:spam -in:trash -in:draft');
    service.gmailList = jest.fn().mockResolvedValue({ messages: [{ id: 'message-1' }] });
    await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(service.gmailList.mock.calls[0][1]).toEqual({ query: firstQuery, pageToken: 'page-12' });
    expect(state.mail.historyId).toBe('old-history');
    expect(state.mail).toEqual(expect.objectContaining({ captureReplayCatchupPending: true }));
    await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(service.syncMailIncremental).toHaveBeenCalledTimes(1);
    expect(state.mail).toEqual(expect.objectContaining({ captureReplayCatchupPending: false }));
  });

  it('leaves the prior repair marker and cursor untouched after a provider failure', async () => {
    const service = syncHarness();
    const state = {
      mail: { historyId: 'old-history', captureReplayReady: true, updatedAt: 'old-time' },
    };
    const before = JSON.stringify(state);
    service.gmailList = jest.fn().mockRejectedValue(new Error('transient mail failure'));
    await expect(service.syncMail(TENANT, CONNECTION, state, 'test-token', {})).rejects.toThrow(
      'transient',
    );
    expect(JSON.stringify(state)).toBe(before);
  });

  it('processes old-history removals before replay and changes during replay from the retained baseline', async () => {
    const service = syncHarness();
    service.syncMailIncremental = Object.getPrototypeOf(service).syncMailIncremental.bind(service);
    service.markGmailMessageRemoved = jest.fn().mockResolvedValue('removed');
    service.gmailHistory = jest.fn().mockResolvedValue({
      historyId: 'caught-up-history',
      history: [{ messagesDeleted: [{ message: { id: 'old-deleted-mail' } }] }],
    });
    const state = { mail: { historyId: 'old-history' } };
    await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(service.markGmailMessageRemoved).toHaveBeenCalledWith(
      TENANT,
      'old-deleted-mail',
      'deleted',
    );
    expect(state.mail).toEqual(
      expect.objectContaining({
        captureVersion: 0,
        captureReplayReady: true,
        historyId: 'caught-up-history',
      }),
    );

    service.gmailList = jest.fn().mockResolvedValue({ messages: [] });
    await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(state.mail).toEqual(
      expect.objectContaining({
        captureVersion: 1,
        captureReplayCatchupPending: true,
        historyId: 'caught-up-history',
      }),
    );
    service.gmailHistory.mockResolvedValue({
      historyId: 'after-replay',
      history: [{ messagesDeleted: [{ message: { id: 'deleted-during-replay' } }] }],
    });
    await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(service.gmailHistory).toHaveBeenLastCalledWith('test-token', {
      startHistoryId: 'caught-up-history',
      pageToken: undefined,
    });
    expect(service.markGmailMessageRemoved).toHaveBeenCalledWith(
      TENANT,
      'deleted-during-replay',
      'deleted',
    );
    expect(state.mail).toEqual(
      expect.objectContaining({ captureReplayCatchupPending: false, historyId: 'after-replay' }),
    );
  });

  it('retains a capped old-history continuation and does not replay prematurely', async () => {
    const service = syncHarness();
    service.syncMailIncremental = Object.getPrototypeOf(service).syncMailIncremental.bind(service);
    service.gmailHistory = jest.fn().mockResolvedValue({
      historyId: 'caught-up-history',
      history: [],
      nextPageToken: 'preparation-page',
    });
    service.gmailList = jest.fn();
    const state = { mail: { historyId: 'old-history' } };
    await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(service.gmailHistory).toHaveBeenCalledTimes(12);
    expect(service.gmailList).not.toHaveBeenCalled();
    expect(state.mail).toEqual(
      expect.objectContaining({
        captureVersion: 0,
        captureReplayReady: false,
        incrementalPageToken: 'preparation-page',
        historyId: 'old-history',
      }),
    );
    service.gmailHistory.mockClear();
    await service.syncMail(TENANT, CONNECTION, state, 'test-token', {});
    expect(service.gmailHistory.mock.calls[0][1]).toEqual({
      startHistoryId: 'old-history',
      pageToken: 'preparation-page',
    });
  });

  it('does not restore a message moved to trash between backfill list and fetch', async () => {
    const service = syncHarness();
    service.gmailList = jest.fn().mockResolvedValue({ messages: [{ id: 'trashed-mail' }] });
    service.gmailGet.mockResolvedValue({
      ...gmailMessage(),
      id: 'trashed-mail',
      labelIds: ['TRASH'],
    });
    service.markGmailMessageRemoved = jest.fn().mockResolvedValue('removed');
    const result = await service.syncMail(TENANT, CONNECTION, {}, 'test-token', {});
    expect(result.ALL.removed).toBe(1);
    expect(service.markGmailMessageRemoved).toHaveBeenCalledWith(TENANT, 'trashed-mail', 'trashed');
    expect(service.persistGmailMessage).not.toHaveBeenCalled();
  });
});
