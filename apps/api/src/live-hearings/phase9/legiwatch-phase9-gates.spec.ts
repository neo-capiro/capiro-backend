import {
  assessCaptureOutcome,
  canonicalEventFingerprint,
  classifyBodyCoverage,
  deriveRunStatus,
  evidenceSourceSatisfiesCutover,
  isRuntimeJobFresh,
  percentage,
  requiredEvidenceTypes,
} from './legiwatch-phase9-gates.js';

describe('LegiWatch Phase 9 fail-closed gates', () => {
  it('never treats a zero denominator as full coverage', () => {
    expect(percentage(0, 0)).toBe(0);
    expect(percentage(1, 2)).toBe(50);
  });

  it('gives zero-event bodies an explicit non-proof status', () => {
    expect(
      classifyBodyCoverage({
        sourcesRegistered: 2,
        sourcesHealthy: 2,
        sourcesFailing: 0,
        officialObservations: 0,
        pendingObservations: 0,
      }),
    ).toMatchObject({
      status: 'HEALTHY_NO_EVENTS_OBSERVED',
      reasonCode: 'SOURCE_HEALTHY_NO_EVENT_EVIDENCE',
    });
  });

  it('requires pending official observations to be reviewed', () => {
    expect(
      classifyBodyCoverage({
        sourcesRegistered: 2,
        sourcesHealthy: 2,
        sourcesFailing: 0,
        officialObservations: 1,
        pendingObservations: 1,
      }),
    ).toMatchObject({
      status: 'REVIEW_REQUIRED',
      reasonCode: 'PENDING_OFFICIAL_OBSERVATIONS',
    });
  });

  it('normalizes canonical duplicate fingerprints without losing start identity', () => {
    const first = canonicalEventFingerprint({
      chamber: 'House',
      committeeSystemCode: 'hsas00',
      title: 'Oversight: Autonomous Systems',
      startsAt: new Date('2026-08-21T14:00:15Z'),
      calendarDate: new Date('2026-08-21T00:00:00Z'),
    });
    const second = canonicalEventFingerprint({
      chamber: 'house',
      committeeSystemCode: 'HSAS00',
      title: 'Oversight — Autonomous Systems',
      startsAt: new Date('2026-08-21T14:00:45Z'),
      calendarDate: new Date('2026-08-21T00:00:00Z'),
    });
    const moved = canonicalEventFingerprint({
      chamber: 'house',
      committeeSystemCode: 'HSAS00',
      title: 'Oversight — Autonomous Systems',
      startsAt: new Date('2026-08-21T15:00:00Z'),
      calendarDate: new Date('2026-08-21T00:00:00Z'),
    });
    expect(second).toBe(first);
    expect(moved).not.toBe(first);
  });

  it('accepts a terminal capture only when it has an explicit reason code', () => {
    expect(
      assessCaptureOutcome({
        captureStatus: 'COMPLETE_WITH_GAPS',
        terminalReasonCode: 'CAPTURE_COMPLETE_WITH_GAPS',
        candidates: [],
      }),
    ).toEqual({ complete: true, reasonCode: 'CAPTURE_COMPLETE_WITH_GAPS' });
    expect(
      assessCaptureOutcome({
        captureStatus: 'COMPLETE',
        candidates: [],
      }),
    ).toEqual({ complete: false, reasonCode: 'TERMINAL_CAPTURE_WITHOUT_REASON' });
  });

  it('accepts an explicit browser/license/policy disposition without inventing a capture', () => {
    expect(
      assessCaptureOutcome({
        candidates: [
          {
            capturePolicy: 'BROWSER_CAPTURE_ONLY',
            resolutionState: 'POLICY_BLOCKED',
            failureReason: 'BROWSER_ONLY_PROVIDER',
          },
        ],
      }),
    ).toEqual({
      complete: true,
      reasonCode: 'EXPLICIT_NON_SERVER_CAPTURE_DISPOSITION',
    });
  });

  it('does not let review-required or unresolved candidates count as an outcome', () => {
    expect(
      assessCaptureOutcome({
        candidates: [
          {
            capturePolicy: 'REVIEW_REQUIRED',
            resolutionState: 'WAITING_FOR_STREAM',
          },
        ],
      }),
    ).toEqual({ complete: false, reasonCode: 'STREAM_POLICY_STILL_REQUIRES_REVIEW' });
  });

  it('requires enabled, scheduled, non-stale runtime heartbeats', () => {
    const now = new Date('2026-08-21T12:00:00Z');
    expect(
      isRuntimeJobFresh({
        enabled: true,
        scheduleEnabled: true,
        status: 'succeeded',
        maxLagSeconds: 300,
        lastHeartbeatAt: new Date('2026-08-21T11:58:00Z'),
        now,
      }),
    ).toBe(true);
    expect(
      isRuntimeJobFresh({
        enabled: false,
        scheduleEnabled: false,
        status: 'disabled',
        maxLagSeconds: 300,
        lastHeartbeatAt: null,
        now,
      }),
    ).toBe(false);
  });

  it('blocks zero-observation and NONE-evidence runs regardless of other gates', () => {
    const passingGate = {
      key: 'EXAMPLE',
      status: 'PASS' as const,
      required: true,
      measured: true,
      target: true,
      reasonCode: 'GATE_SATISFIED',
      message: 'ok',
    };
    expect(
      deriveRunStatus({
        mode: 'READINESS',
        evidenceSource: 'NONE',
        officialObservations: 10,
        canonicalEvents: 10,
        gates: [passingGate],
      }),
    ).toBe('BLOCKED');
    expect(
      deriveRunStatus({
        mode: 'READINESS',
        evidenceSource: 'OFFICIAL_ARCHIVE',
        officialObservations: 0,
        canonicalEvents: 10,
        gates: [passingGate],
      }),
    ).toBe('BLOCKED');
  });

  it('requires live or mixed evidence for production cutover', () => {
    expect(evidenceSourceSatisfiesCutover('LIVE')).toBe(true);
    expect(evidenceSourceSatisfiesCutover('MIXED')).toBe(true);
    expect(evidenceSourceSatisfiesCutover('OFFICIAL_ARCHIVE')).toBe(false);
    expect(requiredEvidenceTypes('CUTOVER_VERIFICATION')).toEqual(
      expect.arrayContaining(['LIVE_DEEPGRAM', 'ROLLBACK', 'TENANT_RLS']),
    );
  });
});
