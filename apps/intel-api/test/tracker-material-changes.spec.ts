import { TrackerBoardService } from '../src/tracker/tracker-board.service.js';
import { TrackerBoardController } from '../src/tracker/tracker-board.controller.js';
import { TenantGuard } from '../src/auth/tenant.guard.js';
import { TrackerOwnerGuard } from '../src/tracker/tracker-owner.guard.js';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const ctx = { tenantId: id(1), clerkUserId: 'synthetic-clerk', role: 'standard_user' };
test('Intel mounted service uses its full federal/state event aggregate and current canonical actor/wall', async () => {
  let allowed = true, queries = 0; const seen: string[] = [];
  const prisma: any = { withTenant: async (tenant: string, read: any, options: any) => {
    expect(tenant).toBe(ctx.tenantId); expect(options.timeoutMs).toBeGreaterThan(0);
    return read({ $executeRawUnsafe: async () => 1, $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      seen.push(sql);
      if (sql.includes('FROM tenants t')) {
        expect(params).toEqual([ctx.tenantId, id(3), ctx.clerkUserId, null]);
        return [{ userId: id(2), memberId: id(4), role: 'standard_user', memberUpdatedAt: 1, clientUpdatedAt: 1 }];
      }
      if (sql.includes('AS allowed')) { expect(params[2]).toBe(id(2)); return [{ allowed }]; }
      queries++; expect(sql).toContain('FROM intel_tracked_bill'); expect(sql).toContain("a.source_type='state_bill'");
      expect(sql).not.toContain('intelligence_change');
      return [{ count: '230', unsupported: '0', sourceObservedAt: new Date(Date.now() - 1000) }];
    } });
  } };
  const service = new TrackerBoardService(prisma, {} as any, {} as any, {} as any), controller = new TrackerBoardController(service);
  await expect(controller.materialChanges(ctx, id(3), {})).resolves.toMatchObject({ backend: 'intelligence', count: 230, complete: true, capped: false });
  expect(seen.filter(sql => sql.includes('FROM tenants t'))).toHaveLength(2);
  allowed = false; await expect(controller.materialChanges(ctx, id(3), {})).rejects.toMatchObject({ status: 404 });
  expect(queries).toBe(1);
  await expect(controller.materialChanges(ctx, id(3), { unread: true })).rejects.toMatchObject({ status: 400 });
  expect(Reflect.getMetadata('__guards__', TrackerBoardController)).toEqual([TenantGuard, TrackerOwnerGuard]);
  expect(Reflect.getMetadata('path', TrackerBoardController.prototype.materialChanges)).toBe(':clientId/tracker/material-changes');
  expect(Reflect.getMetadata('__headers__', TrackerBoardController.prototype.materialChanges)).toEqual([{ name: 'Cache-Control', value: 'private, no-store' }]);
});
