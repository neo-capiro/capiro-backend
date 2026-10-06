import { LegiWatchPhase9ReadinessService } from './legiwatch-phase9-readiness.service.js';
import {
  CORE_READINESS_EVIDENCE_TYPES,
  CUTOVER_EVIDENCE_TYPES,
} from './legiwatch-phase9-gates.js';
import { LEGIWATCH_PHASE9_REQUIRED_JOB_KEYS } from './legiwatch-phase9.types.js';

const NOW = new Date('2026-08-21T12:00:00Z');

/** Deliberately mutable SQL-row fixture used to inject failure cases. */
function snapshot(): any {
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
    dispositions: [],
    captureAllPublicEvents: false,
  };
}

function serviceWith(snapshotValue: any) {
  const service = new LegiWatchPhase9ReadinessService({} as never);
  (service as any).loadSnapshot = jest.fn(async () => snapshotValue);
  return service;
}

function findGate(
  report: Awaited<ReturnType<LegiWatchPhase9ReadinessService['evaluate']>>,
  key: string,
) {
  const value = report.gates.find((item) => item.key === key);
  if (!value) throw new Error(`gate ${key} missing`);
  return value;
}

async function evaluate(value: any, mode: 'READINESS' | 'CUTOVER_VERIFICATION' = 'READINESS', evidenceSource: 'LOCAL_FIXTURE' | 'OFFICIAL_ARCHIVE' | 'MIXED' = 'LOCAL_FIXTURE') {
  return serviceWith(value).evaluate({ now: NOW, evidenceSource, mode });
}

describe('LegiWatchPhase9ReadinessService', () => {
  it('audits federal provenance without counting linked or pending Florida ledger rows', async () => {
    const mixed = snapshot();
    mixed.observations[0].jurisdiction = 'US';
    mixed.observations.push(
      {
        ...mixed.observations[0],
        id: 'fl-linked',
        jurisdiction: 'FL',
        hearingId: 'state-fl-linked',
        bodyCode: null,
      },
      {
        ...mixed.observations[0],
        id: 'fl-pending',
        jurisdiction: 'FL',
        hearingId: null,
        bodyCode: null,
        reconciliationStatus: 'PENDING',
      },
    );
    const report = await evaluate(mixed);
    expect(report.status).toBe('PASS');
    expect(report.counts).toMatchObject({
      officialObservations: 1,
      representedObservations: 1,
      pendingObservations: 0,
      canonicalEventsWithObservation: 1,
    });
    expect(report.exceptions.some((row) => row.observationId?.startsWith('fl-'))).toBe(false);
    expect(mixed.observations).toHaveLength(3);

    // Unknown/federal pending records remain visible: scope must not hide a
    // genuine missing federal identity while removing state-only false alarms.
    mixed.observations.push({
      ...mixed.observations[0],
      id: 'us-pending',
      jurisdiction: 'US',
      hearingId: null,
      bodyCode: null,
      reconciliationStatus: 'PENDING',
    });
    const pending = await evaluate(mixed);
    expect(pending.counts).toMatchObject({ officialObservations: 2, pendingObservations: 1 });
    expect(pending.exceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observationId: 'us-pending',
          reasonCode: 'OFFICIAL_OBSERVATION_PENDING',
        }),
      ]),
    );
  });

  it('cannot use a healthy Florida central source to cover a failed federal source', async () => {
    const mixed = snapshot();
    mixed.sources[0].committeeSystemCode = null;
    mixed.sources[0].jurisdiction = 'US';
    mixed.sources[0].sourceHealth = 'failing';
    mixed.sources.push({
      ...mixed.sources[0],
      id: 'florida-central',
      jurisdiction: 'FL',
      sourceHealth: 'healthy',
    });
    const report = await evaluate(mixed);
    expect(findGate(report, 'SOURCE_COVERAGE_READY').status).toBe('FAIL');
    expect(
      report.bodies.every((body) => body.sourcesRegistered === 1 && body.sourcesHealthy === 0),
    ).toBe(true);
  });

  it('passes the complete readiness contract with explicit fixture evidence', async () => {
    const report = await evaluate(snapshot());
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
    expect(report.blockers).toEqual([]);
  });

  it('a due public hearing with a canonical no_public_stream disposition and no candidate/capture does not fail STREAM_PATH_EXPLICIT', async () => {
    // Mirrors the DeBergalis-shaped case: a completed public hearing with
    // zero hearing_stream_candidate rows, zero public_hearing_capture rows,
    // and zero capture demand, but a canonical hearing-level disposition
    // already persisted via the demand-free disposition path (or the
    // automatic resolver during normal capture flow).
    const value = snapshot();
    value.hearings = [
      {
        id: 'hearing-no-stream',
        chamber: 'house',
        committeeSystemCode: 'hsas00',
        subcommitteeSystemCode: 'hsas01',
        title: 'Joint Deposition With No Public Broadcast',
        eventStatus: 'completed',
        visibility: 'public',
        startsAt: new Date('2026-08-20T10:00:00Z'),
        calendarDate: new Date('2026-08-20T00:00:00Z'),
        coverageStatus: 'no_public_stream',
      },
    ];
    value.candidates = [];
    value.captures = [];
    value.demand = [];
    value.transcript = [];
    value.observations = [
      {
        id: '00000000-0000-0000-0000-000000000912',
        hearingId: 'hearing-no-stream',
        bodyCode: 'hsas01',
        reconciliationStatus: 'RECONCILED',
        reconciliationReasonCode: 'CANONICAL_HEARING_LINKED',
        observedAt: new Date('2026-08-20T09:00:00Z'),
      },
    ];

    const report = await evaluate(value);
    expect(report.counts.unresolvedEvents).toBe(0);
    const gate = findGate(report, 'STREAM_PATH_EXPLICIT');
    expect(gate.status).toBe('PASS');
    expect(
      report.blockers.some((blocker) => blocker.startsWith('STREAM_PATH_EXPLICIT')),
    ).toBe(false);
  });

  it('a due public hearing with NO candidate/capture and a NON-terminal coverageStatus still correctly fails STREAM_PATH_EXPLICIT', async () => {
    // Guards against the fix being too permissive: a hearing that's merely
    // 'not_covered' or 'discovered' (i.e. genuinely still unresolved) must
    // keep failing the gate — only a TERMINAL disposition should satisfy it.
    const value = snapshot();
    value.hearings = [
      {
        id: 'hearing-truly-unresolved',
        chamber: 'house',
        committeeSystemCode: 'hsas00',
        subcommitteeSystemCode: 'hsas01',
        title: 'Still Genuinely Unresolved',
        eventStatus: 'completed',
        visibility: 'public',
        startsAt: new Date('2026-08-20T10:00:00Z'),
        calendarDate: new Date('2026-08-20T00:00:00Z'),
        coverageStatus: 'not_covered',
      },
    ];
    value.candidates = [];
    value.captures = [];
    value.demand = [];
    value.transcript = [];
    value.observations = [
      {
        id: '00000000-0000-0000-0000-000000000913',
        hearingId: 'hearing-truly-unresolved',
        bodyCode: 'hsas01',
        reconciliationStatus: 'RECONCILED',
        reconciliationReasonCode: 'CANONICAL_HEARING_LINKED',
        observedAt: new Date('2026-08-20T09:00:00Z'),
      },
    ];

    const report = await evaluate(value);
    expect(report.counts.unresolvedEvents).toBe(1);
    const gate = findGate(report, 'STREAM_PATH_EXPLICIT');
    expect(gate.status).toBe('FAIL');
  });

  it('historical completed SERVER_CAPTURE_ALLOWED with demand=0 and captureAll=false is NOT in the capture-outcome denominator', async () => {
    // Semantic alignment: preflight only plans captures for captureAll || demand>0.
    // A READY first-party candidate on a completed historical hearing (found by
    // the disposition backfill) proves technical capturability, not authorization.
    const value = snapshot();
    value.hearings = [
      {
        id: 'hearing-hist-ready',
        chamber: 'house',
        committeeSystemCode: 'hsas00',
        subcommitteeSystemCode: 'hsas01',
        title: 'Historical Hearing With Backfilled READY Candidate',
        eventStatus: 'completed',
        visibility: 'public',
        startsAt: new Date('2026-07-14T14:00:00Z'),
        calendarDate: new Date('2026-07-14T00:00:00Z'),
      },
    ];
    value.candidates = [
      {
        hearingId: 'hearing-hist-ready',
        capturePolicy: 'SERVER_CAPTURE_ALLOWED',
        resolutionState: 'READY',
        failureReason: null,
      },
    ];
    value.captures = [];
    value.demand = [];
    value.transcript = [];
    // Keep provenance healthy so only the eligibility semantics are under test.
    value.observations = [
      {
        id: '00000000-0000-0000-0000-000000000914',
        hearingId: 'hearing-hist-ready',
        bodyCode: 'hsas01',
        reconciliationStatus: 'RECONCILED',
        reconciliationReasonCode: 'CANONICAL_HEARING_LINKED',
        observedAt: new Date('2026-08-20T09:00:00Z'),
      },
    ];

    const report = await evaluate(value);
    expect(report.counts.duePublicEvents).toBe(1);
    expect(report.counts.eligibleEvents).toBe(0);
    expect(report.counts.eventsWithOutcomes).toBe(0);
    expect(report.counts.unresolvedEvents).toBe(0);
    // STREAM_PATH_EXPLICIT still satisfied by the READY candidate row.
    expect(findGate(report, 'STREAM_PATH_EXPLICIT').status).toBe('PASS');
  });

  it('a SERVER_CAPTURE_ALLOWED candidate WITH demand>0 stays eligible and requires a terminal outcome', async () => {
    const value = snapshot();
    value.captures = [];
    value.transcript = [];
    // Base snapshot already has demand=2 and a SERVER_CAPTURE_ALLOWED candidate.
    const report = await evaluate(value);
    expect(report.counts.eligibleEvents).toBe(1);
    expect(report.counts.eventsWithOutcomes).toBe(0);
    const gate = findGate(report, 'CAPTURE_OUTCOMES_EXPLICIT');
    expect(gate.status).toBe('FAIL');
    expect(gate.reasonCode).toBe('ELIGIBLE_CAPTURE_OUTCOME_INCOMPLETE');
  });

  it('captureAll=true makes even demandless historical candidates eligible', async () => {
    const value = snapshot();
    value.captureAllPublicEvents = true;
    value.captures = [];
    value.transcript = [];
    value.demand = [];
    const report = await evaluate(value);
    expect(report.counts.eligibleEvents).toBe(1);
    const gate = findGate(report, 'CAPTURE_OUTCOMES_EXPLICIT');
    expect(gate.status).toBe('FAIL');
  });

  it('an existing capture row keeps the event eligible regardless of demand', async () => {
    // Base snapshot: capture-1 COMPLETE with terminal reason; demand would be
    // removed to prove the capture row alone drives eligibility.
    const value = snapshot();
    value.demand = [];
    const report = await evaluate(value);
    expect(report.counts.eligibleEvents).toBe(1);
    expect(report.counts.eventsWithOutcomes).toBe(1);
    expect(findGate(report, 'CAPTURE_OUTCOMES_EXPLICIT').status).toBe('PASS');
  });

  it('duplicate and capture safety gates are unchanged by the eligibility alignment', async () => {
    const value = snapshot();
    // Same-shape hearing twice → duplicate fingerprint detection must stay on.
    // Terminal coverage on both keeps STREAM_PATH_EXPLICIT independently PASS,
    // proving the safety gates are unaffected by the eligibility change.
    value.hearings = [
      { ...value.hearings[0], id: 'hearing-dup-a', coverageStatus: 'no_public_stream' },
      { ...value.hearings[0], id: 'hearing-dup-b', coverageStatus: 'no_public_stream' },
    ];
    value.candidates = [];
    value.captures = [];
    value.demand = [];
    value.transcript = [];
    value.observations = value.hearings.map((h: any, i: number) => ({
      id: `00000000-0000-0000-0000-00000000092${i}`,
      hearingId: h.id,
      bodyCode: 'hsas01',
      reconciliationStatus: 'RECONCILED',
      reconciliationReasonCode: 'CANONICAL_HEARING_LINKED',
      observedAt: new Date('2026-08-20T09:00:00Z'),
    }));
    const report = await evaluate(value);
    // Counting convention: extras beyond the first row in each duplicate group.
    expect(report.counts.duplicateCanonicalEvents).toBe(1);
    expect(findGate(report, 'NO_DUPLICATE_CANONICAL_EVENTS').status).toBe('FAIL');
    expect(findGate(report, 'STREAM_PATH_EXPLICIT').status).toBe('PASS');
  });

  it('blocks zero-event audits rather than reporting full coverage', async () => {
    const value = snapshot();
    value.observations = [];
    value.hearings = [];
    value.captures = [];
    value.demand = [];
    value.transcript = [];
    const report = await evaluate(value, 'READINESS', 'OFFICIAL_ARCHIVE');
    expect(report.status).toBe('BLOCKED');
    expect(report.percentages.observationDisposition).toBe(0);
    expect(findGate(report, 'OFFICIAL_OBSERVATIONS_PRESENT')).toMatchObject({
      status: 'FAIL',
      reasonCode: 'ZERO_EVENT_EVIDENCE',
    });
    expect(
      report.bodies.every((body) => body.status === 'HEALTHY_NO_EVENTS_OBSERVED'),
    ).toBe(true);
  });

  it('fails pending observations and canonical records without provenance', async () => {
    const value = snapshot();
    value.observations[0] = {
      ...value.observations[0],
      hearingId: null,
      reconciliationStatus: 'PENDING',
      reconciliationReasonCode: null,
    };
    const report = await evaluate(value);
    expect(report.status).toBe('FAIL');
    expect(report.counts.pendingObservations).toBe(1);
    expect(findGate(report, 'OFFICIAL_OBSERVATIONS_DISPOSITIONED').status).toBe('FAIL');
    expect(findGate(report, 'CANONICAL_PROVENANCE').status).toBe('FAIL');
    expect(report.exceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reasonCode: 'OFFICIAL_OBSERVATION_PENDING' }),
        expect.objectContaining({
          reasonCode: 'CANONICAL_EVENT_WITHOUT_OFFICIAL_OBSERVATION',
        }),
      ]),
    );
  });

  it('detects duplicate canonical fingerprints and duplicate global captures', async () => {
    const value = snapshot();
    value.hearings.push({ ...value.hearings[0], id: 'hearing-duplicate' });
    value.captures.push({ ...value.captures[0], id: 'capture-duplicate' });
    const report = await evaluate(value);
    expect(report.counts.duplicateCanonicalEvents).toBe(1);
    expect(report.counts.duplicateGlobalCaptures).toBe(1);
    expect(findGate(report, 'NO_DUPLICATE_CANONICAL_EVENTS').status).toBe('FAIL');
    expect(findGate(report, 'ONE_GLOBAL_CAPTURE').status).toBe('FAIL');
  });

  it('requires an explicit terminal capture result and one transcript timeline', async () => {
    const value = snapshot();
    value.captures[0] = {
      ...value.captures[0],
      domainStatus: 'CAPTURING',
      terminalReasonCode: null,
    };
    value.duplicateSequences = [
      { hearingId: 'hearing-1', captureId: 'capture-1', sequence: 7, count: 2 },
    ];
    const report = await evaluate(value);
    expect(report.counts.eventsWithOutcomes).toBe(0);
    expect(findGate(report, 'CAPTURE_OUTCOMES_EXPLICIT').status).toBe('FAIL');
    expect(findGate(report, 'ONE_TRANSCRIPT_TIMELINE').status).toBe('FAIL');
  });

  it('requires a durable marker whenever capture gap time is recorded', async () => {
    const value = snapshot();
    value.captures[0] = {
      ...value.captures[0],
      domainStatus: 'COMPLETE_WITH_GAPS',
      terminalReasonCode: 'CAPTURE_COMPLETE_WITH_GAPS',
      transcriptGapSeconds: 12,
      gapLedgerCount: 0,
    };
    value.transcript[0] = { ...value.transcript[0], gapMarkers: 0 };
    const report = await evaluate(value);
    expect(report.counts.gapsWithoutMarkers).toBe(1);
    expect(findGate(report, 'GAP_MARKERS_DURABLE').status).toBe('FAIL');
  });

  it('fails stale workers and lagging intelligence independently', async () => {
    const value = snapshot();
    value.runtime[0] = {
      ...value.runtime[0],
      lastHeartbeatAt: new Date('2026-08-21T10:00:00Z'),
    };
    value.laggingJobs = [
      { queue: 'public', hearingId: 'hearing-1', status: 'failed', count: 2 },
    ];
    const report = await evaluate(value);
    expect(report.counts.staleJobs).toBe(1);
    expect(report.counts.laggingIntelligenceJobs).toBe(2);
    expect(findGate(report, 'JOB_FRESHNESS').status).toBe('FAIL');
    expect(findGate(report, 'INTELLIGENCE_LATENCY').status).toBe('FAIL');
  });

  it('requires the complete current live/chaos matrix for CUTOVER', async () => {
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
    const report = await evaluate(value, 'CUTOVER_VERIFICATION', 'MIXED');
    expect(report.status).toBe('PASS');
    expect(report.summary.cutoverEligible).toBe(true);
    expect(
      CUTOVER_EVIDENCE_TYPES.every(
        (type) => findGate(report, `EVIDENCE_${type}`).status === 'PASS',
      ),
    ).toBe(true);
  });

  it('rejects archive-only evidence for live cutover gates', async () => {
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
    const report = await evaluate(
      value,
      'CUTOVER_VERIFICATION',
      'OFFICIAL_ARCHIVE',
    );
    expect(report.status).toBe('FAIL');
    expect(findGate(report, 'LIVE_CUTOVER_EVIDENCE_SOURCE').status).toBe('FAIL');
    expect(findGate(report, 'EVIDENCE_LIVE_DEEPGRAM').status).toBe('FAIL');
  });

  describe('evaluateAndPersist transaction budget (production tx-timeout regression)', () => {
    // Regression coverage for the production defect: coverage-audit consistently
    // failed with Prisma "Transaction already closed" at ~5.3-5.9s because the
    // persistence transaction ran under Prisma's default 5000ms interactive-tx
    // budget. This suite proves (1) evaluate() runs BEFORE/outside withSystem,
    // (2) withSystem is called with an extended timeoutMs >= 30_000, and (3) the
    // three writes (run insert, exception audit rows, cutover-state update)
    // still happen inside that single transaction callback.

    function serviceWithMockPrisma(snapshotValue: any) {
      const callOrder: string[] = [];
      const executedStatements: string[] = [];
      let withSystemOpts: { timeoutMs?: number } | undefined;
      const runRow = {
        id: '00000000-0000-0000-0000-0000000000aa',
        mode: 'READINESS',
        status: 'PASS',
        evidenceSource: 'LOCAL_FIXTURE',
        createdAt: new Date('2026-08-21T12:00:00Z'),
      };

      const tx = {
        $queryRawUnsafe: jest.fn(async (sql: string) => {
          callOrder.push('tx.$queryRawUnsafe:insert_run');
          executedStatements.push(sql);
          return [runRow];
        }),
        $executeRawUnsafe: jest.fn(async (sql: string) => {
          if (sql.includes('legiwatch_event_audit')) {
            callOrder.push('tx.$executeRawUnsafe:event_audit');
          } else if (sql.includes('legiwatch_cutover_state')) {
            callOrder.push('tx.$executeRawUnsafe:cutover_state');
          }
          executedStatements.push(sql);
          return undefined;
        }),
      };

      const prisma = {
        withSystem: jest.fn(
          async (
            fn: (tx: unknown) => Promise<unknown>,
            opts?: { timeoutMs?: number },
          ) => {
            callOrder.push('withSystem:start');
            withSystemOpts = opts;
            const result = await fn(tx);
            callOrder.push('withSystem:end');
            return result;
          },
        ),
      };

      const service = new LegiWatchPhase9ReadinessService(prisma as never);
      const evaluateSpy = jest.spyOn(service, 'evaluate').mockImplementation(async () => {
        callOrder.push('evaluate');
        return serviceWith(snapshotValue).evaluate({
          now: NOW,
          evidenceSource: 'LOCAL_FIXTURE',
          mode: 'READINESS',
        });
      });

      return {
        service,
        prisma,
        tx,
        evaluateSpy,
        callOrder,
        executedStatements,
        getWithSystemOpts: () => withSystemOpts,
      };
    }

    it('runs evaluate() before/outside the persistence transaction', async () => {
      const harness = serviceWithMockPrisma(snapshot());
      await harness.service.evaluateAndPersist('test-actor', {
        now: NOW,
        evidenceSource: 'LOCAL_FIXTURE',
      });

      const evaluateIdx = harness.callOrder.indexOf('evaluate');
      const withSystemStartIdx = harness.callOrder.indexOf('withSystem:start');
      expect(evaluateIdx).toBeGreaterThanOrEqual(0);
      expect(withSystemStartIdx).toBeGreaterThan(evaluateIdx);
      // evaluate() must complete (be called) strictly before withSystem opens
      // its transaction — it is not nested inside the tx callback.
      expect(harness.evaluateSpy).toHaveBeenCalledTimes(1);
    });

    it('passes withSystem a timeoutMs budget of at least 30 seconds', async () => {
      const harness = serviceWithMockPrisma(snapshot());
      await harness.service.evaluateAndPersist('test-actor', {
        now: NOW,
        evidenceSource: 'LOCAL_FIXTURE',
      });

      expect(harness.prisma.withSystem).toHaveBeenCalledTimes(1);
      const opts = harness.getWithSystemOpts();
      expect(opts).toBeDefined();
      expect(opts?.timeoutMs).toBeGreaterThanOrEqual(30_000);
    });

    it('executes the run insert, exception audit rows, and cutover-state update atomically inside one withSystem callback', async () => {
      const value = snapshot();
      // Force a pending/failing observation so at least one exception row is
      // generated, exercising the multi-insert exception-audit path.
      value.observations[0] = {
        ...value.observations[0],
        hearingId: null,
        reconciliationStatus: 'PENDING',
        reconciliationReasonCode: null,
      };
      const harness = serviceWithMockPrisma(value);
      const { run } = await harness.service.evaluateAndPersist('test-actor', {
        now: NOW,
        evidenceSource: 'LOCAL_FIXTURE',
      });

      expect(run.id).toBe('00000000-0000-0000-0000-0000000000aa');
      // All three writes happened, and in the required order, inside the same
      // withSystem transaction (between its start and end markers).
      const startIdx = harness.callOrder.indexOf('withSystem:start');
      const endIdx = harness.callOrder.indexOf('withSystem:end');
      const insertIdx = harness.callOrder.indexOf('tx.$queryRawUnsafe:insert_run');
      const auditIdx = harness.callOrder.indexOf('tx.$executeRawUnsafe:event_audit');
      const stateIdx = harness.callOrder.indexOf('tx.$executeRawUnsafe:cutover_state');

      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(insertIdx).toBeGreaterThan(startIdx);
      expect(auditIdx).toBeGreaterThan(insertIdx);
      expect(stateIdx).toBeGreaterThan(auditIdx);
      expect(endIdx).toBeGreaterThan(stateIdx);

      // At least one exception-audit insert happened (multi-insert exercised).
      expect(harness.tx.$executeRawUnsafe.mock.calls.filter(([sql]: [string]) =>
        sql.includes('legiwatch_event_audit'),
      ).length).toBeGreaterThanOrEqual(1);
    });
  });
});
