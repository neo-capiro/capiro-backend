import {
  HearingIntelligenceJobStore,
  type PublicHearingIntelligenceJob,
} from './hearing-intelligence-job.store.js';

function fixture() {
  const query = jest.fn();
  const tx = { $queryRawUnsafe: query };
  const prisma = {
    withSystem: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { query, tx, prisma, store: new HearingIntelligenceJobStore(prisma as never) };
}

describe('HearingIntelligenceJobStore', () => {
  it('claims public work with SKIP LOCKED and a bounded lease', async () => {
    const { query, store } = fixture();
    query.mockResolvedValue([
      {
        id: 'job-1',
        segmentId: 'segment-1',
        captureId: 'capture-1',
        hearingId: 'hearing-1',
        segmentRevision: 1,
        attempts: 1,
      },
    ]);

    await expect(store.claimPublic('worker-a', 12)).resolves.toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, maxAttempts, limit, workerId, leaseSeconds] = query.mock.calls[0] as [
      string,
      number,
      number,
      string,
      number,
    ];
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("status='leased'");
    expect(sql).toContain('lease_expires_at');
    expect(maxAttempts).toBe(8);
    expect(limit).toBe(12);
    expect(workerId).toBe('worker-a');
    expect(leaseSeconds).toBe(180);
  });

  it('uses the claimed transcript revision as a completion fence', async () => {
    const { query, store } = fixture();
    query.mockResolvedValue([{ status: 'pending', segmentRevision: 2 }]);
    const job: PublicHearingIntelligenceJob = {
      id: '00000000-0000-0000-0000-000000000001',
      segmentId: 'segment-1',
      captureId: 'capture-1',
      hearingId: 'hearing-1',
      segmentRevision: 1,
      attempts: 1,
    };

    await expect(store.completePublic(job, 'worker-a')).resolves.toBe('requeued');
    const [sql, id, workerId, revision] = query.mock.calls[0] as [
      string,
      string,
      string,
      number,
    ];
    expect(sql).toContain("CASE WHEN segment_revision=$3 THEN 'completed' ELSE 'pending' END");
    expect(sql).toContain("status='leased'");
    expect(sql).toContain('lease_owner=$2');
    expect(id).toBe(job.id);
    expect(workerId).toBe('worker-a');
    expect(revision).toBe(1);
  });

  it('creates the same tenant batch identity regardless of insight ordering or duplicates', async () => {
    const first = fixture();
    first.query.mockResolvedValue([{ id: 'job-a' }]);
    await first.store.enqueueTenantJobs({
      tenantIds: ['00000000-0000-0000-0000-000000000001'],
      hearingId: 'hearing-1',
      publicInsightIds: ['phi-b', 'phi-a', 'phi-b'],
    });
    const firstArgs = first.query.mock.calls[0] as [string, string, string, string[], string];

    const second = fixture();
    second.query.mockResolvedValue([{ id: 'job-b' }]);
    await second.store.enqueueTenantJobs({
      tenantIds: ['00000000-0000-0000-0000-000000000001'],
      hearingId: 'hearing-1',
      publicInsightIds: ['phi-a', 'phi-b'],
    });
    const secondArgs = second.query.mock.calls[0] as [string, string, string, string[], string];

    expect(firstArgs[3]).toEqual(['phi-a', 'phi-b']);
    expect(firstArgs[4]).toBe(secondArgs[4]);
    expect(firstArgs[4]).toMatch(/^hearing-relevance:v1:[a-f0-9]{64}$/);
  });

  it('cannot finalize or fail work after the lease owner changes', async () => {
    const { query, store } = fixture();
    query.mockResolvedValue([]);
    const job: PublicHearingIntelligenceJob = {
      id: '00000000-0000-0000-0000-000000000001',
      segmentId: 'segment-1',
      captureId: 'capture-1',
      hearingId: 'hearing-1',
      segmentRevision: 1,
      attempts: 1,
    };

    await expect(store.completePublic(job, 'stale-worker')).resolves.toBe('stale_lease');
    await expect(store.failPublic(job, 'stale-worker', new Error('boom'))).resolves.toBe(false);
    expect(query.mock.calls.every(([sql]) => String(sql).includes('lease_owner=$2'))).toBe(true);
  });
});
