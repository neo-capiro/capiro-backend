import { GoogleSyncService } from './google/google-sync.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';

describe.each([
  { provider: 'Google', prototype: GoogleSyncService.prototype, method: 'persistCalendarEvent', title: { summary: 'Meeting' } },
  { provider: 'Microsoft', prototype: MicrosoftGraphSyncService.prototype, method: 'persistGraphEvent', title: { subject: 'Meeting' } },
])('$provider meeting client choices survive repeated sync', ({ prototype, method, title }) => {
  test.each([
    { label: 'assigned', clientId: 'client-b', isInternal: false },
    { label: 'cleared', clientId: null, isInternal: false },
    { label: 'internal', clientId: null, isInternal: true },
  ])('$label choice and manual signal persist over two imports', async ({ clientId, isInternal }) => {
    const row = { id: 'meeting-1', clientId, isInternal, associationScore: clientId ? 1 : null, associationReason: 'Manual user choice', associationSignals: { manual: true }, status: 'scheduled' };
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      meeting: {
        findUnique: jest.fn(async () => ({ ...row })),
        update: jest.fn(async ({ data }: { data: Partial<typeof row> }) => { Object.assign(row, data); return row; }),
      },
      clientAssociationOverride: { findFirst: jest.fn().mockResolvedValue(null) },
      meetingAttendee: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const service = Object.create(prototype);
    Object.assign(service, {
      prisma: {
        withTenant: async (_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx),
        withTenantRetry: async (_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx),
      },
      association: { associate: jest.fn().mockResolvedValue({ clientId: 'wrong-client', score: 0.95, reason: 'Email match', signals: { auto: true } }) },
    });
    const event = {
      id: 'provider-event', ...title,
      start: { dateTime: '2026-09-08T15:00:00Z', timeZone: 'UTC' },
      end: { dateTime: '2026-09-08T16:00:00Z', timeZone: 'UTC' },
    };
    for (let i = 0; i < 2; i++) {
      await expect(service[method]('tenant-1', 'connection-1', event)).resolves.toBe('matched');
      expect(row.clientId).toBe(clientId);
      expect(row.associationSignals).toEqual({ manual: true });
      expect(row.associationScore).toBe(clientId ? 1 : null);
      expect(row.associationReason).toBe('Manual user choice');
    }
  });
});
