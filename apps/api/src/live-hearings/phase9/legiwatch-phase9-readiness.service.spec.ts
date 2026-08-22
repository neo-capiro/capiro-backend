import { LegiWatchPhase9ReadinessService } from './legiwatch-phase9-readiness.service.js';
import {
  CORE_READINESS_EVIDENCE_TYPES,
  CUTOVER_EVIDENCE_TYPES,
} from './legiwatch-phase9-gates.js';
import { LEGIWATCH_PHASE9_REQUIRED_JOB_KEYS } from './legiwatch-phase9.types.js';

const NOW = new Date('2026-08-21T12:00:00Z');

function snapshot() {
  return {
    bodies: [
      {
        systemCode: 'hsas00',
        name: 'House Armed Services Committee',
        chamber: 'house',
        parentSystemCode: null,
      },
      {
        systemCode: 'hsas01',
        name: 'Cyber, Information Technologies, and Innovation',
        chamber: 'house',
        parentSystemCode: 'hsas00',
      },
    ],
    sources: [
      {
        id: 'source-1',
        committeeSystemCode: 'hsas00',
        chamber: 'house',
        sourceHealth: 'healthy',
        lastSuccessAt: new Date('2026-08-21T11:55:00Z'),
      },
    ],
    observations: [
      {
        id: '00000000-0000-0000-0000-000000000911',
        hearingId: 'hearing-1',
        bodyCode: 'hsas01',
        reconciliationStatus: 'RECONCILED',
        reconciliationReasonCode: 'CANONICAL_HEARING_LINKED',
        observedAt: new Date('2026-08-21T10:00:00Z'),
      },
    ],
    hearings: [
      {
        id: 'hearing-1',
        chamber: 'house',
        committeeSystemCode: 'hsas00',
        subcommitteeSystemCode: 'hsas01',
        title: 'Oversight of autonomous systems',
        eventStatus: 'completed',
        visibility: 'public',
        startsAt: new Date('2026-08-21T10:00:00Z'),
        calendarDate: new Date('2026-08-21T00:00:00Z'),
      },
    ],
    candidates: [
      {
        hearingId: 'hearing-1',
        capturePolicy: 'SERVER_CAPTURE_ALLOWED',
        resolutionState: 'READY',
        failureReason: null,
      },
    ],
    captures: [
      {
        id: 'capture-1',
        hearingId: 'hearing-1',
        domainStatus: 'COMPLETE',
        terminalReasonCode: 'CAPTURE_COMPLETE',
        failureCode: null,
        transcriptGapSeconds: 0,
        gapLedgerCount: 0,
      },
    ],
    demand: [{ hearingId: 'hearing-1', count: 2 }],
    transcript: [
      {
        hearingId: 'hearing-1',
        captureId: 'capture-1',
        segmentCount: 20,
        gapMarkers: 0,
      },
    ],
    duplicateSequences: [],
    runtime: LEGIWATCH_PHASE9_REQUIRED_JOB_KEYS.map((jobKey) => ({
      jobKey,
      jobType: jobKey,
      status: 'succeeded',
      enabled: true,
      scheduleEnabled: true,
      expectedIntervalSeconds: 300,
      maxLagSeconds: 900,
      lastStartedAt: new Date('2026-08-21T11:58:00Z'),
      lastHeartbeatAt: new Date('2026-08-21T11:59:00Z'),
      lastSuccessAt: new Date('2026-08-21T11:59:00Z'),
      lastFailureAt: null,
      lastFinishedAt: new Date('2026-08-21T11:59:00Z'),
      consecutiveFailures: 0,
      lastError: null,
      metrics: {},
    })),
    laggingJobs: [],
    evidence: CORE_READINESS_EVIDENCE_TYPES.map((evidenceType) => ({
      evidenceType,
      evidenceSource: 'LOCAL_FIXTURE',
      status: 'PASS',
      observedAt: new Date('2026-08-21T11:00:00Z'),
      expiresAt: new Date('2026-09-21T11:00:00Z'),
      hearingId: evidenceType === 'RECOVERY_GAP' ? 'hearing-1' : null,
      captureId: evidenceType === 'RECOVERY_GAP' ? 'capture-1' : null,
    })),
    captureAllPublicEvents: false,
  };
}

function serviceWith(snapshotValue: ReturnType<typeof snapshot>) {
  const service = new LegiWatchPhase9ReadinessService({} as never);
  (
    service as unknown as {
      loadSnapshot: () => Promise<ReturnType<typeof snapshot>>;
    }
  ).loadSnapshot = jest.fn(async () => snapshotValue);
  return service;
}

function gate(report: Awaited<ReturnType<LegiWatchPhase9ReadinessService['evaluate']>>, key: string) {
  const value = report.gates.find((item) => item.key === key);
  if (!value) throw new Error(`gate ${key} missing`);
  return value;
}

describe('LegiWatchPhase9ReadinessService', () => {
  it('passes the complete readiness contract with explicit real fixture evidence', async () => {
    const report = await serviceWith(snapshot()).evaluate({
      now: NOW,
      evidenceSource: 'LOCAL_FIXTURE',
      mode: 'READINESS',
    });
    expect(report.status).toBe('PASS');
    expect(report.counts).toMatchObject({
      parentBodies: 1,
      subcommitteeBodies: 1,
      totalBodies: 2,
      officialObservations: 1,
      representedObservations: 1,
      canonicalEvents: 1,
      canonicalEventsWithProvenance: 1,
      eligibleEvents: 1,
      eventsWithOutcomes: 1,
      duplicateCanonicalEvents: 0,
      duplicateGlobalCaptures: 0,
      staleJobs: 0,
      laggingIntelligenceJobs: 0,
    });
    expect(report.percentages).toEqual({
      bodyStatusExplicit: 100,
      observationDisposition: 100,
      canonicalProvenance: 100,
      captureOutcome: 100,
    });
    expect(report.summary).toMatchObject({
      sourceCoverageReady: true,
      officialCorpusRepresented: true,
      capturePathReady: true,
      transcriptContinuityReady: true,
      workersFresh: true,
      intelligenceFresh: true,
      cutoverEligible: false,
    });
    expect(report.blockers).toEqual([]);
  });

  it('blocks a zero-event audit instead of reporting full coverage', async () => {
    const value = snapshot();
    value.observations = [];
    value.hearings = [];
    value.candidates = [];
    value.captures = [];
    value.demand = [];
    value.transcript = [];
    const report = await serviceWith(value).evaluate({
      now: NOW,
      evidenceSource: 'OFFICIAL_ARCHIVE',
      mode: 'READINESS',
    });
    expect(report.status).toBe('BLOCKED');
    expect(report.counts.officialObservations).toBe(0);
    expect(report.percentages.observationDisposition).toBe(0);
    expect(gate(report, 'OFFICIAL_OBSERVATIONS_PRESENT')).toMatchObject({
      status: 'FAIL',
      reasonCode: 'ZERO_EVENT_EVIDENCE',
    });
    expect(report.bodies.every((body) => body.status === 'HEALTHY_NO_EVENTS_OBSERVED')).toBe(true);
  });

  it('fails when an official observation remains pending', async () => {
    const value = snapshot();
    value.observations[0] = {
      ...value.observations[0]!,
      hearingId: null,
      reconciliationStatus: 'PENDING',
      reconciliationReasonCode: null,
    };
    const report = await serviceWith(value).evaluate({
      now: NOW,
      evidenceSource: 'LOCAL_FIXTURE',
      mode: 'READINESS',
    });
    expect(report.status).toBe('FAIL');
    expect(report.counts.pendingObservations).toBe(1);
    expect(gate(report, 'OFFICIAL_OBSERVATIONS_DISPOSITIONED').status).toBe('FAIL');
    expect(report.exceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observationId: value.observations[0]?.id,
          reasonCode: 'OFFICIAL_OBSERVATION_PENDING',
        }),
      ]),
    );
  });

  it('detects canonical events that bypass the observation ledger', async () => {
    const value = snapshot();
    value.observations = [];
    const report = await serviceWith(value).evaluate({
      now: NOW,
      evidenceSource: 'LOCAL_FIXTURE',
      mode: 'READINESS',
    });
    expect(report.counts.legacyOnlyCanonicalEvents).toBe(1);
    expect(gate(report, 'CANONICAL_PROVENANCE')).toMatchObject({
      status: 'FAIL',
      reasonCode: 'CANONICAL_EVENTS_MISSING_PROVENANCE',
    });
  });

  it('detects duplicate canonical fingerprints and duplicate global captures', async () => {
    const value = snapshot();
    value.hearings.push({ ...value.hearings[0]!, id: 'hearing-duplicate' });
    value.captures.push({ ...value.captures[0]!, id: 'capture-duplicate' });
    const report = await serviceWith(value).evaluate({
      now: NOW,
      evidenceSource: 'LOCAL_FIXTURE',
      mode: 'READINESS',
    });
    expect(report.counts.duplicateCanonicalEvents).toBe(1);
    expect(report.counts.duplicateGlobalCaptures).toBe(1);
    expect(gate(report, 'NO_DUPLICATE_CANONICAL_EVENTS').status).toBe('FAIL');
    expect(gate(report, 'ONE_GLOBAL_CAPTURE').status).toBe('FAIL');
  });

  it('requires an explicit terminal outcome for every eligible due hearing', async () => {
    const value = snapshot();
    value.captures[0] = {
      ...value.captures[0]!,
      domainStatus: 'CAPTURING',
      terminalReasonCode: null,
    };
    const report = await serviceWith(value).evaluate({
      now: NOW,
      evidenceSource: 'LOCAL_FIXTURE',
      mode: 'READINESS',
    });
    expect(report.counts.eligibleEvents).toBe(1);
    expect(report.counts.eventsWithOutcomes).toBe(0);
    expect(gate(report, 'CAPTURE_OUTCOMES_EXPLICIT')).toMatchObject({
      status: 'FAIL',
      reasonCode: 'ELIGIBLE_CAPTURE_OUTCOME_INCOMPLETE',
    });
  });

  it('requires a durable ledger or transcript marker for every reported gap', async () => {
    const value = snapshot();
    value.captures[0] = {
      ...value.captures[0]!,
      domainStatus: 'COMPLETE_WITH_GAPS',
      terminalReasonCode: 'CAPTURE_COMPLETE_WITH_GAPS',
      transcriptGapSeconds: 12,
      gapLedgerCount: 0,
    };
    value.transcript[0] = { ...value.transcript[0]!, gapMarkers: 0 };
    const report = await serviceWith(value).evaluate({
      now: NOW,
      evidenceSource: 'LOCAL_FIXTURE',
      mode: 'READINESS',
    });
    expect(report.counts.gapsWithoutMarkers).toBe(1);
    expect(gate(report, 'GAP_MARKERS_DURABLE').status).toBe('FAIL');
  });

  it('rejects duplicate transcript sequence numbers in one canonical timeline', async () => {
    const value = snapshot();
    value.duplicateSequences = [
      {
        hearingId: 'hearing-1',
        captureId: 'capture-1',
        sequence: 7,
        count: 2,
      },
    ];
    const report = await serviceWith(value).evaluate({
      now: NOW,
      evidenceSource: 'LOCAL_FIXTURE',
      mode: 'READINESS',
    });
    expect(report.counts.duplicateTranscriptSequences).toBe(1);
    expect(gate(report, 'ONE_TRANSCRIPT_TIMELINE').status).toBe('FAIL');
  });

  it('fails stale worker and intelligence-latency gates independently', async () => {
    const value = snapshot();
    value.runtime[0] = {
      ...value.runtime[0]!,
      lastHeartbeatAt: new Date('2026-08-21T10:00:00Z'),
    };
    value.laggingJobs = [
      { queue: 'public', hearingId: 'hearing-1', status: 'failed', count: 2 },
    ];
    const report = await serviceWith(value).evaluate({
      now: NOW,
      evidenceSource: 'LOCAL_FIXTURE',
      mode: 'READINESS',
    });
    expect(report.counts.staleJobs).toBe(1);
    expect(report.counts.laggingIntelligenceJobs).toBe(2);
    expect(gate(report, 'JOB_FRESHNESS').status).toBe('FAIL');
    expect(gate(report, 'INTELLIGENCE_LATENCY').status).toBe('FAIL');
  });

  it('requires the complete live chaos/e2e evidence matrix for CUTOVER', async () => {
    const value = snapshot();
    value.evidence = CUTOVER_EVIDENCE_TYPES.map((evidenceType) => ({
      evidenceType,
      evidenceSource: evidenceType.startsWith('LIVE_') ? 'LIVE' : 'MIXED',
      status: 'PASS',
      observedAt: new Date('2026-08-21T11:00:00Z'),
      expiresAt: new Date('2026-09-21T11:00:00Z'),
      hearingId: evidenceType.startsWith('LIVE_') ? 'hearing-1' : null,
      captureId: evidenceType.startsWith('LIVE_') ? 'capture-1' : null,
    }));
    const report = await serviceWith(value).evaluate({
      now: NOW,
      evidenceSource: 'MIXED',
      mode: 'CUTOVER_VERIFICATION',
    });
    expect(report.status).toBe('PASS');
    expect(report.summary.cutoverEligible).toBe(true);
    expect(
      CUTOVER_EVIDENCE_TYPES.every(
        (evidenceType) => gate(report, `EVIDENCE_${evidenceType}`).status === 'PASS',
      ),
    ).toBe(true);
  });

  it('will not accept archive-only evidence for a live cutover proof', async () => {
    const value = snapshot();
    value.evidence = CUTOVER_EVIDENCE_TYPES.map((evidenceType) => ({
      evidenceType,
      evidenceSource: 'OFFICIAL_ARCHIVE',
      status: 'PASS',
      observedAt: new Date('2026-08-21T11:00:00Z'),
      expiresAt: new Date('2026-09-21T11:00:00Z'),
      hearingId: 'hearing-1',
      captureId: 'capture-1',
    }));
    const report = await serviceWith(value).evaluate({
      now: NOW,
      evidenceSource: 'OFFICIAL_ARCHIVE',
      mode: 'CUTOVER_VERIFICATION',
    });
    expect(report.status).toBe('FAIL');
    expect(gate(report, 'LIVE_CUTOVER_EVIDENCE_SOURCE').status).toBe('FAIL');
    expect(gate(report, 'EVIDENCE_LIVE_DEEPGRAM').status).toBe('FAIL');
  });
});
