import { runPublicCaptureTask } from './public-capture-task-runner.js';
import { PublicCapturePersistentQueueAdapter } from './public-capture-persistent-queue.adapter.js';

describe('standalone capture task claims', () => {
  it('leaves sibling hearings claimable while one task spends hours recording', async () => {
    const claim = jest.spyOn(PublicCapturePersistentQueueAdapter.prototype, 'claimDue')
      .mockResolvedValue([]);
    try {
      await runPublicCaptureTask('worker', ['--limit=25'], { prisma: {} as never });
      expect(claim).toHaveBeenCalledWith(expect.objectContaining({ jobType: 'capture', limit: 1 }));
    } finally {
      claim.mockRestore();
    }
  });
});
