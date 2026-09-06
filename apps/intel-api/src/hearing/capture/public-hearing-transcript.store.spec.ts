import { PublicHearingTranscriptStore } from './public-hearing-transcript.store.js';
import { StaleCaptureFencingTokenError } from './public-hearing-capture.store.js';

const lease = { ownerId: 'worker-a', fencingToken: 7 };

function harness() {
  const execute = jest.fn().mockResolvedValue(1);
  const query = jest.fn().mockResolvedValue([{ id: 'c' }]);
  const tx = { $executeRawUnsafe: execute, $queryRawUnsafe: query };
  const store = new PublicHearingTranscriptStore({
    ...tx, $transaction: jest.fn(async (operation) => operation(tx)),
  } as never);
  return { store, execute, query };
}

describe('PublicHearingTranscriptStore', () => {
  it('deduplicates finals, marks the segment after a gap, and checkpoints the cursor under lease', async () => {
    const { store, execute, query } = harness();
    await store.appendGap({ captureId: 'c', hearingId: 'h', lease,
      gap: { startMs: 0, endMs: 1500, reason: 'MEDIA_DISCONNECT' } });
    await store.appendFinal({ captureId: 'c', hearingId: 'h', lease,
      segment: { startMs: 1500, endMs: 2000, text: 'hello' } });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), 'c', 'worker-a', 7);
    expect(query.mock.calls[0]![0]).toContain('lease_expires_at > clock_timestamp()');
    expect(execute.mock.calls[1]![0]).toContain('ON CONFLICT (capture_id,start_ms,end_ms) DO NOTHING');
    expect(execute.mock.calls[1]!.at(-1)).toBe(true);
    expect(execute).toHaveBeenLastCalledWith(expect.stringContaining('GREATEST(captured_ms,$2)'), 'c', 2000);
  });

  it('rejects a stale final before inserting any transcript or updating progress', async () => {
    const { store, execute, query } = harness();
    query.mockResolvedValue([]);
    await expect(store.appendFinal({ captureId: 'c', hearingId: 'h', lease,
      segment: { startMs: 0, endMs: 1000, text: 'stale words' } }))
      .rejects.toBeInstanceOf(StaleCaptureFencingTokenError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a stale gap using the same owner, token, and expiry predicates', async () => {
    const { store, execute } = harness();
    execute.mockResolvedValue(0);
    await expect(store.appendGap({ captureId: 'c', hearingId: 'h', lease,
      gap: { startMs: 0, endMs: 1000, reason: 'MEDIA_DISCONNECT' } }))
      .rejects.toBeInstanceOf(StaleCaptureFencingTokenError);
    expect(execute.mock.calls[0]![0]).toContain('worker_lease_owner=$4 AND fencing_token=$5');
    expect(execute.mock.calls[0]![0]).toContain('lease_expires_at > clock_timestamp()');
  });
});
