/**
 * Execute the production change reader through Prisma against PostgreSQL.
 * DATABASE_URL must point to a disposable database with the R4 migrations.
 * Each run copies the ledger structure into its own schema; public facts are
 * never inserted, truncated, or deleted by this test.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { DistrictNexusService } from '../district-nexus.service.js';
import { DistrictNexusPriorityIntelligenceService } from './priority-intelligence.service.js';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

function event(
  id: string,
  source: string,
  stateCode: string,
  districtCode: string | null,
  second: number,
  observationKind = 'change',
): Prisma.DistrictNexusChangeCreateManyInput {
  return {
    dedupeKey: id,
    sourceRecordId: id,
    source,
    stateCode,
    districtCode,
    changeKind:
      source === 'gsa'
        ? 'gsa_property_material_change'
        : source === 'cpf' || source === 'cds'
          ? 'cpf_cds_request_new'
          : 'economic_fact_material_change',
    observedAt: new Date(Date.UTC(2026, 8, 7, 0, 0, second)),
    observationKind,
    geographyVintage: 'source_unknown',
  };
}

describeDb('priority change reader source geography (PostgreSQL)', () => {
  jest.setTimeout(60_000);
  const schema = `dn_change_read_${randomUUID().replace(/-/g, '')}`;
  let admin: PrismaClient | undefined;
  let prisma: PrismaClient | undefined;
  let service: DistrictNexusPriorityIntelligenceService;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    const sourceSchema = url.searchParams.get('schema') || 'public';
    // Restrict identifier interpolation to generated/validated identifiers.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(sourceSchema)) {
      throw new Error('DATABASE_URL schema must be a simple PostgreSQL identifier');
    }
    admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await admin.$executeRawUnsafe(
      `CREATE TABLE "${schema}".district_nexus_change ` +
        `(LIKE "${sourceSchema}".district_nexus_change INCLUDING ALL)`,
    );
    // PGlite has a single session; also release this connection before the
    // reader connects, so the same regression runs on both it and native PG.
    await admin.$disconnect();
    url.searchParams.set('schema', schema);
    url.searchParams.set('connection_limit', '1');
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    service = new DistrictNexusPriorityIntelligenceService(
      prisma as unknown as PrismaService,
      {} as DistrictNexusService,
    );
    await prisma.districtNexusChange.createMany({
      data: [
        event('gsa-fl08', 'gsa', '12', '8', 30),
        event('cpf-fl08', 'cpf', 'FL', '08', 20),
        event('acs-fl08', 'acs', 'FL', '08', 10),
        event('gsa-fl18', 'gsa', '12', '18', 30),
        event('cpf-fl18', 'cpf', 'FL', '18', 20),
        event('gsa-ca08', 'gsa', '06', '8', 30),
        event('cpf-ca08', 'cpf', 'CA', '08', 20),
        // Newer nonmatching rows must not leak in or consume the result limit.
        event('gsa-wrong-state-format', 'gsa', 'FL', '8', 50),
        event('gsa-wrong-district-format', 'gsa', '12', '08', 50),
        event('cpf-wrong-state-format', 'cpf', '12', '08', 50),
        event('cpf-wrong-district-format', 'cpf', 'FL', '8', 50),
        event('cds-statewide', 'cds', 'FL', null, 50),
        ...Array.from({ length: 25 }, (_, i) =>
          event(`baseline-${i}`, 'gsa', '12', '8', 60 + i, 'baseline'),
        ),
      ],
    });
  });

  afterAll(async () => {
    try {
      await prisma?.$disconnect();
      await admin?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin?.$disconnect();
    }
  });

  test.each([
    ['FL', '08', ['gsa-fl08', 'cpf-fl08', 'acs-fl08']],
    ['FL', '18', ['gsa-fl18', 'cpf-fl18']],
    ['CA', '08', ['gsa-ca08', 'cpf-ca08']],
  ])('returns only matching changes for %s-%s, newest first', async (state, district, ids) => {
    // Invoke the actual reader with a real Prisma delegate: do not mock or
    // reimplement its where clause, which would conceal contradictory ANDs.
    const rows = await service['loadChanges'](state, district);
    expect(rows.map((row) => row.sourceRecordId)).toEqual(ids);
    expect(rows[0]).toMatchObject({
      source: 'gsa',
      state,
      district: String(Number(district)),
      geographyVintage: 'source_unknown',
      boundaryCongress: null,
    });
    expect(rows.find((row) => row.source === 'cpf')).toMatchObject({ state, district });
  });

  test('does not turn statewide or another district evidence into district changes', async () => {
    await expect(service['loadChanges']('FL', '07')).resolves.toEqual([]);
  });
});
