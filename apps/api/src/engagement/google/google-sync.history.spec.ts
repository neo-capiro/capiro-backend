// Phase F (remediation plan §3.f4/f5) — foldGmailHistory folds one page of
// Gmail history entries into a last-write-wins map of message id -> the
// single operation to apply. History entries arrive in ascending id order,
// and a single run can contain add-then-delete (or delete-then-add, e.g.
// restored from Trash) for the same message.

import { describe, expect, test } from '@jest/globals';
import { GoogleSyncService, foldGmailHistory } from './google-sync.service.js';

type HistoryEntry = Parameters<typeof foldGmailHistory>[0][number];

function entry(partial: Partial<HistoryEntry>): HistoryEntry {
  return { id: '1', ...partial };
}

describe('foldGmailHistory', () => {
  test('messagesAdded for a message with no excluded label folds to upsert', () => {
    const ops = foldGmailHistory([
      entry({ messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }] }),
    ]);
    expect(ops).toEqual(new Map([['m1', { action: 'upsert' }]]));
  });

  test('messagesAdded then messagesDeleted for the same id folds to remove/deleted (last-write-wins)', () => {
    const ops = foldGmailHistory([
      entry({ id: '1', messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }] }),
      entry({ id: '2', messagesDeleted: [{ message: { id: 'm1' } }] }),
    ]);
    expect(ops).toEqual(new Map([['m1', { action: 'remove', reason: 'deleted' }]]));
  });

  test('messagesDeleted then messagesAdded for the same id folds to upsert (order respected in both directions)', () => {
    const ops = foldGmailHistory([
      entry({ id: '1', messagesDeleted: [{ message: { id: 'm1' } }] }),
      entry({ id: '2', messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }] }),
    ]);
    expect(ops).toEqual(new Map([['m1', { action: 'upsert' }]]));
  });

  test('labelsAdded TRASH folds to remove/trashed; labelsAdded SPAM folds to remove/spam', () => {
    const ops = foldGmailHistory([
      entry({
        id: '1',
        labelsAdded: [
          { message: { id: 'm1' }, labelIds: ['TRASH'] },
          { message: { id: 'm2' }, labelIds: ['SPAM'] },
        ],
      }),
    ]);
    expect(ops).toEqual(
      new Map([
        ['m1', { action: 'remove', reason: 'trashed' }],
        ['m2', { action: 'remove', reason: 'spam' }],
      ]),
    );
  });

  test('labelsRemoved INBOX (archive) folds to upsert, NOT remove', () => {
    const ops = foldGmailHistory([
      entry({ labelsRemoved: [{ message: { id: 'm1' }, labelIds: ['INBOX'] } as never] }),
    ]);
    expect(ops).toEqual(new Map([['m1', { action: 'upsert' }]]));
  });

  test('messagesAdded whose labelIds already contain DRAFT folds to remove/trashed', () => {
    const ops = foldGmailHistory([
      entry({ messagesAdded: [{ message: { id: 'm1', labelIds: ['DRAFT'] } }] }),
    ]);
    expect(ops).toEqual(new Map([['m1', { action: 'remove', reason: 'trashed' }]]));
  });

  test('an entry with no message id anywhere folds to an empty map without throwing', () => {
    expect(() =>
      foldGmailHistory([
        entry({
          messagesAdded: [{ message: {} }],
          messagesDeleted: [{ message: {} }],
          labelsAdded: [{ message: {}, labelIds: ['TRASH'] }],
          labelsRemoved: [{ message: {}, labelIds: ['INBOX'] }],
        }),
      ]),
    ).not.toThrow();
    expect(foldGmailHistory([entry({})])).toEqual(new Map());
  });
});

describe('syncMailIncremental orchestration (Phase F apply loop)', () => {
  // syncMailIncremental's real callees (persistGmailMessage, markGmailMessageRemoved)
  // go through this.prisma.withTenantRetry/withTenant, which no existing spec in
  // this file mocks. Stubbing the service's OWN methods directly (rather than
  // Prisma) tests the orchestration this phase actually rewrote — which fold
  // result routes to which callee, and the live-label re-check — without
  // needing a Prisma transaction mock.
  function makeService(opts: {
    historyPages: Array<{ history: unknown[]; nextPageToken?: string; historyId?: string }>;
    gmailGetImpl?: (token: string, id: string) => Promise<{ id: string; labelIds?: string[] }>;
  }) {
    const service = Object.create(GoogleSyncService.prototype) as GoogleSyncService;
    const patch = service as unknown as Record<string, unknown>;
    patch.logger = { warn: () => {}, error: () => {} };
    let page = 0;
    patch.gmailHistory = jest.fn(async () => {
      const response = opts.historyPages[page];
      page += 1;
      return response;
    });
    patch.gmailGet = jest.fn(
      opts.gmailGetImpl ?? (async (_token: string, id: string) => ({ id, labelIds: ['INBOX'] })),
    );
    patch.markGmailMessageRemoved = jest.fn(async () => 'removed' as const);
    patch.persistGmailMessage = jest.fn(async () => 'matched' as const);
    return { service, patch };
  }

  const connection = { id: 'conn-1' };

  test('a remove op calls markGmailMessageRemoved, never gmailGet/persistGmailMessage', async () => {
    const { service, patch } = makeService({
      historyPages: [
        {
          history: [{ id: '1', messagesDeleted: [{ message: { id: 'm1' } }] }],
          historyId: '200',
        },
      ],
    });
    const mailState: { historyId?: string | null } = { historyId: '100' };

    const stats = await (
      service as unknown as {
        syncMailIncremental: (
          t: string,
          c: unknown,
          m: typeof mailState,
          a: string,
        ) => Promise<{ removed: number; matched: number; scanned: number }>;
      }
    ).syncMailIncremental('t1', connection, mailState, 'token');

    expect(patch.markGmailMessageRemoved).toHaveBeenCalledWith('t1', 'm1', 'deleted');
    expect(patch.gmailGet).not.toHaveBeenCalled();
    expect(patch.persistGmailMessage).not.toHaveBeenCalled();
    expect(stats.removed).toBe(1);
    expect(stats.scanned).toBe(1);
    expect(mailState.historyId).toBe('200');
  });

  test('an upsert op fetches then persists the message', async () => {
    const { service, patch } = makeService({
      historyPages: [
        {
          history: [{ id: '1', messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }] }],
          historyId: '200',
        },
      ],
    });
    const mailState: { historyId?: string | null } = { historyId: '100' };

    const stats = await (
      service as unknown as {
        syncMailIncremental: (
          t: string,
          c: unknown,
          m: typeof mailState,
          a: string,
        ) => Promise<{ matched: number }>;
      }
    ).syncMailIncremental('t1', connection, mailState, 'token');

    expect(patch.gmailGet).toHaveBeenCalledWith('token', 'm1');
    expect(patch.persistGmailMessage).toHaveBeenCalledWith('t1', 'conn-1', { id: 'm1', labelIds: ['INBOX'] });
    expect(patch.markGmailMessageRemoved).not.toHaveBeenCalled();
    expect(stats.matched).toBe(1);
  });

  test('an upsert op whose LIVE message has since moved into an excluded label is removed instead of persisted', async () => {
    const { service, patch } = makeService({
      historyPages: [
        {
          history: [{ id: '1', messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }] }],
          historyId: '200',
        },
      ],
      gmailGetImpl: async (_token: string, id: string) => ({ id, labelIds: ['TRASH'] }),
    });
    const mailState: { historyId?: string | null } = { historyId: '100' };

    const stats = await (
      service as unknown as {
        syncMailIncremental: (
          t: string,
          c: unknown,
          m: typeof mailState,
          a: string,
        ) => Promise<{ removed: number; matched: number }>;
      }
    ).syncMailIncremental('t1', connection, mailState, 'token');

    expect(patch.markGmailMessageRemoved).toHaveBeenCalledWith('t1', 'm1', 'trashed');
    expect(patch.persistGmailMessage).not.toHaveBeenCalled();
    expect(stats.removed).toBe(1);
    expect(stats.matched).toBe(0);
  });

  test('hasMore reflects an unconsumed nextPageToken and historyId advances to the LATEST page seen', async () => {
    const { service } = makeService({
      historyPages: [
        { history: [], nextPageToken: 'p2', historyId: '150' },
        { history: [], historyId: '200' },
      ],
    });
    const mailState: { historyId?: string | null } = { historyId: '100' };

    const stats = await (
      service as unknown as {
        syncMailIncremental: (
          t: string,
          c: unknown,
          m: typeof mailState,
          a: string,
        ) => Promise<{ hasMore: boolean; pages: number }>;
      }
    ).syncMailIncremental('t1', connection, mailState, 'token');

    expect(stats.hasMore).toBe(false);
    expect(stats.pages).toBe(2);
    expect(mailState.historyId).toBe('200');
  });

  // Phase b (remaining-items plan §3.b3) — durable multi-run pagination:
  // a mailbox with more than MAX_MAIL_PAGES_PER_LABEL_PER_RUN (12) pages of
  // history must resume from where a capped run left off, rather than
  // silently discarding the unconsumed nextPageToken and skipping history.
  type DurableMailState = {
    historyId?: string | null;
    incrementalPageToken?: string | null;
    incrementalLatestHistoryId?: string | null;
  };

  test('a 12-page capped run stores continuation and leaves historyId unchanged', async () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({
      history: [],
      historyId: String(101 + i),
      nextPageToken: `p${i + 2}`,
    }));
    const { service } = makeService({ historyPages: pages });
    const mailState: DurableMailState = { historyId: '100' };

    const stats = await (
      service as unknown as {
        syncMailIncremental: (
          t: string,
          c: unknown,
          m: DurableMailState,
          a: string,
        ) => Promise<{ hasMore: boolean; pages: number }>;
      }
    ).syncMailIncremental('t1', connection, mailState, 'token');

    expect(stats.hasMore).toBe(true);
    expect(stats.pages).toBe(12);
    expect(mailState.historyId).toBe('100');
    expect(mailState.incrementalPageToken).toBe('p13');
    expect(mailState.incrementalLatestHistoryId).toBe('112');
  });

  test('a resumed run passes the persisted incrementalPageToken to the first gmailHistory call', async () => {
    const { service, patch } = makeService({
      historyPages: [{ history: [], historyId: '250' }],
    });
    const mailState: DurableMailState = {
      historyId: '100',
      incrementalPageToken: 'p13',
      incrementalLatestHistoryId: '112',
    };

    await (
      service as unknown as {
        syncMailIncremental: (t: string, c: unknown, m: DurableMailState, a: string) => Promise<unknown>;
      }
    ).syncMailIncremental('t1', connection, mailState, 'token');

    expect(patch.gmailHistory).toHaveBeenCalledWith('token', {
      startHistoryId: '100',
      pageToken: 'p13',
    });
  });

  test('the run that finally exhausts the provider chain clears continuation and advances historyId', async () => {
    const { service } = makeService({
      historyPages: [{ history: [], historyId: '250' }],
    });
    const mailState: DurableMailState = {
      historyId: '100',
      incrementalPageToken: 'p13',
      incrementalLatestHistoryId: '112',
    };

    const stats = await (
      service as unknown as {
        syncMailIncremental: (
          t: string,
          c: unknown,
          m: DurableMailState,
          a: string,
        ) => Promise<{ hasMore: boolean }>;
      }
    ).syncMailIncremental('t1', connection, mailState, 'token');

    expect(stats.hasMore).toBe(false);
    expect(mailState.historyId).toBe('250');
    expect(mailState.incrementalPageToken).toBeNull();
    expect(mailState.incrementalLatestHistoryId).toBeNull();
  });

  test('incrementalLatestHistoryId seeds from the persisted value, not startHistoryId, and survives a second capped run', async () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({
      history: [],
      historyId: String(200 + i),
      nextPageToken: `p${20 + i}`,
    }));
    const { service } = makeService({ historyPages: pages });
    const mailState: DurableMailState = {
      historyId: '100',
      incrementalPageToken: 'p19',
      incrementalLatestHistoryId: '105',
    };

    const stats = await (
      service as unknown as {
        syncMailIncremental: (
          t: string,
          c: unknown,
          m: DurableMailState,
          a: string,
        ) => Promise<{ hasMore: boolean }>;
      }
    ).syncMailIncremental('t1', connection, mailState, 'token');

    expect(stats.hasMore).toBe(true);
    // Still mid-chain: the ORIGINAL baseline must not advance.
    expect(mailState.historyId).toBe('100');
    // Seeded from the persisted '105', not reset to startHistoryId ('100').
    expect(mailState.incrementalLatestHistoryId).toBe('211');
    expect(mailState.incrementalPageToken).toBe('p31');
  });

  test('a failed (non-gone) operation propagates and leaves cursor fields untouched', async () => {
    const { service } = makeService({
      historyPages: [
        {
          history: [{ id: '1', messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX'] } }] }],
          historyId: '200',
        },
      ],
      gmailGetImpl: async () => {
        throw new Error('transient boom');
      },
    });
    const mailState: DurableMailState = { historyId: '100' };

    await expect(
      (
        service as unknown as {
          syncMailIncremental: (t: string, c: unknown, m: DurableMailState, a: string) => Promise<unknown>;
        }
      ).syncMailIncremental('t1', connection, mailState, 'token'),
    ).rejects.toThrow('transient boom');

    expect(mailState.historyId).toBe('100');
    expect(mailState.incrementalPageToken).toBeUndefined();
    expect(mailState.incrementalLatestHistoryId).toBeUndefined();
  });
});

describe('gmailHistory request', () => {
  test('requests all four historyTypes values', async () => {
    const service = Object.create(GoogleSyncService.prototype) as GoogleSyncService;
    let requestedUrl = '';
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      requestedUrl = String(url);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ history: [] }),
        text: async () => '{}',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    try {
      await (
        service as unknown as {
          gmailHistory: (token: string, input: { startHistoryId: string }) => Promise<unknown>;
        }
      ).gmailHistory('token', { startHistoryId: '100' });
    } finally {
      globalThis.fetch = original;
    }

    const params = new URL(requestedUrl).searchParams;
    expect(params.getAll('historyTypes').sort()).toEqual(
      ['labelAdded', 'labelRemoved', 'messageAdded', 'messageDeleted'].sort(),
    );
  });
});
