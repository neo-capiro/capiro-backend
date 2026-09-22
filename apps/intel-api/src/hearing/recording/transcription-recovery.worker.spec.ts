import { TranscriptionRecoveryWorker } from './transcription-recovery.worker.js';
import { STATE_CAPTURE_LINK_ONLY } from '../state-capture-policy.js';

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

  it.each([
    [undefined, 'federal_committee_hearing'],
    ['true', 'capturable_committee_hearing'],
  ])(
    'only seeds and claims recovery work with a canonical hearing (state switch=%s → %s)',
    async (stateFlag, view) => {
      const previousFlag = process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED;
      if (stateFlag === undefined) delete process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED;
      else process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED = stateFlag;
      try {
        const executed: string[] = [];
        const queried: string[] = [];
        const tx = {
          $executeRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
            executed.push(renderSql(parts, values));
            return 1;
          }),
          $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
            queried.push(renderSql(parts, values));
            return [];
          }),
        };
        const transcribe = jest.fn().mockResolvedValue([]);
        const worker = new TranscriptionRecoveryWorker(
          { withSystem: (fn: (transaction: typeof tx) => unknown) => fn(tx) } as never,
          {} as never,
          {} as never,
          transcribe,
        );

        await worker.seed();
        expect(executed[0]).toContain('s.hearing_id IS NULL OR EXISTS');
        expect(executed[0]).toContain(`FROM ${view} f`);
        expect(executed[1]).toContain(`JOIN ${view} f`);
        await expect(worker.runOne()).resolves.toBe(false);
        expect(queried[0]).toContain("j.kind='public'");
        expect(queried[0]).toContain(`JOIN ${view} f`);
        expect(transcribe).not.toHaveBeenCalled();
      } finally {
        if (previousFlag === undefined) delete process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED;
        else process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED = previousFlag;
      }
    },
  );

  it('rechecks canonical federal identity before public segment insertion', async () => {
    const publicAudio = process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED;
    process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED = 'true';
    try {
      const job = {
        id: 'job-state',
        kind: 'public',
        epoch_id: 'epoch-state',
        cursor_ms: 0n,
        attempts: 0,
      };
      const queries = jest
        .fn()
        .mockResolvedValueOnce([job])
        .mockResolvedValueOnce([{ id: 'federal-at-start' }])
        .mockResolvedValueOnce([{ id: 'legacy-grant' }])
        .mockResolvedValueOnce([{ id: 'epoch-state' }])
        .mockResolvedValueOnce([{ id: 'job-state' }])
        // The canonical federal row disappeared before the commit transaction.
        .mockResolvedValueOnce([]);
      const writes: string[] = [];
      const tx = {
        $queryRaw: queries,
        $executeRaw: jest.fn(async (parts: TemplateStringsArray) => {
          writes.push(parts.join('?'));
          return 1;
        }),
      };
      const worker = new TranscriptionRecoveryWorker(
        { withSystem: (fn: (transaction: typeof tx) => unknown) => fn(tx) } as never,
        { enabled: true } as never,
        {} as never,
        async () => [{ word: 'blocked', start: 0, end: 0.5 }],
      );
      Object.assign(worker, {
        source: async () => ({
          kind: 'public',
          epochId: 'epoch-state',
          captureId: 'capture-state',
          hearingId: 'hearing-state',
          sourceUrl: 'https://example.gov/watch',
          startMs: 0,
          durationMs: 1000,
          sampleRate: 16000,
          channels: 1,
        }),
        readPcm: async () => Buffer.alloc(16),
      });

      await expect(worker.runOne()).resolves.toBe(true);
      expect(writes.some((sql) => sql.includes('INSERT INTO public_hearing_transcript_segment'))).toBe(
        false,
      );
      expect(
        writes.find((sql) => sql.includes('last_error=')),
      ).toBeDefined();
      expect(queries).toHaveBeenCalledTimes(6);
    } finally {
      if (publicAudio === undefined) delete process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED;
      else process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED = publicAudio;
    }
  });

  const floridaSource = {
    kind: 'public',
    epochId: 'epoch-state',
    captureId: 'capture-state',
    hearingId: 'hearing-state',
    sourceUrl: 'https://www.flsenate.gov/Media/VideoPlayer/6382',
    startMs: 0,
    durationMs: 1000,
    sampleRate: 16000,
    channels: 1,
  };

  it('rejects a known Florida publisher source before federal or grant lookups (switch off)', async () => {
    delete process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED;
    const worker = new TranscriptionRecoveryWorker(
      {} as never,
      { enabled: true } as never,
      {} as never,
    );
    const query = jest.fn().mockResolvedValue([{ id: 'federal-substitute' }]);
    await expect(
      (worker as any).authorize({ $queryRaw: query }, floridaSource),
    ).rejects.toThrow(STATE_CAPTURE_LINK_ONLY);
    expect(query).not.toHaveBeenCalled();
  });

  it('authorizes a Florida publisher source against the capturable view once the switch is on', async () => {
    const previousEnv = {
      state: process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED,
      publicAudio: process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED,
    };
    process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED = 'true';
    process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED = 'true';
    try {
      const worker = new TranscriptionRecoveryWorker(
        {} as never,
        { enabled: true } as never,
        {} as never,
      );
      const query = jest.fn(async () => [{ id: 'row' }]);
      await expect(
        (worker as any).authorize({ $queryRaw: query }, floridaSource),
      ).resolves.toBeUndefined();
      const [parts, ...values] = query.mock.calls[0]! as unknown as [TemplateStringsArray, ...unknown[]];
      expect(renderSql(parts, values)).toContain('FROM capturable_committee_hearing');
    } finally {
      for (const [key, value] of [
        ['LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED', previousEnv.state],
        ['HEARING_PUBLIC_AUDIO_STORAGE_ENABLED', previousEnv.publicAudio],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

/** Render a tagged-template call, inlining Prisma.raw fragments (view names). */
function renderSql(parts: TemplateStringsArray, values: unknown[]): string {
  return parts.reduce(
    (sql, part, index) =>
      sql +
      part +
      (index < values.length ? ((values[index] as { sql?: string })?.sql ?? '?') : ''),
    '',
  );
}
