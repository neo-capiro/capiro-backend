import { describe, expect, jest, test } from '@jest/globals';
import { parseArgs, run, type UeiClientRef } from './generate-tango-enrichment-candidates.js';

describe('CLI parsing', () => {
  test('defaults to a 2000-client limit', () => {
    expect(parseArgs([])).toEqual({ limit: 2000 });
  });

  test('--limit is clamped at 20000, and a bad value falls back to the default', () => {
    expect(parseArgs(['--limit=50'])).toEqual({ limit: 50 });
    expect(parseArgs(['--limit=999999']).limit).toBe(20_000);
    expect(parseArgs(['--limit=0']).limit).toBe(2000);
    expect(parseArgs(['--limit=nonsense']).limit).toBe(2000);
  });
});

function refs(...pairs: Array<[string, string]>): UeiClientRef[] {
  return pairs.map(([id, tenantId]) => ({ id, tenantId }));
}

describe('run — pagination over UEI-having clients across tenants', () => {
  test('a single small batch scans everything in one read', async () => {
    const readUeiClientBatch = jest.fn(async () => refs(['c1', 't1'], ['c2', 't2']));
    const proposeCandidatesForClient = jest.fn(async () => ({ proposed: 1, alreadyExisted: 0, skipped: false }));

    const summary = await run({ readUeiClientBatch, proposeCandidatesForClient }, 2000);
    expect(summary.clientsScanned).toBe(2);
    expect(summary.proposed).toBe(2);
    expect(readUeiClientBatch).toHaveBeenCalledTimes(1);
  });

  test('every client is processed with its OWN tenantId, not a shared/global one', async () => {
    const readUeiClientBatch = jest.fn(async () => refs(['c1', 'tenant-a'], ['c2', 'tenant-b']));
    const proposeCandidatesForClient = jest.fn(async () => ({ proposed: 0, alreadyExisted: 0, skipped: false }));

    await run({ readUeiClientBatch, proposeCandidatesForClient }, 2000);
    expect(proposeCandidatesForClient).toHaveBeenNthCalledWith(1, 'tenant-a', 'c1');
    expect(proposeCandidatesForClient).toHaveBeenNthCalledWith(2, 'tenant-b', 'c2');
  });

  test('stops at the configured limit, even mid-batch', async () => {
    const readUeiClientBatch = jest.fn(async () => refs(['c1', 't1'], ['c2', 't1'], ['c3', 't1']));
    const proposeCandidatesForClient = jest.fn(async () => ({ proposed: 0, alreadyExisted: 0, skipped: false }));

    const summary = await run({ readUeiClientBatch, proposeCandidatesForClient }, 2);
    expect(summary.clientsScanned).toBe(2);
    expect(proposeCandidatesForClient).toHaveBeenCalledTimes(2);
  });

  test('aggregates proposed/alreadyExisted/skipped across every client', async () => {
    const readUeiClientBatch = jest.fn(async () => refs(['c1', 't1'], ['c2', 't1'], ['c3', 't1']));
    let call = 0;
    const results = [
      { proposed: 2, alreadyExisted: 0, skipped: false },
      { proposed: 0, alreadyExisted: 1, skipped: false },
      { proposed: 0, alreadyExisted: 0, skipped: true },
    ];
    const proposeCandidatesForClient = jest.fn(async () => results[call++]!);

    const summary = await run({ readUeiClientBatch, proposeCandidatesForClient }, 2000);
    expect(summary).toEqual({ clientsScanned: 3, proposed: 2, alreadyExisted: 1, skipped: 1 });
  });

  test('an empty client base returns a zeroed summary without error', async () => {
    const readUeiClientBatch = jest.fn(async () => []);
    const proposeCandidatesForClient = jest.fn(async () => ({ proposed: 0, alreadyExisted: 0, skipped: false }));

    const summary = await run({ readUeiClientBatch, proposeCandidatesForClient }, 2000);
    expect(summary).toEqual({ clientsScanned: 0, proposed: 0, alreadyExisted: 0, skipped: 0 });
    expect(proposeCandidatesForClient).not.toHaveBeenCalled();
  });
});
