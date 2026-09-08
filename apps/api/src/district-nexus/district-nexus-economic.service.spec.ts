import { ConflictException, NotFoundException } from '@nestjs/common';
import { DistrictNexusEconomicService } from './district-nexus-economic.service.js';
import { UNFILTERED_SUBAWARD_SYNC_KEY } from '../external/tango/tango-subaward-sync-key.js';

function tenantHarness(
  options: {
    imports?: unknown[];
    evidence?: unknown[];
    queryRows?: unknown[][]; // DEPRECATED: only used by import-flow tests below.
    client?: { id: string } | null;
    /** Router-mocked rows for the supplier-status queries (longest-match first). */
    subawardCoverage?: Array<{ n: bigint; last_synced_at: Date | null }>;
    subawardCheckpoint?: Array<Record<string, unknown>>;
    subawardMatches?: Array<{ n: bigint }>;
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
      findFirst: jest
        .fn()
        .mockResolvedValue(options.client === undefined ? { id: 'client-1' } : options.client),
    },
    $queryRaw: queryRaw,
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  // Router keyed on distinctive SQL fragments, most-specific first: the
  // checkpoint table name, then the match query's UEI join, then the plain
  // active-row coverage aggregate. $queryRaw is invoked as a TAGGED TEMPLATE,
  // so the first argument is the raw template-strings array (jest.fn receives
  // (stringsArray, ...values)), not a Prisma.sql object.
  const prismaQueryRaw = jest.fn((...args: unknown[]) => {
    const first = args[0] as { sql?: string; strings?: string[] } | string[];
    const text = Array.isArray(first)
      ? first.join(' ')
      : String(first?.sql ?? (first?.strings ?? []).join(' '));
    if (text.includes('tango_subaward_sync_checkpoint')) {
      return Promise.resolve(options.subawardCheckpoint ?? []);
    }
    if (text.includes('subawardee_uei')) {
      return Promise.resolve(options.subawardMatches ?? [{ n: 0n }]);
    }
    if (text.includes('max(last_synced_at)')) {
      return Promise.resolve(options.subawardCoverage ?? [{ n: 0n, last_synced_at: null }]);
    }
    return Promise.resolve([]);
  });
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (arg: typeof tx) => unknown) => fn(tx)),
    $queryRaw: prismaQueryRaw,
  };
  return { prisma, tx };
}

/** A row shaped like tango_subaward_sync_checkpoint for the unfiltered walk. */
// Keys mirror the service's SELECT aliases (camelCase), not the raw columns.
function checkpointRow(overrides: Record<string, unknown> = {}) {
  return {
    windowEnd: new Date('2026-09-08T03:16:34.000Z'),
    completeness: 'in_progress',
    pageSize: 25,
    totalReported: 2743636n,
    ...overrides,
  };
}

const now = new Date('2026-08-22T12:00:00.000Z');

describe('supplier status reports observed coverage and usable identity', () => {
  test.each([
    [0, now, 'ABCDEF123456', 0, 'not_populated'],
    [20, null, 'ABCDEF123456', 0, 'unavailable'],
    [20, now, null, 0, 'no_identity'],
    [20, now, ' ', 0, 'no_identity'],
    [20, now, 'bad-uei', 0, 'no_identity'],
    [20, now, 'ABCDEF123456', 0, 'no_matching_records'],
    [20, now, 'ABCDEF123456', 2, 'available'],
  ])('source=%s lastSync=%s uei=%s matches=%s → %s', async (rows, synced, uei, matches, status) => {
    const { prisma, tx } = tenantHarness({
      subawardCoverage: [{ n: BigInt(rows), last_synced_at: synced }],
      // A completed unfiltered walk: these legacy cases keep their strong
      // "real empty result" wording only when the corpus is actually complete.
      subawardCheckpoint: [checkpointRow({ completeness: 'complete', next_page: 1 })],
      subawardMatches: [{ n: BigInt(matches) }],
    });
    tx.client.findFirst.mockResolvedValue({ id: 'client-1', uei } as never);
    Object.assign(tx, {
      clientIntelMapping: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const response = await new DistrictNexusEconomicService(
      prisma as never,
    ).getSupplierFootprintStatus('tenant-1', 'client-1');
    expect(response.status).toBe(status);
    expect(response.available).toBe(status === 'available');
    if (status === 'no_identity' || status === 'not_populated')
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2); // coverage + checkpoint
  });
});

describe('supplier status separates source completeness from client matching', () => {
  const uei = 'ABCDEF123456';

  function statusHarness(options: Parameters<typeof tenantHarness>[0]) {
    const { prisma, tx } = tenantHarness(options);
    tx.client.findFirst.mockResolvedValue({ id: 'client-1', uei } as never);
    Object.assign(tx, { clientIntelMapping: { findMany: jest.fn().mockResolvedValue([]) } });
    return { prisma, tx, service: () => new DistrictNexusEconomicService(prisma as never) };
  }

  it('partial coverage with matches still shows available but qualifies the corpus as in progress', async () => {
    // The exact live shape after the first bounded Tango run: 25 rows ingested,
    // unfiltered walk checkpoint in_progress.
    const { service } = statusHarness({
      subawardCoverage: [{ n: 25n, last_synced_at: now }],
      subawardCheckpoint: [checkpointRow()],
      subawardMatches: [{ n: 3n }],
    });
    const response = await service().getSupplierFootprintStatus('tenant-1', 'client-1');
    expect(response.status).toBe('available');
    expect(response.attributableSubawardRows).toBe(3);
    expect(response.sourceCompleteness).toBe('in_progress');
    expect(response.sourceCoverageNote).toMatch(/ingested so far/i);
    expect(response.sourceCoverageNote).toMatch(/2,743,636/);
    expect(response.note).not.toMatch(/real empty/i);
  });

  it('partial coverage without matches says "No matches in records ingested so far", not a real empty result', async () => {
    const { service } = statusHarness({
      subawardCoverage: [{ n: 25n, last_synced_at: now }],
      subawardCheckpoint: [checkpointRow()],
      subawardMatches: [{ n: 0n }],
    });
    const response = await service().getSupplierFootprintStatus('tenant-1', 'client-1');
    expect(response.status).toBe('no_matching_records');
    expect(response.note).toBe('No matches in records ingested so far.');
    expect(response.sourceCompleteness).toBe('in_progress');
  });

  it('complete corpus with no matches keeps the strong real-empty-result wording', async () => {
    const { service } = statusHarness({
      subawardCoverage: [{ n: 2_700_000n, last_synced_at: now }],
      subawardCheckpoint: [
        checkpointRow({
          completeness: 'complete',
          next_page: 1,
          rows_processed: 2_700_000n,
        }),
      ],
      subawardMatches: [{ n: 0n }],
    });
    const response = await service().getSupplierFootprintStatus('tenant-1', 'client-1');
    expect(response.status).toBe('no_matching_records');
    expect(response.note).toMatch(/real empty result/i);
    expect(response.sourceCompleteness).toBe('complete');
  });

  it('keeps unknown completeness explicit when the corpus is populated but no unfiltered checkpoint exists', async () => {
    const { service } = statusHarness({
      subawardCoverage: [{ n: 500n, last_synced_at: now }],
      subawardCheckpoint: [],
      subawardMatches: [{ n: 1n }],
    });
    const response = await service().getSupplierFootprintStatus('tenant-1', 'client-1');
    expect(response.status).toBe('available');
    expect(response.sourceCompleteness).toBe('unknown');
    expect(response.sourceCoverageNote).toMatch(/completeness is unknown/i);
    expect(response.note).toMatch(/ingested so far/i);
  });

  it('reads completeness only from the unfiltered walk key, never from a filtered run', async () => {
    const { prisma, service } = statusHarness({
      subawardCoverage: [{ n: 25n, last_synced_at: now }],
      subawardCheckpoint: [checkpointRow()],
      subawardMatches: [{ n: 0n }],
    });
    await service().getSupplierFootprintStatus('tenant-1', 'client-1');
    const checkpointCall = prisma.$queryRaw.mock.calls.find(
      (call) =>
        Array.isArray(call[0]) &&
        (call[0] as readonly string[]).join(' ').includes('tango_subaward_sync_checkpoint'),
    );
    expect(checkpointCall).toBeDefined();
    // Tagged-template values are the args after the strings array.
    const values = checkpointCall!.slice(1);
    expect(values).toContain(UNFILTERED_SUBAWARD_SYNC_KEY);
  });

  it('a not-populated corpus reports the rail state without claiming a client result', async () => {
    const { service } = statusHarness({
      subawardCoverage: [{ n: 0n, last_synced_at: null }],
      subawardCheckpoint: [checkpointRow({ completeness: 'in_progress', rows_processed: 0n })],
      subawardMatches: [{ n: 0n }],
    });
    const response = await service().getSupplierFootprintStatus('tenant-1', 'client-1');
    expect(response.status).toBe('not_populated');
    expect(response.sourceCompleteness).toBe('in_progress');
    expect(response.note).toMatch(/missing-source/i);
  });

  it('absent identity keeps attribution impossible distinct from zero matches, with completeness reported', async () => {
    const { prisma, tx, service } = statusHarness({
      subawardCoverage: [{ n: 25n, last_synced_at: now }],
      subawardCheckpoint: [checkpointRow()],
      subawardMatches: [{ n: 0n }],
    });
    tx.client.findFirst.mockResolvedValue({ id: 'client-1', uei: null } as never);
    const response = await service().getSupplierFootprintStatus('tenant-1', 'client-1');
    expect(response.status).toBe('no_identity');
    expect(response.sourceCompleteness).toBe('in_progress');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2); // coverage + checkpoint only
  });

  it('does not invent a provider total when the checkpoint never observed one', async () => {
    const { service } = statusHarness({
      subawardCoverage: [{ n: 25n, last_synced_at: now }],
      subawardCheckpoint: [checkpointRow({ totalReported: null })],
      subawardMatches: [{ n: 0n }],
    });
    const response = await service().getSupplierFootprintStatus('tenant-1', 'client-1');
    expect(response.providerTotalRecords).toBeNull();
    expect(response.sourceCoverageNote).toMatch(/ingested so far/i);
    expect(response.sourceCoverageNote).not.toMatch(/2,743,636/);
  });
});

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
    const { prisma } = tenantHarness({
      evidence: [rejected, rejectedUnresolved],
    });
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
      service.commitImport('tenant-1', null, 'client-1', '00000000-0000-0000-0000-000000000001'),
    ).rejects.toThrow('Footprint import not found');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('blocks a duplicate committed file before evidence is inserted', async () => {
    const { prisma, tx } = tenantHarness({
      queryRows: [[importRow()], [{ id: 'already-committed' }]],
    });
    const service = new DistrictNexusEconomicService(prisma as never);

    await expect(
      service.commitImport('tenant-1', null, 'client-1', '00000000-0000-0000-0000-000000000001'),
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
