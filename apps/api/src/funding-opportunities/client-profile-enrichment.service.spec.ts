import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, jest, test } from '@jest/globals';
import {
  ClientProfileEnrichmentService,
  TANGO_BUSINESS_TYPE_TO_CERTIFICATION,
} from './client-profile-enrichment.service.js';
import type { TangoEntity } from '../external/tango/tango.types.js';

const TENANT = 'tenant-1';

function entity(overrides: Partial<TangoEntity> = {}): TangoEntity {
  return {
    provenance: { provider: 'tango', resourceType: 'entity', externalId: 'UEI1', fetchedAt: 'x', providerUpdatedAt: null },
    uei: 'UEI1',
    cageCode: null,
    legalBusinessName: 'Synthetic Turbine Works LLC',
    dbaName: null,
    businessTypes: [],
    sbaBusinessTypes: [],
    naicsCodes: [],
    pscCodes: [],
    primaryNaics: null,
    registrationStatus: null,
    samExpirationDate: null,
    physicalAddress: null,
    entityStructure: null,
    stateOfIncorporation: null,
    ...overrides,
  };
}

function fakePrisma() {
  const clients: Record<string, any> = {};
  const candidates: Record<string, any> = {};
  let nextId = 1;
  let clock = 1;

  function matches(row: any, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([k, v]) => v === undefined || row[k] === v);
  }

  const tx = {
    client: {
      findFirst: jest.fn(async ({ where }: any) => clients[where.id] ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        Object.assign(clients[where.id], data);
        return clients[where.id];
      }),
    },
    clientProfileEnrichmentCandidate: {
      findFirst: jest.fn(async ({ where }: any) => {
        return Object.values(candidates).find((c) => matches(c, where)) ?? null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        return Object.values(candidates)
          .filter((c) => matches(c, where))
          .sort((a: any, b: any) => b.__seq - a.__seq);
      }),
      create: jest.fn(async ({ data }: any) => {
        const id = `cand-${nextId++}`;
        const row = {
          id,
          reviewedBy: null,
          reviewedAt: null,
          rejectionReason: null,
          status: 'pending',
          createdAt: new Date(clock++),
          __seq: nextId,
          ...data,
        };
        candidates[id] = row;
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        Object.assign(candidates[where.id], data);
        return candidates[where.id];
      }),
    },
  };

  const prisma: any = {
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };

  return { prisma, clients, candidates, tx };
}

function fakeTangoStore(byUei: Record<string, TangoEntity | undefined>) {
  return {
    getActiveSnapshot: jest.fn(async (_resourceType: string, externalId: string) => {
      const found = byUei[externalId];
      return found ? { normalizedJsonb: found } : null;
    }),
  } as any;
}

function buildService(byUei: Record<string, TangoEntity | undefined> = {}) {
  const { prisma, clients, candidates } = fakePrisma();
  const store = fakeTangoStore(byUei);
  return { service: new ClientProfileEnrichmentService(prisma, store), clients, candidates, store };
}

function seedClient(clients: Record<string, any>, overrides: Partial<Record<string, unknown>> = {}) {
  const row = {
    id: 'client-1',
    uei: 'UEI1',
    naicsCodes: [] as string[],
    pscCodes: [] as string[],
    setAsideCertifications: [] as string[],
    cageCode: null as string | null,
    ...overrides,
  };
  clients[row.id] = row;
  return row;
}

describe('proposeCandidatesForClient — no fetch without a UEI', () => {
  test('a client with no UEI is skipped, and the Tango store is never even queried', async () => {
    const { service, clients, store } = buildService();
    seedClient(clients, { uei: null });
    const result = await service.proposeCandidatesForClient(TENANT, 'client-1');
    expect(result).toMatchObject({ skipped: true, proposed: 0 });
    expect(store.getActiveSnapshot).not.toHaveBeenCalled();
  });

  test('a nonexistent client throws NotFoundException', async () => {
    const { service } = buildService();
    await expect(service.proposeCandidatesForClient(TENANT, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  test('a UEI with no active Tango snapshot yet is skipped', async () => {
    const { service, clients } = buildService();
    seedClient(clients);
    const result = await service.proposeCandidatesForClient(TENANT, 'client-1');
    expect(result).toMatchObject({ skipped: true });
  });
});

describe('proposeCandidatesForClient — array fields propose an ADDITIVE union', () => {
  test('new NAICS codes from Tango are proposed as the full union, not just the delta', async () => {
    const { service, clients, candidates } = buildService({ UEI1: entity({ naicsCodes: ['541512', '336412'] }) });
    seedClient(clients, { naicsCodes: ['541512'] });
    const result = await service.proposeCandidatesForClient(TENANT, 'client-1');
    expect(result.proposed).toBe(1);
    const row = Object.values(candidates)[0] as any;
    expect(row.field).toBe('naicsCodes');
    expect(row.currentValueJsonb).toEqual(['541512']);
    expect(row.proposedValueJsonb).toEqual(['541512', '336412']);
  });

  test('when Tango has nothing new, no candidate is created and the field is reported noChange', async () => {
    const { service, clients, candidates } = buildService({ UEI1: entity({ naicsCodes: ['541512'] }) });
    seedClient(clients, { naicsCodes: ['541512'] });
    const result = await service.proposeCandidatesForClient(TENANT, 'client-1');
    expect(result.proposed).toBe(0);
    expect(result.noChange).toContain('naicsCodes');
    expect(Object.keys(candidates)).toHaveLength(0);
  });

  test('PSC codes behave the same as NAICS codes', async () => {
    const { service, clients } = buildService({ UEI1: entity({ pscCodes: ['1560', 'J015'] }) });
    seedClient(clients, { pscCodes: [] });
    const result = await service.proposeCandidatesForClient(TENANT, 'client-1');
    expect(result.proposed).toBeGreaterThanOrEqual(1);
  });
});

describe('proposeCandidatesForClient — certifications: curated exact matches only', () => {
  test('a recognized business-type description proposes the mapped certification', async () => {
    const { service, clients, candidates } = buildService({
      UEI1: entity({ businessTypes: ['Woman Owned Small Business'] }),
    });
    seedClient(clients);
    const result = await service.proposeCandidatesForClient(TENANT, 'client-1');
    expect(result.proposed).toBe(1);
    const row = Object.values(candidates).find((c: any) => c.field === 'setAsideCertifications') as any;
    expect(row.proposedValueJsonb).toEqual(['WOSB']);
  });

  test('every curated mapping entry resolves to a real DURABLE_SET_ASIDE_CERTIFICATIONS value', () => {
    const DURABLE = ['8A', 'SDVOSB', 'VOSB', 'WOSB', 'EDWOSB', 'HUBZONE'];
    for (const value of Object.values(TANGO_BUSINESS_TYPE_TO_CERTIFICATION)) {
      expect(DURABLE).toContain(value);
    }
  });

  test('an UNRECOGNIZED business-type string is never guessed at — no certification proposed', async () => {
    const { service, clients, candidates } = buildService({
      UEI1: entity({ businessTypes: ['Some Novel Provider Label Nobody Curated'] }),
    });
    seedClient(clients);
    const result = await service.proposeCandidatesForClient(TENANT, 'client-1');
    expect(result.noChange).toContain('setAsideCertifications');
    expect(Object.values(candidates).some((c: any) => c.field === 'setAsideCertifications')).toBe(false);
  });

  test('an existing certification is never proposed for removal just because Tango omits it', async () => {
    // Absence of evidence is not evidence of absence.
    const { service, clients, candidates } = buildService({ UEI1: entity({ businessTypes: [] }) });
    seedClient(clients, { setAsideCertifications: ['HUBZONE'] });
    const result = await service.proposeCandidatesForClient(TENANT, 'client-1');
    expect(result.noChange).toContain('setAsideCertifications');
    expect(Object.values(candidates).some((c: any) => c.field === 'setAsideCertifications')).toBe(false);
  });

  test('sbaBusinessTypes are matched the same way as businessTypes', async () => {
    const { service, clients, candidates } = buildService({
      UEI1: entity({ sbaBusinessTypes: ['HUBZone Certified Small Business'] }),
    });
    seedClient(clients);
    await service.proposeCandidatesForClient(TENANT, 'client-1');
    const row = Object.values(candidates).find((c: any) => c.field === 'setAsideCertifications') as any;
    expect(row.proposedValueJsonb).toEqual(['HUBZONE']);
  });
});

describe('proposeCandidatesForClient — cageCode: fill-if-empty, flag-if-different', () => {
  test('an empty client cageCode gets Tango\'s value proposed', async () => {
    const { service, clients, candidates } = buildService({ UEI1: entity({ cageCode: '9ZZ99' }) });
    seedClient(clients, { cageCode: null });
    await service.proposeCandidatesForClient(TENANT, 'client-1');
    const row = Object.values(candidates).find((c: any) => c.field === 'cageCode') as any;
    expect(row.proposedValueJsonb).toBe('9ZZ99');
    expect(row.currentValueJsonb).toBeNull();
  });

  test('a DIFFERING cageCode is proposed as a discrepancy, not silently ignored', async () => {
    const { service, clients, candidates } = buildService({ UEI1: entity({ cageCode: 'NEW11' }) });
    seedClient(clients, { cageCode: 'OLD99' });
    await service.proposeCandidatesForClient(TENANT, 'client-1');
    const row = Object.values(candidates).find((c: any) => c.field === 'cageCode') as any;
    expect(row.currentValueJsonb).toBe('OLD99');
    expect(row.proposedValueJsonb).toBe('NEW11');
  });

  test('a MATCHING cageCode proposes nothing', async () => {
    const { service, clients, candidates } = buildService({ UEI1: entity({ cageCode: 'SAME1' }) });
    seedClient(clients, { cageCode: 'SAME1' });
    const result = await service.proposeCandidatesForClient(TENANT, 'client-1');
    expect(result.noChange).toContain('cageCode');
    expect(Object.values(candidates).some((c: any) => c.field === 'cageCode')).toBe(false);
  });
});

describe('proposeCandidatesForClient — durability: idempotent, and rejection survives a re-sync', () => {
  test('proposing twice with the identical snapshot creates only ONE candidate', async () => {
    const { service, clients, candidates } = buildService({ UEI1: entity({ naicsCodes: ['541512'] }) });
    seedClient(clients);
    const first = await service.proposeCandidatesForClient(TENANT, 'client-1');
    const second = await service.proposeCandidatesForClient(TENANT, 'client-1');
    expect(first.proposed).toBe(1);
    expect(second.proposed).toBe(0);
    expect(second.alreadyExisted).toBe(1);
    expect(Object.keys(candidates)).toHaveLength(1);
  });

  test('THE ACCEPTANCE BAR: a rejected candidate is never re-proposed by a later sync of the same data', async () => {
    const { service, clients, candidates } = buildService({ UEI1: entity({ naicsCodes: ['541512'] }) });
    seedClient(clients);
    await service.proposeCandidatesForClient(TENANT, 'client-1');
    const candidateId = Object.keys(candidates)[0]!;

    await service.reviewCandidate(TENANT, candidateId, {
      status: 'rejected',
      reviewedBy: 'user-1',
      rejectionReason: 'Not a real NAICS for this client',
    });

    // Re-run the sync as if a later scheduled job proposed the SAME data again.
    const resync = await service.proposeCandidatesForClient(TENANT, 'client-1');
    expect(resync.proposed).toBe(0);
    expect(resync.alreadyExisted).toBe(1);
    expect(Object.keys(candidates)).toHaveLength(1);
    expect(candidates[candidateId]!.status).toBe('rejected');
  });

  test('a GENUINELY DIFFERENT proposed value for the same field is a NEW candidate, not blocked forever', async () => {
    const { service, clients, candidates } = buildService({ UEI1: entity({ naicsCodes: ['541512'] }) });
    seedClient(clients);
    await service.proposeCandidatesForClient(TENANT, 'client-1');
    const firstId = Object.keys(candidates)[0]!;
    await service.reviewCandidate(TENANT, firstId, { status: 'rejected', reviewedBy: 'u1', rejectionReason: 'no' });

    // The real-world Tango data changes to something NEW — swap the service's
    // store for one returning the new snapshot, reusing the SAME candidates
    // table so durability is checked against the SAME tenant/client history.
    (service as unknown as { tangoStore: unknown }).tangoStore = fakeTangoStore({
      UEI1: entity({ naicsCodes: ['541512', '999999'] }),
    });

    const result = await service.proposeCandidatesForClient(TENANT, 'client-1');
    expect(result.proposed).toBe(1);
    expect(Object.keys(candidates)).toHaveLength(2);
  });
});

describe('reviewCandidate — exactly one at a time, and applies on accept', () => {
  test('accepting applies the proposed value to the actual client field', async () => {
    const { service, clients, candidates } = buildService({ UEI1: entity({ naicsCodes: ['541512', '336412'] }) });
    seedClient(clients, { naicsCodes: ['541512'] });
    await service.proposeCandidatesForClient(TENANT, 'client-1');
    const candidateId = Object.keys(candidates)[0]!;

    const view = await service.reviewCandidate(TENANT, candidateId, { status: 'accepted', reviewedBy: 'user-1' });
    expect(view.status).toBe('accepted');
    expect(view.reviewedBy).toBe('user-1');
    expect(clients['client-1']!.naicsCodes).toEqual(['541512', '336412']);
  });

  test('rejecting does NOT touch the client field at all', async () => {
    const { service, clients, candidates } = buildService({ UEI1: entity({ naicsCodes: ['541512', '336412'] }) });
    seedClient(clients, { naicsCodes: ['541512'] });
    await service.proposeCandidatesForClient(TENANT, 'client-1');
    const candidateId = Object.keys(candidates)[0]!;

    await service.reviewCandidate(TENANT, candidateId, { status: 'rejected', reviewedBy: 'user-1', rejectionReason: 'no' });
    expect(clients['client-1']!.naicsCodes).toEqual(['541512']);
  });

  test('rejecting with no reason is refused', async () => {
    const { service, clients, candidates } = buildService({ UEI1: entity({ naicsCodes: ['541512'] }) });
    seedClient(clients);
    await service.proposeCandidatesForClient(TENANT, 'client-1');
    const candidateId = Object.keys(candidates)[0]!;
    await expect(
      service.reviewCandidate(TENANT, candidateId, { status: 'rejected', reviewedBy: 'user-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.reviewCandidate(TENANT, candidateId, { status: 'rejected', reviewedBy: 'user-1', rejectionReason: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test('reviewing a candidate twice is refused — a decision is not reversible through this method', async () => {
    const { service, clients, candidates } = buildService({ UEI1: entity({ naicsCodes: ['541512'] }) });
    seedClient(clients);
    await service.proposeCandidatesForClient(TENANT, 'client-1');
    const candidateId = Object.keys(candidates)[0]!;
    await service.reviewCandidate(TENANT, candidateId, { status: 'accepted', reviewedBy: 'user-1' });
    await expect(
      service.reviewCandidate(TENANT, candidateId, { status: 'rejected', reviewedBy: 'user-2', rejectionReason: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  test('reviewing a nonexistent candidate throws NotFoundException', async () => {
    const { service } = buildService();
    await expect(
      service.reviewCandidate(TENANT, 'missing', { status: 'accepted', reviewedBy: 'user-1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  test('there is no bulk-review method on this service — every review is exactly one candidate', () => {
    const proto = ClientProfileEnrichmentService.prototype as unknown as Record<string, unknown>;
    const methodNames = Object.getOwnPropertyNames(proto);
    const bulkLike = methodNames.filter((n) => /all|bulk|batch/i.test(n));
    expect(bulkLike).toEqual([]);
  });
});

describe('listCandidates', () => {
  test('filters by clientId and by status', async () => {
    const { service, clients, candidates } = buildService({
      UEI1: entity({ naicsCodes: ['541512'] }),
    });
    seedClient(clients, { id: 'client-1', uei: 'UEI1' });
    seedClient(clients, { id: 'client-2', uei: 'UEI1' });
    await service.proposeCandidatesForClient(TENANT, 'client-1');
    await service.proposeCandidatesForClient(TENANT, 'client-2');

    const forClient1 = await service.listCandidates(TENANT, { clientId: 'client-1' });
    expect(forClient1).toHaveLength(1);
    expect(forClient1[0]!.clientId).toBe('client-1');

    const candidateId = Object.keys(candidates).find((id) => candidates[id]!.clientId === 'client-1')!;
    await service.reviewCandidate(TENANT, candidateId, { status: 'accepted', reviewedBy: 'u1' });

    const pending = await service.listCandidates(TENANT, { status: 'pending' });
    expect(pending.every((c) => c.status === 'pending')).toBe(true);
    const accepted = await service.listCandidates(TENANT, { status: 'accepted' });
    expect(accepted).toHaveLength(1);
  });
});
