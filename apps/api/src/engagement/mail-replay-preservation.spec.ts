import { GoogleSyncService } from './google/google-sync.service.js';
import {
  GraphHttpError,
  MicrosoftGraphSyncService,
} from './microsoft/microsoft-graph-sync.service.js';

const TENANT = 'tenant-replay';
const CONNECTION = 'connection-replay';
const WHEN = '2026-09-07T12:00:00.000Z';

describe.each(['google', 'microsoft'] as const)(
  '%s replay association preservation',
  (provider) => {
    it('preserves a manual-signal-only client assignment through two successive replays', async () => {
      let savedThread = {
        id: 'thread-replay',
        clientId: 'manually-selected-client',
        lastMessageAt: null as Date | null,
        associationSignals: { manual: true },
      };
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        mailThread: {
          findUnique: jest.fn(async () => ({ ...savedThread })),
          update: jest.fn(async ({ data }: { data: Partial<typeof savedThread> }) => {
            savedThread = { ...savedThread, ...data };
            return { id: savedThread.id };
          }),
          create: jest.fn(),
        },
        mailMessage: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn().mockResolvedValue({ id: 'message-replay' }),
        },
        clientAssociationOverride: { findFirst: jest.fn().mockResolvedValue(null) },
        engagementContact: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      const withTenant = jest.fn((_tenant: string, action: (value: typeof tx) => unknown) =>
        action(tx),
      );
      const service = Object.assign(
        Object.create(
          provider === 'google' ? GoogleSyncService.prototype : MicrosoftGraphSyncService.prototype,
        ),
        {
          prisma: { withTenant, withTenantRetry: withTenant },
          association: {
            associate: jest.fn().mockResolvedValue({
              clientId: 'automatically-selected-client',
              score: 1,
              reason: 'domain',
              signals: { domain: true },
            }),
          },
          logger: { warn: jest.fn(), log: jest.fn() },
        },
      );
      const persist = () =>
        provider === 'google'
          ? service.persistGmailMessage(
              TENANT,
              CONNECTION,
              {
                id: 'message-replay',
                threadId: 'thread-external',
                labelIds: ['INBOX'],
                internalDate: String(new Date(WHEN).getTime()),
                snippet: 'Meeting follow-up',
                payload: {
                  mimeType: 'text/plain',
                  headers: [
                    { name: 'Subject', value: 'Meeting' },
                    { name: 'From', value: 'sender@example.com' },
                  ],
                  body: { data: Buffer.from('Meeting follow-up').toString('base64url') },
                },
              },
              'backfill',
            )
          : service.persistGraphMessage(
              TENANT,
              CONNECTION,
              'inbox',
              {
                id: 'message-replay',
                conversationId: 'thread-external',
                subject: 'Meeting',
                from: { emailAddress: { address: 'sender@example.com' } },
                receivedDateTime: WHEN,
                bodyPreview: 'Meeting follow-up',
                body: { contentType: 'text', content: 'Meeting follow-up' },
              },
              'backfill',
            );

      await persist();
      await persist();

      expect(tx.mailThread.update).toHaveBeenCalledTimes(2);
      for (const [{ data }] of tx.mailThread.update.mock.calls) {
        expect(data.clientId).toBe('manually-selected-client');
      }
      expect(savedThread.clientId).toBe('manually-selected-client');
      expect(savedThread.associationSignals).toEqual(expect.objectContaining({ manual: true }));
      expect(tx.mailThread.create).not.toHaveBeenCalled();
    });
  },
);

describe('Graph mail folder discovery coverage', () => {
  function harness(junkLookupStatus: number) {
    return Object.assign(Object.create(MicrosoftGraphSyncService.prototype), {
      logger: { warn: jest.fn(), log: jest.fn() },
      graphGet: jest.fn(async (url: string) => {
        const wellKnown = /^\/me\/mailFolders\/([^?]+)\?\$select=id$/.exec(url)?.[1];
        if (wellKnown === 'junkemail') {
          throw new GraphHttpError(
            `Microsoft Graph GET ${url} failed (${junkLookupStatus}): folder lookup failed`,
            junkLookupStatus,
          );
        }
        if (wellKnown) return { id: `${wellKnown}-id` };
        return {
          value: [
            { id: 'inbox-id', displayName: 'Inbox', totalItemCount: 1 },
            { id: 'sentitems-id', displayName: 'Sent Items', totalItemCount: 1 },
            { id: 'archive-id', displayName: 'Archive', totalItemCount: 1 },
          ],
        };
      }),
    });
  }

  it.each([429, 503])(
    'reports incomplete fallback when a well-known folder lookup fails with %i',
    async (status) => {
      const service = harness(status);
      await expect(service.listSyncableMailFolders(CONNECTION, 'test-token')).resolves.toEqual({
        folders: [],
        enumerated: false,
        coverageComplete: false,
      });
    },
  );

  it('permits a genuinely absent well-known folder while retaining complete enumeration', async () => {
    const service = harness(404);
    await expect(service.listSyncableMailFolders(CONNECTION, 'test-token')).resolves.toEqual({
      folders: [{ key: 'archive-id', pathSegment: 'archive-id', displayPath: 'Archive' }],
      enumerated: true,
      coverageComplete: true,
    });
  });
});
