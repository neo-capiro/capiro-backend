import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import { DraftJobWorkerService } from './draft-job-worker.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MeriService } from './meri.service.js';
import type { StrategyOrchestratorClient } from './strategy-orchestrator.client.js';
import type { DraftJobRuntime } from './draft-job.types.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';

/** A jest.fn() typed to resolve T — plain `jest.fn()` infers a `never`
 *  parameter under this repo's ts-jest config, which then rejects any
 *  .mockResolvedValue/.mockImplementation argument (see meri.service.spec.ts's
 *  `jest.fn<() => Promise<...>>()` for the same pattern). */
function asyncMock<Args extends unknown[], T>() {
  return jest.fn<(...args: Args) => Promise<T>>();
}

function config(values: Record<string, string | undefined> = {}): ConfigService {
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function makePrisma() {
  const updateMany = asyncMock<[unknown], { count: number }>();
  updateMany.mockResolvedValue({ count: 1 });
  const queryRawUnsafe = asyncMock<[string, ...unknown[]], unknown[]>();
  queryRawUnsafe.mockResolvedValue([]);
  const tx = { spDraftJob: { updateMany }, $queryRawUnsafe: queryRawUnsafe };
  const prisma = {
    withSystem: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  return { prisma, tx, updateMany, queryRawUnsafe };
}

interface ClaimedJobLike {
  id: string;
  tenantId: string;
  ownerUserId: string;
  input: { dto: unknown; bearer: string | null };
  streamPreview: string | null;
  deadlineAt: Date;
}

/** A worker whose private methods are reached via cast — processJob,
 *  claimNext, failExpired and reclaimStale are internal to the claim-sweep and
 *  have no reason to be public API; the tick()-level behavior is exactly the
 *  composition of these, already covered individually. */
type WorkerInternals = {
  processJob(job: ClaimedJobLike): Promise<void>;
  claimNext(): Promise<unknown>;
  failExpired(): Promise<void>;
  reclaimStale(): Promise<void>;
};

function makeWorker(opts?: { orchestratorConfigured?: boolean }) {
  const { prisma, tx, updateMany, queryRawUnsafe } = makePrisma();
  const draftMock = asyncMock<
    [string, string, string | undefined, unknown, DraftJobRuntime],
    Record<string, unknown>
  >();
  const meriService = { draft: draftMock } as unknown as MeriService;
  const orchestrator = {
    configured: opts?.orchestratorConfigured ?? true,
  } as unknown as StrategyOrchestratorClient;
  const worker = new DraftJobWorkerService(prisma, meriService, orchestrator, config());
  return {
    worker,
    internals: worker as unknown as WorkerInternals,
    prisma,
    tx,
    updateMany,
    queryRawUnsafe,
    draftMock,
    orchestrator,
  };
}

function claimedJob(overrides: Partial<ClaimedJobLike> = {}): ClaimedJobLike {
  return {
    id: 'job-1',
    tenantId: 'tenant-1',
    ownerUserId: 'user-1',
    input: { dto: { clientId: CLIENT, type: 'appropriations' }, bearer: 'token' },
    streamPreview: null,
    deadlineAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe('DraftJobWorkerService claim query', () => {
  it('claims via FOR UPDATE SKIP LOCKED, scoped to queued + not-yet-expired jobs, and maps the snake_case row', async () => {
    const { internals, queryRawUnsafe } = makeWorker();
    const deadline = new Date(Date.now() + 60_000);
    queryRawUnsafe.mockResolvedValueOnce([
      {
        id: 'job-9',
        tenant_id: 'tenant-9',
        owner_user_id: 'user-9',
        input: { dto: { clientId: CLIENT }, bearer: null },
        stream_preview: 'partial',
        deadline_at: deadline,
      },
    ]);

    const claimed = await internals.claimNext();

    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql] = queryRawUnsafe.mock.calls[0]!;
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/status = 'queued'/);
    expect(sql).toMatch(/deadline_at > NOW\(\)/);
    expect(sql).toMatch(/LIMIT 1/);
    expect(claimed).toEqual({
      id: 'job-9',
      tenantId: 'tenant-9',
      ownerUserId: 'user-9',
      input: { dto: { clientId: CLIENT }, bearer: null },
      streamPreview: 'partial',
      deadlineAt: deadline,
    });
  });

  it('returns null when nothing is claimable', async () => {
    const { internals, queryRawUnsafe } = makeWorker();
    queryRawUnsafe.mockResolvedValueOnce([]);
    await expect(internals.claimNext()).resolves.toBeNull();
  });
});

describe('DraftJobWorkerService sweeps', () => {
  it('failExpired flips queued/running past-deadline jobs to failed with a clear message', async () => {
    const { internals, updateMany } = makeWorker();
    await internals.failExpired();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { in: ['queued', 'running'] }, deadlineAt: { lte: expect.any(Date) } },
        data: expect.objectContaining({ status: 'failed', stage: 'failed' }),
      }),
    );
  });

  it('reclaimStale returns a running-but-quiet job to queued (no-progress reclaim, not just claim age)', async () => {
    const { internals, updateMany } = makeWorker();
    await internals.reclaimStale();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'running',
          updatedAt: { lt: expect.any(Date) },
          deadlineAt: { gt: expect.any(Date) },
        }),
        data: { status: 'queued', claimedBy: null, claimedAt: null },
      }),
    );
  });
});

describe('DraftJobWorkerService.processJob', () => {
  it('deadline already exceeded before start: fails WITHOUT calling the orchestrator', async () => {
    const { internals, draftMock, updateMany } = makeWorker();
    const job = claimedJob({ deadlineAt: new Date(Date.now() - 1_000) });

    await internals.processJob(job);

    expect(draftMock).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          stage: 'failed',
          errorMessage: expect.stringMatching(/too long/i),
        }),
      }),
    );
  });

  it('successful completion sets status completed and the persisted strategyId', async () => {
    const { internals, draftMock, updateMany } = makeWorker();
    draftMock.mockResolvedValue({ id: 'strategy-123', nodes: [] });
    const job = claimedJob();

    await internals.processJob(job);

    expect(draftMock).toHaveBeenCalledWith(
      'tenant-1',
      'user-1',
      'token',
      job.input.dto,
      expect.objectContaining({
        timeoutMs: expect.any(Number),
        onStage: expect.any(Function),
        onStreamDelta: expect.any(Function),
      }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'job-1', status: 'running' }),
        data: expect.objectContaining({ status: 'completed', strategyId: 'strategy-123' }),
      }),
    );
  });

  it('passes an undefined bearer to draft() when none was captured at submit time', async () => {
    const { internals, draftMock } = makeWorker();
    draftMock.mockResolvedValue({ id: 'strategy-1' });
    const job = claimedJob({ input: { dto: { clientId: CLIENT }, bearer: null } });

    await internals.processJob(job);

    expect(draftMock).toHaveBeenCalledWith('tenant-1', 'user-1', undefined, job.input.dto, expect.anything());
  });

  it('an orchestrator/verify/persist failure sets status failed with the thrown message', async () => {
    const { internals, draftMock, updateMany } = makeWorker();
    draftMock.mockRejectedValue(new Error('Meri strategy-draft-stream timed out'));
    const job = claimedJob();

    await internals.processJob(job);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'failed', stage: 'failed', errorMessage: 'Meri strategy-draft-stream timed out' },
      }),
    );
  });

  it('a job that goes over its deadline WHILE running is still recorded as a deadline failure', async () => {
    const { internals, draftMock, updateMany } = makeWorker();
    const job = claimedJob({ deadlineAt: new Date(Date.now() + 5) });
    draftMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('aborted');
    });

    await internals.processJob(job);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', errorMessage: expect.stringMatching(/too long/i) }),
      }),
    );
  });

  it('jobRuntime.onStage writes stage + progressText immediately', async () => {
    const { internals, draftMock, updateMany } = makeWorker();
    draftMock.mockImplementation(async (_t, _u, _b, _dto, jobRuntime) => {
      jobRuntime.onStage('drafting', 'Drafting the plan');
      return { id: 'strategy-1' };
    });

    await internals.processJob(claimedJob());

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { stage: 'drafting', progressText: 'Drafting the plan' } }),
    );
  });

  it('jobRuntime.onStreamDelta throttles DB writes instead of writing on every delta', async () => {
    const { internals, draftMock, updateMany } = makeWorker();
    const nowSpy = jest.spyOn(Date, 'now');
    let clock = 1_000_000;
    nowSpy.mockImplementation(() => clock);

    draftMock.mockImplementation(async (_t, _u, _b, _dto, jobRuntime) => {
      jobRuntime.onStreamDelta('a'); // first delta always flushes
      clock += 100; // well under the 750ms throttle window
      jobRuntime.onStreamDelta('b'); // should be buffered, not written
      clock += 1_000; // now past the throttle window
      jobRuntime.onStreamDelta('c'); // should flush the accumulated buffer
      return { id: 'strategy-1' };
    });

    await internals.processJob(claimedJob());

    const streamWrites = updateMany.mock.calls.filter((c) => {
      const data = (c[0] as { data: Record<string, unknown> }).data;
      return typeof data.streamPreview === 'string' && !('status' in data);
    });
    expect(streamWrites).toHaveLength(2);
    expect((streamWrites[0]![0] as { data: { streamPreview: string } }).data.streamPreview).toBe('a');
    expect((streamWrites[1]![0] as { data: { streamPreview: string } }).data.streamPreview).toBe('abc');

    nowSpy.mockRestore();
  });
});

describe('DraftJobWorkerService lifecycle', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not start the sweep when the orchestrator is not configured', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const { worker } = makeWorker({ orchestratorConfigured: false });
    worker.onModuleInit();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('starts and stops the sweep interval when configured', () => {
    jest.useFakeTimers();
    const { worker } = makeWorker({ orchestratorConfigured: true });
    const internals = worker as unknown as { timer?: unknown };
    worker.onModuleInit();
    expect(internals.timer).toBeDefined();
    worker.onModuleDestroy();
  });
});
