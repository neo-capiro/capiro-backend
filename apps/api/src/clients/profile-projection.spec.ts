import type { TenantContext } from '@capiro/shared';
import { ProfileProjectionService } from './profile-projection.service.js';

const ctx = { tenantId: 'tenant', userId: 'actor' } as TenantContext;
test('passes explicit address clearing through the canonical helper and delays effects until commit', async () => {
  const facility = { id: 'site', addressLine: '', congressionalDistrict: null };
  const canonical = jest.fn(async (..._args: unknown[]) => ({ facility, addressChanged: true })),
    after = jest.fn();
  const service = new ProfileProjectionService(
    {} as never,
    {} as never,
    { updateFacilityInTransaction: canonical, afterFacilityUpdated: after } as never,
    {} as never,
  );
  const effects: Array<() => unknown> = [];
  const tx = {
    clientFacility: {
      findFirst: async () => ({
        id: 'site',
        addressLine: 'Old address',
        congressionalDistrict: '01',
      }),
    },
  };
  const result = await service.project(
    { tx: tx as never, afterCommit: effects as never },
    ctx,
    { kind: 'client', id: 'client' },
    'locations.site',
    { id: 'site', name: 'Factory', addressLine: '' },
  );
  expect(canonical.mock.calls[0]?.[4]).toMatchObject({ addressLine: '' });
  expect(after).not.toHaveBeenCalled();
  expect(result).toMatchObject({ id: 'site', addressLine: '' });
  await effects[0]!();
  expect(after).toHaveBeenCalledWith(ctx, { facility, addressChanged: true });
});
test('preserves a sourced capability lifecycle through canonical projection', async () => {
  const create = jest.fn(async (..._args: unknown[]) => ({ id: 'new-capability' }));
  const service = new ProfileProjectionService(
    {} as never,
    {} as never,
    {} as never,
    { createCapabilityInTransaction: create, afterCapabilityCreated: jest.fn() } as never,
  );
  await service.project(
    { tx: {} as never, afterCommit: [] },
    ctx,
    { kind: 'client', id: 'client' },
    'capabilities.source',
    { name: 'Planned program', type: 'program', lifecycle: 'planned', description: '' },
  );
  expect(create.mock.calls[0]?.[3]).toMatchObject({ lifecycle: 'planned', description: '' });
});
