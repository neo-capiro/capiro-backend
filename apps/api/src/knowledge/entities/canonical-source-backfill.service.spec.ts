import { describe, expect, jest, test } from '@jest/globals';
import { CanonicalSourceAdapterService } from './canonical-source-adapter.service.js';
import { CanonicalSourceBackfillRepository } from './canonical-source-backfill.repository.js';
import { CanonicalSourceBackfillService } from './canonical-source-backfill.service.js';

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
  const syncClient = jest.fn(async (record: ReturnType<typeof client>) => ({
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
