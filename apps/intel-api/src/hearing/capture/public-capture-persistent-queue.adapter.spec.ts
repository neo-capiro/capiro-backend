import { PublicCapturePersistentQueueAdapter } from './public-capture-persistent-queue.adapter.js';

type MockPrisma = {
  $queryRawUnsafe: jest.Mock;
  $executeRawUnsafe: jest.Mock;
};

function makeQueue() {
  const prisma: MockPrisma = {
    $queryRawUnsafe: jest.fn(),
    $executeRawUnsafe: jest.fn(),
  };
  return {
    prisma,
    queue: new PublicCapturePersistentQueueAdapter(prisma as never),
  };
}

describe('PublicCapturePersistentQueueAdapter', () => {
  it('enqueues a stable-id capture job with worker-side re-resolution and deduplication', async () => {
    const { prisma, queue } = makeQueue();
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'job-1' }]);

    await expect(
      queue.enqueue({
        dedupeKey: 'public-hearing-capture:v1:hearing-1',
        hearingId: 'hearing-1',
        captureId: 'capture-1',
        mustReresolve: true,
      }),
    ).resolves.toEqual({ enqueued: true, jobId: 'job-1' });

    const [sql, dedupeKey, hearingId, captureId, payload] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (dedupe_key) DO UPDATE');
    expect(sql).toContain("public_hearing_capture_job.status='pending'");
    expect(sql).toContain('public_hearing_capture_job.lease_owner IS NULL');
    expect(sql).toContain("VALUES ('capture'");
    expect(dedupeKey).toBe('public-hearing-capture:v1:hearing-1');
    expect(hearingId).toBe('hearing-1');
    expect(captureId).toBe('capture-1');
    expect(JSON.parse(payload)).toEqual({ mustReresolve: true });
    expect(sql.toLowerCase()).not.toContain('tenant_id');
    expect(sql.toLowerCase()).not.toContain('client_id');
    expect(sql.toLowerCase()).not.toContain('media_url');
  });

  it('refuses capture jobs that do not require worker-side re-resolution', async () => {
    const { queue } = makeQueue();
    await expect(
      queue.enqueue({
        dedupeKey: 'bad',
        hearingId: 'hearing-1',
        captureId: 'capture-1',
        mustReresolve: false,
      } as never),
    ).rejects.toThrow('public capture jobs must require worker-side re-resolution');
  });

  it('claims due jobs with SKIP LOCKED and increments the durable attempt counter', async () => {
    const { prisma, queue } = makeQueue();
    const now = new Date('2026-08-21T20:00:00.000Z');
    const dueAt = new Date('2026-08-21T19:59:00.000Z');
    const leaseExpiresAt = new Date('2026-08-21T20:05:00.000Z');
    prisma.$queryRawUnsafe.mockResolvedValue([
      {
        id: '00000000-0000-0000-0000-000000000001',
        jobType: 'capture',
        dedupeKey: 'capture-job',
        hearingId: 'hearing-1',
        captureId: 'capture-1',
        status: 'leased',
        dueAt,
        attempts: 2,
        maxAttempts: 10,
        leaseOwner: 'worker-a',
        leaseExpiresAt,
        lastError: null,
        createdAt: dueAt,
        updatedAt: now,
        completedAt: null,
      },
    ]);

    const jobs = await queue.claimDue({
      jobType: 'capture',
      workerId: 'worker-a',
      now,
      limit: 5,
      leaseDurationMs: 5 * 60_000,
    });

    expect(jobs).toEqual([
      expect.objectContaining({
        hearingId: 'hearing-1',
        captureId: 'capture-1',
        status: 'leased',
        attempts: 2,
        leaseOwner: 'worker-a',
      }),
    ]);
    const sql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('attempts = job.attempts + 1');
    expect(sql).toContain("status = 'leased'");
  });

  it('requeues a failed leased job only while attempts remain', async () => {
    const { prisma, queue } = makeQueue();
    const now = new Date('2026-08-21T20:00:00.000Z');
    const retryAt = new Date('2026-08-21T20:01:00.000Z');

    prisma.$queryRawUnsafe.mockResolvedValueOnce([{ status: 'pending' }]);
    await expect(
      queue.fail({
        jobId: '00000000-0000-0000-0000-000000000001',
        workerId: 'worker-a',
        now,
        error: new Error('temporary source failure'),
        retryAt,
      }),
    ).resolves.toBe('REQUEUED');

    prisma.$queryRawUnsafe.mockResolvedValueOnce([{ status: 'failed' }]);
    await expect(
      queue.fail({
        jobId: '00000000-0000-0000-0000-000000000001',
        workerId: 'worker-a',
        now,
        error: new Error('retry ceiling reached'),
        retryAt,
      }),
    ).resolves.toBe('FAILED');

    const sql = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain('attempts < max_attempts');
    expect(sql).toContain("ELSE 'failed'");
  });

  it('fails closed when a worker attempts to complete a job after losing its queue lease', async () => {
    const { prisma, queue } = makeQueue();
    prisma.$executeRawUnsafe.mockResolvedValue(0);

    await expect(
      queue.complete({
        jobId: '00000000-0000-0000-0000-000000000001',
        workerId: 'stale-worker',
        now: new Date('2026-08-21T20:00:00.000Z'),
      }),
    ).rejects.toThrow('capture queue completion lost lease');
  });

  it('schedules preflight idempotently and never mutates an actively leased duplicate', async () => {
    const { prisma, queue } = makeQueue();
    prisma.$executeRawUnsafe.mockResolvedValue(1);
    const dueAt = new Date('2026-08-21T20:15:00.000Z');

    await queue.schedulePreflight({
      dedupeKey: 'hearing-stream-preflight:v1:hearing-1',
      hearingId: 'hearing-1',
      dueAt,
    });

    const sql = prisma.$executeRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain('ON CONFLICT (dedupe_key) DO UPDATE');
    expect(sql).toContain("WHERE public_hearing_capture_job.status <> 'leased'");
    expect(sql).toContain(
      "WHEN public_hearing_capture_job.status IN ('completed','failed') THEN 0",
    );
  });
});
