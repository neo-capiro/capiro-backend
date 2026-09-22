import { PublicHearingTranscriptStore } from './public-hearing-transcript.store.js';
import { StaleCaptureFencingTokenError } from './public-hearing-capture.store.js';
import { STATE_CAPTURE_LINK_ONLY } from '../state-capture-policy.js';

const lease = { ownerId: 'worker-a', fencingToken: 7 };

function harness(federalHearingId: string | null = 'h') {
  const execute = jest.fn().mockResolvedValue(1);
  const query = jest.fn().mockResolvedValue([{ id: 'c', federalHearingId }]);
  const tx = { $executeRawUnsafe: execute, $queryRawUnsafe: query };
  const store = new PublicHearingTranscriptStore({
    ...tx,
    $transaction: jest.fn(async (operation: (value: typeof tx) => unknown) => operation(tx)),
  } as never);
  return { store, execute, query };
}

describe('PublicHearingTranscriptStore', () => {
  it('deduplicates federal finals, marks the segment after a gap, and checkpoints under lease', async () => {
    const { store, execute, query } = harness();
    await store.appendGap({
      captureId: 'c',
      hearingId: 'h',
      lease,
      gap: { startMs: 0, endMs: 1500, reason: 'MEDIA_DISCONNECT' },
    });
    await store.appendFinal({
      captureId: 'c',
      hearingId: 'h',
      lease,
      segment: { startMs: 1500, endMs: 2000, text: 'hello' },
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('c.hearing_id=$2'),
      'c',
      'h',
      'worker-a',
      7,
    );
    expect(execute.mock.calls[1]![0]).toContain(
      'ON CONFLICT (capture_id,start_ms,end_ms) DO NOTHING',
    );
    expect(execute.mock.calls[1]!.at(-1)).toBe(true);
  });

  it('rejects a stale or substituted hearing before writing transcript state', async () => {
    const { store, execute, query } = harness();
    query.mockResolvedValue([]);
    await expect(
      store.appendFinal({
        captureId: 'c',
        hearingId: 'other-hearing',
        lease,
        segment: { startMs: 0, endMs: 1000, text: 'stale words' },
      }),
    ).rejects.toBeInstanceOf(StaleCaptureFencingTokenError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an owned capture when its canonical federal hearing row is missing', async () => {
    const { store, execute } = harness(null);
    await expect(
      store.appendFinal({
        captureId: 'c',
        hearingId: 'h',
        lease,
        segment: { startMs: 0, endMs: 1000, text: 'orphan words' },
      }),
    ).rejects.toThrow(STATE_CAPTURE_LINK_ONLY);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['appendFinal', 'appendGap'] as const)(
    'hard-blocks state transcript persistence through %s',
    async (method) => {
      const { store, execute } = harness(null);
      const operation =
        method === 'appendFinal'
          ? store.appendFinal({
              captureId: 'c',
              hearingId: 'h',
              lease,
              segment: { startMs: 0, endMs: 1000, text: 'must not persist' },
            })
          : store.appendGap({
              captureId: 'c',
              hearingId: 'h',
              lease,
              gap: { startMs: 0, endMs: 1000, reason: 'MEDIA_DISCONNECT' },
            });
      await expect(operation).rejects.toThrow(STATE_CAPTURE_LINK_ONLY);
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
