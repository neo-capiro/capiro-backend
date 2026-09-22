import { PublicHearingTranscriptStore } from './public-hearing-transcript.store.js';
import { StaleCaptureFencingTokenError } from './public-hearing-capture.store.js';
import { STATE_CAPTURE_LINK_ONLY } from '../state-capture-policy.js';

const lease = { ownerId: 'worker-a', fencingToken: 7 };
const FLAG = 'LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED';

function harness(canonicalHearingId: string | null = 'h') {
  const execute = jest.fn().mockResolvedValue(1);
  const query = jest.fn().mockResolvedValue([{ id: 'c', canonicalHearingId }]);
  const tx = { $executeRawUnsafe: execute, $queryRawUnsafe: query };
  const store = new PublicHearingTranscriptStore({
    ...tx,
    $transaction: jest.fn(async (operation: (value: typeof tx) => unknown) => operation(tx)),
  } as never);
  return { store, execute, query };
}

const previous = process.env[FLAG];
beforeEach(() => {
  delete process.env[FLAG];
});
afterAll(() => {
  if (previous === undefined) delete process.env[FLAG];
  else process.env[FLAG] = previous;
});

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
    expect(query.mock.calls[0]![0]).toContain('LEFT JOIN federal_committee_hearing');
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

  it('rejects an owned capture when its canonical hearing row is missing', async () => {
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
    'hard-blocks ineligible transcript persistence through %s',
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

  it('joins the capturable (federal + state) view once state capture is enabled, still failing closed on null', async () => {
    process.env[FLAG] = 'true';
    const { store, execute, query } = harness();
    await store.appendFinal({
      captureId: 'c',
      hearingId: 'h',
      lease,
      segment: { startMs: 0, endMs: 1000, text: 'state words' },
    });
    expect(query.mock.calls[0]![0]).toContain('LEFT JOIN capturable_committee_hearing');
    expect(execute).toHaveBeenCalled();

    const orphan = harness(null);
    await expect(
      orphan.store.appendFinal({
        captureId: 'c',
        hearingId: 'h',
        lease,
        segment: { startMs: 0, endMs: 1000, text: 'orphan words' },
      }),
    ).rejects.toThrow(STATE_CAPTURE_LINK_ONLY);
    expect(orphan.execute).not.toHaveBeenCalled();
  });
});
