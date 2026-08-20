import {
  parsePublicCaptureQueueJob,
  PublicCaptureWorkerHandler,
} from './public-capture-jobs.js';
import type { PublicCaptureWorkerCoordinator } from './public-capture.orchestrator.js';

describe('public capture queue jobs', () => {
  it('accepts only the global identity and JIT-resolution contract', () => {
    expect(
      parsePublicCaptureQueueJob({
        version: 1,
        captureId: 'capture-1',
        hearingId: 'hearing-1',
        officialPageUrl: 'https://www.armed-services.senate.gov/hearings/example',
        mustReresolve: true,
      }),
    ).toEqual(expect.objectContaining({ captureId: 'capture-1', mustReresolve: true }));
  });

  for (const field of ['tenantId', 'clientId', 'mediaUrl', 'apiKey'] as const) {
    it(`rejects forbidden ${field} data`, () => {
      expect(() =>
        parsePublicCaptureQueueJob({
          version: 1,
          captureId: 'capture-1',
          hearingId: 'hearing-1',
          mustReresolve: true,
          [field]: 'forbidden',
        }),
      ).toThrow(/Forbidden/);
    });
  }

  it('generates a unique worker identity at the queue boundary', async () => {
    const run = jest.fn(async () => ({ action: 'LEASE_HELD_BY_OTHER' as const }));
    const handler = new PublicCaptureWorkerHandler(
      { run } as unknown as PublicCaptureWorkerCoordinator,
      { workerIdFactory: () => 'worker-unique-1' },
    );

    await handler.handle({
      version: 1,
      captureId: 'capture-1',
      hearingId: 'hearing-1',
      mustReresolve: true,
    });

    expect(run).toHaveBeenCalledWith({
      captureId: 'capture-1',
      hearingId: 'hearing-1',
      workerId: 'worker-unique-1',
    });
  });
});
