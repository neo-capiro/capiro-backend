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

  it('blocks zero-event audits rather than reporting full coverage', async () => {
    const value = snapshot();
    value.observations = [];
    value.hearings = [];
    value.candidates = [];
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
