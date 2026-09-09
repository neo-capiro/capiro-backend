import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RepresentationResolverService } from '../clients/representation-resolver.service.js';
import { DistrictNexusService } from '../district-nexus/district-nexus.service.js';
import { buildDistrictNexusIdentity } from '../district-nexus/district-nexus.identity.js';
import type { AwardIdentityRail } from '../funding-opportunities/award-history-identity.js';
import type { ContractDistrictRow } from '../district-nexus/district-nexus.aggregate.js';
import { FederalMarketService } from './federal-market.service.js';

// Isolated schema on a disposable DATABASE_URL only. Real contract SQL is run
// through both readers; unrelated subaward/forecast rails and tenant lookups
// are stubbed so this test has no dependency on a populated application DB.
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const TENANT = 'tenant-canary';
const CLIENT = 'client-canary';
const OWN_UEI = 'AAA111BBB222';
const MAPPED_UEI = 'CCC333DDD444';
const OTHER_UEI = 'EEE555FFF666';
const CONTRACTOR = 'aaaaaaaa-1111-4111-8111-111111111111';

type Mapping = {
  source: string;
  externalId: string;
  externalName: string;
  matchBasis: string | null;
  matchTier: number | null;
};
const mapping = (overrides: Partial<Mapping> = {}): Mapping => ({
  source: 'contracting',
  externalId: 'name-only',
  externalName: 'Shared Name',
  matchBasis: 'exact_name',
  matchTier: 2,
  ...overrides,
});

describeDb('Federal Market / District Nexus contract identity parity', () => {
  let admin: PrismaClient;
  let db: PrismaClient;
  const schema = `federal_market_identity_${randomUUID().replace(/-/g, '')}`;

  beforeAll(async () => {
    admin = new PrismaClient();
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await admin.$disconnect();
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('schema', schema);
    url.searchParams.set('connection_limit', '1');
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    // Also set the single session explicitly for PostgreSQL wire harnesses
    // that do not apply startup search_path options to raw SQL.
    await db.$executeRawUnsafe(`SET search_path TO "${schema}"`);
    await db.$executeRawUnsafe(`CREATE TABLE federal_contractor (id uuid PRIMARY KEY, uei text)`);
    await db.$executeRawUnsafe(`CREATE TABLE federal_award (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), award_unique_id text,
      recipient_uei text, contractor_name text, amount numeric,
      pop_state text, pop_congressional_district text, awarding_agency text,
      description text, action_date timestamptz, last_synced_at timestamptz
    )`);
    await db.$executeRaw(Prisma.sql`
      INSERT INTO federal_contractor (id, uei) VALUES (${CONTRACTOR}::uuid, ${MAPPED_UEI})
    `);
    await db.$executeRaw(Prisma.sql`
      INSERT INTO federal_award
        (award_unique_id, recipient_uei, contractor_name, amount, pop_state, pop_congressional_district)
      VALUES
        ('own', ${OWN_UEI}, 'Own Entity', 100, 'FL', '08'),
        ('mapped', ${MAPPED_UEI}, 'Shared Name', 200, 'FL', '08'),
        ('wrong-same-name', ${OTHER_UEI}, 'Shared Name', 2000000000, 'FL', '08')
    `);
  });

  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.$disconnect();
    }
  });

  function harness(uei: string | null, mappings: Mapping[], visible = true) {
    const tx = {
      client: { findFirst: jest.fn().mockResolvedValue(visible ? { id: CLIENT, uei } : null) },
      clientIntelMapping: { findMany: jest.fn().mockResolvedValue(mappings) },
    };
    const prisma = {
      $queryRaw: db.$queryRaw.bind(db),
      federalContractor: {
        findMany: jest.fn(db.federalContractor.findMany.bind(db.federalContractor)),
      },
      withTenant: jest.fn(async (_tenant: string, fn: (value: typeof tx) => unknown) => fn(tx)),
    };
    const market = new FederalMarketService(prisma as unknown as PrismaService);
    const unrelated = market as unknown as {
      aggregateSubawardGeography: () => Promise<[]>;
      futureSignals: () => Promise<[]>;
    };
    unrelated.aggregateSubawardGeography = async () => [];
    unrelated.futureSignals = async () => [];
    const nexus = new DistrictNexusService(
      prisma as unknown as PrismaService,
      {} as RepresentationResolverService,
    ) as unknown as {
      aggregateContracts: (rail: AwardIdentityRail) => Promise<ContractDistrictRow[]>;
    };
    return { market, nexus, prisma, tx };
  }

  test.each([
    ['own UEI suppresses every same-name fallback', OWN_UEI, [mapping()], 100, 1],
    ['contractor UUID resolves to its UEI', null, [mapping({ externalId: CONTRACTOR })], 200, 1],
    [
      'assistance identifiers cannot supply contract scope',
      null,
      [mapping({ source: 'assistance_recipient', externalId: OTHER_UEI })],
      null,
      0,
    ],
    [
      'unrecorded names cannot supply contract scope',
      null,
      [mapping({ matchBasis: null })],
      null,
      0,
    ],
    [
      'legacy names cannot supply contract scope',
      null,
      [mapping({ matchBasis: 'legacy_unrecorded' })],
      null,
      0,
    ],
    [
      'fuzzy names cannot supply contract scope',
      null,
      [mapping({ matchBasis: 'fuzzy_name' })],
      null,
      0,
    ],
    ['fuzzy tiers cannot supply contract scope', null, [mapping({ matchTier: 4 })], null, 0],
    ['reviewed exact names remain a fallback without UEIs', null, [mapping()], 2000000200, 2],
  ] as const)('%s', async (_label, uei, mappings, expectedAmount, expectedCount) => {
    const { market, nexus, prisma, tx } = harness(uei, [...mappings]);
    const geography = await market.geography(TENANT, {
      clientId: CLIENT,
      state: 'FL',
      district: '08',
    });
    const list = await market.listContracts(TENANT, {
      clientId: CLIENT,
      state: 'FL',
      district: '08',
    });
    const identity = buildDistrictNexusIdentity(
      { clientId: CLIENT, clientName: 'Canary client', uei, mappings: [...mappings] },
      new Map([[CONTRACTOR, MAPPED_UEI]]),
    );
    const canonical = await nexus.aggregateContracts(identity.contract);

    expect(geography.warnings).toEqual([]);
    expect(geography.districts[0]?.contractAmount ?? null).toBe(expectedAmount);
    expect(geography.districts[0]?.contractCount ?? 0).toBe(expectedCount);
    expect(geography.districts[0]?.contractAmount ?? null).toBe(canonical[0]?.totalAmount ?? null);
    expect(list.total).toBe(expectedCount);
    if (expectedCount > 0)
      expect(list.items.reduce((sum, row) => sum + (row.amount ?? 0), 0)).toBe(expectedAmount);
    expect(prisma.withTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(tx.client.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CLIENT, status: { not: 'archived' }, profileStatus: 'ACTIVE' },
      }),
    );
    expect(tx.clientIntelMapping.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          clientId: CLIENT,
          confirmed: true,
          reviewStatus: 'confirmed',
          rollUpAwards: true,
        }),
      }),
    );
  });

  test('rejects an invisible client before reading global award data', async () => {
    const { market, prisma, tx } = harness(OWN_UEI, [], false);
    await expect(market.geography(TENANT, { clientId: CLIENT })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.clientIntelMapping.findMany).not.toHaveBeenCalled();
    expect(prisma.federalContractor.findMany).not.toHaveBeenCalled();
  });

  test('preserves the unscoped regional market when no client is selected', async () => {
    const { market, prisma } = harness(null, []);
    const result = await market.geography(TENANT, { state: 'FL', district: '08' });
    expect(result.districts[0]).toMatchObject({ contractCount: 3, contractAmount: 2000000300 });
    expect(prisma.withTenant).not.toHaveBeenCalled();
  });
});
