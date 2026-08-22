import { ConflictException, NotFoundException } from '@nestjs/common';
import { DistrictNexusEconomicService } from './district-nexus-economic.service.js';

function tenantHarness(
  options: {
    imports?: unknown[];
    evidence?: unknown[];
    queryRows?: unknown[][];
    client?: { id: string } | null;
  } = {},
) {
  const queryRaw = jest.fn();
  if (options.queryRows) {
    for (const rows of options.queryRows) queryRaw.mockResolvedValueOnce(rows);
  } else {
    queryRaw
      .mockResolvedValueOnce(options.imports ?? [])
      .mockResolvedValueOnce(options.evidence ?? []);
  }
  const tx = {
    client: {
      findFirst: jest.fn().mockResolvedValue(
        options.client === undefined ? { id: 'client-1' } : options.client,
      ),
    },
    $queryRaw: queryRaw,
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (arg: typeof tx) => unknown) => fn(tx)),
    $queryRaw: jest.fn(),
  };
  return { prisma, tx };
}

const now = new Date('2026-08-22T12:00:00.000Z');

function evidenceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e-1',
    import_id: 'i-1',
    row_ordinal: 1,
    evidence_type: 'employee',
    subject_id: null,
    subject_name: 'Plant A',
    address_line1: null,
    address_line2: null,
    city: 'Austin',
    state: 'TX',
    postal_code: null,
    country: 'US',
    latitude: null,
    longitude: null,
    congressional_district: '10',
    congressional_district_congress: 119,
    district_source: 'provided',
    numeric_value: 100,
    unit: 'people',
    currency: null,
    source_type: 'client_import',
    source_record_id: 'row-1-1',
    verification_status: 'user_provided',
    review_status: 'approved',
    confidence: null,
    external_use_approved: false,
    effective_from: null,
    effective_to: null,
    observed_at: null,
    metadata_jsonb: {},
    promoted_facility_id: null,
    created_at: now,
    reviewed_at: now,
    ...overrides,
  };
}

function importRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    client_id: 'client-1',
    filename: 'footprint.csv',
    format: 'csv',
    status: 'preview',
    content_sha256: 'abc123',
    row_count: 1,
    accepted_count: 1,
    rejected_count: 0,
    preview_jsonb: [],
    warnings_jsonb: [],
    effective_date: null,
    external_use_approved: false,
    created_at: now,
    committed_at: null,
    ...overrides,
  };
}

describe('DistrictNexusEconomicService', () => {
  it('keeps pending evidence out of approved economic totals and reports it separately', async () => {
    const approved = evidenceRow({ id: 'approved', numeric_value: 125 });
    const pending = evidenceRow({
      id: 'pending',
      numeric_value: 900,
      review_status: 'pending_review',
    });
    const { prisma } = tenantHarness({ evidence: [approved, pending] });
    const service = new DistrictNexusEconomicService(prisma as never);

    const result = await service.getClientFootprint('tenant-1', 'client-1');

    expect(result.totals.employeeCount).toBe(125);
    expect(result.totals.approvedEvidenceCount).toBe(1);
    expect(result.totals.pendingEvidenceCount).toBe(1);
    expect(result.warnings.join(' ')).toContain('await review');
  });

  it('returns null rather than zero for unmeasured money fields', async () => {
    const { prisma } = tenantHarness({ evidence: [evidenceRow()] });
    const service = new DistrictNexusEconomicService(prisma as never);

    const result = await service.getClientFootprint('tenant-1', 'client-1');

    expect(result.totals.payroll).toBeNull();
    expect(result.totals.capitalInvestment).toBeNull();
    expect(result.totals.taxes).toBeNull();
    expect(result.coverage.missing).toContain('payroll');
  });

  it('keeps rejected evidence as history but out of districts and active unresolved warnings', async () => {
    const rejected = evidenceRow({
      id: 'rejected',
      state: 'CA',
      congressional_district: '12',
      review_status: 'rejected',
    });
    const rejectedUnresolved = evidenceRow({
      id: 'rejected-unresolved',
      state: null,
      congressional_district: null,
      review_status: 'rejected',
    });
    const { prisma } = tenantHarness({ evidence: [rejected, rejectedUnresolved] });
    const service = new DistrictNexusEconomicService(prisma as never);

    const result = await service.getClientFootprint('tenant-1', 'client-1');

    expect(result.evidence).toHaveLength(2);
    expect(result.districts).toEqual([]);
    expect(result.warnings.join(' ')).not.toContain('cannot yet be placed');
  });

  it('does not count public district context as client-owned economic evidence', async () => {
    const { prisma } = tenantHarness({ evidence: [] });
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          source: 'cbp',
          dataset: 'cbp',
          source_year: 2023,
          boundary_congress: 119,
          metric_key: 'employment',
          metric_value: 14_280,
          unit: 'people',
          margin_of_error: null,
          naics_code: '31-33',
          source_record_id: '48:10:31-33:EMP',
          source_url: 'https://api.census.gov/',
          observed_at: now,
          last_synced_at: now,
          metadata_jsonb: {},
        },
      ])
      .mockResolvedValueOnce([]);
    const service = new DistrictNexusEconomicService(prisma as never);

    const context = await service.getDistrictContext('tx', '10');
    const footprint = await service.getClientFootprint('tenant-1', 'client-1');

    expect(context.metrics[0]?.value).toBe(14_280);
    expect(footprint.totals.employeeCount).toBeNull();
    expect(footprint.totals.approvedEvidenceCount).toBe(0);
  });

  it('rejects a cross-client import lookup through explicit tenant/client predicates', async () => {
    const { prisma, tx } = tenantHarness({ queryRows: [[]] });
    const service = new DistrictNexusEconomicService(prisma as never);

    await expect(
      service.commitImport(
        'tenant-1',
        null,
        'client-1',
        '00000000-0000-0000-0000-000000000001',
      ),
    ).rejects.toThrow('Footprint import not found');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('blocks a duplicate committed file before evidence is inserted', async () => {
    const { prisma, tx } = tenantHarness({
      queryRows: [[importRow()], [{ id: 'already-committed' }]],
    });
    const service = new DistrictNexusEconomicService(prisma as never);

    await expect(
      service.commitImport(
        'tenant-1',
        null,
        'client-1',
        '00000000-0000-0000-0000-000000000001',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('makes review decisions terminal while preserving same-decision idempotency', async () => {
    const approved = evidenceRow({ review_status: 'approved' });
    const idempotent = tenantHarness({ queryRows: [[approved]] });
    const service = new DistrictNexusEconomicService(idempotent.prisma as never);
    await expect(
      service.decideEvidence('tenant-1', null, 'client-1', 'e-1', 'approve', {}),
    ).resolves.toMatchObject({ reviewStatus: 'approved' });
    expect(idempotent.tx.$queryRaw).toHaveBeenCalledTimes(1);

    const conflicting = tenantHarness({ queryRows: [[approved]] });
    const conflictService = new DistrictNexusEconomicService(conflicting.prisma as never);
    await expect(
      conflictService.decideEvidence('tenant-1', null, 'client-1', 'e-1', 'reject', {}),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('asserts client ownership before reporting supplier-footprint availability', async () => {
    const { prisma } = tenantHarness({ client: null });
    const service = new DistrictNexusEconomicService(prisma as never);
    await expect(
      service.getSupplierFootprintStatus('tenant-1', 'other-tenant-client'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
