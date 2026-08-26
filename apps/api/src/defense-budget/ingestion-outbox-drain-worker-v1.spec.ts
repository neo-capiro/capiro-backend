import {
  drainIngestionOutboxBatchV1,
  drainReadinessPendingBatchV1,
} from './ingestion-outbox-drain-worker-v1.js';
import type {
  ObservationIngestionBridgeResult,
  ObservationIngestionBridgeStatus,
} from './observation-ingestion-bridge.service.js';

function bridge(
  status: ObservationIngestionBridgeStatus = 'ingested',
  success = true,
): ObservationIngestionBridgeResult {
  return {
    status,
    ingestionSucceeded: success,
    observationId: 'obs',
    sourceDocumentId: 'doc',
    reason: status,
    sourceDocumentBound: success,
    parserVerificationSucceeded: success,
    durableEvidencePersisted: success,
    parserHandoffInvoked: true,
    parserHandoffError: null,
    verifierDecision: success
      ? 'PASS'
      : status === 'review_required'
        ? 'REVIEW'
        : status === 'verification_rejected'
          ? 'REJECT'
          : null,
  };
}
function setup(
  input: {
    family?: any;
    track?: any;
    result?: ObservationIngestionBridgeResult;
    attempts?: number;
    readinessError?: Error;
    rows?: { id: string; observationId: string; attempts: number }[];
  } = {},
) {
  const calls: {
    succeeded: any[][];
    retry: any[];
    governed: any[];
    poison: any[];
    readiness: any[];
    readinessWrites: any[];
  } = { succeeded: [], retry: [], governed: [], poison: [], readiness: [], readinessWrites: [] };
  const rows = input.rows ?? [{ id: 'row', observationId: 'obs', attempts: input.attempts ?? 0 }];
  const repository: any = {
    claimBatch: async () => rows,
    claimReadinessPendingBatch: async () => rows,
    claimReadinessPendingRow: async () => true,
    markSucceeded: async (...a: any[]) => {
      calls.succeeded.push(a);
      return true;
    },
    markRetryableFailure: async (a: any) => {
      calls.retry.push(a);
      return true;
    },
    markGoverned: async (a: any) => {
      calls.governed.push(a);
      return true;
    },
    markDeadLetterPoison: async (a: any) => {
      calls.poison.push(a);
      return true;
    },
    markReadinessSucceeded: async (a: any) => {
      calls.readinessWrites.push(a);
      return true;
    },
    markReadinessRetryableFailure: async (a: any) => {
      calls.readinessWrites.push(a);
      return true;
    },
    markReadinessDeferredCommittee: async (a: any) => {
      calls.readinessWrites.push(a);
      return true;
    },
    markReadinessNotApplicable: async (a: any) => {
      calls.readinessWrites.push(a);
      return true;
    },
  };
  const ports: any = {
    repository,
    bridge: { bridge: async () => input.result ?? bridge() },
    loadObservationScope: async () => ({
      classifiedSourceFamily: input.family ?? 'pb_r1',
      authorityTrack: input.track ?? 'request',
      fiscalYear: 2027,
    }),
    invokeReadiness: async (scope: any) => {
      calls.readiness.push(scope);
      if (input.readinessError) throw input.readinessError;
      return { outcome: 'awaiting_authorization' };
    },
  };
  return { calls, ports, repository };
}
describe('ingestion outbox worker', () => {
  test.each([
    ['pb_r1', 'rdte'],
    ['pb_p1', 'procurement'],
    ['pb_o1', 'om'],
    ['pb_milcon_c1', 'milcon'],
  ] as const)('PASS %s invokes %s readiness', async (family, familyGroup) => {
    const { calls, ports } = setup({ family });
    const out = await drainIngestionOutboxBatchV1({ leaseOwner: 'w', now: new Date() }, ports);
    expect(calls.succeeded).toHaveLength(1);
    expect(calls.readiness).toEqual([{ fiscalYear: 2027, authorityTrack: 'request', familyGroup }]);
    expect(out.readinessInvoked).toBe(1);
  });
  test('committee succeeds but readiness is explicitly deferred', async () => {
    const { calls, ports } = setup({ family: 'auth_committee_mark', track: 'authorization' });
    const out = await drainIngestionOutboxBatchV1({ leaseOwner: 'w', now: new Date() }, ports);
    expect(calls.succeeded).toHaveLength(1);
    expect(calls.readiness).toHaveLength(0);
    expect(out.readiness_deferred_committee).toBe(1);
    expect(out.readinessSkippedNoScope).toBe(0);
  });
  test.each([
    ['alt_supplemental', 'alternative_funding'],
    ['exec_obligation', 'execution'],
  ] as const)('%s unsupported track has no scope', async (family, track) => {
    const { calls, ports } = setup({ family, track });
    const out = await drainIngestionOutboxBatchV1({ leaseOwner: 'w', now: new Date() }, ports);
    expect(calls.readiness).toHaveLength(0);
    expect(out.readinessSkippedNoScope).toBe(1);
    expect(out.readiness_deferred_committee).toBe(0);
  });
  test.each([
    ['review_required', 'governed_review', 'review_required'],
    ['verification_rejected', 'governed_reject', 'verification_rejected'],
  ] as const)('%s is governed terminal', async (status, disposition, governedDisposition) => {
    const { calls, ports } = setup({ result: bridge(status, false) });
    await drainIngestionOutboxBatchV1({ leaseOwner: 'w', now: new Date() }, ports);
    expect(calls.governed[0]!).toMatchObject({ disposition, metadata: { governedDisposition } });
    expect(calls.retry).toHaveLength(0);
    expect(calls.readiness).toHaveLength(0);
  });
  test('rejected is governed terminal on its first attempt', async () => {
    const { calls, ports } = setup({ result: bridge('rejected', false), attempts: 0 });
    const out = await drainIngestionOutboxBatchV1({ leaseOwner: 'w', now: new Date() }, ports);
    expect(calls.governed[0]).toMatchObject({
      disposition: 'governed_reject',
      metadata: { governedDisposition: 'rejected' },
    });
    expect(calls.retry).toHaveLength(0);
    expect(out.governedReject).toBe(1);
  });
  test('transient failure retries below ceiling and poisons at ceiling', async () => {
    let x = setup({ result: bridge('downstream_failed', false), attempts: 0 });
    let out = await drainIngestionOutboxBatchV1(
      { leaseOwner: 'w', now: new Date('2026-01-01') },
      x.ports,
    );
    expect(out.retried).toBe(1);
    expect(x.calls.retry[0]!.attemptsBefore).toBe(0);
    x = setup({ result: bridge('downstream_failed', false), attempts: 4 });
    out = await drainIngestionOutboxBatchV1({ leaseOwner: 'w', now: new Date() }, x.ports);
    expect(out.poisoned).toBe(1);
    expect(x.calls.poison[0]!.metadata).toEqual({ governedDisposition: 'retries_exhausted' });
  });
  test('readiness failure after mark is reported and never reverts success', async () => {
    const { calls, ports } = setup({ readinessError: new Error('readiness unavailable') });
    const out = await drainIngestionOutboxBatchV1({ leaseOwner: 'w', now: new Date() }, ports);
    expect(calls.succeeded).toHaveLength(1);
    expect(calls.retry).toHaveLength(0);
    expect(calls.poison).toHaveLength(0);
    expect(out.readinessFailures).toEqual([
      { observationId: 'obs', detail: 'readiness unavailable' },
    ]);
  });
  test('one throwing row does not abort the batch', async () => {
    const x = setup({
      rows: [
        { id: 'bad', observationId: 'bad', attempts: 4 },
        { id: 'good', observationId: 'good', attempts: 0 },
      ],
    });
    x.ports.bridge.bridge = async (id: string) => {
      if (id === 'bad') throw new Error('boom');
      return bridge();
    };
    const out = await drainIngestionOutboxBatchV1({ leaseOwner: 'w', now: new Date() }, x.ports);
    expect(out).toMatchObject({ claimed: 2, succeeded: 1, poisoned: 1 });
  });
  test('lost ingestion lease suppresses counters and readiness', async () => {
    const x = setup();
    x.repository.markSucceeded = async () => false;
    const out = await drainIngestionOutboxBatchV1({ leaseOwner: 'w', now: new Date() }, x.ports);
    expect(out).toMatchObject({ succeeded: 0, leaseLost: 1, readinessInvoked: 0 });
    expect(x.calls.readiness).toHaveLength(0);
  });
  test('lost governed/retry/poison leases suppress their outcome counters', async () => {
    let x = setup({ result: bridge('review_required', false) });
    x.repository.markGoverned = async () => false;
    expect(
      await drainIngestionOutboxBatchV1({ leaseOwner: 'w', now: new Date() }, x.ports),
    ).toMatchObject({ governedReview: 0, leaseLost: 1 });
    x = setup({ result: bridge('downstream_failed', false), attempts: 0 });
    x.repository.markRetryableFailure = async () => false;
    expect(
      await drainIngestionOutboxBatchV1({ leaseOwner: 'w', now: new Date() }, x.ports),
    ).toMatchObject({ retried: 0, leaseLost: 1 });
    x = setup({ result: bridge('downstream_failed', false), attempts: 4 });
    x.repository.markDeadLetterPoison = async () => false;
    expect(
      await drainIngestionOutboxBatchV1({ leaseOwner: 'w', now: new Date() }, x.ports),
    ).toMatchObject({ poisoned: 0, leaseLost: 1 });
  });
  test('readiness-only catch-up never invokes the bridge', async () => {
    const x = setup();
    let bridgeCalls = 0;
    x.ports.bridge.bridge = async () => {
      bridgeCalls++;
      return bridge();
    };
    const out = await drainReadinessPendingBatchV1({ leaseOwner: 'w2', now: new Date() }, x.ports);
    expect(bridgeCalls).toBe(0);
    expect(out).toMatchObject({ claimed: 1, readinessInvoked: 1, readinessSucceeded: 1 });
  });
  test('committee and unsupported scopes are counted only after their durable writes land', async () => {
    let x = setup({ family: 'auth_committee_mark', track: 'authorization' });
    x.repository.markReadinessDeferredCommittee = async () => false;
    let out = await drainReadinessPendingBatchV1({ leaseOwner: 'w', now: new Date() }, x.ports);
    expect(out).toMatchObject({ readiness_deferred_committee: 0, leaseLost: 1 });
    x = setup({ family: 'exec_obligation', track: 'execution' });
    x.repository.markReadinessNotApplicable = async () => false;
    out = await drainReadinessPendingBatchV1({ leaseOwner: 'w', now: new Date() }, x.ports);
    expect(out).toMatchObject({ readinessSkippedNoScope: 0, leaseLost: 1 });
  });
  test.each([
    ['pb_r1', 'rdte'],
    ['pb_p1', 'procurement'],
  ] as const)('passes the derived %s scope to invokeReadiness', async (family, familyGroup) => {
    const x = setup({ family });
    let outcome = '';
    x.ports.invokeReadiness = async (scope: any) => {
      expect(scope.familyGroup).toBe(familyGroup);
      outcome = 'awaiting_authorization';
      return { outcome };
    };
    const out = await drainIngestionOutboxBatchV1({ leaseOwner: 'w', now: new Date() }, x.ports);
    expect(out.readinessInvoked).toBe(1);
    expect(outcome).toBe('awaiting_authorization');
  });
});
