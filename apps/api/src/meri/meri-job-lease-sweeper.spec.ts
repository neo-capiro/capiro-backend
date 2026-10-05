import {
  MERI_JOB_REQUEUED_STAGE,
  MERI_JOB_SWEEP_GRACE_MS,
  MeriJobLeaseSweeper,
  meriJobSweeperEnabled,
  reclaimExpiredJobLease,
} from './meri-job-lease-sweeper.js';
import { RESEARCH_RUN_LEASE_MS } from './meri-research-run-state.js';
import * as coordinatorModule from './meri-research-coordinator.js';

const now = new Date('2026-10-06T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const expired = ago(RESEARCH_RUN_LEASE_MS + MERI_JOB_SWEEP_GRACE_MS + 1_000);

function session(status: string, run: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    status: 'researching',
    reportArtifactId: null,
    metadata: {
      unrelated: { kept: true },
      run: {
        id: 'run-1',
        leaseEpoch: 3,
        eventSequence: 7,
        phase: 'research',
        status,
        stage: 'Gathering evidence',
        startedAt: ago(30 * 60_000),
        heartbeatAt: expired,
        ...run,
      },
      ...extra,
    },
  };
}

describe('reclaimExpiredJobLease', () => {
  it('leaves a live lease alone, including one just past the lease but inside the grace', () => {
    expect(reclaimExpiredJobLease(session('running', { heartbeatAt: ago(5_000) }), now)).toBeNull();
    expect(
      reclaimExpiredJobLease(
        session('running', { heartbeatAt: ago(RESEARCH_RUN_LEASE_MS + 1_000) }),
        now,
      ),
    ).toBeNull();
  });

  it('requeues a dead running job for the next signed-in resume, keeping its epoch and metadata', () => {
    const decision = reclaimExpiredJobLease(session('running', {}), now)!;
    expect(decision.action).toBe('requeue');
    expect(decision.status).toBe('researching');
    expect(decision.metadata.unrelated).toEqual({ kept: true });
    expect(decision.metadata.run).toMatchObject({
      id: 'run-1',
      leaseEpoch: 3,
      eventSequence: 7,
      status: 'interrupted',
      readyToStart: true,
      stage: MERI_JOB_REQUEUED_STAGE,
      heartbeatAt: now.toISOString(),
    });
  });

  it('treats an unreadable heartbeat as expired', () => {
    expect(reclaimExpiredJobLease(session('running', { heartbeatAt: 'never' }), now)?.action).toBe(
      'requeue',
    );
  });

  it('completes an orphaned stop as cancelled', () => {
    const decision = reclaimExpiredJobLease(session('cancel_requested', {}), now)!;
    expect(decision).toMatchObject({ action: 'cancel', status: 'cancelled' });
    expect(decision.metadata.run).toMatchObject({
      status: 'cancelled',
      finishedAt: now.toISOString(),
    });
  });

  it('records the stop through the coordinator when one requested it', () => {
    jest
      .spyOn(coordinatorModule, 'readDurableResearchCoordinator')
      .mockReturnValueOnce({ cancellation: { state: 'requested' } } as never);
    const observe = jest
      .spyOn(coordinatorModule, 'observeDurableResearchCancellation')
      .mockReturnValueOnce({ metadata: { observed: true } } as never);
    const decision = reclaimExpiredJobLease(session('cancel_requested', {}), now)!;
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ now }));
    expect(decision).toEqual({ action: 'cancel', status: 'cancelled', metadata: { observed: true } });
    observe.mockRestore();
  });

  it.each(['interrupted', 'complete', 'failed', 'cancelled', 'awaiting_clarification'])(
    'never touches a %s run',
    (status) => {
      expect(reclaimExpiredJobLease(session(status, {}), now)).toBeNull();
    },
  );

  it('never touches a job whose report is saved', () => {
    expect(
      reclaimExpiredJobLease({ ...session('running', {}), reportArtifactId: 'artifact-1' }, now),
    ).toBeNull();
  });
});

describe('MeriJobLeaseSweeper', () => {
  function prisma(rows: Array<Record<string, unknown>>, counts: number[]) {
    const tx = {
      $queryRawUnsafe: jest.fn(async () => rows),
      clioResearchSession: { updateMany: jest.fn(async () => ({ count: counts.shift() ?? 0 })) },
    };
    return { tx, service: { withSystem: async (fn: (db: typeof tx) => unknown) => fn(tx) } };
  }

  it('is dark unless MERI_JOB_SWEEPER_ENABLED=true', () => {
    expect(meriJobSweeperEnabled({})).toBe(false);
    expect(meriJobSweeperEnabled({ MERI_JOB_SWEEPER_ENABLED: 'false' })).toBe(false);
    expect(meriJobSweeperEnabled({ MERI_JOB_SWEEPER_ENABLED: 'true' })).toBe(true);
  });

  it('reclaims through a compare-and-swap and counts only the leases it won', async () => {
    const first = { id: 's-1', tenantId: 't-1', ...session('running', {}) };
    const second = { id: 's-2', tenantId: 't-2', ...session('cancel_requested', {}) };
    const { tx, service } = prisma([first, second], [1, 0]);
    const sweeper = new MeriJobLeaseSweeper(service as never);
    await expect(sweeper.sweep(now)).resolves.toEqual({ scanned: 2, reclaimed: 1 });
    const [sql, cutoff] = tx.$queryRawUnsafe.mock.calls[0] as unknown as [string, string];
    expect(sql).toContain("IN ('running', 'cancel_requested')");
    expect(cutoff).toBe(ago(RESEARCH_RUN_LEASE_MS + MERI_JOB_SWEEP_GRACE_MS));
    expect(tx.clioResearchSession.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: 's-1',
          tenantId: 't-1',
          reportArtifactId: null,
          metadata: { equals: first.metadata },
        }),
      }),
    );
  });

  it('a failed sweep is logged and reports nothing reclaimed', async () => {
    const service = {
      withSystem: async () => {
        throw new Error('database unavailable');
      },
    };
    const sweeper = new MeriJobLeaseSweeper(service as never);
    await expect(sweeper.sweep(now)).resolves.toEqual({ scanned: 0, reclaimed: 0 });
  });
});
