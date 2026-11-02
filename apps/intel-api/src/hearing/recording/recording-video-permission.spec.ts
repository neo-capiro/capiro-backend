import { RecordingPermissionService } from './recording-permission.service.js';
jest.mock('./recording-storage.service.js', () => ({ RecordingStorageService: jest.fn() }));

it('withholds video enable when its actual database function is absent', async () => {
  const service = new RecordingPermissionService(
    {} as never,
    {} as never,
    { enabled: true, assertReady: jest.fn() } as never,
  );
  const query = jest
    .fn()
    .mockResolvedValueOnce([{ eligible: true }])
    .mockResolvedValueOnce([{ available: false }]);
  await expect(service.canEnableVideo({ $queryRaw: query } as never, 'session')).resolves.toBe(
    false,
  );
  query
    .mockReset()
    .mockResolvedValueOnce([{ eligible: true }])
    .mockResolvedValueOnce([{ available: false }]);
  await expect(service.enableVideo({ $queryRaw: query } as never, 'session')).rejects.toThrow(
    'Video permission is unavailable',
  );
  expect(query).toHaveBeenCalledTimes(2);
});

it('requires a distinct video operation and current source-bound grant', async () => {
  const source = { sourceUrl: 'https://official.example/hearing', hearingId: 'hearing' };
  const findMany = jest.fn().mockResolvedValue([]);
  const service = new RecordingPermissionService(
    {
      withTenant: async (_tenant: string, work: (tx: unknown) => unknown) =>
        work({ hearingMediaPermission: { findMany } }),
    } as never,
    { isEnabled: async () => true } as never,
    { enabled: true } as never,
  );
  await expect(service.require('tenant', source, true)).rejects.toThrow();
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        ...source,
        tenantId: 'tenant',
        mode: 'browser',
        revokedAt: null,
        operations: { has: 'video_retention' },
      }),
    }),
  );
  const grant = {
    ...source,
    mode: 'browser',
    operations: ['capture', 'transcription', 'retention', 'video_retention'],
    revokedAt: null,
    expiresAt: new Date('2099-01-01'),
    retentionDays: 30,
  };
  findMany.mockResolvedValue([grant]);
  await expect(service.require('tenant', source, true)).resolves.toEqual(grant);
  findMany.mockResolvedValue([{ ...grant, revokedAt: new Date() }]);
  await expect(service.require('tenant', source, true)).rejects.toThrow();
});
