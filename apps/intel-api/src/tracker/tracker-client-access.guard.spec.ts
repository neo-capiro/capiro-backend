import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { TrackerClientAccessGuard, type TrackerClientRequest } from './tracker-client-access.guard.js';
import { TrackerBoardController } from './tracker-board.controller.js';
import { TrackerWatchlistController } from './tracker-watchlist.controller.js';
import { TrackerChannelController } from './tracker-channel.controller.js';
import { TrackerTenantBoardRead } from './tracker-tenant-board-read.js';
import { TrackerBoardQueries } from './tracker-board-queries.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const clientId = '00000000-0000-4000-8000-000000000003';
const hiddenId = '00000000-0000-4000-8000-000000000004';
const actor = { tenantId, clerkUserId: 'user_synthetic', role: 'standard_user' };
function fixture() {
  const state = { member: true, client: true, allowed: new Set([clientId]) };
  const tx = { $queryRawUnsafe: jest.fn(async (sql: string, _tenant: string, selectedClient: string) => {
    if (sql.startsWith('SELECT id::text FROM clients')) return [{ id: clientId }, { id: hiddenId }];
    if (sql.includes('FROM tenants t')) return state.member && state.client
      ? [{ userId, memberId: 'synthetic', role: 'standard_user', memberUpdatedAt: new Date(0), clientUpdatedAt: new Date(0) }] : [];
    if (sql.includes('client_memory_access')) return [{ allowed: state.allowed.has(selectedClient) }];
    throw new Error('Unexpected synthetic query');
  }) };
  const prisma = { withTenant: jest.fn(async (_tenant, work) => work(tx)) };
  const req: TrackerClientRequest = { tenantContext: actor, params: { clientId } };
  const execution = { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => TrackerBoardController.prototype.getBoard } as ExecutionContext;
  return { state, tx, req, execution, guard: new TrackerClientAccessGuard(prisma as never) };
}

describe('retained Intel tracker request-start client authorization', () => {
  it.each([TrackerBoardController, TrackerWatchlistController, TrackerChannelController])('protects %p through the shared canonical guard', controller => {
    expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toContain(TrackerClientAccessGuard);
  });
  it('binds the signed-in Clerk subject to current Core tenant/member/role and wall scope', async () => {
    const f = fixture();
    expect(await f.guard.canActivate(f.execution)).toBe(true);
    expect(f.req.trackerClientIds).toEqual([clientId]);
    expect(f.tx.$queryRawUnsafe.mock.calls[0]?.slice(1)).toEqual([tenantId, clientId, actor.clerkUserId, null]);
    expect(f.tx.$queryRawUnsafe.mock.calls[0]?.[0]).toContain("m.role::text IN ('standard_user','user_admin','capiro_admin')");
  });
  it.each(['cross-tenant client', 'archived client', 'revoked membership', 'walled client'])('denies %s before native tracker actions', async reason => {
    const f = fixture();
    if (reason.includes('client') && reason !== 'walled client') f.state.client = false;
    if (reason === 'revoked membership') f.state.member = false;
    if (reason === 'walled client') f.state.allowed.clear();
    const action = jest.fn();
    await expect((async () => { await f.guard.canActivate(f.execution); action(); })()).rejects.toBeInstanceOf(NotFoundException);
    expect(action).not.toHaveBeenCalled();
  });
  it('does not cache a deleted wall grant or accept a query/body client hint', async () => {
    const f = fixture();
    await f.guard.canActivate(f.execution);
    f.state.allowed.clear();
    Object.assign(f.req, { body: { clientId: hiddenId }, query: { clientId: hiddenId } });
    await expect(f.guard.canActivate(f.execution)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('narrows the all-client scope to authorized clients', async () => {
    const f = fixture(); f.req.params = { clientId: '_all' };
    expect(await f.guard.canActivate(f.execution)).toBe(true);
    expect(f.req.trackerClientIds).toEqual([clientId]);
    f.state.allowed.clear();
    expect(await f.guard.canActivate(f.execution)).toBe(true);
    expect(f.req.trackerClientIds).toEqual([]);
  });
  it('does not treat missing or _all client IDs as authority for native mutations', async () => {
    const f = fixture();
    const execution = { ...f.execution, getHandler: () => TrackerBoardController.prototype.trackBill } as ExecutionContext;
    f.req.params = {};
    await expect(f.guard.canActivate(execution)).rejects.toBeInstanceOf(NotFoundException);
    f.req.params = { clientId: '_all' };
    await expect(f.guard.canActivate(execution)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });
  it('intersects all-board filters with authorized clients and scopes portfolio counts', () => {
    const svc = { getTenantBoard: jest.fn(), getPortfolioCounts: jest.fn() };
    const controller = new TrackerBoardController(svc as never);
    const req = { trackerClientIds: [clientId] };
    controller.getBoard(actor, '_all', { clientIds: [hiddenId] } as never, req);
    expect(svc.getTenantBoard.mock.calls[0]?.[1].filters.clientIds).toEqual([]);
    controller.getPortfolioCounts(actor, req);
    expect(svc.getPortfolioCounts).toHaveBeenCalledWith(tenantId, [clientId]);
  });
  it.each([[clientId], []].map(clientIds => ({ clientIds })))('applies authorized IDs $clientIds to page and count queries before pagination', async ({ clientIds }) => {
    const tx = { trackedBill: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), groupBy: jest.fn().mockResolvedValue([]) } };
    const host = { prisma: { withTenant: async (_tenant: string, work: (value: typeof tx) => unknown) => work(tx) }, alignStateStageFilter: jest.fn() };
    const reader = new TrackerTenantBoardRead({ pageSize: 25, pageSizeMax: 100, recentChangeDays: 21, dayMs: 86400000 });
    await reader.getTenantBoard(host as never, tenantId, { filters: { clientIds } });
    expect(tx.trackedBill.findMany.mock.calls[0]?.[0].where.clientId).toEqual({ in: clientIds });
    expect(tx.trackedBill.count.mock.calls[0]?.[0].where.clientId).toEqual({ in: clientIds });
    await new TrackerBoardQueries().getPortfolioCounts(host as never, tenantId, clientIds);
    expect(tx.trackedBill.groupBy.mock.calls[0]?.[0].where.clientId).toEqual({ in: clientIds });
  });
});
