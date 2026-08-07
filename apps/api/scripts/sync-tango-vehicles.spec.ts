import { describe, expect, jest, test } from '@jest/globals';
import { parseArgs, runVehicleSync, type KnownClientRef, type VehicleSyncDeps } from './sync-tango-vehicles.js';
import { TangoRequestCeilingExceededError } from '../src/external/tango/tango-resilience.service.js';
import { computeFilterFingerprint } from '../src/external/tango/tango-store.service.js';
import type { TangoEntity, TangoVehicle, TangoVehicleAwardee } from '../src/external/tango/tango.types.js';

describe('CLI parsing', () => {
  test('dry run is the default, with a 500-vehicle limit', () => {
    expect(parseArgs([])).toEqual({ commit: false, limit: 500 });
  });

  test('--commit and --limit, clamped at 5000', () => {
    expect(parseArgs(['--commit'])).toEqual({ commit: true, limit: 500 });
    expect(parseArgs(['--limit=10'])).toEqual({ commit: false, limit: 10 });
    expect(parseArgs(['--limit=999999']).limit).toBe(5000);
    expect(parseArgs(['--limit=0']).limit).toBe(500);
  });
});

function vehicle(id: string, overrides: Partial<TangoVehicle> = {}): TangoVehicle {
  return {
    provenance: { provider: 'tango', resourceType: 'vehicle', externalId: id, fetchedAt: 'x', providerUpdatedAt: null },
    vehicleId: id,
    programAcronym: `PROG-${id}`,
    solicitationTitle: null,
    solicitationIdentifier: null,
    vehicleType: 'GWAC',
    agencyId: null,
    organizationId: null,
    naicsCode: null,
    pscCode: null,
    setAside: null,
    whoCanUse: null,
    awardDate: null,
    lastDateToOrder: null,
    idvCount: null,
    awardeeCount: null,
    orderCount: null,
    totalObligated: null,
    ...overrides,
  };
}

function awardee(id: string, overrides: Partial<TangoVehicleAwardee> = {}): TangoVehicleAwardee {
  return {
    provenance: { provider: 'tango', resourceType: 'vehicle_awardee', externalId: id, fetchedAt: 'x', providerUpdatedAt: null },
    awardeeId: id,
    contractKey: null,
    piid: null,
    title: null,
    awardDate: null,
    orderCount: 3,
    idvObligations: 100000,
    idvContractsValue: 200000,
    recipientUei: null,
    recipientParentUei: null,
    recipientName: null,
    ...overrides,
  };
}

function fakeGateway(
  vehiclePages: Array<{ items: TangoVehicle[]; nextCursor: string | null }>,
  awardeesByVehicle: Record<string, Array<{ items: TangoVehicleAwardee[]; nextCursor: string | null }>>,
) {
  let vehicleCall = 0;
  const awardeeCallIndex: Record<string, number> = {};
  return {
    listVehicles: jest.fn(async (options?: { limit?: number; cursor?: string | null }) => {
      const page = vehiclePages[Math.min(vehicleCall, vehiclePages.length - 1)]!;
      vehicleCall += 1;
      const limit = options?.limit;
      // A real gateway never returns more than the requested `limit` — it
      // truncates and leaves a cursor for the remainder rather than
      // dropping it. A staged fixture can legitimately hold more items than
      // a small --limit leaves room for (see the mid-page-limit regression
      // test below); without this the fake would mask exactly the
      // over-fetch bug that test exists to catch.
      if (limit != null && page.items.length > limit) {
        return { items: page.items.slice(0, limit), totalCount: null, nextCursor: `__truncated__${vehicleCall}`, rate: null };
      }
      return { items: page.items, totalCount: null, nextCursor: page.nextCursor, rate: null };
    }),
    listVehicleAwardees: jest.fn(async (vehicleId: string) => {
      const pages = awardeesByVehicle[vehicleId] ?? [{ items: [], nextCursor: null }];
      const idx = awardeeCallIndex[vehicleId] ?? 0;
      awardeeCallIndex[vehicleId] = idx + 1;
      const page = pages[Math.min(idx, pages.length - 1)]!;
      return { items: page.items, totalCount: null, nextCursor: page.nextCursor, rate: null };
    }),
    // Unused by this sync, present only to satisfy the TangoGateway interface.
    configured: true,
    lastRate: null,
    getVersion: jest.fn(async () => ({})),
    getEntity: jest.fn(async (): Promise<TangoEntity | null> => null),
    listEntities: jest.fn(async () => ({ items: [], totalCount: null, nextCursor: null, rate: null })),
    listOpportunities: jest.fn(async () => ({ items: [], totalCount: null, nextCursor: null, rate: null })),
    listNotices: jest.fn(async () => ({ items: [], totalCount: null, nextCursor: null, rate: null })),
    listForecasts: jest.fn(async () => ({ items: [], totalCount: null, nextCursor: null, rate: null })),
  } as any;
}

function fakeStore() {
  const snapshots: unknown[] = [];
  const checkpoints: unknown[] = [];
  let storedCheckpoint: { cursor: string | null } | null = null;
  const store = {
    readCheckpoint: jest.fn(async () => storedCheckpoint),
    writeCheckpoint: jest.fn(async (input: any) => {
      checkpoints.push(input);
      storedCheckpoint = { cursor: input.cursor };
      return {};
    }),
    writeSnapshot: jest.fn(async (input: any) => {
      snapshots.push(input);
      return { id: 'snap', version: 1, contentSha256: 'x', created: true };
    }),
  };
  return { store: store as unknown as VehicleSyncDeps['store'], snapshots, checkpoints };
}

function knownUeis(map: Record<string, KnownClientRef[]>) {
  return jest.fn(async () => new Map(Object.entries(map)));
}

describe('runVehicleSync — a vehicle with no matching awardee writes nothing', () => {
  test('no snapshot, no relevant-vehicle row, but the vehicle IS counted as processed', async () => {
    const gateway = fakeGateway(
      [{ items: [vehicle('V1')], nextCursor: null }],
      { V1: [{ items: [awardee('A1', { recipientUei: 'UNRELATED' })], nextCursor: null }] },
    );
    const { store, snapshots } = fakeStore();
    const upsertRelevantVehicle = jest.fn(async () => {});

    const summary = await runVehicleSync(
      { gateway, store, loadKnownUeis: knownUeis({ KNOWNUEI: [{ tenantId: 't1', clientId: 'c1' }] }), upsertRelevantVehicle },
      { commit: true, limit: 500 },
    );

    expect(summary).toMatchObject({ vehiclesProcessed: 1, vehiclesRelevant: 0, relevantRowsWritten: 0 });
    expect(snapshots).toHaveLength(0);
    expect(upsertRelevantVehicle).not.toHaveBeenCalled();
  });
});

describe('runVehicleSync — a matching awardee writes vehicle + awardee snapshots and a relevant-vehicle row', () => {
  test('self relationship: the awardee IS the known client', async () => {
    const v = vehicle('V1');
    const a = awardee('A1', { recipientUei: 'KNOWNUEI' });
    const gateway = fakeGateway([{ items: [v], nextCursor: null }], { V1: [{ items: [a], nextCursor: null }] });
    const { store, snapshots } = fakeStore();
    const upsertRelevantVehicle = jest.fn(async () => {});

    const summary = await runVehicleSync(
      { gateway, store, loadKnownUeis: knownUeis({ KNOWNUEI: [{ tenantId: 't1', clientId: 'c1' }] }), upsertRelevantVehicle },
      { commit: true, limit: 500 },
    );

    expect(summary).toMatchObject({ vehiclesProcessed: 1, vehiclesRelevant: 1, relevantRowsWritten: 1 });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({ resourceType: 'vehicle', externalId: 'V1' });
    expect(snapshots[1]).toMatchObject({ resourceType: 'vehicle_awardee', externalId: 'V1#A1' });
    expect(upsertRelevantVehicle).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', clientId: 'c1', relationship: 'self' }),
    );
  });

  test('parent relationship: the awardee\'s PARENT is the known client', async () => {
    const v = vehicle('V1');
    const a = awardee('A1', { recipientUei: 'SUBSIDIARY', recipientParentUei: 'PARENTUEI' });
    const gateway = fakeGateway([{ items: [v], nextCursor: null }], { V1: [{ items: [a], nextCursor: null }] });
    const { store } = fakeStore();
    const upsertRelevantVehicle = jest.fn(async () => {});

    await runVehicleSync(
      { gateway, store, loadKnownUeis: knownUeis({ PARENTUEI: [{ tenantId: 't1', clientId: 'c1' }] }), upsertRelevantVehicle },
      { commit: true, limit: 500 },
    );

    expect(upsertRelevantVehicle).toHaveBeenCalledWith(
      expect.objectContaining({ relationship: 'parent' }),
    );
  });

  test('the SAME awardee can match multiple known clients (e.g. across two tenants)', async () => {
    const v = vehicle('V1');
    const a = awardee('A1', { recipientUei: 'SHAREDUEI' });
    const gateway = fakeGateway([{ items: [v], nextCursor: null }], { V1: [{ items: [a], nextCursor: null }] });
    const { store } = fakeStore();
    const upsertRelevantVehicle = jest.fn(async () => {});

    const summary = await runVehicleSync(
      {
        gateway,
        store,
        loadKnownUeis: knownUeis({ SHAREDUEI: [{ tenantId: 't1', clientId: 'c1' }, { tenantId: 't2', clientId: 'c2' }] }),
        upsertRelevantVehicle,
      },
      { commit: true, limit: 500 },
    );

    expect(summary.relevantRowsWritten).toBe(2);
    expect(upsertRelevantVehicle).toHaveBeenCalledTimes(2);
  });

  test('dry run still walks vehicles and awardees, but writes nothing', async () => {
    const v = vehicle('V1');
    const a = awardee('A1', { recipientUei: 'KNOWNUEI' });
    const gateway = fakeGateway([{ items: [v], nextCursor: null }], { V1: [{ items: [a], nextCursor: null }] });
    const { store, snapshots, checkpoints } = fakeStore();
    const upsertRelevantVehicle = jest.fn(async () => {});

    const summary = await runVehicleSync(
      { gateway, store, loadKnownUeis: knownUeis({ KNOWNUEI: [{ tenantId: 't1', clientId: 'c1' }] }), upsertRelevantVehicle },
      { commit: false, limit: 500 },
    );

    expect(summary.vehiclesRelevant).toBe(1);
    expect(snapshots).toHaveLength(0);
    expect(checkpoints).toHaveLength(0);
    expect(upsertRelevantVehicle).not.toHaveBeenCalled();
  });
});

describe('runVehicleSync — pagination: multi-page vehicles AND multi-page awardees within one vehicle', () => {
  test('awardees paginate fully within one vehicle before moving to the next', async () => {
    const v1 = vehicle('V1');
    const gateway = fakeGateway(
      [{ items: [v1], nextCursor: null }],
      {
        V1: [
          { items: [awardee('A1', { recipientUei: 'X' })], nextCursor: 'cursor-2' },
          { items: [awardee('A2', { recipientUei: 'KNOWNUEI' })], nextCursor: null },
        ],
      },
    );
    const { store, snapshots } = fakeStore();
    const upsertRelevantVehicle = jest.fn(async () => {});

    await runVehicleSync(
      { gateway, store, loadKnownUeis: knownUeis({ KNOWNUEI: [{ tenantId: 't1', clientId: 'c1' }] }), upsertRelevantVehicle },
      { commit: true, limit: 500 },
    );

    expect(gateway.listVehicleAwardees).toHaveBeenCalledTimes(2);
    // Only A2 (page 2) matched; A1 (page 1) did not.
    expect(snapshots.find((s: any) => s.externalId === 'V1#A2')).toBeDefined();
    expect(snapshots.find((s: any) => s.externalId === 'V1#A1')).toBeUndefined();
  });

  test('the vehicle cursor is read from the checkpoint and passed to the first page', async () => {
    const gateway = fakeGateway([{ items: [], nextCursor: null }], {});
    const { store } = fakeStore();
    (store.readCheckpoint as jest.Mock).mockResolvedValueOnce({ cursor: 'vehicle-99' } as never);

    await runVehicleSync(
      { gateway, store, loadKnownUeis: knownUeis({}), upsertRelevantVehicle: jest.fn(async () => {}) },
      { commit: true, limit: 500 },
    );

    expect(gateway.listVehicles).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'vehicle-99' }));
  });

  test('the checkpoint uses this sync verb, resourceType vehicle, and an empty filter fingerprint', async () => {
    const gateway = fakeGateway([{ items: [vehicle('V1')], nextCursor: null }], {});
    const { store } = fakeStore();
    await runVehicleSync(
      { gateway, store, loadKnownUeis: knownUeis({}), upsertRelevantVehicle: jest.fn(async () => {}) },
      { commit: true, limit: 500 },
    );
    expect(store.readCheckpoint).toHaveBeenCalledWith('sync-tango-vehicles', 'vehicle', computeFilterFingerprint({}));
  });

  test('completeness is in_progress when the outer vehicle list has more pages', async () => {
    const gateway = fakeGateway([{ items: [vehicle('V1')], nextCursor: 'more' }], {});
    const { store } = fakeStore();
    const summary = await runVehicleSync(
      { gateway, store, loadKnownUeis: knownUeis({}), upsertRelevantVehicle: jest.fn(async () => {}) },
      { commit: true, limit: 500 },
    );
    expect(summary.completeness).toBe('in_progress');
  });

  test('vehiclesProcessed respects the limit, and completeness correctly stays in_progress (not a false complete)', async () => {
    const gateway = fakeGateway([{ items: [vehicle('V1'), vehicle('V2'), vehicle('V3')], nextCursor: null }], {});
    const { store, checkpoints } = fakeStore();
    const summary = await runVehicleSync(
      { gateway, store, loadKnownUeis: knownUeis({}), upsertRelevantVehicle: jest.fn(async () => {}) },
      { commit: true, limit: 2 },
    );
    expect(summary.vehiclesProcessed).toBe(2);
    // Regression: hitting --limit mid-page must NOT be reported as
    // 'complete' — a 3rd vehicle exists that this run never reached. Before
    // the fix, a mid-page stop skipped the `cursor = page.nextCursor`
    // update and the checkpoint write entirely, leaving `cursor` at its
    // initial `null` and wrongly reporting 'complete' — a resumed run would
    // have restarted from scratch instead of continuing.
    expect(summary.completeness).toBe('in_progress');
    // Root-cause check, not just the symptom: the gateway must be asked for
    // only what's left (2), never a full batch that gets partly discarded.
    expect(gateway.listVehicles).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
    // The checkpoint is what a resumed run actually reads — it must carry a
    // real, non-null cursor alongside 'in_progress'.
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ completeness: 'in_progress' });
    expect((checkpoints[0] as any).cursor).not.toBeNull();
  });
});

describe('runVehicleSync — errors', () => {
  test('a generic error on one vehicle does not stop the sync, and is counted', async () => {
    const gateway = fakeGateway([{ items: [vehicle('V1'), vehicle('V2')], nextCursor: null }], {
      V2: [{ items: [awardee('A1', { recipientUei: 'KNOWNUEI' })], nextCursor: null }],
    });
    (gateway.listVehicleAwardees as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('transient boom');
    });
    const { store } = fakeStore();
    const upsertRelevantVehicle = jest.fn(async () => {});

    const summary = await runVehicleSync(
      { gateway, store, loadKnownUeis: knownUeis({ KNOWNUEI: [{ tenantId: 't1', clientId: 'c1' }] }), upsertRelevantVehicle },
      { commit: true, limit: 500 },
    );

    expect(summary.errored).toBe(1);
    expect(summary.vehiclesProcessed).toBe(2);
    // V2's real match still landed despite V1's failure.
    expect(upsertRelevantVehicle).toHaveBeenCalledTimes(1);
  });

  test('a request-ceiling error stops the WHOLE sync immediately, not counted as errored', async () => {
    const gateway = fakeGateway([{ items: [vehicle('V1'), vehicle('V2')], nextCursor: null }], {});
    (gateway.listVehicleAwardees as jest.Mock).mockImplementationOnce(async () => {
      throw new TangoRequestCeilingExceededError('listVehicleAwardees', 100);
    });
    const { store } = fakeStore();
    const upsertRelevantVehicle = jest.fn(async () => {});

    const summary = await runVehicleSync(
      { gateway, store, loadKnownUeis: knownUeis({}), upsertRelevantVehicle },
      { commit: true, limit: 500 },
    );

    expect(summary.ceilingReached).toBe(true);
    expect(summary.errored).toBe(0);
    expect(summary.completeness).toBe('in_progress');
    // V2 was never even attempted.
    expect(gateway.listVehicleAwardees).toHaveBeenCalledTimes(1);
  });
});
