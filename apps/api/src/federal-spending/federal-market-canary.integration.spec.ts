import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { DistrictNexusService } from '../district-nexus/district-nexus.service.js';
import { DistrictNexusPriorityIntelligenceService } from '../district-nexus/priority-intelligence/priority-intelligence.service.js';
import { loadPriorityMemberDirectory } from '../district-nexus/priority-intelligence/priority-intelligence-member-directory.js';
import { FederalMarketService } from './federal-market.service.js';

// Run only against a disposable DATABASE_URL. SQL is executed through Prisma;
// physical column names come from its schema metadata, not the query under test.
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
describeDb('District Nexus canary SQL contracts', () => {
  const schema = `dn_canary_${randomUUID().replace(/-/g, '')}`;
  let admin: PrismaClient;
  let db: PrismaClient;

  async function createTable(modelName: string, fields: string[]) {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName)!;
    const columns = fields.map((name) => {
      const field = model.fields.find((f) => f.name === name)!;
      if (!field) throw new Error(`Missing schema field ${modelName}.${name}`);
      const type = {
        String: 'text',
        Int: 'integer',
        Boolean: 'boolean',
        Json: 'jsonb',
        DateTime: 'timestamptz',
      }[field.type];
      if (!type) throw new Error(`Unsupported fixture type ${field.type}`);
      return `"${field.dbName ?? field.name}" ${type}`;
    });
    await db.$executeRawUnsafe(
      `CREATE TABLE "${model.dbName ?? model.name}" (${columns.join(', ')})`,
    );
  }

  beforeAll(async () => {
    admin = new PrismaClient();
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await admin.$disconnect();
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('schema', schema);
    url.searchParams.set('connection_limit', '1');
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await db.$executeRawUnsafe(`SET search_path TO "${schema}"`);
    await createTable('SamOpportunity', [
      'id',
      'title',
      'agency',
      'responseDeadline',
      'placeOfPerformance',
      'sourceUrl',
      'active',
    ]);
    await createTable('TangoProcurementForecast', [
      'id',
      'title',
      'organizationAgencyName',
      'agency',
      'placeOfPerformance',
      'anticipatedAwardDate',
      'isActive',
      'sourceUrl',
    ]);
    await createTable('CongressMember', [
      'bioguideId',
      'firstName',
      'lastName',
      'fullName',
      'state',
      'district',
      'chamber',
      'isCurrent',
    ]);
    await db.$executeRawUnsafe(`INSERT INTO sam_opportunity
      (id, title, agency, response_deadline, place_of_performance_jsonb, active)
      SELECT 'other-' || n, 'Other state', 'Agency', now() + interval '1 day', '{"state":{"code":"NY"}}'::jsonb, true
      FROM generate_series(1, 101) n`);
    await db.$executeRawUnsafe(`INSERT INTO sam_opportunity
      (id, title, agency, response_deadline, place_of_performance_jsonb, active) VALUES
      ('fl-district', 'FL district notice', 'Agency', now() + interval '2 days', '{"state":{"code":"FL"},"congressional_district":"8"}', true),
      ('fl-state', 'FL statewide notice', 'Agency', now() + interval '2 days', '{"state_code":"FL"}', true),
      ('fl-other', 'Other FL district', 'Agency', now() + interval '2 days', '{"state":"FL","congressional_district":"09"}', true),
      ('fl-inactive', 'Inactive notice', 'Agency', now() + interval '2 days', '{"state":"FL"}', false)`);
    await db.$executeRawUnsafe(`INSERT INTO congress_member
      (bioguide_id, first_name, last_name, full_name, state, district, chamber, is_current) VALUES
      ('H001', 'Henry', 'Hale', 'Henry Hale', 'California', null, 'senate', false),
      ('A001', 'Alice', 'Able', 'Alice Able', 'California', null, 'senate', true),
      ('B001', 'Bob', 'Baker', 'Bob Baker', 'California', null, 'senate', true),
      ('D001', 'Dana', 'Dale', 'Dana Dale', 'California', 47, 'house', true)`);
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  function market() {
    const svc = new FederalMarketService(db as unknown as PrismaService);
    const other = svc as unknown as {
      aggregateContractGeography: () => Promise<[]>;
      aggregateSubawardGeography: () => Promise<[]>;
    };
    other.aggregateContractGeography = async () => [];
    other.aggregateSubawardGeography = async () => [];
    return svc;
  }
  test('reads the real SAM geography column and nested state before limiting the preview', async () => {
    const result = await market().geography('tenant', { state: 'FL', district: '08' });
    expect(result.futureSignalsAvailability).toBe('available');
    expect(result.warnings).toEqual([]);
    expect(result.futureSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'sam:fl-district', districtKey: 'FL-08' }),
        expect.objectContaining({ id: 'sam:fl-state', state: 'FL', districtKey: null }),
      ]),
    );
    expect(result.futureSignals).toHaveLength(2);
  });
  test('a successful empty query remains available', async () => {
    const result = await market().geography('tenant', { state: 'VA', district: '10' });
    expect(result.futureSignalsAvailability).toBe('available');
    expect(result.futureSignals).toEqual([]);
  });
  test('excludes past and inactive forecasts from upcoming signals while keeping availability', async () => {
    await db.$executeRawUnsafe(`INSERT INTO tango_procurement_forecast
      (id, title, organization_agency_name, agency, place_of_performance, anticipated_award_date, is_active) VALUES
      ('past', 'Past forecast', 'Agency', 'Agency', 'Florida', '2020-01-01', true),
      ('inactive', 'Inactive future', 'Agency', 'Agency', 'Florida', (CURRENT_DATE + interval '30 days')::date, false),
      ('upcoming', 'Live upcoming<br />signal', 'Agency', 'Agency', 'Florida', (CURRENT_DATE + interval '14 days')::date, true),
      ('undated', 'Undated forecast', 'Agency', 'Agency', 'Florida', null, true)`);
    try {
      const result = await market().geography('tenant', { state: 'FL', district: '08' });
      expect(result.futureSignalsAvailability).toBe('available');
      const forecastIds = result.futureSignals
        .filter((s) => s.source === 'agency_forecast')
        .map((s) => s.id)
        .sort();
      expect(forecastIds).toEqual(['forecast:undated', 'forecast:upcoming'].sort());
      expect(result.futureSignals.some((s) => s.id === 'forecast:past')).toBe(false);
      expect(result.futureSignals.some((s) => s.id === 'forecast:inactive')).toBe(false);
      const upcoming = result.futureSignals.find((s) => s.id === 'forecast:upcoming');
      expect(upcoming?.title).toBe('Live upcoming signal');
    } finally {
      await db.$executeRawUnsafe(
        `DELETE FROM tango_procurement_forecast WHERE id IN ('past','inactive','upcoming','undated')`,
      );
    }
  });
  test('a real database error is unavailable, never a successful zero', async () => {
    await db.$executeRawUnsafe(
      'ALTER TABLE sam_opportunity RENAME COLUMN place_of_performance_jsonb TO unavailable_geography',
    );
    try {
      const result = await market().geography('tenant', { state: 'FL', district: '08' });
      expect(result.futureSignalsAvailability).toBe('unavailable');
      expect(result.warnings).toContain('future opportunity geography unavailable');
    } finally {
      // A transport may close its session after a failed statement. Restore
      // the isolated fixture through a fresh connection in either case.
      await db.$disconnect();
      await db.$executeRawUnsafe(`SET search_path TO "${schema}"`);
      await db.$executeRawUnsafe(
        'ALTER TABLE sam_opportunity RENAME COLUMN unavailable_geography TO place_of_performance_jsonb',
      );
    }
  });
  test('representation excludes former senators, while requester resolution retains their identities', async () => {
    const prisma = {
      withTenant: async (_tenant: string, fn: (tx: PrismaClient) => unknown) => fn(db),
    };
    const svc = new DistrictNexusPriorityIntelligenceService(
      prisma as unknown as PrismaService,
      {} as DistrictNexusService,
    );
    const members = await (
      svc as unknown as {
        loadMembers: (
          tenant: string,
          state: string,
          district: string,
        ) => Promise<{ senatorBioguideIds: string[]; houseMemberBioguideIds: string[] }>;
      }
    ).loadMembers('tenant', 'CA', '47');
    expect(members.senatorBioguideIds).toEqual(['A001', 'B001']);
    expect(members.houseMemberBioguideIds).toEqual(['D001']);
    const directory = await loadPriorityMemberDirectory(db as unknown as PrismaService, 'CA');
    expect(directory.find((m) => m.bioguideId === 'H001')).toMatchObject({
      fullName: 'Henry Hale',
      isCurrent: false,
    });
  });
});
