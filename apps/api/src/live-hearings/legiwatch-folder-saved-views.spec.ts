import type { TenantContext } from '@capiro/shared';
import { LegiWatchWave2SavedViewsService } from './legiwatch-wave2-saved-views.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const folderId = '33333333-3333-4333-8333-333333333333';
const ctx = { tenantId, userId: 'owner' } as TenantContext;
function harness(params: Record<string, string>, folders: object[] = []) {
  const row = {
    id: 'view',
    surface: 'bills',
    name: 'Scoped',
    scope: 'personal',
    isDefault: false,
    clientId: null,
    configVersion: 1,
    config: { filters: { params } },
    ownerUserId: 'owner',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const tx = {
    legiWatchSavedView: { findFirst: jest.fn().mockResolvedValue(row) },
    client: { findFirst: jest.fn().mockResolvedValue({ status: 'active' }) },
    $queryRaw: jest.fn().mockResolvedValue(folders),
  };
  const withTenant = jest.fn(async (_id, fn) => fn(tx));
  return {
    service: new LegiWatchWave2SavedViewsService({ withTenant } as never),
    tx,
    withTenant,
    row,
  };
}
describe('folder saved-view scope restoration', () => {
  it('warns about missing folders while retaining the exact saved scope', async () => {
    const h = harness({ folder: folderId, client: clientId });
    const result = await h.service.apply(ctx, 'view');
    expect(result.folderWarning).toMatch(/unavailable/);
    expect(result.config).toEqual(h.row.config);
    expect(h.withTenant.mock.calls.every(([id]) => id === tenantId)).toBe(true);
  });
  it('rejects a folder/client mismatch and accepts its actual client', async () => {
    const wrong = harness({ folder: folderId, client: clientId }, [
      { id: folderId, clientId: null },
    ]);
    expect((await wrong.service.apply(ctx, 'view')).folderWarning).toMatch(/saved client scope/);
    const right = harness({ folder: folderId, client: clientId }, [{ id: folderId, clientId }]);
    expect((await right.service.apply(ctx, 'view')).folderWarning).toBeNull();
  });
  it('treats malformed saved clients as unavailable without an invalid UUID query', async () => {
    const h = harness({ client: 'not-a-client-uuid' });
    expect((await h.service.apply(ctx, 'view')).clientWarning).toMatch(/unavailable/);
    expect(h.tx.client.findFirst).not.toHaveBeenCalled();
  });
});
