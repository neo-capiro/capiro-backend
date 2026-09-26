import type { TenantContext } from '@capiro/shared';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import type { R5DistrictContext } from './r5-types.js';
import { rankDistrictActions, R5DistrictActionsService } from './r5-district-actions.service.js';
import { R5DistrictActionsController } from './r5-district-actions.controller.js';
import { R5FlagGuard, DISTRCT_NEXUS_R5_ACTIONS } from './r5-flag.guard.js';
import { validateTransition } from '../../intelligence/actions/action-transitions.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1', role: 'standard_user' } as TenantContext;
const context: R5DistrictContext = { clientId: '11111111-1111-4111-8111-111111111111', clientName: 'Client', state: 'TX', district: '08', generatedAt: '2026-01-01', sourceHealth: [], gaps: [], facts: [{
  id: 'footprint:facility:a', section: 'footprint', label: 'Site', value: null, unit: null, amountStage: null,
  basis: 'verified_client_nexus', source: { type: 'facility', label: 'Facility', recordId: 'a', url: null },
  asOf: { date: null, fiscalYear: null, sourceYear: null }, geography: { state: 'TX', district: '08', scope: 'district', basis: null, boundaryCongress: null },
  freshness: { stale: false, unavailable: false, lastSyncedAt: null }, coverage: 'complete', caveats: [],
}] };

describe('district action ranker', () => {
  it('is stable, capped, and never targets a missing representation fact', () => {
    const first = rankDistrictActions(context, ctx.userId);
    expect(first).toEqual(rankDistrictActions(context, ctx.userId));
    expect(first.length).toBeLessThanOrEqual(5);
    expect(first[0]?.actionType).toBe('district_one_pager');
    expect(first.every((c) => c.targetAudience.length === 0)).toBe(true);
  });
  it('escalates identity uncertainty and lowers partial/stale confidence', () => {
    const result = rankDistrictActions({ ...context, gaps: [{ section: 'footprint', reason: 'Client UEI identity needed', source: null }],
      facts: [{ ...context.facts[0]!, coverage: 'partial', freshness: { ...context.facts[0]!.freshness, stale: true } }] }, ctx.userId);
    expect(result[0]?.actionType).toBe('escalate_uncertainty');
    expect(result[0]?.confidence.clientRelevance).toBe('low');
    expect(result[1]?.confidence.clientRelevance).toBe('low');
    expect(result[1]?.uncertainty).toMatch(/Partial source coverage/);
  });
});

describe('district action API boundary', () => {
  const rows: Array<Record<string, unknown>> = [];
  const tx = {
    actionRecommendation: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => Object.entries(where).every(([k, v]) => k === 'evidence' || r[k] === v)) ?? null),
      findMany: jest.fn(async () => rows.map((r) => ({ id: r.id }))),
      createMany: jest.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => { if (rows.length) return { count: 0 }; rows.push({ ...data[0], id: 'action-1' }); return { count: 1 }; }),
    },
    auditLog: { create: jest.fn() },
  };
  const prisma = { withTenant: jest.fn(async (_tenant: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
  const contextService = { getContext: jest.fn(async (tenant: string) => {
    if (tenant !== ctx.tenantId) throw new NotFoundException();
    return context;
  }) };
  const read = { getOne: jest.fn(async () => ({ id: 'action-1', districtKey: 'TX-08' })),
    updateStatus: jest.fn(async (_c, _id, status: string, reason?: string) => {
      const transition = validateTransition('triaged', status as 'dismissed', { dismissalReason: reason });
      if (!transition.ok) throw new BadRequestException(transition.error);
      return { status };
    }) };
  const service = new R5DistrictActionsService(prisma as never, contextService as never, read as never);
  const controller = new R5DistrictActionsController(service);
  beforeEach(() => { rows.length = 0; jest.clearAllMocks(); });
  it('stages once, persists district key, and returns the existing card on replay', async () => {
    const key = rankDistrictActions(context, ctx.userId)[0]!.key;
    await controller.stage(ctx, { clientId: context.clientId, state: 'TX', district: '08', key });
    await controller.stage(ctx, { clientId: context.clientId, state: 'TX', district: '08', key });
    expect(tx.actionRecommendation.createMany).toHaveBeenCalledTimes(1);
    expect(rows[0]?.districtKey).toBe('TX-08');
  });
  it('returns 404 for another tenant and rejects invalid dismissal', async () => {
    await expect(controller.list({ ...ctx, tenantId: 'other' }, context.clientId, 'TX', '08')).rejects.toBeInstanceOf(NotFoundException);
    rows.push({ id: 'action-1', clientId: context.clientId, tenantId: ctx.tenantId, districtKey: 'TX-08' });
    await expect(controller.status(ctx, 'action-1', { clientId: context.clientId, state: 'TX', district: '08', status: 'dismissed' })).rejects.toBeInstanceOf(BadRequestException);
    expect(read.updateStatus).toHaveBeenCalled();
  });
  it('fails closed when the actions flag is off', async () => {
    const flag = new R5FlagGuard({ withSystem: jest.fn(async () => []) } as never, { get: jest.fn() } as never, {} as never);
    await expect(flag.assertEnabledForTenant(ctx.tenantId, DISTRCT_NEXUS_R5_ACTIONS)).rejects.toBeInstanceOf(NotFoundException);
  });
});
