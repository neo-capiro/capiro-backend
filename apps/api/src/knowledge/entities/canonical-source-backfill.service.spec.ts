import { describe, expect, jest, test } from '@jest/globals';
import { CanonicalSourceAdapterService } from './canonical-source-adapter.service.js';
import { CanonicalSourceBackfillRepository } from './canonical-source-backfill.repository.js';
import { CanonicalSourceBackfillService } from './canonical-source-backfill.service.js';
import type { CanonicalSourceSyncResult } from './canonical-source-adapter.types.js';
import type {
  CanonicalEntityBackfillCheckpointRecord,
  CanonicalEntityBackfillCheckpointRepository,
  CanonicalEntityBackfillPageSummary,
} from './canonical-entity-backfill-checkpoint.repository.js';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function client(id: string) {
  return { id, tenantId: TENANT_ID, name: `Client ${id}` };
}

function harness(records = [client('11111111-1111-4111-8111-111111111111')]) {
  const listClients = jest.fn(async () => records);
  const repository = {
    listClients,
    listClientPeople: jest.fn(async () => []),
    listEngagementContacts: jest.fn(async () => []),
    listConfirmedClientMappings: jest.fn(async () => []),
  } as unknown as CanonicalSourceBackfillRepository;
  const syncClient = jest.fn(async (record: ReturnType<typeof client>): Promise<CanonicalSourceSyncResult> => ({
    sourceKind: 'client' as const,
    sourceId: record.id,
    status: 'would_create' as const,
    entityId: null,
    resolutionId: null,
    candidates: [],
    reason: null,
  }));
  const adapter = {
    syncClient,
  } as unknown as CanonicalSourceAdapterService;
  return {
    service: new CanonicalSourceBackfillService(repository, adapter),
    listClients,
    syncClient,
  };
}

/** In-memory stand-in for the real Prisma-backed checkpoint repository,
 * mirroring its idempotent-start and cumulative-counter semantics exactly so
 * runToCompletion tests exercise genuine resume behavior, not a mock stub. */
function fakeCheckpointRepository(): CanonicalEntityBackfillCheckpointRepository {
  const store = new Map<string, CanonicalEntityBackfillCheckpointRecord>();
  const key = (tenantId: string | null, source: string) => `${tenantId ?? 'GLOBAL'}::${source}`;
  let counter = 0;
  return {
    async find(tenantId: string | null, source: string) {
      return store.get(key(tenantId, source)) ?? null;
    },
    async startOrResume(tenantId: string | null, source: string) {
      const k = key(tenantId, source);
      const existing = store.get(k);
      if (existing) return existing;
      counter += 1;
      const record: CanonicalEntityBackfillCheckpointRecord = {
        id: `checkpoint-${counter}`,
        tenantId,
        source,
        cursor: null,
        status: 'running',
        scanned: 0,
        created: 0,
        linked: 0,
        ambiguous: 0,
        skipped: 0,
        failed: 0,
        lastError: null,
        startedAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      };
      store.set(k, record);
      return record;
    },
    async recordPage(
      tenantId: string | null,
      source: string,
      page: CanonicalEntityBackfillPageSummary,
    ) {
      const k = key(tenantId, source);
      const existing = store.get(k);
      if (!existing) throw new Error('checkpoint missing');
      const status = page.errorMessage ? 'failed' : page.complete ? 'completed' : 'running';
      const updated: CanonicalEntityBackfillCheckpointRecord = {
        ...existing,
        cursor: page.nextCursor,
        status,
        scanned: existing.scanned + page.scanned,
        created: existing.created + page.created,
        linked: existing.linked + page.linked,
        ambiguous: existing.ambiguous + page.ambiguous,
        skipped: existing.skipped + page.skipped,
        failed: existing.failed + page.failed,
        lastError: page.errorMessage,
        updatedAt: new Date(),
        completedAt: status === 'completed' ? new Date() : null,
      };
      store.set(k, updated);
      return updated;
    },
  } as unknown as CanonicalEntityBackfillCheckpointRepository;
}

/** Paginates an in-memory record array the way the real repository's
 * keyset queries do: strictly-after afterId, ordered, bounded by limit. */
function paginatedListClients(records: ReturnType<typeof client>[]) {
  return jest.fn(async (_tenantId: string, afterId: string | null, limit: number) => {
    const startIndex = afterId ? records.findIndex((record) => record.id === afterId) + 1 : 0;
    return records.slice(startIndex, startIndex + limit);
  });
}

function harnessWithCheckpoints(records: ReturnType<typeof client>[]) {
  const listClients = paginatedListClients(records);
  const repository = {
    listClients,
    listClientPeople: jest.fn(async () => []),
    listEngagementContacts: jest.fn(async () => []),
    listConfirmedClientMappings: jest.fn(async () => []),
  } as unknown as CanonicalSourceBackfillRepository;
  const syncClient = jest.fn(async (record: ReturnType<typeof client>): Promise<CanonicalSourceSyncResult> => ({
    sourceKind: 'client' as const,
    sourceId: record.id,
    status: 'created' as const,
    entityId: `entity-${record.id}`,
    resolutionId: null,
    candidates: [],
    reason: null,
  }));
  const adapter = { syncClient } as unknown as CanonicalSourceAdapterService;
  const checkpoints = fakeCheckpointRepository();
  return {
    newService: () => new CanonicalSourceBackfillService(repository, adapter, checkpoints),
    listClients,
    syncClient,
    checkpoints,
  };
}

describe('CanonicalSourceBackfillService', () => {
  test('runs a bounded dry-run page and returns an opaque keyset cursor', async () => {
    const records = [
      client('11111111-1111-4111-8111-111111111111'),
      client('22222222-2222-4222-8222-222222222222'),
    ];
    const { service, listClients, syncClient } = harness(records);

    const result = await service.runPage(TENANT_ID, {
      source: 'client',
      limit: 2,
      dryRun: true,
    });

    expect(result.scanned).toBe(2);
    expect(result.counts.would_create).toBe(2);
    expect(result.nextCursor).toBe(records[1]!.id);
    expect(result.complete).toBe(false);
    expect(listClients).toHaveBeenCalledWith(TENANT_ID, null, 2);
    expect(syncClient).toHaveBeenCalledWith(
      records[0],
      expect.objectContaining({ dryRun: true }),
    );
  });

  test('halts on the first write failure so the failed row remains retryable', async () => {
    const records = [
      client('11111111-1111-4111-8111-111111111111'),
      client('22222222-2222-4222-8222-222222222222'),
      client('33333333-3333-4333-8333-333333333333'),
    ];
    const { service, syncClient } = harness(records);
    syncClient
      .mockResolvedValueOnce({
        sourceKind: 'client',
        sourceId: records[0]!.id,
        status: 'created',
        entityId: '44444444-4444-4444-8444-444444444444',
        resolutionId: null,
        candidates: [],
        reason: null,
      })
      .mockRejectedValueOnce(new Error('conflict'));

    const result = await service.runPage(TENANT_ID, {
      source: 'client',
      limit: 3,
    });

    expect(result.scanned).toBe(2);
    expect(result.counts.created).toBe(1);
    expect(result.counts.failed).toBe(1);
    expect(result.failures).toEqual([
      expect.objectContaining({ sourceId: records[1]!.id }),
    ]);
    expect(result.nextCursor).toBe(records[0]!.id);
    expect(result.complete).toBe(false);
    expect(syncClient).toHaveBeenCalledTimes(2);
  });

  test('marks a short final page complete', async () => {
    const { service } = harness([
      client('11111111-1111-4111-8111-111111111111'),
    ]);

    const result = await service.runPage(TENANT_ID, {
      source: 'client',
      limit: 25,
      dryRun: true,
    });

    expect(result.complete).toBe(true);
    expect(result.nextCursor).toBeNull();
  });
});

describe('CanonicalSourceBackfillService.runToCompletion', () => {
  function fiveClients() {
    return Array.from({ length: 5 }, (_, index) =>
      client(`1111111${index}-1111-4111-8111-11111111111${index}`),
    );
  }

  test('throws when no checkpoint repository was provided', async () => {
    const { service } = harness();
    await expect(
      service.runToCompletion(TENANT_ID, { source: 'client', limit: 2 }),
    ).rejects.toThrow(/CanonicalEntityBackfillCheckpointRepository/);
  });

  test('loops every page to completion and marks the checkpoint completed', async () => {
    const records = fiveClients();
    const { newService, syncClient } = harnessWithCheckpoints(records);

    const { pages, checkpoint } = await newService().runToCompletion(TENANT_ID, {
      source: 'client',
      limit: 2,
    });

    expect(pages).toHaveLength(3); // 2 + 2 + 1
    expect(checkpoint.status).toBe('completed');
    expect(checkpoint.scanned).toBe(5);
    expect(checkpoint.created).toBe(5);
    expect(checkpoint.completedAt).not.toBeNull();
    expect(syncClient).toHaveBeenCalledTimes(5);
  });

  test('resumes from the persisted cursor after a simulated crash instead of restarting', async () => {
    const records = fiveClients();
    const { newService, syncClient, checkpoints } = harnessWithCheckpoints(records);

    // "Process 1: crashes" after exactly one bounded page.
    const crashed = await newService().runToCompletion(TENANT_ID, {
      source: 'client',
      limit: 2,
      maxPages: 1,
    });
    expect(crashed.pages).toHaveLength(1);
    expect(crashed.checkpoint.status).toBe('running');
    expect(crashed.checkpoint.scanned).toBe(2);
    expect(syncClient).toHaveBeenCalledTimes(2);

    // "Process 2: a fresh service instance restarted after the crash," sharing
    // only the persisted checkpoint store — never told the prior cursor.
    const resumed = await newService().runToCompletion(TENANT_ID, {
      source: 'client',
      limit: 2,
    });

    expect(resumed.checkpoint.status).toBe('completed');
    expect(resumed.checkpoint.scanned).toBe(5); // cumulative across both processes
    // Every record synced exactly once in total — resume, not replay-from-scratch.
    expect(syncClient).toHaveBeenCalledTimes(5);
    const syncedIds = syncClient.mock.calls.map((call) => (call[0] as { id: string }).id);
    expect(new Set(syncedIds).size).toBe(5);
    expect(checkpoints.find(TENANT_ID, 'client')).resolves.toEqual(resumed.checkpoint);
  });

  test('is a no-op once the checkpoint is already completed', async () => {
    const records = [client('11111111-1111-4111-8111-111111111111')];
    const { newService, syncClient } = harnessWithCheckpoints(records);

    const first = await newService().runToCompletion(TENANT_ID, { source: 'client', limit: 10 });
    expect(first.checkpoint.status).toBe('completed');
    expect(syncClient).toHaveBeenCalledTimes(1);

    const second = await newService().runToCompletion(TENANT_ID, { source: 'client', limit: 10 });
    expect(second.pages).toEqual([]);
    expect(second.checkpoint).toEqual(first.checkpoint);
    expect(syncClient).toHaveBeenCalledTimes(1); // not re-run
  });

  test('marks the checkpoint failed and preserves the resumable cursor on a row failure', async () => {
    const records = fiveClients();
    const { newService, syncClient, checkpoints } = harnessWithCheckpoints(records);
    syncClient.mockImplementation(async (record: { id: string }) => {
      if (record.id === records[2]!.id) throw new Error('conflict');
      return {
        sourceKind: 'client' as const,
        sourceId: record.id,
        status: 'created' as const,
        entityId: `entity-${record.id}`,
        resolutionId: null,
        candidates: [],
        reason: null,
      };
    });

    const { checkpoint } = await newService().runToCompletion(TENANT_ID, {
      source: 'client',
      limit: 10,
    });

    expect(checkpoint.status).toBe('failed');
    // errorCode() reports Error.name (not the raw message) by existing convention.
    expect(checkpoint.lastError).toBe(`client:${records[2]!.id}:Error`);
    expect(checkpoint.cursor).toBe(records[1]!.id);
    await expect(checkpoints.find(TENANT_ID, 'client')).resolves.toEqual(checkpoint);
  });
});
