import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { R5MeriDistrictTools } from './r5-meri-district-tools.js';
import type { R5DistrictContext } from './r5-types.js';
import type { R5DistrictContextService } from './r5-district-context.service.js';
import type { R5FlagGuard } from './r5-flag.guard.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

const ctx = { tenantId: 'tenant-one' } as TenantContext;
const input = { clientId: 'client-one', state: 'FL', district: '08' };
const fixture: R5DistrictContext = {
  ...input, clientName: 'Client One', generatedAt: '2026-09-24T00:00:00.000Z', sourceHealth: [],
  facts: [{
    id: 'cpf_cds:requested:r1', section: 'cpf_cds', label: 'Request', value: 0,
    unit: 'USD', amountStage: 'requested', basis: 'public_context',
    source: { type: 'cpf_cds', label: 'House CPF', recordId: 'r1', url: null },
    asOf: { date: null, fiscalYear: 2027, sourceYear: null },
    geography: { state: 'FL', district: '08', scope: 'district', basis: null, boundaryCongress: null },
    freshness: { lastSyncedAt: null, stale: true, unavailable: true },
    coverage: 'partial', caveats: ['stale_source'],
  }],
  gaps: [{ section: 'economic', reason: 'Economic rail unavailable', source: 'census' }],
};

function setup() {
  const flags = { assertEnabledForTenant: jest.fn().mockResolvedValue(true) };
  const context = { getContext: jest.fn().mockResolvedValue(fixture) };
  const prisma = { districtNexusChange: { findMany: jest.fn().mockResolvedValue([]) } };
  const tools = new R5MeriDistrictTools(
    flags as unknown as R5FlagGuard,
    context as unknown as R5DistrictContextService,
    prisma as unknown as PrismaService,
  );
  return { tools, flags, context, prisma };
}

describe('R5 Meri district reads', () => {
  it('uses the page context facts unchanged, including zero, stage, provenance and gaps', async () => {
    const { tools, context } = setup();
    const result = await tools.getContext(ctx, input);
    expect(context.getContext).toHaveBeenCalledWith(ctx.tenantId, input.clientId, 'FL', '08');
    expect(result).toMatchObject({ available: true, facts: fixture.facts, gaps: fixture.gaps });
  });

  it('returns structured disabled results without reading any rail', async () => {
    const { tools, flags, context, prisma } = setup();
    flags.assertEnabledForTenant.mockRejectedValue(new NotFoundException());
    expect(await tools.getContext(ctx, input)).toEqual({ available: false, reason: 'feature_disabled' });
    expect(await tools.getChanges(ctx, input)).toEqual({ available: false, reason: 'feature_disabled' });
    expect(context.getContext).not.toHaveBeenCalled();
    expect(prisma.districtNexusChange.findMany).not.toHaveBeenCalled();
  });

  it('rejects another tenant client before querying changes', async () => {
    const { tools, context, prisma } = setup();
    context.getContext.mockRejectedValue(new NotFoundException('Client not found'));
    await expect(tools.getChanges(ctx, { ...input, clientId: 'other-client' })).rejects.toThrow(NotFoundException);
    expect(prisma.districtNexusChange.findMany).not.toHaveBeenCalled();
  });

  it('keeps supported facts with rail gaps; change ledger filters baseline and honors since', async () => {
    const { tools, prisma } = setup();
    expect(await tools.getContext(ctx, input)).toMatchObject({ facts: fixture.facts, gaps: fixture.gaps });
    prisma.districtNexusChange.findMany.mockResolvedValue([{
      changeKind: 'request_updated', source: 'cpf_cds', sourceRecordId: 'r1',
      observedAt: new Date('2026-09-24T01:00:00.000Z'), effectiveAt: null,
      severity: 'notable', oldValue: null, newValue: { amount: 0 },
    }]);
    const result = await tools.getChanges(ctx, { ...input, since: '2026-09-23T00:00:00Z' });
    expect(prisma.districtNexusChange.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ observationKind: 'change', observedAt: { gte: new Date('2026-09-23T00:00:00Z') } }),
      take: 20,
    }));
    expect(result).toMatchObject({ available: true, changes: [{ source: 'cpf_cds', severity: 'notable', observedAt: '2026-09-24T01:00:00.000Z' }] });
    prisma.districtNexusChange.findMany.mockRejectedValue(new Error('rail unavailable'));
    expect(await tools.getChanges(ctx, input)).toMatchObject({ changes: [], gaps: [{ reason: 'Change ledger unavailable' }] });
  });
});
