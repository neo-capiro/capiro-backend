import {
  acquireCaptureLease,
  canAcquireCaptureLease,
  canTransitionCapture,
  captureGapDurationMs,
  completionStatusForCapture,
  mergeCaptureGaps,
  publicCaptureIdempotencyKey,
  renewCaptureLease,
  transitionCapture,
} from './public-hearing-capture-state.js';

describe('public hearing capture state', () => {
  it('enforces the capture lifecycle and requires a failure code', () => {
    expect(canTransitionCapture('SCHEDULED', 'PREPARING')).toBe(true);
    expect(canTransitionCapture('CAPTURING', 'COMPLETE')).toBe(false);
    expect(() =>
      transitionCapture(
        { status: 'CAPTURING', version: 3, updatedAt: new Date('2026-08-20T14:00:00Z') },
        'COMPLETE',
        new Date('2026-08-20T15:00:00Z'),
      ),
    ).toThrow(/Illegal/);
    expect(() =>
      transitionCapture(
        { status: 'CAPTURING', version: 3, updatedAt: new Date('2026-08-20T14:00:00Z') },
        'FAILED',
        new Date('2026-08-20T15:00:00Z'),
      ),
    ).toThrow(/failure code/i);
  });

  it('provides one stable queue idempotency key per canonical hearing', () => {
    expect(publicCaptureIdempotencyKey(' Hearing-123 ')).toBe(
      'public-hearing-capture:v1:hearing-123',
    );
  });

  it('uses an expiring lease and fencing token for single-worker ownership', () => {
    const now = new Date('2026-08-20T14:00:00Z');
    const lease = acquireCaptureLease(null, 'worker-a', now, 60_000);
    expect(lease.fencingToken).toBe(1);
    expect(canAcquireCaptureLease(lease, 'worker-b', new Date('2026-08-20T14:00:30Z'))).toBe(
      false,
    );
    expect(canAcquireCaptureLease(lease, 'worker-b', new Date('2026-08-20T14:01:00Z'))).toBe(
      true,
    );

    const takenOver = acquireCaptureLease(
      lease,
      'worker-b',
      new Date('2026-08-20T14:01:00Z'),
      60_000,
    );
    expect(takenOver.fencingToken).toBe(2);
    expect(() =>
      renewCaptureLease(takenOver, 'worker-a', 1, new Date('2026-08-20T14:01:10Z'), 60_000),
    ).toThrow(/mismatch/i);
  });

  it('merges overlapping gaps and avoids double-counting different reasons', () => {
    let gaps = mergeCaptureGaps([], {
      startMs: 1_000,
      endMs: 5_000,
      reason: 'MEDIA_DISCONNECT',
    });
    gaps = mergeCaptureGaps(gaps, {
      startMs: 4_000,
      endMs: 8_000,
      reason: 'MEDIA_DISCONNECT',
    });
    gaps = mergeCaptureGaps(gaps, {
      startMs: 6_000,
      endMs: 10_000,
      reason: 'DEEPGRAM_DISCONNECT',
    });

    expect(gaps).toHaveLength(2);
    expect(captureGapDurationMs(gaps)).toBe(9_000);
    expect(completionStatusForCapture({ capturedMs: 60_000, gaps })).toBe(
      'COMPLETE_WITH_GAPS',
    );
  });
});
