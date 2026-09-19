import { TranscriptionRecoveryWorker } from './transcription-recovery.worker.js';

describe('transcript recovery cursor and recorded context', () => {
  const enabled = process.env.HEARING_TRANSCRIPTION_RECOVERY_ENABLED;
  beforeEach(() => {
    process.env.HEARING_TRANSCRIPTION_RECOVERY_ENABLED = 'true';
  });
  afterEach(() => {
    if (enabled === undefined) delete process.env.HEARING_TRANSCRIPTION_RECOVERY_ENABLED;
    else process.env.HEARING_TRANSCRIPTION_RECOVERY_ENABLED = enabled;
  });

  it.each([
    [900000, 242000],
    [721000, 241000],
  ])(
    'reads only available lookahead at source duration %i and advances a four-minute cursor',
    async (sourceDuration, expectedReadDuration) => {
      const job = {
        id: 'job-1',
        kind: 'browser',
        epoch_id: 'epoch-1',
        cursor_ms: 480000n,
        attempts: 0,
      };
      const writes: Array<{ sql: string; values: unknown[] }> = [];
      const tx = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([job])
          .mockResolvedValue([{ id: job.id }]),
        $executeRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
          writes.push({ sql: parts.join('?'), values });
          return 1;
        }),
        transcriptSegment: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn().mockResolvedValue({}),
        },
        hearingRecordingEpoch: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          count: jest.fn().mockResolvedValue(1),
        },
        hearingRecording: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      const readPcm = jest.fn().mockResolvedValue(Buffer.alloc(0));
      const worker = new TranscriptionRecoveryWorker(
        { withSystem: (fn: (transaction: typeof tx) => unknown) => fn(tx) } as never,
        {} as never,
        { encrypt: () => ({ textCipher: 'test-only' }) } as never,
        async () => [
          { word: 'discussing', start: 239.625, end: 240.665 },
          { word: 'following', start: 240.7, end: 240.9 },
        ],
      );
      Object.assign(worker, {
        source: async () => ({
          kind: 'browser',
          startMs: 0,
          durationMs: sourceDuration,
          tenantId: 'tenant-1',
          sessionId: 'session-1',
          epochId: 'epoch-1',
          recordingId: 'recording-1',
          actor: 'actor-1',
        }),
        authorize: async () => undefined,
        readPcm,
      });
      expect(await worker.runOne()).toBe(true);
      expect(readPcm.mock.calls[0]?.slice(1, 3)).toEqual([480000, expectedReadDuration]);
      expect(tx.transcriptSegment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ startMs: { lt: 480000 + expectedReadDuration } }),
        }),
      );
      expect(tx.transcriptSegment.create).toHaveBeenCalledTimes(1);
      expect(tx.transcriptSegment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            startMs: 719625,
            endMs: 720665,
            source: 'deepgram_recovery',
          }),
        }),
      );
      expect(
        writes.find((write) => write.sql.includes('SET cursor_ms='))?.values.slice(0, 2),
      ).toEqual([720000, 'pending']);
    },
  );
});
