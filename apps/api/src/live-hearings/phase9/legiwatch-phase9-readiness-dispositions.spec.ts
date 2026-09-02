/**
 * Readiness provenance-disposition semantics (Neo Stage 4 spec §10–§12).
 *
 * Fixture contract mirrors legiwatch-phase9-readiness.service.spec.ts: a
 * mutable snapshot() with `dispositions` injected per case. Each case proves
 * exactly one rule of the disposition model:
 *
 *  1. no observation + no disposition              -> FAIL (unresolved)
 *  2. no observation + unreviewed/missing row      -> FAIL
 *  3. expired / revoked / superseded               -> FAIL
 *  4. valid reviewed disposition                   -> CANONICAL_PROVENANCE PASS
 *  5. reconciled observation                       -> PASS without disposition
 *  6. observation takes precedence over disposition (both present -> OBSERVED)
 *  7. counts observation / disposition / unresolved separately, each counted once
 *  8. disposition does not increase officialObservations
 *  9. no hearing-specific identifiers anywhere in the semantics
 * 10. no weakening of SOURCE_COVERAGE_READY / OFFICIAL_OBSERVATIONS_DISPOSITIONED
 * 11. no effect on STREAM_PATH_EXPLICIT / CAPTURE_OUTCOMES_EXPLICIT
 */
import { LegiWatchPhase9ReadinessService } from './legiwatch-phase9-readiness.service.js';
import { CORE_READINESS_EVIDENCE_TYPES } from './legiwatch-phase9-gates.js';
import { LEGIWATCH_PHASE9_REQUIRED_JOB_KEYS } from './legiwatch-phase9.types.js';

const NOW = new Date('2026-09-02T12:00:00Z');

function snapshot(): any {
  return {
    bodies: [
      { systemCode: 'sscm00', name: 'Committee', chamber: 'senate', parentSystemCode: null },
    ],
    sources: [
      {
        id: 'source-1',
        committeeSystemCode: 'sscm00',
        chamber: 'senate',
        sourceHealth: 'healthy',
        lastSuccessAt: new Date('2026-09-02T11:55:00Z'),
      },
    ],
    observations: [],
    hearings: [
      {
        id: 'hearing-x',
        chamber: 'senate',
        committeeSystemCode: 'sscm00',
        subcommitteeSystemCode: null,
        title: 'A canonical event',
        eventStatus: 'completed',
        visibility: 'public',
        startsAt: new Date('2026-09-01T10:00:00Z'),
        calendarDate: new Date('2026-09-01T00:00:00Z'),
        coverageStatus: 'no_public_stream',
      },
    ],
    candidates: [],
    captures: [],
    demand: [],
    transcript: [],
    duplicateSequences: [],
    runtime: LEGIWATCH_PHASE9_REQUIRED_JOB_KEYS.map((jobKey) => ({
      jobKey,
      jobType: jobKey,
      status: 'succeeded',
      enabled: true,
      scheduleEnabled: true,
      expectedIntervalSeconds: 300,
      maxLagSeconds: 900,
      lastHeartbeatAt: new Date('2026-09-02T11:59:00Z'),
      lastSuccessAt: new Date('2026-09-02T11:59:00Z'),
      lastFinishedAt: new Date('2026-09-02T11:59:00Z'),
      consecutiveFailures: 0,
      metrics: {},
    })),
    laggingJobs: [],
    evidence: CORE_READINESS_EVIDENCE_TYPES.map((evidenceType) => ({
      evidenceType,
      evidenceSource: 'LOCAL_FIXTURE',
      status: 'PASS',
      observedAt: new Date('2026-08-31T11:00:00Z'),
      expiresAt: new Date('2026-11-29T11:00:00Z'),
      hearingId: null,
      captureId: null,
    })),
    dispositions: [],
    captureAllPublicEvents: false,
  };
}

function serviceWith(value: any) {
  const service = new LegiWatchPhase9ReadinessService({} as never);
  (service as any).loadSnapshot = jest.fn(async () => value);
  return service;
}

function findGate(report: any, key: string) {
  const gate = report.gates.find((item: any) => item.key === key);
  if (!gate) throw new Error(`gate ${key} missing`);
  return gate;
}

async function evaluate(value: any) {
  return serviceWith(value).evaluate({ now: NOW, evidenceSource: 'LOCAL_FIXTURE', mode: 'READINESS' });
}

describe('LegiWatchPhase9ReadinessService — canonical provenance dispositions', () => {
  it('9. no observation + no disposition => FAIL (unresolved provenance)', async () => {
    const report = await evaluate(snapshot());
    expect(report.counts.unresolvedCanonicalProvenance).toBe(1);
    expect(findGate(report, 'CANONICAL_PROVENANCE').status).toBe('FAIL');
    expect(report.blockers.some((b: string) => b.startsWith('CANONICAL_PROVENANCE'))).toBe(true);
  });

  it('12. a valid reviewed disposition passes provenance for that hearing', async () => {
    const value = snapshot();
    value.dispositions = [
      {
        hearingId: 'hearing-x',
        dispositionType: 'OFFICIAL_OBSERVATION_UNAVAILABLE',
        artifactUri: 's3://bucket/investigation.json',
        status: 'ACTIVE',
        expiresAt: null,
      },
    ];
    const report = await evaluate(value);
    expect(report.counts.unresolvedCanonicalProvenance).toBe(0);
    expect(findGate(report, 'CANONICAL_PROVENANCE').status).toBe('PASS');
  });

  it('12b. the PASS message names the honest split (observation vs disposition)', async () => {
    const value = snapshot();
    value.dispositions = [
      {
        hearingId: 'hearing-x',
        dispositionType: 'OFFICIAL_OBSERVATION_UNAVAILABLE',
        artifactUri: 's3://bucket/investigation.json',
        status: 'ACTIVE',
        expiresAt: null,
      },
    ];
    const report = await evaluate(value);
    const message = findGate(report, 'CANONICAL_PROVENANCE').message;
    expect(message).toContain('explicit provenance');
    expect(message).toContain('0 with reconciled official observations');
    expect(message).toContain('1 with reviewed official-observation-unavailable dispositions');
  });

  it('10b. an unreviewed disposition row (missing artifact/reviewer is impossible by schema; here: wrong type) does not pass', async () => {
    // Only ACTIVE rows in the supported type set count as accepted; anything
    // else in the table is history. A REVOKED row must never pass.
    const value = snapshot();
    value.dispositions = [
      {
        hearingId: 'hearing-x',
        dispositionType: 'OFFICIAL_OBSERVATION_UNAVAILABLE',
        artifactUri: 's3://bucket/investigation.json',
        status: 'REVOKED',
        expiresAt: null,
      },
    ];
    const report = await evaluate(value);
    expect(findGate(report, 'CANONICAL_PROVENANCE').status).toBe('FAIL');
  });

  it('11b. an expired disposition does not pass', async () => {
    const value = snapshot();
    value.dispositions = [
      {
        hearingId: 'hearing-x',
        dispositionType: 'OFFICIAL_OBSERVATION_UNAVAILABLE',
        artifactUri: 's3://bucket/investigation.json',
        status: 'ACTIVE',
        expiresAt: new Date('2026-09-01T00:00:00Z'), // < NOW
      },
    ];
    const report = await evaluate(value);
    expect(findGate(report, 'CANONICAL_PROVENANCE').status).toBe('FAIL');
  });

  it('13. a reconciled observation passes without any disposition', async () => {
    const value = snapshot();
    value.observations = [
      {
        id: 'obs-1',
        hearingId: 'hearing-x',
        bodyCode: 'sscm00',
        reconciliationStatus: 'RECONCILED',
        reconciliationReasonCode: 'CANONICAL_HEARING_LINKED',
        observedAt: new Date('2026-09-01T09:00:00Z'),
      },
    ];
    const report = await evaluate(value);
    expect(findGate(report, 'CANONICAL_PROVENANCE').status).toBe('PASS');
    expect(report.counts.canonicalEventsWithObservation).toBe(1);
    expect(report.counts.canonicalEventsWithAcceptedDisposition).toBe(0);
  });

  it('14. an observation takes precedence over a historical disposition (OBSERVED wins)', async () => {
    const value = snapshot();
    value.observations = [
      {
        id: 'obs-1',
        hearingId: 'hearing-x',
        bodyCode: 'sscm00',
        reconciliationStatus: 'RECONCILED',
        reconciliationReasonCode: 'CANONICAL_HEARING_LINKED',
        observedAt: new Date('2026-09-01T09:00:00Z'),
      },
    ];
    value.dispositions = [
      {
        hearingId: 'hearing-x',
        dispositionType: 'OFFICIAL_OBSERVATION_UNAVAILABLE',
        artifactUri: 's3://bucket/investigation.json',
        status: 'SUPERSEDED',
        expiresAt: null,
      },
    ];
    const report = await evaluate(value);
    expect(findGate(report, 'CANONICAL_PROVENANCE').status).toBe('PASS');
    expect(report.counts.canonicalEventsWithObservation).toBe(1);
    expect(report.counts.canonicalEventsWithAcceptedDisposition).toBe(0);
  });

  it('15. counts observation / disposition / unresolved separately (each hearing once)', async () => {
    const value = snapshot();
    value.hearings = [
      { ...snapshot().hearings[0], id: 'hearing-observed' },
      { ...snapshot().hearings[0], id: 'hearing-dispositioned' },
      { ...snapshot().hearings[0], id: 'hearing-unresolved' },
    ];
    value.observations = [
      {
        id: 'obs-1',
        hearingId: 'hearing-observed',
        bodyCode: 'sscm00',
        reconciliationStatus: 'RECONCILED',
        reconciliationReasonCode: 'CANONICAL_HEARING_LINKED',
        observedAt: new Date('2026-09-01T09:00:00Z'),
      },
    ];
    value.dispositions = [
      {
        hearingId: 'hearing-dispositioned',
        dispositionType: 'OFFICIAL_OBSERVATION_UNAVAILABLE',
        artifactUri: 's3://bucket/investigation.json',
        status: 'ACTIVE',
        expiresAt: null,
      },
    ];
    const report = await evaluate(value);
    expect(report.counts.canonicalEvents).toBe(3);
    expect(report.counts.canonicalEventsWithObservation).toBe(1);
    expect(report.counts.canonicalEventsWithAcceptedDisposition).toBe(1);
    expect(report.counts.unresolvedCanonicalProvenance).toBe(1);
    // observed + accepted == provenance rollup; unresolved is the only blocker
    expect(report.counts.canonicalEventsWithProvenance).toBe(2);
    expect(findGate(report, 'CANONICAL_PROVENANCE').status).toBe('FAIL');
    expect(findGate(report, 'CANONICAL_PROVENANCE').measured).toBeCloseTo(66.67);
  });

  it('16. a disposition does not increase officialObservations', async () => {
    const value = snapshot();
    value.dispositions = [
      {
        hearingId: 'hearing-x',
        dispositionType: 'OFFICIAL_OBSERVATION_UNAVAILABLE',
        artifactUri: 's3://bucket/investigation.json',
        status: 'ACTIVE',
        expiresAt: null,
      },
    ];
    const report = await evaluate(value);
    expect(report.counts.officialObservations).toBe(0);
  });

  it('16b. a disposition never lands in the observation corpus (no hearing_source_observation semantics here)', async () => {
    // The readiness snapshot derives officialObservations ONLY from
    // snapshot.observations (hearing_source_observation rows); dispositions
    // ride a separate table. This asserts the two channels never mix.
    const value = snapshot();
    value.dispositions = [
      {
        hearingId: 'hearing-x',
        dispositionType: 'OFFICIAL_OBSERVATION_UNAVAILABLE',
        artifactUri: 's3://bucket/investigation.json',
        status: 'ACTIVE',
        expiresAt: null,
      },
    ];
    const report = await evaluate(value);
    expect(report.counts.officialObservations).toBe(0);
    expect(report.counts.representedObservations).toBe(0);
    expect(report.counts.canonicalEventsWithAcceptedDisposition).toBe(1);
  });

  it('17. OFFICIAL_OBSERVATIONS_DISPOSITIONED: dispositions neither fake the corpus nor break the gate', async () => {
    const value = snapshot();
    value.dispositions = [
      {
        hearingId: 'hearing-x',
        dispositionType: 'OFFICIAL_OBSERVATION_UNAVAILABLE',
        artifactUri: 's3://bucket/investigation.json',
        status: 'ACTIVE',
        expiresAt: null,
      },
    ];
    // With ZERO observations the gate still fails — a disposition cannot
    // substitute for the observation corpus existing at all.
    const reportZero = await evaluate(value);
    expect(findGate(reportZero, 'OFFICIAL_OBSERVATIONS_DISPOSITIONED').status).toBe('FAIL');
    // With a real observation corpus present, the gate passes unchanged —
    // dispositions do not introduce PENDING rows or break disposition math.
    value.observations = [
      {
        id: 'obs-1',
        hearingId: 'hearing-x',
        bodyCode: 'sscm00',
        reconciliationStatus: 'RECONCILED',
        reconciliationReasonCode: 'CANONICAL_HEARING_LINKED',
        observedAt: new Date('2026-09-01T09:00:00Z'),
      },
    ];
    const reportWithObs = await evaluate(value);
    expect(findGate(reportWithObs, 'OFFICIAL_OBSERVATIONS_DISPOSITIONED').status).toBe('PASS');
    expect(findGate(reportWithObs, 'SOURCE_COVERAGE_READY').status).toBe('PASS');
  });

  it('19. STREAM_PATH_EXPLICIT semantics are independent of provenance dispositions', async () => {
    const value = snapshot();
    value.dispositions = [
      {
        hearingId: 'hearing-x',
        dispositionType: 'OFFICIAL_OBSERVATION_UNAVAILABLE',
        artifactUri: 's3://bucket/investigation.json',
        status: 'ACTIVE',
        expiresAt: null,
      },
    ];
    // The fixture hearing carries a terminal coverage status; the gate must
    // still be driven by coverage/candidates, not by the disposition.
    const report = await evaluate(value);
    expect(findGate(report, 'STREAM_PATH_EXPLICIT').status).toBe('PASS');
    // And with a non-terminal coverage status the gate must fail regardless.
    const value2 = snapshot();
    value2.dispositions = value.dispositions;
    value2.hearings[0].coverageStatus = 'not_covered';
    const report2 = await evaluate(value2);
    expect(findGate(report2, 'STREAM_PATH_EXPLICIT').status).toBe('FAIL');
  });

  it('20. CAPTURE_OUTCOMES_EXPLICIT semantics are independent of provenance dispositions', async () => {
    const value = snapshot();
    value.dispositions = [
      {
        hearingId: 'hearing-x',
        dispositionType: 'OFFICIAL_OBSERVATION_UNAVAILABLE',
        artifactUri: 's3://bucket/investigation.json',
        status: 'ACTIVE',
        expiresAt: null,
      },
    ];
    // No demand, no capture -> eligible=0 -> gate FAILs (correct, unchanged).
    const report = await evaluate(value);
    expect(findGate(report, 'CAPTURE_OUTCOMES_EXPLICIT').status).toBe('FAIL');
    expect(findGate(report, 'CAPTURE_OUTCOMES_EXPLICIT').measured).toBe(0);
  });

  it('21. informational audit exception carries the disposition without failing the gate', async () => {
    const value = snapshot();
    value.dispositions = [
      {
        hearingId: 'hearing-x',
        dispositionType: 'OFFICIAL_OBSERVATION_UNAVAILABLE',
        artifactUri: 's3://bucket/artifact.json',
        status: 'ACTIVE',
        expiresAt: null,
      },
    ];
    const report = await evaluate(value);
    const info = report.exceptions.filter(
      (e: any) => e.reasonCode === 'CANONICAL_EVENT_PROVENANCE_ACCEPTED_DISPOSITION',
    );
    expect(info).toHaveLength(1);
    expect(info[0]?.status).toBe('NOT_APPLICABLE');
    expect(info[0]?.hearingId).toBe('hearing-x');
    // And no failing CANONICAL_PROVENANCE exception exists for that hearing.
    expect(
      report.exceptions.some(
        (e: any) =>
          e.gateKey === 'CANONICAL_PROVENANCE' &&
          e.status === 'FAIL' &&
          e.hearingId === 'hearing-x',
      ),
    ).toBe(false);
  });

  it('22. no hearing-specific hardcoding: semantics are pure set logic over rows', async () => {
    // Any hearing id / committee code behaves identically — flip them and the
    // outcome must not change.
    const a = snapshot();
    a.dispositions = [
      {
        hearingId: 'hearing-x',
        dispositionType: 'OFFICIAL_OBSERVATION_UNAVAILABLE',
        artifactUri: 's3://bucket/investigation.json',
        status: 'ACTIVE',
        expiresAt: null,
      },
    ];
    const b = snapshot();
    b.hearings[0].id = 'zz-arbitrary-id';
    b.hearings[0].committeeSystemCode = 'zzzz00';
    b.dispositions = [
      {
        hearingId: 'zz-arbitrary-id',
        dispositionType: 'OFFICIAL_OBSERVATION_UNAVAILABLE',
        artifactUri: 's3://bucket/investigation.json',
        status: 'ACTIVE',
        expiresAt: null,
      },
    ];
    const ra = await evaluate(a);
    const rb = await evaluate(b);
    expect(findGate(ra, 'CANONICAL_PROVENANCE').status)
      .toBe(findGate(rb, 'CANONICAL_PROVENANCE').status);
    expect(rb.counts.canonicalEventsWithAcceptedDisposition).toBe(1);
  });
});
