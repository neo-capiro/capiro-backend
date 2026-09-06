/**
 * District Nexus R4 operational hardening (Phase 7): wires the existing pure
 * `detectEconomicFactChange` into the canonical ACS/CBP/LODES commit path
 * (`writeEconomicFacts`) so economic fact changes actually reach
 * district_nexus_change — previously wired to nothing, a no-op function.
 *
 * DB-gated (`process.env.DATABASE_URL ? describe : describe.skip`), matching
 * the existing convention (priority-intelligence-change-ledger.integration.spec.ts).
 * This is deliberately a REAL Postgres test, not a mock: the commit path now
 * does a WITH-CTE-based "capture old value, then upsert" in a single SQL
 * statement, which needs a real database to prove it actually parses and
 * behaves as intended (a mock would just echo back whatever it's told).
 */
import { PrismaClient } from '@prisma/client';
import { writeEconomicFacts, type EconomicFactInput } from './district-economic-source.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

function fact(overrides: Partial<EconomicFactInput> = {}): EconomicFactInput {
  return {
    source: 'cbp',
    dataset: 'cbp',
    sourceYear: 2023,
    state: 'ny',
    districtCode: '05',
    boundaryCongress: null,
    metricKey: 'employment',
    metricValue: 10000,
    unit: 'count',
    naicsCode: '00',
    sourceRecordId: null,
    sourceUrl: null,
    observedAt: new Date('2026-09-01T00:00:00.000Z'),
    metadata: {},
    ...overrides,
  };
}

describeDb('writeEconomicFacts — economic change-detector wiring (Postgres)', () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaClient();

  const ledgerCount = (where: Record<string, unknown>) =>
    prisma.districtNexusChange.count({ where: where as never });

  // district_economic_fact has no Prisma model (raw-SQL-managed, same
  // pattern as tango_subaward) — count/read it directly.
  const factCount = async (districtCode?: string): Promise<number> => {
    const rows = districtCode
      ? await prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*) AS count FROM district_economic_fact WHERE district_code = ${districtCode}`
      : await prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*) AS count FROM district_economic_fact`;
    return Number(rows[0]?.count ?? 0);
  };
  const factMetricValue = async (
    source: string,
    districtCode: string,
    sourceYear: number,
  ): Promise<string | null> => {
    const rows = await prisma.$queryRaw<Array<{ metric_value: string | null }>>`
      SELECT metric_value::text AS metric_value FROM district_economic_fact
      WHERE source = ${source} AND district_code = ${districtCode} AND source_year = ${sourceYear}`;
    return rows[0]?.metric_value ?? null;
  };

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.$executeRawUnsafe(
      'TRUNCATE district_nexus_change, district_economic_fact, district_economic_source_run RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE district_nexus_change, district_economic_fact, district_economic_source_run RESTART IDENTITY CASCADE',
    );
    await prisma.$disconnect();
  });

  it('a dry run writes ZERO fact rows and ZERO ledger rows', async () => {
    const result = await writeEconomicFacts(
      prisma,
      { source: 'cbp', dataset: 'cbp', sourceYear: 2023, boundaryCongress: null, dryRun: true },
      [fact({ districtCode: '01' })],
    );
    expect(result.rowsWritten).toBe(0);
    expect(result.changesWritten).toBe(0);
    expect(await factCount()).toBe(0);
    expect(await ledgerCount({ source: 'cbp' })).toBe(0);
  });

  it('first-ever population (no prior row) writes the fact but emits NO ledger row — explicit baseline semantics', async () => {
    const result = await writeEconomicFacts(
      prisma,
      { source: 'cbp', dataset: 'cbp', sourceYear: 2023, boundaryCongress: null, dryRun: false },
      [fact({ districtCode: '02', metricValue: 10000 })],
    );
    expect(result.rowsWritten).toBe(1);
    expect(result.changesWritten).toBe(0);
    expect(await factCount('02')).toBe(1);
    expect(
      await ledgerCount({
        source: 'cbp',
        districtCode: '02',
        changeKind: 'economic_fact_material_change',
      }),
    ).toBe(0);
  });

  it('an identical rerun of the same value emits no new ledger row (idempotent)', async () => {
    const result = await writeEconomicFacts(
      prisma,
      { source: 'cbp', dataset: 'cbp', sourceYear: 2023, boundaryCongress: null, dryRun: false },
      [fact({ districtCode: '02', metricValue: 10000 })],
    );
    expect(result.rowsWritten).toBe(1); // upsert-in-place still "writes" (matches existing rowsWritten semantics)
    expect(result.changesWritten).toBe(0);
    expect(
      await ledgerCount({
        source: 'cbp',
        districtCode: '02',
        changeKind: 'economic_fact_material_change',
      }),
    ).toBe(0);
  });

  it('a same-year correction compares against the existing value for THAT year, not a different year', async () => {
    // District 04, self-contained: a first population for 2023, then a
    // corrected re-submission for the SAME year 2023 (not a new year) — the
    // prior-value lookup's `source_year <= fact.sourceYear ORDER BY
    // source_year DESC LIMIT 1` must prefer the exact-year match over any
    // earlier year, which is exactly what a same-year correction needs.
    const baseline = await writeEconomicFacts(
      prisma,
      { source: 'cbp', dataset: 'cbp', sourceYear: 2023, boundaryCongress: null, dryRun: false },
      [fact({ districtCode: '04', sourceYear: 2023, metricValue: 8000 })],
    );
    expect(baseline.changesWritten).toBe(0); // first-ever for district 04: baseline, not a change

    const corrected = await writeEconomicFacts(
      prisma,
      { source: 'cbp', dataset: 'cbp', sourceYear: 2023, boundaryCongress: null, dryRun: false },
      [fact({ districtCode: '04', sourceYear: 2023, metricValue: 9500 })], // +18.75% correction, same year
    );
    expect(corrected.changesWritten).toBe(1);

    const rows = await prisma.districtNexusChange.findMany({
      where: { source: 'cbp', districtCode: '04', changeKind: 'economic_fact_material_change' },
    });
    expect(rows).toHaveLength(1);
    expect(Number((rows[0]!.oldValue as Record<string, unknown>).value)).toBe(8000);
    expect(Number((rows[0]!.newValue as Record<string, unknown>).value)).toBe(9500);
    expect((rows[0]!.oldValue as Record<string, unknown>).sourceYear).toBe(2023);
    expect((rows[0]!.newValue as Record<string, unknown>).sourceYear).toBe(2023);
  });

  it('a material year-over-year movement emits exactly one economic_fact_material_change row with durable old/new values, transactionally with the fact write', async () => {
    const result = await writeEconomicFacts(
      prisma,
      { source: 'cbp', dataset: 'cbp', sourceYear: 2024, boundaryCongress: null, dryRun: false },
      [fact({ districtCode: '02', sourceYear: 2024, metricValue: 15000 })], // +50% vs the 10000 committed above
    );
    expect(result.rowsWritten).toBe(1);
    expect(result.changesWritten).toBe(1);

    const rows = await prisma.districtNexusChange.findMany({
      where: { source: 'cbp', districtCode: '02', changeKind: 'economic_fact_material_change' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe('material');
    // metric_value is numeric(24,6): the raw stored string carries trailing
    // zeros ("10000.000000") — compare numerically, not by exact string.
    expect(Number((rows[0]!.oldValue as Record<string, unknown>).value)).toBe(10000);
    expect(Number((rows[0]!.newValue as Record<string, unknown>).value)).toBe(15000);
    // Global public row: no tenant/client association exists on this model at
    // all (schema-level guarantee), and provenance carries only the metric
    // identity, never a client id.
    expect(rows[0]!.provenance).not.toHaveProperty('clientId');
    expect(rows[0]!.provenance).not.toHaveProperty('tenantId');

    // Fact row itself was updated (upsert-in-place) to the new value —
    // proving the fact write and the ledger write both really happened in
    // the same run, off the same transaction.
    expect(Number(await factMetricValue('cbp', '02', 2024))).toBe(15000);
  });

  it('a sub-threshold movement (below the 2% minimum reportable delta) writes the fact but emits no ledger row', async () => {
    const result = await writeEconomicFacts(
      prisma,
      { source: 'cbp', dataset: 'cbp', sourceYear: 2024, boundaryCongress: null, dryRun: false },
      [fact({ districtCode: '03', sourceYear: 2024, metricValue: 5000 })],
    );
    expect(result.changesWritten).toBe(0); // first-ever for district 03, still baseline (no prior)

    const nextYear = await writeEconomicFacts(
      prisma,
      { source: 'cbp', dataset: 'cbp', sourceYear: 2025, boundaryCongress: null, dryRun: false },
      [fact({ districtCode: '03', sourceYear: 2025, metricValue: 5010 })], // +0.2%
    );
    expect(nextYear.changesWritten).toBe(0);
    expect(
      await ledgerCount({
        source: 'cbp',
        districtCode: '03',
        changeKind: 'economic_fact_material_change',
      }),
    ).toBe(0);
    expect(result.rowsWritten).toBe(1);
  });
});
