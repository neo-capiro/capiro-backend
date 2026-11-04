import { ProfileBuildService } from './profile-build.service.js';
import type { TenantContext } from '@capiro/shared';
const ctx = { tenantId: 'tenant-fixture', userId: 'actor-fixture' } as TenantContext;
const prospect = { kind: 'prospect' as const, id: 'prospect-fixture' };
function service() {
  const instance = Object.create(ProfileBuildService.prototype) as ProfileBuildService;
  const startRun = jest.fn(async () => ({ id: 'run-fixture' }));
  const query = jest.fn(() => {
    throw new Error('Unexpected persistence');
  });
  Object.assign(instance, {
    completion: { startRun },
    prisma: { withTenantUser: query, withTenant: query },
  });
  return { instance, startRun, query };
}
it.each([
  { purpose: 'alignment' },
  { purpose: 'capabilities' },
  { purpose: 'business_units' },
  { capabilityId: 'capability-fixture' },
  { businessUnitId: 'unit-fixture' },
])('rejects client-only producer scope on a prospect before persistence: %j', async (scope) => {
  const h = service();
  await expect(
    h.instance.start(ctx, prospect, {
      requestId: 'request-fixture',
      sources: ['public_web'],
      ...scope,
    }),
  ).rejects.toThrow('require a client profile');
  expect(h.query).not.toHaveBeenCalled();
  expect(h.startRun).not.toHaveBeenCalled();
});
it('passes client producer scope intact to the existing durable completion owner', async () => {
  const h = service(),
    input = {
      requestId: 'request-fixture',
      sources: ['public_web' as const],
      purpose: 'alignment',
      capabilityId: 'capability-fixture',
    };
  await h.instance.start(ctx, { kind: 'client', id: 'client-fixture' }, input);
  expect(h.startRun).toHaveBeenCalledWith(ctx, 'client-fixture', input);
});
