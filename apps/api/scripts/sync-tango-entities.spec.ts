import { describe, expect, jest, test } from '@jest/globals';
import { parseArgs, runEntitySync, type SyncDeps, type UeiClientRow } from './sync-tango-entities.js';
import { computeFilterFingerprint } from '../src/external/tango/tango-store.service.js';
import type { TangoEntity } from '../src/external/tango/tango.types.js';

describe('CLI parsing', () => {
  test('dry run is the default, with a 500-row limit', () => {
    expect(parseArgs([])).toEqual({ commit: false, limit: 500 });
  });

  test('--commit and --limit', () => {
    expect(parseArgs(['--commit'])).toEqual({ commit: true, limit: 500 });
    expect(parseArgs(['--limit=10'])).toEqual({ commit: false, limit: 10 });
    expect(parseArgs(['--commit', '--limit', '3'])).toEqual({ commit: true, limit: 3 });
  });

  test('the limit is clamped at 5000, and a bad value falls back to the default', () => {
    expect(parseArgs(['--limit=999999']).limit).toBe(5000);
    expect(parseArgs(['--limit=0']).limit).toBe(500);
    expect(parseArgs(['--limit=-5']).limit).toBe(500);
    expect(parseArgs(['--limit=nonsense']).limit).toBe(500);
  });
});

function entity(uei: string, overrides: Partial<TangoEntity> = {}): TangoEntity {
  return {
    provenance: { provider: 'tango', resourceType: 'entity', externalId: uei, fetchedAt: '2026-08-07T00:00:00.000Z', providerUpdatedAt: null },
    uei,
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

function fakeStore(overrides: Partial<Record<string, unknown>> = {}) {
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
      return { id: 'snap-1', version: 1, contentSha256: 'x', created: true };
    }),
    ...overrides,
  };
  return { store: store as unknown as SyncDeps['store'], snapshots, checkpoints, setCheckpoint: (c: { cursor: string | null } | null) => (storedCheckpoint = c) };
}

function fakeGateway(getEntityImpl: (uei: string) => Promise<TangoEntity | null>) {
  return { getEntity: jest.fn(getEntityImpl) } as unknown as SyncDeps['gateway'];
}

function clients(...ueis: string[]): UeiClientRow[] {
  return ueis.map((uei, i) => ({ id: `client-${i + 1}`, uei }));
}

describe('runEntitySync — pagination and checkpoint', () => {
  test('a single batch smaller than batchSize completes in one pass', async () => {
    const { store } = fakeStore();
    const gateway = fakeGateway(async (uei) => entity(uei));
    const readClientBatch = jest.fn(async (_cursor: string | null, _take: number) => clients('UEI001', 'UEI002'));
    const updateClientStatus = jest.fn(async () => {});

    const summary = await runEntitySync(
      { gateway, store, readClientBatch, updateClientStatus },
      { commit: true, limit: 500, batchSize: 25 },
    );

    expect(summary).toMatchObject({ processed: 2, synced: 2, notFound: 0, errored: 0, completeness: 'complete' });
    expect(readClientBatch).toHaveBeenCalledTimes(1);
  });

  test('a full batch followed by an empty one walks to completion across two reads', async () => {
    const { store } = fakeStore();
    const gateway = fakeGateway(async (uei) => entity(uei));
    let call = 0;
    const readClientBatch = jest.fn(async () => {
      call += 1;
      return call === 1 ? clients('U1', 'U2') : [];
    });
    const updateClientStatus = jest.fn(async () => {});

    const summary = await runEntitySync(
      { gateway, store, readClientBatch, updateClientStatus },
      { commit: true, limit: 500, batchSize: 2 },
    );

    expect(readClientBatch).toHaveBeenCalledTimes(2);
    expect(summary.completeness).toBe('complete');
    expect(summary.processed).toBe(2);
  });

  test('the checkpoint cursor is read at start and passed to the FIRST batch read', async () => {
    const { store, setCheckpoint } = fakeStore();
    setCheckpoint({ cursor: 'client-99' });
    const gateway = fakeGateway(async (uei) => entity(uei));
    const readClientBatch = jest.fn(async () => []);
    const updateClientStatus = jest.fn(async () => {});

    await runEntitySync({ gateway, store, readClientBatch, updateClientStatus }, { commit: true, limit: 500 });

    expect(readClientBatch).toHaveBeenCalledWith('client-99', expect.any(Number));
  });

  test('the cursor advances to the LAST row of each batch, not the first', async () => {
    const { store } = fakeStore();
    const gateway = fakeGateway(async (uei) => entity(uei));
    const readClientBatch = jest.fn(async () => clients('A', 'B', 'C'));
    const updateClientStatus = jest.fn(async () => {});

    // batchSize 3 == the batch length, so this is the terminal batch; assert
    // via the checkpoint write rather than a second read.
    await runEntitySync({ gateway, store, readClientBatch, updateClientStatus }, { commit: true, limit: 3, batchSize: 3 });
    expect((store.writeCheckpoint as jest.Mock).mock.calls[0]![0]).toMatchObject({ cursor: 'client-3' });
  });

  test('checkpoint completeness is in_progress when a full batch is processed but the limit is not yet reached', async () => {
    const { store } = fakeStore();
    const gateway = fakeGateway(async (uei) => entity(uei));
    let call = 0;
    const readClientBatch = jest.fn(async () => {
      call += 1;
      return call === 1 ? clients('A', 'B') : [];
    });
    const updateClientStatus = jest.fn(async () => {});

    await runEntitySync({ gateway, store, readClientBatch, updateClientStatus }, { commit: true, limit: 500, batchSize: 2 });
    const firstWrite = (store.writeCheckpoint as jest.Mock).mock.calls[0]![0] as any;
    expect(firstWrite.completeness).toBe('in_progress');
  });

  test('reaching the limit mid-run reports complete, not in_progress', async () => {
    const { store } = fakeStore();
    const gateway = fakeGateway(async (uei) => entity(uei));
    const readClientBatch = jest.fn(async () => clients('A', 'B'));
    const updateClientStatus = jest.fn(async () => {});

    const summary = await runEntitySync(
      { gateway, store, readClientBatch, updateClientStatus },
      { commit: true, limit: 2, batchSize: 25 },
    );
    expect(summary.completeness).toBe('complete');
    expect(summary.processed).toBe(2);
  });

  test('an empty client base on the very first read is immediately complete', async () => {
    const { store, checkpoints } = fakeStore();
    const gateway = fakeGateway(async (uei) => entity(uei));
    const readClientBatch = jest.fn(async () => []);
    const updateClientStatus = jest.fn(async () => {});

    const summary = await runEntitySync({ gateway, store, readClientBatch, updateClientStatus }, { commit: true, limit: 500 });
    expect(summary).toMatchObject({ processed: 0, completeness: 'complete' });
    expect(checkpoints[0]).toMatchObject({ rowsProcessed: 0 });
  });

  test('the checkpoint uses the entity resourceType and this sync verb, with an empty filter fingerprint', async () => {
    const { store } = fakeStore();
    const gateway = fakeGateway(async (uei) => entity(uei));
    const readClientBatch = jest.fn(async () => clients('A'));
    const updateClientStatus = jest.fn(async () => {});

    await runEntitySync({ gateway, store, readClientBatch, updateClientStatus }, { commit: true, limit: 500 });
    expect(store.readCheckpoint).toHaveBeenCalledWith('sync-tango-entities', 'entity', computeFilterFingerprint({}));
    expect((store.writeCheckpoint as jest.Mock).mock.calls[0]![0]).toMatchObject({
      syncVerb: 'sync-tango-entities',
      resourceType: 'entity',
      filterFingerprint: computeFilterFingerprint({}),
    });
  });
});

describe('runEntitySync — dry run still calls Tango, but writes nothing locally', () => {
  test('getEntity is called and counted even when commit is false', async () => {
    const { store, snapshots, checkpoints } = fakeStore();
    const gateway = fakeGateway(async (uei) => entity(uei));
    const readClientBatch = jest.fn(async () => clients('A', 'B'));
    const updateClientStatus = jest.fn(async () => {});

    const summary = await runEntitySync(
      { gateway, store, readClientBatch, updateClientStatus },
      { commit: false, limit: 500 },
    );

    expect(gateway.getEntity).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ processed: 2, synced: 2 });
    expect(snapshots).toHaveLength(0);
    expect(checkpoints).toHaveLength(0);
    expect(updateClientStatus).not.toHaveBeenCalled();
  });
});

describe('runEntitySync — the acceptance bar: only what readClientBatch supplies is ever fetched', () => {
  test('every row returned by readClientBatch is fetched by its uei, verbatim', async () => {
    const { store } = fakeStore();
    const gateway = fakeGateway(async (uei) => entity(uei));
    const readClientBatch = jest.fn(async () => clients('REALUEI001', 'REALUEI002'));
    const updateClientStatus = jest.fn(async () => {});

    await runEntitySync({ gateway, store, readClientBatch, updateClientStatus }, { commit: true, limit: 500 });
    expect(gateway.getEntity).toHaveBeenNthCalledWith(1, 'REALUEI001');
    expect(gateway.getEntity).toHaveBeenNthCalledWith(2, 'REALUEI002');
  });
});

describe('runEntitySync — writes on a real find', () => {
  test('writeSnapshot is called with the entity and its provenance-stated update time', async () => {
    const { store, snapshots } = fakeStore();
    const found = entity('U1', { provenance: { provider: 'tango', resourceType: 'entity', externalId: 'U1', fetchedAt: 'x', providerUpdatedAt: '2026-07-01T00:00:00.000Z' } });
    const gateway = fakeGateway(async () => found);
    const readClientBatch = jest.fn(async () => clients('U1'));
    const updateClientStatus = jest.fn(async () => {});

    await runEntitySync({ gateway, store, readClientBatch, updateClientStatus }, { commit: true, limit: 500 });

    expect(snapshots[0]).toMatchObject({
      resourceType: 'entity',
      externalId: 'U1',
      sourceUpdatedAt: '2026-07-01T00:00:00.000Z',
      normalized: found,
    });
  });

  test('the client status is patched with a fresh lastSyncedAt/lastAttemptAt and a cleared error', async () => {
    const { store } = fakeStore();
    const gateway = fakeGateway(async (uei) => entity(uei));
    const readClientBatch = jest.fn(async () => clients('U1'));
    const updateClientStatus = jest.fn(async () => {});
    const now = () => new Date('2026-08-07T12:00:00.000Z');

    await runEntitySync({ gateway, store, readClientBatch, updateClientStatus, now }, { commit: true, limit: 500 });

    expect(updateClientStatus).toHaveBeenCalledWith('client-1', {
      lastSyncedAt: now(),
      lastAttemptAt: now(),
      lastError: null,
    });
  });
});

describe('runEntitySync — a definitive not_found is a SUCCESSFUL sync, not a failure', () => {
  test('null from getEntity counts as notFound, still stamps lastSyncedAt, writes no snapshot', async () => {
    const { store, snapshots } = fakeStore();
    const gateway = fakeGateway(async () => null);
    const readClientBatch = jest.fn(async () => clients('U1'));
    const updateClientStatus = jest.fn(async () => {});

    const summary = await runEntitySync({ gateway, store, readClientBatch, updateClientStatus }, { commit: true, limit: 500 });

    expect(summary).toMatchObject({ synced: 0, notFound: 1, errored: 0 });
    expect(snapshots).toHaveLength(0);
    expect(updateClientStatus).toHaveBeenCalledWith('client-1', expect.objectContaining({ lastError: null }));
    expect((updateClientStatus as jest.Mock).mock.calls[0]![1]).toHaveProperty('lastSyncedAt');
  });
});

describe('runEntitySync — a real failure is recorded but does not stop the run', () => {
  test('an error on one client does not prevent later clients from being processed', async () => {
    const { store } = fakeStore();
    const gateway = fakeGateway(async (uei) => {
      if (uei === 'BAD') throw new Error('transient failure');
      return entity(uei);
    });
    const readClientBatch = jest.fn(async () => clients('BAD', 'GOOD'));
    const updateClientStatus = jest.fn(async () => {});

    const summary = await runEntitySync({ gateway, store, readClientBatch, updateClientStatus }, { commit: true, limit: 500 });
    expect(summary).toMatchObject({ processed: 2, synced: 1, notFound: 0, errored: 1 });
  });

  test('a failed attempt patches lastAttemptAt and a redacted lastError, WITHOUT lastSyncedAt', async () => {
    const { store } = fakeStore();
    const gateway = fakeGateway(async () => {
      throw new Error('upstream error: X-API-KEY=abc123def456 was rejected');
    });
    const readClientBatch = jest.fn(async () => clients('U1'));
    const updateClientStatus = jest.fn(async () => {});
    const now = () => new Date('2026-08-07T12:00:00.000Z');

    await runEntitySync({ gateway, store, readClientBatch, updateClientStatus, now }, { commit: true, limit: 500 });

    const patch = (updateClientStatus as jest.Mock).mock.calls[0]![1] as any;
    expect(patch).not.toHaveProperty('lastSyncedAt');
    expect(patch.lastAttemptAt).toEqual(now());
    expect(patch.lastError).toEqual(expect.any(String));
    expect(patch.lastError).not.toContain('abc123def456');
  });

  test('no snapshot is written for a failed attempt', async () => {
    const { store, snapshots } = fakeStore();
    const gateway = fakeGateway(async () => {
      throw new Error('boom');
    });
    const readClientBatch = jest.fn(async () => clients('U1'));
    const updateClientStatus = jest.fn(async () => {});

    await runEntitySync({ gateway, store, readClientBatch, updateClientStatus }, { commit: true, limit: 500 });
    expect(snapshots).toHaveLength(0);
  });

  test('a non-Error throw is still recorded, not left to crash the run', async () => {
    const { store } = fakeStore();
    const gateway = fakeGateway(async () => {
      throw 'a string, not an Error';
    });
    const readClientBatch = jest.fn(async () => clients('U1'));
    const updateClientStatus = jest.fn(async () => {});

    const summary = await runEntitySync({ gateway, store, readClientBatch, updateClientStatus }, { commit: true, limit: 500 });
    expect(summary.errored).toBe(1);
  });
});
