import { backfillFloridaArchiveSessions } from './florida-archive-discovery.js';
import { LegiWatchPhase9JobsService } from '../live-hearings/phase9/legiwatch-phase9-jobs.service.js';
import { LegiWatchPhase9PartialFailure } from '../live-hearings/phase9/legiwatch-phase9-runtime.service.js';

jest.mock('./florida-archive-discovery.js', () => ({
  backfillFloridaArchiveSessions: jest.fn(),
}));

const archiveBatch = jest.mocked(backfillFloridaArchiveSessions);

function metrics(overrides: Record<string, unknown> = {}) {
  return {
    archiveSessions: 2,
    archiveSessionsCompleted: 2,
    archiveSessionFailures: 0,
    archivePages: 2,
    archiveListed: 4,
    archiveAccepted: 3,
    archiveInserted: 1,
    archiveUpdated: 1,
    archiveUnchanged: 1,
    archiveRejected: 0,
    archiveErrors: 0,
    archiveIssues: 0,
    archiveAmbiguous: 0,
    archiveCatalogRows: 1,
    archiveCatalogAttached: 1,
    archiveCatalogReported: 0,
    archiveCatalogFailures: 0,
    archivePartial: false,
    archiveFailedSessions: '',
    ...overrides,
  };
}

function harness() {
  const runtime = {
    run: jest.fn(async (input: { execute: () => Promise<unknown> }) => input.execute()),
  };
  const service = new LegiWatchPhase9JobsService(
    {} as never,
    runtime as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, runtime };
}

describe('Florida Phase 9 archive job', () => {
  const originalPrimary = process.env.FL_CALENDAR_SESSION;
  const originalAdditional = process.env.FL_CALENDAR_ADDITIONAL_SESSION;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2027-10-15T12:00:00Z'));
    delete process.env.FL_CALENDAR_SESSION;
    delete process.env.FL_CALENDAR_ADDITIONAL_SESSION;
    archiveBatch.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalPrimary === undefined) delete process.env.FL_CALENDAR_SESSION;
    else process.env.FL_CALENDAR_SESSION = originalPrimary;
    if (originalAdditional === undefined) delete process.env.FL_CALENDAR_ADDITIONAL_SESSION;
    else process.env.FL_CALENDAR_ADDITIONAL_SESSION = originalAdditional;
  });

  it('leases the job and passes both fall sessions to the archive batch', async () => {
    archiveBatch.mockResolvedValue(metrics());
    const { service, runtime } = harness();

    await expect(service.run({ job: 'florida-archive' })).resolves.toEqual(metrics());
    expect(runtime.run).toHaveBeenCalledWith(
      expect.objectContaining({
        jobKey: 'florida-archive',
        skipIfRunning: true,
        leaseSeconds: 5_400,
      }),
    );
    expect(archiveBatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessions: ['2027', '2028'],
        from: '2027-09-16',
        to: '2027-10-15',
        catalog: true,
      }),
    );
  });

  it('turns partial archive evidence into failed runtime health with flat metrics', async () => {
    archiveBatch.mockResolvedValue(
      metrics({
        archiveErrors: 1,
        archiveIssues: 2,
        archiveAmbiguous: 1,
        archiveCatalogFailures: 1,
        archivePartial: true,
      }),
    );
    const { service } = harness();

    const result = service.run({ job: 'florida-archive' });
    await expect(result).rejects.toBeInstanceOf(LegiWatchPhase9PartialFailure);
    await expect(result).rejects.toMatchObject({
      runtimeMetrics: expect.objectContaining({
        archiveErrors: 1,
        archiveIssues: 2,
        archiveAmbiguous: 1,
        archiveCatalogFailures: 1,
        archivePartial: true,
      }),
    });
  });
});
