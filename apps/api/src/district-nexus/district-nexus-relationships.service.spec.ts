import { describe, expect, jest, test } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import { DistrictNexusRelationshipsService } from './district-nexus-relationships.service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const AWARD_ID = '44444444-4444-4444-8444-444444444444';
const FACILITY_ID = '55555555-5555-4555-8555-555555555555';
const RELATIONSHIP_ID = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-07-27T12:00:00.000Z');

function award(overrides: Record<string, unknown> = {}) {
  return {
    id: AWARD_ID,
    awardUniqueId: 'ASST_NON_123',
    fain: 'FAIN-123',
    recipientName: 'Example Research University',
    recipientUei: 'ABC123DEF456',
    assistanceListingNumber: '12.345',
    assistanceListingTitle: 'Example Program',
    awardingAgency: 'Department of Example',
    totalObligatedAmount: 1_000_000,
    totalOutlayedAmount: 250_000,
    startDate: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2027-01-01T00:00:00.000Z'),
    popState: 'VA',
    popCongressionalDistrict: '10',
    recipientState: 'DC',
    recipientCongressionalDistrict: '98',
    ...overrides,
  };
}

function facility() {
  return {
    id: FACILITY_ID,
    name: 'Arlington Lab',
    city: 'Arlington',
    state: 'VA',
    congressionalDistrict: '08',
  };
}

function relationship(overrides: Record<string, unknown> = {}) {
  return {
    id: RELATIONSHIP_ID,
    clientId: CLIENT_ID,
    assistanceAwardId: AWARD_ID,
    facilityId: FACILITY_ID,
    relationshipType: 'project_site',
    relationshipDescription: 'Client performs a verified portion of the project here.',
    attributableAmount: 250_000,
    beneficiaryCount: null,
    evidenceSourceType: 'analyst_manual_entry',
    evidenceSourceRef: 'client-approved project agreement dated 2026-07-20',
    confidence: 1,
    verificationStatus: 'verified',
    externalUseApproved: true,
    verifiedAt: NOW,
    verifiedByUserId: USER_ID,
    effectiveStart: new Date('2026-01-01T00:00:00.000Z'),
    effectiveEnd: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function harness(options?: {
  award?: ReturnType<typeof award> | null;
  facility?: ReturnType<typeof facility> | null;
  duplicate?: { id: string } | null;
  existing?: ReturnType<typeof relationship> | null;
}) {
  const created = relationship();
  const rejected = relationship({
    verificationStatus: 'rejected',
    confidence: 0,
    externalUseApproved: false,
    verifiedAt: null,
    verifiedByUserId: null,
  });

  const clientFindFirst = jest.fn(async () => ({ id: CLIENT_ID }));
  const facilityFindFirst = jest.fn(async () => options?.facility ?? facility());
  const grantFindFirst = jest.fn(async (args: unknown) => {
    const where = (args as { where?: { id?: string } }).where;
    if (where?.id === RELATIONSHIP_ID) return options?.existing ?? relationship();
    return options?.duplicate ?? null;
  });
  const grantCreate = jest.fn(async () => created);
  const grantUpdate = jest.fn(async () => rejected);
  const auditCreate = jest.fn(async () => ({ id: 'audit-1' }));

  const tx = {
    client: { findFirst: clientFindFirst },
    clientFacility: { findFirst: facilityFindFirst },
    clientGrantNexus: {
      findFirst: grantFindFirst,
      create: grantCreate,
      update: grantUpdate,
    },
    auditLog: { create: auditCreate },
  };
  const awardFindUnique = jest.fn(async () =>
    options && 'award' in options ? options.award : award(),
  );
  const withTenant = jest.fn(async (_tenantId: string, fn: (client: typeof tx) => unknown) => fn(tx));
  const prisma = {
    withTenant,
    federalAssistanceAward: { findUnique: awardFindUnique },
  } as unknown as PrismaService;

  return {
    service: new DistrictNexusRelationshipsService(prisma),
    tx,
    clientFindFirst,
    facilityFindFirst,
    grantFindFirst,
    grantCreate,
    grantUpdate,
    auditCreate,
    awardFindUnique,
    withTenant,
  };
}

const ACTOR = { userId: USER_ID, role: 'user_admin' as const };

describe('DistrictNexusRelationshipsService', () => {
  test('creates verified project-site evidence and its audit record in one tenant transaction', async () => {
    const h = harness();

    const result = await h.service.create(TENANT_ID, CLIENT_ID, ACTOR, {
      assistanceAwardId: AWARD_ID,
      relationshipType: 'project_site',
      facilityId: FACILITY_ID,
      relationshipDescription: 'Client performs a verified portion of the project here.',
      attributableAmount: 250_000,
      evidenceSourceRef: 'client-approved project agreement dated 2026-07-20',
      verificationStatus: 'verified',
      externalUseApproved: true,
      effectiveStart: '2026-01-01',
    });

    expect(h.withTenant).toHaveBeenCalledTimes(1);
    expect(h.facilityFindFirst).toHaveBeenCalledTimes(1);
    const createArgs = h.grantCreate.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(createArgs.data).toMatchObject({
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      assistanceAwardId: AWARD_ID,
      facilityId: FACILITY_ID,
      relationshipType: 'project_site',
      evidenceSourceType: 'analyst_manual_entry',
      verificationStatus: 'verified',
      externalUseApproved: true,
      confidence: 1,
      verifiedByUserId: USER_ID,
    });
    expect(h.auditCreate).toHaveBeenCalledTimes(1);
    const auditArgs = h.auditCreate.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(auditArgs.data).toMatchObject({
      tenantId: TENANT_ID,
      actorUserId: USER_ID,
      actorRole: 'user_admin',
      action: 'district_nexus.grant_relationship.create',
      entityType: 'client_grant_nexus',
      entityId: RELATIONSHIP_ID,
    });
    expect(auditArgs.data).not.toHaveProperty('before');
    expect(result.award.geographyBasis).toBe('place_of_performance');
    expect(result.facility?.id).toBe(FACILITY_ID);
  });

  test('requires a facility for project-site evidence before any tenant write begins', async () => {
    const h = harness();

    await expect(
      h.service.create(TENANT_ID, CLIENT_ID, ACTOR, {
        assistanceAwardId: AWARD_ID,
        relationshipType: 'project_site',
      }),
    ).rejects.toThrow('A project-site relationship requires a client facility.');

    expect(h.withTenant).not.toHaveBeenCalled();
    expect(h.grantCreate).not.toHaveBeenCalled();
  });

  test('refuses an attributable amount larger than the underlying federal obligation', async () => {
    const h = harness();

    await expect(
      h.service.create(TENANT_ID, CLIENT_ID, ACTOR, {
        assistanceAwardId: AWARD_ID,
        relationshipType: 'subrecipient',
        attributableAmount: 1_000_001,
      }),
    ).rejects.toThrow(
      'Attributable amount cannot exceed the award total obligated amount.',
    );

    expect(h.withTenant).not.toHaveBeenCalled();
  });

  test('verified evidence requires a concrete source reference', async () => {
    const h = harness();

    await expect(
      h.service.create(TENANT_ID, CLIENT_ID, ACTOR, {
        assistanceAwardId: AWARD_ID,
        relationshipType: 'research_partner',
        verificationStatus: 'verified',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(h.withTenant).not.toHaveBeenCalled();
  });

  test('soft-rejects a relationship and keeps the before/after audit trail', async () => {
    const h = harness();

    const result = await h.service.reject(
      TENANT_ID,
      CLIENT_ID,
      RELATIONSHIP_ID,
      ACTOR,
    );

    expect(result).toEqual({ id: RELATIONSHIP_ID, verificationStatus: 'rejected' });
    expect(h.grantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: RELATIONSHIP_ID },
        data: expect.objectContaining({
          verificationStatus: 'rejected',
          confidence: 0,
          externalUseApproved: false,
        }),
      }),
    );
    const auditArgs = h.auditCreate.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(auditArgs.data).toMatchObject({
      action: 'district_nexus.grant_relationship.reject',
      entityId: RELATIONSHIP_ID,
    });
    expect(auditArgs.data.before).toBeDefined();
    expect(auditArgs.data.after).toBeDefined();
  });
});
