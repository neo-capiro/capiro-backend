import JSZip from 'jszip';
import {
  refreshFederalBills,
  parseFederalRefreshCursor,
  type FederalRefreshCursor,
} from './federal-bill-refresh';
import { federalHash, FEDERAL_BILL_TYPES } from './federal-billstatus';
import {
  importFrozenFederalBillStatus,
  stageFederalAmendmentList,
} from './federal-billstatus-import';
import {
  loadFederalGeneration,
  enumerateFederalInventories,
  finalizeFederalDiscovery,
} from './federal-bill-inventory';
import { refreshHeldFederalMetadata } from './federal-bill-metadata';
import { hydrateFederalInventories } from './federal-bill-hydration';
import { parseFederalInventoryArgs } from '../../scripts/sync-federal-bill-inventory';
jest.mock('./federal-billstatus-import', () => ({
  ...jest.requireActual('./federal-billstatus-import'),
  importFrozenFederalBillStatus: jest.fn(),
  stageFederalAmendmentList: jest.fn(),
}));
jest.mock('./federal-bill-inventory', () => ({
  ...jest.requireActual('./federal-bill-inventory'),
  loadFederalGeneration: jest.fn(),
  enumerateFederalInventories: jest.fn(),
  finalizeFederalDiscovery: jest.fn(),
}));
jest.mock('./federal-bill-metadata', () => ({ refreshHeldFederalMetadata: jest.fn() }));
jest.mock('./federal-bill-hydration', () => ({
  ...jest.requireActual('./federal-bill-hydration'),
  hydrateFederalInventories: jest.fn(),
}));
jest.mock('./federal-inventory-reuse', () => ({
  federalInventoryReuse: async () => async () => false,
}));
const member = { congress: 119, type: 'samdt', number: '1', updateDate: '2026-01-01T00:00:00Z' };
const start = '2026-11-02T00:00:00.000Z';
function cursor(phase: FederalRefreshCursor['phase'] = 'amendments'): FederalRefreshCursor {
  return {
    schemaVersion: 1,
    phase,
    startedAt: start,
    archives: FEDERAL_BILL_TYPES.map((billType, i) => ({
      billType,
      hash: String(i).repeat(64),
      count: 1,
    })),
    pages: [],
    offset: 0,
    expected: null,
    verifyPage: 0,
    verifyOffset: 0,
    listHash: null,
    importIndex: 0,
    hydration: null,
    completedAt: null,
  };
}
function prepared(phase: FederalRefreshCursor['phase']) {
  return {
    ...cursor(phase),
    pages: ['a'.repeat(64)],
    offset: 1,
    expected: 1,
    verifyPage: 1,
    verifyOffset: 1,
    listHash: 'b'.repeat(64),
  };
}
function fixture(initial: FederalRefreshCursor | null = null) {
  let saved: any = initial ? structuredClone(initial) : null;
  const retained = new Map<string, string>();
  const db: any = {
    federalEvidenceCheckpoint: {
      findUnique: jest.fn(async () => (saved ? { cursor: saved } : null)),
      upsert: jest.fn(async (input: any) => {
        saved = structuredClone(input.update.cursor);
        return {};
      }),
    },
    $queryRawUnsafe: jest.fn(async (sql: string, ...args: any[]) =>
      sql === 'SELECT 1'
        ? [{ value: 1 }]
        : sql.includes('AS bytes')
          ? retained.has(args[0])
            ? [{ bytes: retained.get(args[0]) }]
            : []
          : retained.get(args[0]) === args[1]
            ? [{ content_hash: args[0] }]
            : [],
    ),
    $executeRawUnsafe: jest.fn(async (sql: string, ...args: any[]) => {
      if (sql.includes('INSERT INTO legal_dataset_archive')) retained.set(args[0], args[1]);
      return 1;
    }),
  };
  const responses: Response[] = [];
  const transport = jest.fn(async (url: string, consume: any, options: any) => {
    options.validateDestination(new URL(url));
    await options.beforeRequest(new URL(url));
    return consume(responses.shift()!, url, {
      check: () => {},
      wait: (x: any) => x,
      signal: new AbortController().signal,
      registerCleanup: () => () => {},
    });
  });
  const run = (extra: any = {}) =>
    refreshFederalBills(db, {
      limit: 1,
      requestCap: 1,
      apiKey: 'synthetic-never-network',
      now: () => Date.parse(start),
      transport: transport as any,
      sleep: async () => {},
      ...extra,
    });
  return { db, retained, responses, transport, run, saved: () => saved };
}
const response = (members: any[], count = members.length, next?: string) =>
  new Response(
    JSON.stringify({ amendments: members, pagination: { count, ...(next ? { next } : {}) } }),
    { headers: { 'content-type': 'application/json' } },
  );
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(importFrozenFederalBillStatus)
    .mockResolvedValue({ complete: true, processed: 1 } as any);
  jest.mocked(loadFederalGeneration).mockResolvedValue({ inventoryHash: 'c'.repeat(64) } as any);
  jest.mocked(refreshHeldFederalMetadata).mockResolvedValue({ complete: true } as any);
  jest.mocked(enumerateFederalInventories).mockResolvedValue({ complete: true } as any);
  jest.mocked(finalizeFederalDiscovery).mockResolvedValue({ complete: true } as any);
  jest
    .mocked(hydrateFederalInventories)
    .mockResolvedValue({
      scanned: 1,
      listedVersions: 2,
      partial: 1,
      complete: false,
      pass: {
        taskHash: 'a'.repeat(64),
        listedVersions: 2,
        unavailableListedVersions: 0,
        scanned: 1,
        processed: 1,
        retained: 0,
        failed: 0,
        partial: 1,
        unreadable: 0,
        unavailable: 0,
      },
    } as any);
});
describe('resumable bounded refresh phases', () => {
  it('acquires one fixed archive, stages it without admitting parents, and resumes the next type', async () => {
    const h = fixture(),
      zip = new JSZip();
    zip.file('BILLSTATUS-119hr1.xml', 'synthetic inspected by canonical owner');
    h.responses.push(
      new Response(await zip.generateAsync({ type: 'uint8array' }), {
        headers: { 'content-type': 'application/zip' },
      }),
    );
    expect(await h.run()).toMatchObject({
      phase: 'archives',
      archives: 1,
      complete: false,
      providerCalls: 1,
    });
    expect(importFrozenFederalBillStatus).toHaveBeenCalledWith(
      h.db,
      expect.any(Buffer),
      expect.objectContaining({ billType: 'hr', expectedBills: 1 }),
      expect.objectContaining({ inventoryOnly: true, refresh: true, limit: 1 }),
    );
    expect(h.saved().archives).toHaveLength(1);
    expect(stageFederalAmendmentList).not.toHaveBeenCalled();
    expect(finalizeFederalDiscovery).not.toHaveBeenCalled();
  });
  it('counts failed retry attempts and leaves the page resumable when the request cap is hit', async () => {
    const h = fixture(cursor());
    h.responses.push(new Response('', { status: 503 }));
    expect(await h.run()).toMatchObject({ capped: true, providerCalls: 1, complete: false });
    expect(h.saved().offset).toBe(0);
    h.responses.push(response([member]));
    expect(await h.run()).toMatchObject({ nextPhase: 'verify-amendments', providerCalls: 1 });
    expect(h.saved().offset).toBe(1);
    expect(stageFederalAmendmentList).not.toHaveBeenCalled();
  });
  it('requires a second identical paginated pass before exact membership/parent proof and metadata writes', async () => {
    const h = fixture(cursor());
    h.responses.push(response([member]));
    await h.run();
    const archived = [...h.retained.keys()][0]!;
    expect(archived).toBe(
      federalHash(JSON.stringify({ offset: 0, count: 1, complete: true, members: [member] })),
    );
    h.responses.push(response([member]));
    expect(await h.run()).toMatchObject({ nextPhase: 'imports', complete: false });
    expect(stageFederalAmendmentList).toHaveBeenCalledWith(
      h.db,
      expect.any(Buffer),
      expect.any(String),
      119,
      1,
      [archived],
    );
    expect(jest.mocked(loadFederalGeneration).mock.calls[0]!.slice(2)).toEqual([
      expect.any(String),
      119,
      1,
      false,
    ]);
    expect(jest.mocked(loadFederalGeneration).mock.calls[0]![1]).toEqual(
      cursor().archives.map((a) => a.hash),
    );
    expect(importFrozenFederalBillStatus).not.toHaveBeenCalled();
    expect(finalizeFederalDiscovery).not.toHaveBeenCalled();
  });
  it('retains the old complete discovery and restarts acquisition when membership moves at equal count', async () => {
    const h = fixture(cursor());
    h.responses.push(response([member]));
    await h.run();
    h.responses.push(response([{ ...member, number: '2' }]));
    expect(await h.run()).toMatchObject({
      error: 'FEDERAL_REFRESH_AMENDMENT_SOURCE_MOVED',
      nextPhase: 'archives',
      complete: false,
    });
    expect(finalizeFederalDiscovery).not.toHaveBeenCalled();
    expect(h.saved().archives).toEqual([]);
  });
  it('stops before acquisition at the hard deadline without advancing the saved cursor', async () => {
    const h = fixture(cursor());
    let n = 0;
    expect(await h.run({ now: () => Date.parse(start) + n++, deadlineMs: 1 })).toMatchObject({
      capped: true,
      providerCalls: 0,
    });
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.saved().offset).toBe(0);
  });
  it('reacquires a lagged archive graph after the provider catches up without publishing the failed capture', async () => {
    const h = fixture(cursor());
    h.responses.push(response([member]));
    await h.run();
    jest
      .mocked(loadFederalGeneration)
      .mockRejectedValueOnce(Error('FEDERAL_AMENDMENT_PARENT_UNRESOLVED'));
    h.responses.push(response([member]));
    expect(await h.run()).toMatchObject({
      nextPhase: 'archives',
      error: 'FEDERAL_AMENDMENT_PARENT_UNRESOLVED',
    });
    const zip = new JSZip();
    zip.file('BILLSTATUS-119hr1.xml', 'fresh official capture passed to strict owner');
    h.responses.push(
      new Response(await zip.generateAsync({ type: 'uint8array' }), {
        headers: { 'content-type': 'application/zip' },
      }),
    );
    expect(await h.run()).toMatchObject({
      archives: 1,
      complete: false,
      apiCalls: 0,
      publisherCalls: 1,
    });
    expect(finalizeFederalDiscovery).not.toHaveBeenCalled();
  });
  it('recaptures a seven-day partial cycle instead of remaining pinned to stale files forever', async () => {
    const old = prepared('metadata');
    old.startedAt = '2026-10-24T00:00:00.000Z';
    const h = fixture(old),
      zip = new JSZip();
    zip.file('BILLSTATUS-119hr1.xml', 'fresh owned archive');
    h.responses.push(
      new Response(await zip.generateAsync({ type: 'uint8array' }), {
        headers: { 'content-type': 'application/zip' },
      }),
    );
    expect(await h.run()).toMatchObject({
      phase: 'archives',
      staleCycleRestarted: true,
      complete: false,
    });
    expect(h.saved().startedAt).toBe(start);
    expect(h.saved().archives).toHaveLength(1);
    expect(refreshHeldFederalMetadata).not.toHaveBeenCalled();
    expect(finalizeFederalDiscovery).not.toHaveBeenCalled();
  });
  it('keeps failed inventory and metadata phases pending and never promotes their denominator', async () => {
    const h = fixture(prepared('inventory'));
    jest
      .mocked(enumerateFederalInventories)
      .mockResolvedValueOnce({ complete: false, failed: 1 } as any);
    expect(await h.run()).toMatchObject({ nextPhase: 'inventory', failed: 1, complete: false });
    expect(finalizeFederalDiscovery).not.toHaveBeenCalled();
    const m = fixture(prepared('metadata'));
    jest
      .mocked(refreshHeldFederalMetadata)
      .mockRejectedValueOnce(Error('FEDERAL_METADATA_TRUNCATED'));
    expect(await m.run()).toMatchObject({
      error: 'FEDERAL_METADATA_TRUNCATED',
      nextPhase: 'metadata',
    });
    expect(finalizeFederalDiscovery).not.toHaveBeenCalled();
  });
  it('bounds import slices with a distinct refresh binding and retains the same phase on a partial slice', async () => {
    const c = prepared('imports'),
      h = fixture(c),
      bytes = Buffer.from('retained synthetic ZIP');
    c.archives[0]!.hash = federalHash(bytes);
    const fresh = fixture(c);
    fresh.retained.set(c.archives[0]!.hash, bytes.toString('base64'));
    jest
      .mocked(importFrozenFederalBillStatus)
      .mockResolvedValueOnce({ complete: false, processed: 1 } as any);
    expect(await fresh.run()).toMatchObject({ nextPhase: 'imports', complete: false });
    expect(importFrozenFederalBillStatus).toHaveBeenCalledWith(
      fresh.db,
      bytes,
      expect.any(Object),
      expect.objectContaining({ limit: 1, refresh: true, refreshId: start }),
    );
    expect(fresh.saved().importIndex).toBe(0);
  });
  it('promotes only in finalization, then finishes a bounded hydration pass without claiming partial text is complete', async () => {
    const h = fixture(prepared('finalize'));
    expect(await h.run()).toMatchObject({ nextPhase: 'hydrate', complete: false });
    expect(finalizeFederalDiscovery).toHaveBeenCalledTimes(1);
    expect(await h.run()).toMatchObject({ nextPhase: 'hydrate', partial: 1, complete: false });
    jest
      .mocked(hydrateFederalInventories)
      .mockResolvedValueOnce({
        scanned: 1,
        listedVersions: 2,
        partial: 0,
        complete: false,
        pass: { ...h.saved().hydration, scanned: 2, processed: 2 },
      } as any);
    expect(await h.run()).toMatchObject({
      nextPhase: 'completed',
      partial: 0,
      complete: false,
      cycleComplete: true,
      hydrationComplete: false,
      hydration: { scanned: 2, partial: 1 },
    });
    expect(await h.run()).toMatchObject({
      phase: 'completed',
      complete: false,
      cycleComplete: true,
      hydrationComplete: false,
      due: false,
      providerCalls: 0,
    });
    expect(finalizeFederalDiscovery).toHaveBeenCalledTimes(1);
  });
  it('rejects corrupted checkpoints instead of skipping unqualified phases', () => {
    expect(() => parseFederalRefreshCursor(cursor('imports'))).toThrow('CHECKPOINT_INVALID');
    expect(() => parseFederalRefreshCursor({ ...cursor(), archives: [] })).toThrow(
      'CHECKPOINT_INVALID',
    );
  });
});
describe('refresh CLI safety', () => {
  const host = 'capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com',
    env = { DATABASE_URL: `postgresql://fixture:unused@${host}/capiro` };
  it('supports read-only preview without a key and requires clone/key/explicit commit for refresh', () => {
    const args = ['--congress', '119', '--stage', 'refresh'];
    expect(parseFederalInventoryArgs(args, env)).toMatchObject({ commit: false, stage: 'refresh' });
    expect(() =>
      parseFederalInventoryArgs([...args, '--commit', '--expected-host', host], env),
    ).toThrow('KEY_REQUIRED');
    expect(
      parseFederalInventoryArgs([...args, '--commit', '--expected-host', host], {
        ...env,
        CONGRESS_API_KEY: 'synthetic',
      }).commit,
    ).toBe(true);
    expect(() =>
      parseFederalInventoryArgs([...args, '--expected-amendments', '7119'], env),
    ).toThrow('SCOPE');
    expect(() =>
      parseFederalInventoryArgs([...args, '--archive-hashes', 'a'.repeat(64)], env),
    ).toThrow('SCOPE');
    expect(() => parseFederalInventoryArgs([...args, '--limit', '1001'], env)).toThrow('SCOPE');
  });
});
