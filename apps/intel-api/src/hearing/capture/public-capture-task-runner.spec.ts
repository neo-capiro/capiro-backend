import { runPublicCaptureTask } from './public-capture-task-runner.js';
import { PublicCapturePersistentQueueAdapter } from './public-capture-persistent-queue.adapter.js';
import { PublicHearingCaptureStore } from './public-hearing-capture.store.js';
import {
  PublicCaptureOrchestrator,
  PublicCaptureWorkerCoordinator,
} from './public-capture.orchestrator.js';
import { PublicCaptureCredentialsAdapter } from './public-capture-credentials.adapter.js';

describe('standalone capture task claims', () => {
  it.each([
    [{ action: 'FAILED', error: 'storage unavailable' }, 1, 0, 0],
    [{ action: 'RECOVERING' }, 0, 1, 0],
    [{ action: 'COMPLETE' }, 0, 0, 1],
  ])(
    'reports recording outcome %j accurately without duplicating coordinator retries',
    async (outcome, failed, requeued, completed) => {
      const claim = jest
        .spyOn(PublicCapturePersistentQueueAdapter.prototype, 'claimDue')
        .mockResolvedValue([
          { id: 'job', jobType: 'capture', hearingId: 'hearing', captureId: 'capture' },
        ] as never);
      const finish = jest
        .spyOn(PublicCapturePersistentQueueAdapter.prototype, 'complete')
        .mockResolvedValue(undefined);
      const fail = jest.spyOn(PublicCapturePersistentQueueAdapter.prototype, 'fail');
      const credential = jest
        .spyOn(PublicCaptureCredentialsAdapter.prototype, 'resolve')
        .mockResolvedValue({ apiKey: 'test' } as never);
      const run = jest
        .spyOn(PublicCaptureWorkerCoordinator.prototype, 'run')
        .mockResolvedValue(outcome as never);
      try {
        const result = await runPublicCaptureTask('worker', [], { prisma: {} as never });
        expect(result).toMatchObject({ failed, requeued, completed });
        expect(finish).toHaveBeenCalledTimes(1);
        expect(fail).not.toHaveBeenCalled();
      } finally {
        [claim, finish, fail, credential, run].forEach((spy) => spy.mockRestore());
      }
    },
  );
  it('retires old undated preflight jobs without rearming them or changing capture history', async () => {
    const claim = jest
      .spyOn(PublicCapturePersistentQueueAdapter.prototype, 'claimDue')
      .mockResolvedValue([{ id: 'old-job', hearingId: 'old-hearing' }] as never);
    const complete = jest
      .spyOn(PublicCapturePersistentQueueAdapter.prototype, 'complete')
      .mockResolvedValue(undefined);
    const due = jest
      .spyOn(PublicHearingCaptureStore.prototype, 'listDueHearingIds')
      .mockResolvedValue(['current-hearing']);
    const hearing = jest
      .spyOn(PublicHearingCaptureStore.prototype, 'getHearing')
      .mockResolvedValue({ id: 'old-hearing', eventStatus: 'scheduled' } as never);
    const reconcile = jest
      .spyOn(PublicCaptureOrchestrator.prototype, 'reconcile')
      .mockResolvedValue({} as never);
    try {
      const result = await runPublicCaptureTask('preflight', ['--limit=10'], {
        prisma: {} as never,
      });
      expect(complete).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'old-job' }));
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith('current-hearing');
      expect(result.results).toContainEqual({
        hearingId: 'old-hearing',
        outcome: 'OUTSIDE_AUTOMATIC_CAPTURE_WINDOW',
      });
    } finally {
      [claim, complete, due, hearing, reconcile].forEach((spy) => spy.mockRestore());
    }
  });
  it('leaves sibling hearings claimable while one task spends hours recording', async () => {
    const claim = jest
      .spyOn(PublicCapturePersistentQueueAdapter.prototype, 'claimDue')
      .mockResolvedValue([]);
    try {
      await runPublicCaptureTask('worker', ['--limit=25'], { prisma: {} as never });
      expect(claim).toHaveBeenCalledWith(expect.objectContaining({ jobType: 'capture', limit: 1 }));
    } finally {
      claim.mockRestore();
    }
  });
});
