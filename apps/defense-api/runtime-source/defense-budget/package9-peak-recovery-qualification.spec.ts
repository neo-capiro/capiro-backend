import type { ObservationIngestionBridgeResult } from './observation-ingestion-bridge.service.js';
import {
  drainIngestionOutboxBatchV1,
  type IngestionOutboxDrainWorkerPortsV1,
} from './ingestion-outbox-drain-worker-v1.js';

type QueueState = 'pending' | 'leased' | 'succeeded' | 'retry';

interface QualificationRow {
  id: string;
  observationId: string;
  attempts: number;
  state: QueueState;
  leasedBy: string | null;
  readiness: 'pending' | 'succeeded' | null;
}

const NOW = new Date('2026-09-25T00:00:00.000Z');
const QUALIFICATION_FAMILIES = ['pb_r1', 'pb_p1', 'pb_o1', 'pb_milcon_c1'] as const;

function ingested(observationId: string): ObservationIngestionBridgeResult {
  return {
    status: 'ingested',
    ingestionSucceeded: true,
    observationId,
    sourceDocumentId: `doc-${observationId}`,
    reason: 'package9-qualified-fixture',
    sourceDocumentBound: true,
    parserVerificationSucceeded: true,
    durableEvidencePersisted: true,
    parserHandoffInvoked: true,
    parserHandoffError: null,
    verifierDecision: 'PASS',
  };
}

class PeakQualificationRepository {
  readonly rows: QualificationRow[];

  constructor(count: number) {
    this.rows = Array.from({ length: count }, (_, index) => ({
      id: `row-${index.toString().padStart(3, '0')}`,
      observationId: `observation-${index.toString().padStart(3, '0')}`,
      attempts: 0,
      state: 'pending' as const,
      leasedBy: null,
      readiness: null,
    }));
  }

  async claimBatch(input: { leaseOwner: string; limit: number }) {
    const rows = this.rows
      .filter((row) => row.state === 'pending' || row.state === 'retry')
      .slice(0, input.limit);
    for (const row of rows) {
      row.state = 'leased';
      row.leasedBy = input.leaseOwner;
    }
    return rows.map((row) => ({
      id: row.id,
      observationId: row.observationId,
      attempts: row.attempts,
    }));
  }

  async markSucceeded(rowId: string, leasedBy: string) {
    const row = this.row(rowId);
    if (row.state !== 'leased' || row.leasedBy !== leasedBy) return false;
    row.state = 'succeeded';
    row.leasedBy = null;
    row.readiness = 'pending';
    return true;
  }

  async claimReadinessPendingRow(input: { rowId: string; leaseOwner: string }) {
    const row = this.row(input.rowId);
    if (row.state !== 'succeeded' || row.readiness !== 'pending' || row.leasedBy !== null)
      return null;
    row.leasedBy = input.leaseOwner;
    return {
      id: row.id,
      observationId: row.observationId,
      attempts: row.attempts,
    };
  }

  async markReadinessSucceeded(input: { rowId: string; leasedBy: string }) {
    const row = this.row(input.rowId);
    if (row.readiness !== 'pending' || row.leasedBy !== input.leasedBy) return false;
    row.readiness = 'succeeded';
    row.leasedBy = null;
    return true;
  }

  async markRetryableFailure(input: { rowId: string; leasedBy: string; attemptsBefore: number }) {
    const row = this.row(input.rowId);
    if (row.state !== 'leased' || row.leasedBy !== input.leasedBy) return false;
    row.attempts = input.attemptsBefore + 1;
    row.state = 'retry';
    row.leasedBy = null;
    return true;
  }

  async markDeadLetterPoison() {
    throw new Error('qualification fixture must recover before the poison ceiling');
  }

  async markGoverned() {
    throw new Error('qualification fixture contains only verified PASS observations');
  }

  async markReadinessRetryableFailure() {
    throw new Error('qualification fixture does not inject readiness failures');
  }

  async markReadinessDeferredCommittee() {
    throw new Error('qualification fixture contains no committee observations');
  }

  async markReadinessNotApplicable() {
    throw new Error('qualification fixture contains only supported RDT&E observations');
  }

  expireLease(rowId: string) {
    const row = this.row(rowId);
    row.state = 'retry';
    row.leasedBy = null;
  }

  pendingCount() {
    return this.rows.filter((row) => row.state === 'pending' || row.state === 'retry').length;
  }

  private row(rowId: string) {
    const row = this.rows.find((candidate) => candidate.id === rowId);
    if (!row) throw new Error(`unknown qualification row ${rowId}`);
    return row;
  }
}

function ports(
  repository: PeakQualificationRepository,
  bridge: IngestionOutboxDrainWorkerPortsV1['bridge'],
): IngestionOutboxDrainWorkerPortsV1 {
  return {
    repository: repository as unknown as IngestionOutboxDrainWorkerPortsV1['repository'],
    bridge,
    loadObservationScope: async (observationId) => ({
      classifiedSourceFamily:
        QUALIFICATION_FAMILIES[
          Number(observationId.split('-').at(-1)) % QUALIFICATION_FAMILIES.length
        ]!,
      authorityTrack: 'request',
      fiscalYear: 2027,
    }),
    invokeReadiness: async () => ({ outcome: 'awaiting_authorization' }),
  };
}

describe('Package 9 peak-load and failure-recovery qualification', () => {
  test('four workers drain the 100-row component ceiling exactly once across four budget families', async () => {
    const repository = new PeakQualificationRepository(100);
    const acceptedEvidence = new Set<string>();
    const logicalNotifications = new Set<string>();
    const bridgeCalls = new Map<string, number>();

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, worker) =>
        drainIngestionOutboxBatchV1(
          { leaseOwner: `package9-worker-${worker}`, now: NOW, batchSize: 25 },
          ports(repository, {
            bridge: async (observationId) => {
              bridgeCalls.set(observationId, (bridgeCalls.get(observationId) ?? 0) + 1);
              acceptedEvidence.add(observationId);
              logicalNotifications.add(`verified:${observationId}`);
              return ingested(observationId);
            },
          }),
        ),
      ),
    );

    expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(100);
    expect(results.reduce((sum, result) => sum + result.succeeded, 0)).toBe(100);
    expect(results.reduce((sum, result) => sum + result.readinessSucceeded, 0)).toBe(100);
    expect(results.reduce((sum, result) => sum + result.leaseLost, 0)).toBe(0);
    expect(repository.pendingCount()).toBe(0);
    expect(acceptedEvidence.size).toBe(100);
    expect(logicalNotifications.size).toBe(100);
    expect([...bridgeCalls.values()]).toEqual(Array.from({ length: 100 }, () => 1));
  });

  test('a crash after evidence commit and transient source/provider outages recover without duplicate facts or notifications', async () => {
    const repository = new PeakQualificationRepository(30);
    const calls = new Map<string, number>();
    const acceptedEvidence = new Set<string>();
    const logicalNotifications = new Set<string>();
    let notificationWrites = 0;
    const injectedFailures = new Set<string>();

    const qualificationPorts = ports(repository, {
      bridge: async (observationId) => {
        const call = (calls.get(observationId) ?? 0) + 1;
        calls.set(observationId, call);
        const sequence = Number(observationId.split('-').at(-1));

        // Rows 0-9 model a crash after the immutable evidence and logical
        // notification keys are committed. Rows 10-19 model a source outage;
        // rows 20-29 model a provider outage before either commit.
        if (sequence < 10) {
          const inserted = !acceptedEvidence.has(observationId);
          acceptedEvidence.add(observationId);
          if (inserted) {
            logicalNotifications.add(`verified:${observationId}`);
            notificationWrites++;
          }
          if (call === 1) {
            injectedFailures.add('crash_after_evidence_commit');
            throw new Error('injected crash after evidence commit');
          }
        } else if (call === 1) {
          injectedFailures.add(sequence < 20 ? 'source_outage' : 'provider_outage');
          throw new Error(sequence < 20 ? 'injected source outage' : 'injected provider outage');
        } else {
          acceptedEvidence.add(observationId);
          logicalNotifications.add(`verified:${observationId}`);
          notificationWrites++;
        }
        return ingested(observationId);
      },
    });

    const first = await drainIngestionOutboxBatchV1(
      { leaseOwner: 'package9-first-attempt', now: NOW, batchSize: 30 },
      qualificationPorts,
    );
    const recovered = await drainIngestionOutboxBatchV1(
      { leaseOwner: 'package9-recovery', now: NOW, batchSize: 30 },
      qualificationPorts,
    );

    expect(first).toMatchObject({ claimed: 30, succeeded: 0, retried: 30, poisoned: 0 });
    expect(recovered).toMatchObject({ claimed: 30, succeeded: 30, retried: 0, poisoned: 0 });
    expect(injectedFailures).toEqual(
      new Set(['crash_after_evidence_commit', 'source_outage', 'provider_outage']),
    );
    expect(repository.pendingCount()).toBe(0);
    expect(acceptedEvidence.size).toBe(30);
    expect(logicalNotifications.size).toBe(30);
    expect(notificationWrites).toBe(30);
  });

  test('an expired lease fences the stale worker and permits one clean recovery', async () => {
    const repository = new PeakQualificationRepository(1);
    const acceptedEvidence = new Set<string>();
    const logicalNotifications = new Set<string>();
    const qualificationPorts = ports(repository, {
      bridge: async (observationId) => {
        acceptedEvidence.add(observationId);
        logicalNotifications.add(`verified:${observationId}`);
        return ingested(observationId);
      },
    });

    const staleClaim = await repository.claimBatch({ leaseOwner: 'stale-worker', limit: 1 });
    repository.expireLease(staleClaim[0]!.id);
    expect(await repository.markSucceeded(staleClaim[0]!.id, 'stale-worker')).toBe(false);

    const recovered = await drainIngestionOutboxBatchV1(
      { leaseOwner: 'replacement-worker', now: NOW, batchSize: 1 },
      qualificationPorts,
    );
    expect(recovered).toMatchObject({ claimed: 1, succeeded: 1, leaseLost: 0 });
    expect(acceptedEvidence.size).toBe(1);
    expect(logicalNotifications.size).toBe(1);
  });
});
