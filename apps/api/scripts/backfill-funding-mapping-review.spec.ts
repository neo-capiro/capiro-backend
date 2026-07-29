import { describe, expect, jest, test } from '@jest/globals';
import type { PrismaClient } from '@prisma/client';
import {
  backfillFundingMappingReview,
  parseMappingReviewArgs,
  resolveMappingReviewTenantIds,
} from './backfill-funding-mapping-review.js';

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000010';
const CONTRACTOR = '00000000-0000-0000-0000-000000000020';
const UEI = 'ABC123456789';

function fake(options: { source?: string; sourceUei?: string | null } = {}) {
  const updates: unknown[] = [];
  const audits: unknown[] = [];
  const mappingWhere: unknown[] = [];
  const raw: Record<string, any> = {};
  raw.$transaction = jest.fn(async (fn: (tx: PrismaClient) => Promise<unknown>) =>
    fn(raw as PrismaClient),
  );
  raw.$executeRawUnsafe = jest.fn(async () => 0);
  raw.$queryRaw = jest.fn(async () => [{ tenant_id: TENANT }]);
  raw.client = { findMany: jest.fn(async () => [{ id: CLIENT, uei: UEI }]) };
  raw.clientIntelMapping = {
    findMany: jest.fn(async (args: { where?: unknown }) => {
      mappingWhere.push(args.where);
      return [
        {
          id: 'mapping-1',
          tenantId: TENANT,
          clientId: CLIENT,
          source: options.source ?? 'contracting',
          externalId: options.source === 'assistance_recipient' ? (options.sourceUei ?? UEI) : CONTRACTOR,
          externalName: 'Acme Federal LLC',
          matchBasis: 'legacy_unrecorded',
          matchTier: null,
          relationshipType: null,
          rollUpAwards: null,
          reviewStatus: 'confirmed',
        },
      ];
    }),
    update: jest.fn(async (args: unknown) => {
      updates.push(args);
      return args;
    }),
  };
  raw.federalContractor = {
    findMany: jest.fn(async () => [
      { id: CONTRACTOR, uei: options.sourceUei === undefined ? UEI : options.sourceUei },
    ]),
  };
  raw.auditLog = {
    create: jest.fn(async (args: unknown) => {
      audits.push(args);
      return args;
    }),
  };
  return { prisma: raw as PrismaClient, updates, audits, mappingWhere };
}

describe('backfill funding mapping review', () => {
  test('dry run is default', () => {
    expect(parseMappingReviewArgs([])).toEqual({ commit: false, tenantId: null });
    expect(parseMappingReviewArgs(['--commit', '--tenant', TENANT])).toEqual({
      commit: true,
      tenantId: TENANT,
    });
  });

  test('an exact contractor UEI is repaired as self with explicit roll-up', async () => {
    const { prisma, updates, audits } = fake();
    const result = await backfillFundingMappingReview(prisma, {
      tenantIds: [TENANT],
      commit: true,
    });
    expect(result.exactIdentifierRepairs).toBe(1);
    expect(updates[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          matchBasis: 'exact_uei',
          matchTier: 1,
          relationshipType: 'self',
          rollUpAwards: true,
          reviewStatus: 'confirmed',
        }),
      }),
    );
    expect(audits).toHaveLength(1);
  });

  test('an exact assistance-recipient UEI is repaired the same way', async () => {
    const { prisma } = fake({ source: 'assistance_recipient' });
    const result = await backfillFundingMappingReview(prisma, {
      tenantIds: [TENANT],
      commit: false,
    });
    expect(result.exactIdentifierRepairs).toBe(1);
  });

  test('a name-only or conflicting identity remains human-review required', async () => {
    const { prisma, updates } = fake({ sourceUei: 'ZZZ999999999' });
    const result = await backfillFundingMappingReview(prisma, {
      tenantIds: [TENANT],
      commit: true,
    });
    expect(result.exactIdentifierRepairs).toBe(0);
    expect(result.needsHumanReview).toBe(1);
    expect(updates).toHaveLength(0);
  });

  test('the mapping query only considers confirmed, undecided award identities', async () => {
    const { prisma, mappingWhere } = fake();
    await backfillFundingMappingReview(prisma, { tenantIds: [TENANT], commit: false });
    expect(mappingWhere[0]).toEqual(
      expect.objectContaining({
        tenantId: TENANT,
        confirmed: true,
        reviewStatus: 'confirmed',
        rollUpAwards: null,
      }),
    );
  });
});

describe('mapping review tenant resolution', () => {
  test('explicit tenant wins', async () => {
    const { prisma } = fake();
    await expect(resolveMappingReviewTenantIds(prisma, TENANT)).resolves.toEqual([TENANT]);
  });

  test('otherwise tenants are discovered from existing award mappings', async () => {
    const { prisma } = fake();
    await expect(resolveMappingReviewTenantIds(prisma, null)).resolves.toEqual([TENANT]);
  });
});
