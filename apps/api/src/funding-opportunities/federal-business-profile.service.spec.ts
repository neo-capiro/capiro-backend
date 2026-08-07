import { NotFoundException } from '@nestjs/common';
import { describe, expect, jest, test } from '@jest/globals';
import { FederalBusinessProfileService } from './federal-business-profile.service.js';
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

function snapshotRow(version: number, active: boolean, entityValue: TangoEntity, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    version,
    active,
    providerFetchedAt: new Date(`2026-08-0${version}T00:00:00.000Z`),
    sourceUpdatedAt: null,
    contentSha256: `hash-v${version}`,
    normalizedJsonb: entityValue,
    ...overrides,
  };
}

function fakePrisma(clientRow: Record<string, unknown> | null) {
  return {
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ client: { findFirst: jest.fn(async () => clientRow) } }),
    ),
  } as any;
}

function fakeTangoStore(history: ReturnType<typeof snapshotRow>[]) {
  return { getSnapshotHistory: jest.fn(async () => history) } as any;
}

function fakeEnrichment(pending: unknown[] = []) {
  return { listCandidates: jest.fn(async () => pending) } as any;
}

function clientRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'client-1',
    uei: 'UEI1',
    naicsCodes: ['541512'],
    pscCodes: [],
    setAsideCertifications: [],
    cageCode: null,
    tangoEntityLastSyncedAt: null,
    tangoEntityLastAttemptAt: null,
    tangoEntityLastError: null,
    ...overrides,
  };
}

describe('getProfile — no UEI, nothing to verify or version', () => {
  test('returns firstParty populated, everything Tango-shaped empty/null', async () => {
    const prisma = fakePrisma(clientRow({ uei: null }));
    const store = fakeTangoStore([]);
    const enrichment = fakeEnrichment([]);
    const service = new FederalBusinessProfileService(prisma, store, enrichment);

    const profile = await service.getProfile(TENANT, 'client-1');
    expect(profile.uei).toBeNull();
    expect(profile.verified).toBeNull();
    expect(profile.history).toEqual([]);
    expect(profile.pendingEnrichment).toEqual([]);
    expect(profile.firstParty.naicsCodes).toEqual(['541512']);
    expect(store.getSnapshotHistory).not.toHaveBeenCalled();
  });

  test('a nonexistent client throws NotFoundException', async () => {
    const service = new FederalBusinessProfileService(fakePrisma(null), fakeTangoStore([]), fakeEnrichment([]));
    await expect(service.getProfile(TENANT, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('getProfile — UEI present but never synced', () => {
  test('verified is null and history is empty when no snapshot exists yet', async () => {
    const service = new FederalBusinessProfileService(fakePrisma(clientRow()), fakeTangoStore([]), fakeEnrichment([]));
    const profile = await service.getProfile(TENANT, 'client-1');
    expect(profile.verified).toBeNull();
    expect(profile.history).toEqual([]);
  });
});

describe('getProfile — versioned history', () => {
  test('history carries every version, oldest first, verbatim from the store', async () => {
    const history = [
      snapshotRow(1, false, entity({ naicsCodes: ['541512'] })),
      snapshotRow(2, false, entity({ naicsCodes: ['541512', '336412'] })),
      snapshotRow(3, true, entity({ naicsCodes: ['541512', '336412', '999999'] })),
    ];
    const service = new FederalBusinessProfileService(fakePrisma(clientRow()), fakeTangoStore(history), fakeEnrichment([]));
    const profile = await service.getProfile(TENANT, 'client-1');

    expect(profile.history).toHaveLength(3);
    expect(profile.history.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(profile.history[0]!.active).toBe(false);
    expect(profile.history[2]!.active).toBe(true);
  });

  test('verified is exactly the ACTIVE version from history, not assumed to be the last one', async () => {
    // Deliberately out of order relative to "active = latest" to prove this
    // reads the `active` flag, not array position.
    const history = [
      snapshotRow(1, true, entity({ legalBusinessName: 'Old Name Inc' })),
      snapshotRow(2, false, entity({ legalBusinessName: 'Superseded Mid Name LLC' })),
    ];
    const service = new FederalBusinessProfileService(fakePrisma(clientRow()), fakeTangoStore(history), fakeEnrichment([]));
    const profile = await service.getProfile(TENANT, 'client-1');
    expect(profile.verified!.version).toBe(1);
    expect(profile.verified!.entity.legalBusinessName).toBe('Old Name Inc');
  });

  test('no active row in history (a real, if unusual, state) leaves verified null without throwing', async () => {
    const history = [snapshotRow(1, false, entity()), snapshotRow(2, false, entity())];
    const service = new FederalBusinessProfileService(fakePrisma(clientRow()), fakeTangoStore(history), fakeEnrichment([]));
    const profile = await service.getProfile(TENANT, 'client-1');
    expect(profile.verified).toBeNull();
    expect(profile.history).toHaveLength(2);
  });
});

describe('getProfile — firstParty and verified are separate, never merged', () => {
  test('a disagreement between the two sides is visible, not silently resolved', async () => {
    const history = [snapshotRow(1, true, entity({ naicsCodes: ['999999'] }))];
    const service = new FederalBusinessProfileService(
      fakePrisma(clientRow({ naicsCodes: ['541512'] })),
      fakeTangoStore(history),
      fakeEnrichment([]),
    );
    const profile = await service.getProfile(TENANT, 'client-1');
    expect(profile.firstParty.naicsCodes).toEqual(['541512']);
    expect(profile.verified!.entity.naicsCodes).toEqual(['999999']);
  });
});

describe('getProfile — pending enrichment and sync status', () => {
  test('lists ONLY pending candidates for this client', async () => {
    const enrichment = fakeEnrichment([{ id: 'cand-1', field: 'naicsCodes', status: 'pending' }]);
    const service = new FederalBusinessProfileService(fakePrisma(clientRow()), fakeTangoStore([]), enrichment);
    const profile = await service.getProfile(TENANT, 'client-1');
    expect(profile.pendingEnrichment).toHaveLength(1);
    expect(enrichment.listCandidates).toHaveBeenCalledWith(TENANT, { clientId: 'client-1', status: 'pending' });
  });

  test('sync status timestamps are ISO strings, and null passes through as null', async () => {
    const service = new FederalBusinessProfileService(
      fakePrisma(clientRow({ tangoEntityLastSyncedAt: new Date('2026-08-01T00:00:00.000Z'), tangoEntityLastError: 'boom' })),
      fakeTangoStore([]),
      fakeEnrichment([]),
    );
    const profile = await service.getProfile(TENANT, 'client-1');
    expect(profile.syncStatus.lastSyncedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(profile.syncStatus.lastAttemptAt).toBeNull();
    expect(profile.syncStatus.lastError).toBe('boom');
  });
});
