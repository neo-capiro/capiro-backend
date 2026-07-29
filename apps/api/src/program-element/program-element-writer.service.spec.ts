import { describe, expect, jest, test } from '@jest/globals';
import { ProgramElementWriterService } from './program-element-writer.service.js';

const basePe = {
  peCode: '0603270A',
  title: 'Test Program Element',
};

describe('ProgramElementWriterService', () => {
  test('Sync delta on watched PE emits IntelligenceChange with related client ids', async () => {
    const service = createService();
    await service.upsertProgramElement(basePe, 'fixture', 0.9);

    service.__mock.watches.push({ tenantId: 'tenant-a', peCode: '0603270A' });
    service.__mock.capabilities.push({ tenantId: 'tenant-a', clientId: 'client-1', peNumber: '0603270A' });
    service.__mock.capabilities.push({ tenantId: 'tenant-a', clientId: 'client-2', peNumber: '0603270A' });

    await service.upsertProgramElementYear(
      {
        peCode: '0603270A',
        fy: 2026,
        request: '100000000',
      },
      'r_doc',
    );

    await service.upsertProgramElementYear(
      {
        peCode: '0603270A',
        fy: 2026,
        request: '100000000',
        hascMark: '110000000',
      },
      'conference_report',
    );

    expect(service.__mock.intelligenceChanges).toHaveLength(1);
    const change = service.__mock.intelligenceChanges[0] as {
      source: string;
      relatedPeCodes: string[];
      relatedClientIds: string[];
      changeType: string;
    };
    expect(change.source).toBe('program_element');
    expect(change.changeType).toBe('pe_mark_added');
    expect(change.relatedPeCodes).toEqual(['0603270A']);
    expect(change.relatedClientIds.sort()).toEqual(['client-1', 'client-2']);
  });

  test('Watch-only tenant still receives the delta — watch read uses the bypass path', async () => {
    // Regression guard for the Phase C RLS fan-out defect. program_element_watch becomes
    // RLS-FORCED in Phase C and capiro_app is not BYPASSRLS, so reading it outside
    // withSystem yields zero rows with NO error. tenant-a here has a watch and NO client
    // capability, so it is reachable only through the watch signal: off the bypass path
    // getAffectedTenants returns empty and emitForTenants silently emits nothing.
    const service = createService();
    await service.upsertProgramElement(basePe, 'fixture', 0.9);

    service.__mock.watches.push({ tenantId: 'tenant-a', peCode: '0603270A' });
    // Deliberately NO capability rows — the watch must carry this on its own.

    await service.upsertProgramElementYear(
      { peCode: '0603270A', fy: 2026, request: '100000000' },
      'r_doc',
    );
    await service.upsertProgramElementYear(
      { peCode: '0603270A', fy: 2026, request: '100000000', hascMark: '110000000' },
      'conference_report',
    );

    expect(service.__mock.intelligenceChanges).toHaveLength(1);
    const change = service.__mock.intelligenceChanges[0] as {
      relatedPeCodes: string[];
      relatedClientIds: string[];
    };
    expect(change.relatedPeCodes).toEqual(['0603270A']);
    expect(change.relatedClientIds).toEqual([]);
    expect(service.__mock.withSystem).toHaveBeenCalled();
    // The non-bypass client must never be consulted for this table.
    expect(service.__mock.programElementWatch.findMany).not.toHaveBeenCalled();
  });

  test('Severity thresholds classify critical/notable/info correctly', async () => {
    const service = createService();
    await service.upsertProgramElement(basePe, 'fixture', 0.9);

    service.__mock.watches.push({ tenantId: 'tenant-a', peCode: '0603270A' });
    service.__mock.capabilities.push({ tenantId: 'tenant-a', clientId: 'client-1', peNumber: '0603270A' });

    await service.upsertProgramElementYear(
      {
        peCode: '0603270A',
        fy: 2026,
        request: '100',
      },
      'r_doc',
    );

    await service.upsertProgramElementYear(
      {
        peCode: '0603270A',
        fy: 2026,
        request: '130',
      },
      'r_doc',
    );
    await service.upsertProgramElementYear(
      {
        peCode: '0603270A',
        fy: 2026,
        request: '144.3',
      },
      'r_doc',
    );
    await service.upsertProgramElementYear(
      {
        peCode: '0603270A',
        fy: 2026,
        request: '152.958',
      },
      'r_doc',
    );

    const severities = service.__mock.intelligenceChanges.map(
      (change) => (change as { severity: string }).severity,
    );
    expect(severities).toEqual(['critical', 'notable', 'info']);
  });

  test('Initial sync (no prior value) does not emit IntelligenceChange', async () => {
    const service = createService();
    await service.upsertProgramElement(basePe, 'fixture', 0.9);

    service.__mock.watches.push({ tenantId: 'tenant-a', peCode: '0603270A' });
    service.__mock.capabilities.push({ tenantId: 'tenant-a', clientId: 'client-1', peNumber: '0603270A' });

    await service.upsertProgramElementYear(
      {
        peCode: '0603270A',
        fy: 2026,
        request: '100',
      },
      'r_doc',
    );

    expect(service.__mock.intelligenceChanges).toHaveLength(0);
  });

  test('Multiple watchers in same tenant emits one IntelligenceChange row', async () => {
    const service = createService();
    await service.upsertProgramElement(basePe, 'fixture', 0.9);

    service.__mock.watches.push({ tenantId: 'tenant-a', peCode: '0603270A' });
    service.__mock.watches.push({ tenantId: 'tenant-a', peCode: '0603270A' });
    service.__mock.capabilities.push({ tenantId: 'tenant-a', clientId: 'client-1', peNumber: '0603270A' });

    await service.upsertProgramElementYear(
      {
        peCode: '0603270A',
        fy: 2026,
        request: '100',
      },
      'r_doc',
    );

    await service.upsertProgramElementYear(
      {
        peCode: '0603270A',
        fy: 2026,
        request: '112',
      },
      'r_doc',
    );

    expect(service.__mock.intelligenceChanges).toHaveLength(1);
  });

  test('Fresh PE upsert → inserted:true', async () => {
    const service = createService();

    const result = await service.upsertProgramElement(basePe, 'fixture', 0.9);

    expect(result).toEqual({ inserted: true, pe_code: '0603270A' });
  });

  test('Same PE again → inserted:false', async () => {
    const service = createService();

    await service.upsertProgramElement(basePe, 'fixture', 0.9);
    const result = await service.upsertProgramElement(basePe, 'fixture', 0.9);

    expect(result).toEqual({ inserted: false, pe_code: '0603270A' });
  });

  test('Update a year field → changed:true with delta', async () => {
    const service = createService();
    await service.upsertProgramElement(basePe, 'fixture', 0.9);

    await service.upsertProgramElementYear(
      {
        peCode: '0603270A',
        fy: 2026,
        request: '100.00',
      },
      'r_doc',
    );

    const result = await service.upsertProgramElementYear(
      {
        peCode: '0603270A',
        fy: 2026,
        request: '150.00',
      },
      'r_doc',
    );

    expect(result.inserted).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.delta).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'request', oldValue: '100', newValue: '150' }),
      ]),
    );
  });

  test('No change → changed:false', async () => {
    const service = createService();
    await service.upsertProgramElement(basePe, 'fixture', 0.9);

    await service.upsertProgramElementYear(
      {
        peCode: '0603270A',
        fy: 2026,
        request: '100.00',
      },
      'r_doc',
    );

    const result = await service.upsertProgramElementYear(
      {
        peCode: '0603270A',
        fy: 2026,
        request: '100.00',
      },
      'r_doc',
    );

    expect(result).toEqual({ inserted: false, changed: false });
  });

  test('Bad pe_code → quarantined', async () => {
    const service = createService();

    const peResult = await service.upsertProgramElement({ peCode: 'BAD', title: 'Invalid' }, 'fixture', 0.1);
    const yearResult = await service.upsertProgramElementYear({ peCode: 'BAD', fy: 2026, request: '1.00' }, 'fixture');

    expect(peResult.inserted).toBe(false);
    expect(yearResult.changed).toBe(false);
    expect(service.__mock.quarantineRows.length).toBe(2);
  });

  test("Low-priority source doesn't override high-priority", async () => {
    const service = createService();
    await service.upsertProgramElement(basePe, 'fixture', 0.9);

    await service.upsertProgramElementYear(
      {
        peCode: '0603270A',
        fy: 2026,
        request: '500.00',
      },
      'conference_report',
    );

    const result = await service.upsertProgramElementYear(
      {
        peCode: '0603270A',
        fy: 2026,
        request: '100.00',
      },
      'fixture',
    );

    expect(result).toEqual({ inserted: false, changed: false });
    expect(String(service.__mock.years.get('0603270A::2026')?.request)).toBe('500');
  });

  test('Multiple sources merge into one row without clobbering (full funding lifecycle)', async () => {
    const service = createService();
    await service.upsertProgramElement(basePe, 'fixture', 0.9);

    // Each source carries only its own field — the real ingestion shape. Before
    // the merge fix, each write overwrote the whole row, so only the last source's
    // field survived (the "all program elements show no funding" bug).
    await service.upsertProgramElementYear({ peCode: '0603270A', fy: 2027, request: '382.0' }, 'r_doc_fy27');
    await service.upsertProgramElementYear({ peCode: '0603270A', fy: 2027, hascMark: '290.0' }, 'hasc_report_fy27');
    await service.upsertProgramElementYear(
      { peCode: '0603270A', fy: 2027, conference: '286.0' },
      'conference_report_fy27',
    );
    // Public law (enacted) writes LAST — the case that used to wipe everything else.
    await service.upsertProgramElementYear({ peCode: '0603270A', fy: 2027, enacted: '286.0' }, 'public_law_fy27');

    const row = service.__mock.years.get('0603270A::2027')!;
    expect(String(row.request)).toBe('382');
    expect(String(row.hascMark)).toBe('290');
    expect(String(row.conference)).toBe('286');
    expect(String(row.enacted)).toBe('286');

    // Per-field provenance is recorded so the FY drawer's "Source" column is real.
    const attribution = (row.raw as { sourceAttribution?: Record<string, string> }).sourceAttribution ?? {};
    expect(attribution.request).toBe("President's Budget (R-2)");
    expect(attribution.enacted).toBe('Enacted public law');
  });

  test('Higher-priority source wins per field even with _fy-suffixed tags', async () => {
    const service = createService();
    await service.upsertProgramElement(basePe, 'fixture', 0.9);

    // conference_report (rank 0) outranks r_doc (rank 5). The suffixed tags must
    // still resolve to those ranks — the old indexOf left every real tag tied at
    // the bottom, so this lower-priority r_doc write would have clobbered the 500.
    await service.upsertProgramElementYear(
      { peCode: '0603270A', fy: 2027, request: '500' },
      'conference_report_fy27',
    );
    const result = await service.upsertProgramElementYear(
      { peCode: '0603270A', fy: 2027, request: '100' },
      'r_doc_fy27',
    );

    expect(result).toEqual({ inserted: false, changed: false });
    expect(String(service.__mock.years.get('0603270A::2027')?.request)).toBe('500');
  });

  test('refreshProgramElementDetailMaterializedView runs concurrent refresh', async () => {
    const service = createService();

    await service.refreshProgramElementDetailMaterializedView();

    expect(service.__mock.materializedViewRefreshCount).toBe(1);
  });

  test('getHealthSummary returns degraded when source sync older than 48h', async () => {
    const service = createService();
    service.__mock.programElementYearSourceRows.push(
      { source: 'r_doc_army', recordedAt: new Date(Date.now() - 72 * 60 * 60 * 1000) },
      { source: 'hasc_report', recordedAt: new Date() },
    );

    const result = await service.getHealthSummary();

    expect(result.status).toBe('degraded');
    expect(result.last_sync_at_by_source.r_doc_army).toBeDefined();
  });

  test('getHealthSummary returns error when quarantine count > 100', async () => {
    const service = createService();
    for (let i = 0; i < 101; i += 1) {
      service.__mock.quarantineRows.push({ id: `q-${i}` } as Record<string, unknown>);
    }

    const result = await service.getHealthSummary();

    expect(result.status).toBe('error');
    expect(result.quarantine_count).toBe(101);
  });
});

function createService(): ProgramElementWriterService & { __mock: ReturnType<typeof createPrismaMock> } {
  const mock = createPrismaMock();
  const metrics = {
    emitCount: jest.fn(async () => undefined),
    emitSeconds: jest.fn(async () => undefined),
    emitGauge: jest.fn(async () => undefined),
  };
  const service = new ProgramElementWriterService(mock as never, metrics as never) as ProgramElementWriterService & {
    __mock: ReturnType<typeof createPrismaMock>;
  };
  service.__mock = mock;
  return service;
}

function createPrismaMock() {
  const peRows = new Map<string, Record<string, unknown>>();
  const yearRows = new Map<string, Record<string, unknown>>();
  const milestoneRows = new Map<string, Record<string, unknown>>();
  const sourceRows: Array<Record<string, unknown>> = [];
  const quarantineRows: Array<Record<string, unknown>> = [];
  const intelligenceChanges: Array<Record<string, unknown>> = [];
  const programElementYearSourceRows: Array<{ source: string; recordedAt: Date }> = [];
  let materializedViewRefreshCount = 0;
  const watches: Array<{ tenantId: string; peCode: string }> = [];
  const capabilities: Array<{ tenantId: string; clientId: string; peNumber: string }> = [];

  type PeWhere = { peCode: string };
  type PeData = Record<string, unknown> & { peCode: string };
  type PeYearWhere = { peCode_fy: { peCode: string; fy: number } };
  type PeYearData = Record<string, unknown> & { peCode: string; fy: number; id?: string };
  type MilestoneWhere = { peCode_milestoneType: { peCode: string; milestoneType: string } };
  type MilestoneData = Record<string, unknown> & { peCode: string; milestoneType: string };
  type SourceWhere = { peCode: string; fy: number; fieldName: string; isWinner: boolean };
  type SourceData = Record<string, unknown> & { recordedAt?: string };
  type QuarantineData = Record<string, unknown>;

  const key = (peCode: string, fy: number) => `${peCode}::${fy}`;
  const mkey = (peCode: string, milestoneType: string) => `${peCode}::${milestoneType}`;

  return {
    __store: { peRows, yearRows, milestoneRows, sourceRows, quarantineRows, intelligenceChanges, watches, capabilities },
    get quarantineRows() {
      return quarantineRows;
    },
    get programElementYearSourceRows() {
      return programElementYearSourceRows;
    },
    get years() {
      return yearRows;
    },
    get intelligenceChanges() {
      return intelligenceChanges;
    },
    get materializedViewRefreshCount() {
      return materializedViewRefreshCount;
    },
    get watches() {
      return watches;
    },
    get capabilities() {
      return capabilities;
    },
    programElement: {
      findUnique: jest.fn(async ({ where }: { where: PeWhere }) => peRows.get(where.peCode) ?? null),
      count: jest.fn(async () => peRows.size),
      create: jest.fn(async ({ data }: { data: PeData }) => {
        peRows.set(data.peCode, { ...data });
        return { ...data };
      }),
      update: jest.fn(async ({ where, data }: { where: PeWhere; data: Record<string, unknown> }) => {
        const current = peRows.get(where.peCode) ?? {};
        const next = { ...current, ...data };
        peRows.set(where.peCode, next);
        return next;
      }),
    },
    programElementYear: {
      findUnique: jest.fn(async ({ where }: { where: PeYearWhere }) => yearRows.get(key(where.peCode_fy.peCode, where.peCode_fy.fy)) ?? null),
      create: jest.fn(async ({ data }: { data: PeYearData }) => {
        const row = {
          id: data.id ?? `${Date.now()}`,
          ...data,
        };
        yearRows.set(key(data.peCode, data.fy), row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: PeYearWhere; data: Record<string, unknown> }) => {
        const k = key(where.peCode_fy.peCode, where.peCode_fy.fy);
        const current = yearRows.get(k) ?? {};
        const next = { ...current, ...data };
        yearRows.set(k, next);
        return next;
      }),
    },
    programElementMilestone: {
      findUnique: jest.fn(async ({ where }: { where: MilestoneWhere }) =>
        milestoneRows.get(mkey(where.peCode_milestoneType.peCode, where.peCode_milestoneType.milestoneType)) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: MilestoneData }) => {
        milestoneRows.set(mkey(data.peCode, data.milestoneType), { ...data });
        return { ...data };
      }),
      update: jest.fn(async ({ where, data }: { where: MilestoneWhere; data: Record<string, unknown> }) => {
        const k = mkey(where.peCode_milestoneType.peCode, where.peCode_milestoneType.milestoneType);
        const current = milestoneRows.get(k) ?? {};
        const next = { ...current, ...data };
        milestoneRows.set(k, next);
        return next;
      }),
    },
    programElementYearSourceValue: {
      findFirst: jest.fn(async ({ where }: { where: SourceWhere }) => {
        const filtered = sourceRows
          .filter(
            (r) =>
              r.peCode === where.peCode &&
              r.fy === where.fy &&
              r.fieldName === where.fieldName &&
              r.isWinner === where.isWinner,
          )
          .sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)));
        return filtered[0] ?? null;
      }),
      findMany: jest.fn(async () => [...programElementYearSourceRows]),
      updateMany: jest.fn(async ({ where, data }: { where: SourceWhere; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of sourceRows) {
          if (
            row.peCode === where.peCode &&
            row.fy === where.fy &&
            row.fieldName === where.fieldName &&
            row.isWinner === where.isWinner
          ) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      }),
      create: jest.fn(async ({ data }: { data: SourceData }) => {
        const row = { ...data, recordedAt: data.recordedAt ?? new Date().toISOString() };
        sourceRows.push(row);
        const sourceValue = typeof data.source === 'string' ? data.source : 'unknown';
        const recordedAtIso = typeof row.recordedAt === 'string' ? row.recordedAt : new Date().toISOString();
        programElementYearSourceRows.push({ source: sourceValue, recordedAt: new Date(recordedAtIso) });
        return row;
      }),
    },
    programElementQuarantine: {
      create: jest.fn(async ({ data }: { data: QuarantineData }) => {
        quarantineRows.push(data);
        return data;
      }),
      count: jest.fn(async () => quarantineRows.length),
    },
    // Model the live database, not a permissive stub. client_capabilities has been
    // RLS-FORCED since the tenancy migration and program_element_watch is RLS-FORCED as
    // of the Phase C tenant-isolation migration; capiro_app is NOT BYPASSRLS since the
    // 2026-07-20 role hardening, so a read that skips withSystem returns ZERO rows with
    // no error. These bare accessors therefore serve [] — that is what makes the
    // watch-driven tests below able to detect a regression off the bypass path.
    programElementWatch: {
      findMany: jest.fn(async () => [] as Array<{ tenantId: string; peCode: string }>),
    },
    clientCapability: {
      findMany: jest.fn(async () => [] as Array<{ tenantId: string; clientId: string }>),
    },
    // getAffectedTenants reads BOTH tables cross-tenant via the bypass path
    // (withSystem). Run the callback against a stub tx backed by the fixtures.
    withSystem: jest.fn(
      async (
        fn: (tx: {
          programElementWatch: {
            findMany: (args: { where: { peCode: string } }) => Promise<unknown>;
          };
          clientCapability: {
            findMany: (args: { where: { peNumber: string } }) => Promise<unknown>;
          };
        }) => unknown,
      ) =>
        fn({
          programElementWatch: {
            findMany: async ({ where }: { where: { peCode: string } }) =>
              watches.filter((w) => w.peCode === where.peCode),
          },
          clientCapability: {
            findMany: async ({ where }: { where: { peNumber: string } }) =>
              capabilities.filter((c) => c.peNumber === where.peNumber),
          },
        }),
    ),
    intelligenceChange: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        intelligenceChanges.push({ ...data });
        return data;
      }),
    },
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      // The writer refreshes via the SECURITY DEFINER function (capiro_app isn't the
      // MV owner), so match the function call the service actually issues.
      if (sql === 'SELECT refresh_program_element_detail_mv()') {
        materializedViewRefreshCount += 1;
      }
      return 0;
    }),
  };
}
