import { DiscoveryJobsService } from '../../hearing-discovery/discovery-jobs.service.js';
import type { ProbeAdapterMap } from '../../hearing-discovery/discovery-jobs.service.js';
import { LegiWatchPhase9JobsService } from './legiwatch-phase9-jobs.service.js';
import {
  LegiWatchPhase9PartialFailure,
  LegiWatchPhase9RuntimeService,
} from './legiwatch-phase9-runtime.service.js';

const cases = [
  ['committee-enrichment', 'enrichCommitteeHearings'],
  ['committee-updates', 'detectCommitteeUpdates'],
  ['source-probe', 'probeSources'],
  ['archive-reconciliation', 'reconcileArchives'],
] as const;

function harness() {
  const execute = jest.fn(async (_sql: string, ..._values: unknown[]) => 1);
  const prisma = { $executeRawUnsafe: execute };
  const runtime = new LegiWatchPhase9RuntimeService(prisma as never);
  // Entry authorization is tested by the runtime suite; exercise its real
  // success/failure persistence here after the authorized job has started.
  const begin = jest.spyOn(runtime, 'begin').mockResolvedValue(undefined);
  const jobs = new LegiWatchPhase9JobsService(
    prisma as never,
    runtime,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  jest
    .spyOn(jobs as unknown as { probeAdapters(): Promise<ProbeAdapterMap> }, 'probeAdapters')
    .mockResolvedValue(new Map());
  return { jobs, execute, begin };
}

afterEach(() => jest.restoreAllMocks());

describe.each(cases)('%s result truth', (job, method) => {
  it('retains successful partial counts but records failed heartbeat and propagates nonzero-exit failure', async () => {
    const counts = { inserted: 5, updated: 12, skipped: 3, errors: 8 };
    const work = jest.spyOn(DiscoveryJobsService.prototype, method).mockResolvedValue(counts);
    const { jobs, execute, begin } = harness();
    const error = await jobs
      .run({ job, workerId: 'test-worker', manual: false, limit: 23 })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(LegiWatchPhase9PartialFailure);
    expect((error as LegiWatchPhase9PartialFailure).runtimeMetrics).toEqual(counts);
    expect(work).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledWith(expect.objectContaining({ limit: 23 }));
    expect(begin).toHaveBeenCalledWith({ jobKey: job, workerId: 'test-worker', manual: false });
    const writes = execute.mock.calls;
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toContain("status='failed'");
    expect(writes[0]![0]).toContain('consecutive_failures=consecutive_failures+1');
    expect(writes[0]![1]).toBe(job);
    expect(JSON.parse(writes[0]![3] as string)).toMatchObject(counts);
    expect(writes[0]![0]).not.toContain('last_success_at=now()');
  });

  it.each([0, 17])(
    'keeps a zero-error run successful even with %s skipped rows',
    async (skipped) => {
      const counts = { inserted: 5, updated: 12, skipped, errors: 0 };
      const work = jest.spyOn(DiscoveryJobsService.prototype, method).mockResolvedValue(counts);
      const { jobs, execute } = harness();
      await expect(jobs.run({ job, workerId: 'test-worker' })).resolves.toEqual(counts);
      expect(work).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls).toHaveLength(1);
      expect(execute.mock.calls[0]![0]).toContain("status='succeeded'");
      expect(JSON.parse(execute.mock.calls[0]![2] as string)).toMatchObject(counts);
    },
  );
});

it('does not execute discovery or persist a result when the runtime entry gate refuses the job', async () => {
  const work = jest.spyOn(DiscoveryJobsService.prototype, 'probeSources');
  const { jobs, execute, begin } = harness();
  begin.mockRejectedValueOnce(new Error('Job is disabled'));
  await expect(jobs.run({ job: 'source-probe', workerId: 'test-worker' })).rejects.toThrow(
    'Job is disabled',
  );
  expect(work).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
