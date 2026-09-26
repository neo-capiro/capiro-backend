import type {
  MeriHermesDispatchRecoveryInputV1,
  MeriHermesDispatchRecoveryResultV1,
} from './meri-hermes-dispatch-recovery-boundary.js';
import type {
  MeriHermesReservationRecoveryInputV1,
  MeriHermesReservationRecoveryResultV1,
} from './meri-hermes-reservation-recovery-boundary.js';

/**
 * Dormant, authority-neutral Phase 4 recovery coordinator.
 *
 * This file deliberately owns no timer, Nest registration, database
 * connection, clock, randomness, transport, or key source. The authority
 * repository must durably claim a bounded batch and supply a stable operation
 * ID and attempt nonce before any native request is attempted. Replays reuse
 * those exact values; the coordinator never mints a replacement after an
 * uncertain transport result.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const MAX_BATCH = 100;
const STOP_BODY = Uint8Array.from(Buffer.from('{}'));

export interface MeriHermesPhase4ReservationCandidateV1 {
  readonly kind: 'reservation';
  readonly tenantId: string;
  readonly runId: string;
  readonly claimToken: string;
  readonly operationId: string;
  readonly attemptNonce: string;
}

export interface MeriHermesPhase4DispatchCandidateV1 {
  readonly kind: 'dispatch';
  readonly tenantId: string;
  readonly runId: string;
  readonly action: 'status' | 'stop';
  readonly claimToken: string;
  readonly operationId: string;
  readonly attemptNonce: string;
  readonly nativeBodyBytes: Uint8Array;
}

export type MeriHermesPhase4RecoveryCandidateV1 =
  | MeriHermesPhase4ReservationCandidateV1
  | MeriHermesPhase4DispatchCandidateV1;

export type MeriHermesPhase4RecoveryObservationV1 =
  | Readonly<{
      kind: 'reservation';
      result: Readonly<MeriHermesReservationRecoveryResultV1>;
    }>
  | Readonly<{
      kind: 'dispatch';
      action: 'status' | 'stop';
      result: Readonly<MeriHermesDispatchRecoveryResultV1>;
    }>
  | Readonly<{
      kind: 'boundary_failure';
      category: 'reservation_unavailable' | 'dispatch_unavailable';
    }>;

export interface MeriHermesPhase4RecoveryCoordinatorDependenciesV1 {
  /** Default-off activation decision owned by separately reviewed wiring. */
  readonly enabled: () => boolean;
  /**
   * Must atomically claim at most `limit` durable obligations across replicas.
   * Returned operation IDs, nonces, actions and body bytes are immutable replay
   * material, not process-generated suggestions.
   */
  readonly claimBatch: (
    limit: number,
  ) => Promise<readonly MeriHermesPhase4RecoveryCandidateV1[]>;
  readonly reservationBoundary: {
    recover(
      input: Readonly<MeriHermesReservationRecoveryInputV1>,
    ): Promise<MeriHermesReservationRecoveryResultV1>;
  };
  readonly dispatchBoundary: {
    recover(
      input: Readonly<MeriHermesDispatchRecoveryInputV1>,
    ): Promise<MeriHermesDispatchRecoveryResultV1>;
  };
  /**
   * Records the outcome under the same authority claim. UNKNOWN/failure may
   * only retain or reschedule the obligation; only an exact verified boundary
   * result may drive known-worker completion or terminalization.
   */
  readonly recordOutcome: (
    candidate: Readonly<MeriHermesPhase4RecoveryCandidateV1>,
    observation: Readonly<MeriHermesPhase4RecoveryObservationV1>,
  ) => Promise<'recorded' | 'replayed'>;
}

export type MeriHermesPhase4RecoveryCoordinatorRunV1 =
  | Readonly<{ version: 1; kind: 'disabled' | 'already_running' | 'source_unavailable' }>
  | Readonly<{ version: 1; kind: 'source_invalid'; claimed: number }>
  | Readonly<{
      version: 1;
      kind: 'completed';
      claimed: number;
      processed: number;
      verified: number;
      unknown: number;
      boundaryFailures: number;
      invalid: number;
      outcomeUnconfirmed: number;
    }>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function validNonce(value: unknown): value is string {
  if (typeof value !== 'string' || !NONCE.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 16 && bytes.toString('base64url') === value;
}

function snapshotCandidate(value: unknown): MeriHermesPhase4RecoveryCandidateV1 | null {
  const row = record(value);
  if (!row || (row.kind !== 'reservation' && row.kind !== 'dispatch') ||
      typeof row.tenantId !== 'string' || typeof row.runId !== 'string' ||
      typeof row.operationId !== 'string' || !UUID.test(row.tenantId) ||
      !UUID.test(row.runId) || typeof row.claimToken !== 'string' ||
      !UUID.test(row.claimToken) || !UUID.test(row.operationId) ||
      !validNonce(row.attemptNonce)) return null;

  if (row.kind === 'reservation') {
    if (!exactKeys(row, [
      'kind', 'tenantId', 'runId', 'claimToken', 'operationId', 'attemptNonce',
    ])) return null;
    return Object.freeze({
      kind: 'reservation',
      tenantId: row.tenantId,
      runId: row.runId,
      claimToken: row.claimToken,
      operationId: row.operationId,
      attemptNonce: row.attemptNonce,
    });
  }

  if (!exactKeys(row, [
    'kind', 'tenantId', 'runId', 'action', 'claimToken',
    'operationId', 'attemptNonce', 'nativeBodyBytes',
  ]) || (row.action !== 'status' && row.action !== 'stop') ||
      !(row.nativeBodyBytes instanceof Uint8Array) ||
      ((row.action === 'status' && row.nativeBodyBytes.length !== 0) ||
       (row.action === 'stop' && !Buffer.from(row.nativeBodyBytes).equals(STOP_BODY)))) return null;

  return Object.freeze({
    kind: 'dispatch',
    tenantId: row.tenantId,
    runId: row.runId,
    action: row.action,
    claimToken: row.claimToken,
    operationId: row.operationId,
    attemptNonce: row.attemptNonce,
    nativeBodyBytes: Uint8Array.from(row.nativeBodyBytes),
  });
}

function candidateForCall(
  candidate: Readonly<MeriHermesPhase4RecoveryCandidateV1>,
): MeriHermesPhase4RecoveryCandidateV1 {
  return candidate.kind === 'reservation'
    ? Object.freeze({ ...candidate })
    : Object.freeze({ ...candidate, nativeBodyBytes: Uint8Array.from(candidate.nativeBodyBytes) });
}

function priority(candidate: Readonly<MeriHermesPhase4RecoveryCandidateV1>): number {
  // Discover an unknown worker before attempting its Stop/status; then prefer
  // Stop over observation so a committed cancellation cannot be delayed by a
  // lower-authority status query.
  if (candidate.kind === 'reservation') return 0;
  return candidate.action === 'stop' ? 1 : 2;
}

function compareCandidates(
  left: Readonly<MeriHermesPhase4RecoveryCandidateV1>,
  right: Readonly<MeriHermesPhase4RecoveryCandidateV1>,
): number {
  return priority(left) - priority(right) ||
    left.tenantId.localeCompare(right.tenantId) ||
    left.runId.localeCompare(right.runId) ||
    left.operationId.localeCompare(right.operationId);
}

function snapshotDispatchResult(
  result: MeriHermesDispatchRecoveryResultV1,
): Readonly<MeriHermesDispatchRecoveryResultV1> {
  return result.kind === 'UNKNOWN'
    ? Object.freeze({ ...result })
    : Object.freeze({ ...result, receipt: Object.freeze({ ...result.receipt }) });
}

function snapshotReservationResult(
  result: MeriHermesReservationRecoveryResultV1,
): Readonly<MeriHermesReservationRecoveryResultV1> {
  return result.kind === 'UNKNOWN'
    ? Object.freeze({ ...result })
    : Object.freeze({ ...result, receipt: Object.freeze({ ...result.receipt }) });
}

export class MeriHermesPhase4RecoveryCoordinatorV1 {
  readonly #dependencies: MeriHermesPhase4RecoveryCoordinatorDependenciesV1;
  readonly #batchLimit: number;
  #running = false;

  constructor(
    dependencies: MeriHermesPhase4RecoveryCoordinatorDependenciesV1,
    batchLimit = 20,
  ) {
    if (!dependencies || typeof dependencies.enabled !== 'function' ||
        typeof dependencies.claimBatch !== 'function' ||
        typeof dependencies.reservationBoundary?.recover !== 'function' ||
        typeof dependencies.dispatchBoundary?.recover !== 'function' ||
        typeof dependencies.recordOutcome !== 'function') {
      throw new Error('Phase 4 recovery coordinator requires explicit authority ports');
    }
    if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > MAX_BATCH) {
      throw new Error('Phase 4 recovery coordinator batch limit is invalid');
    }
    this.#dependencies = dependencies;
    this.#batchLimit = batchLimit;
  }

  async runOnce(): Promise<MeriHermesPhase4RecoveryCoordinatorRunV1> {
    let enabled = false;
    try {
      enabled = this.#dependencies.enabled() === true;
    } catch {
      return Object.freeze({ version: 1, kind: 'disabled' });
    }
    if (!enabled) return Object.freeze({ version: 1, kind: 'disabled' });
    if (this.#running) return Object.freeze({ version: 1, kind: 'already_running' });

    this.#running = true;
    try {
      let raw: readonly MeriHermesPhase4RecoveryCandidateV1[];
      try {
        raw = await this.#dependencies.claimBatch(this.#batchLimit);
      } catch {
        return Object.freeze({ version: 1, kind: 'source_unavailable' });
      }
      if (!Array.isArray(raw) || raw.length > this.#batchLimit) {
        return Object.freeze({
          version: 1,
          kind: 'source_invalid',
          claimed: Array.isArray(raw) ? raw.length : 0,
        });
      }

      const candidates: MeriHermesPhase4RecoveryCandidateV1[] = [];
      const operationKeys = new Set<string>();
      let invalid = 0;
      for (const value of raw) {
        const copied = snapshotCandidate(value);
        if (!copied) {
          invalid += 1;
          continue;
        }
        const operationKey = `${copied.tenantId}:${copied.operationId}`;
        if (operationKeys.has(operationKey)) {
          return Object.freeze({ version: 1, kind: 'source_invalid', claimed: raw.length });
        }
        operationKeys.add(operationKey);
        candidates.push(copied);
      }
      candidates.sort(compareCandidates);

      let processed = 0;
      let verified = 0;
      let unknown = 0;
      let boundaryFailures = 0;
      let outcomeUnconfirmed = 0;

      for (const candidate of candidates) {
        let observation: MeriHermesPhase4RecoveryObservationV1;
        if (candidate.kind === 'reservation') {
          try {
            const result = snapshotReservationResult(
              await this.#dependencies.reservationBoundary.recover({
                tenantId: candidate.tenantId,
                runId: candidate.runId,
                operationId: candidate.operationId,
                attemptNonce: candidate.attemptNonce,
              }),
            );
            observation = Object.freeze({ kind: 'reservation', result });
            if (result.kind === 'UNKNOWN') unknown += 1;
            else verified += 1;
          } catch {
            observation = Object.freeze({
              kind: 'boundary_failure',
              category: 'reservation_unavailable',
            });
            boundaryFailures += 1;
          }
        } else {
          try {
            const result = snapshotDispatchResult(
              await this.#dependencies.dispatchBoundary.recover({
                tenantId: candidate.tenantId,
                runId: candidate.runId,
                action: candidate.action,
                operationId: candidate.operationId,
                attemptNonce: candidate.attemptNonce,
                nativeBodyBytes: Uint8Array.from(candidate.nativeBodyBytes),
              }),
            );
            observation = Object.freeze({ kind: 'dispatch', action: candidate.action, result });
            if (result.kind === 'UNKNOWN') unknown += 1;
            else verified += 1;
          } catch {
            observation = Object.freeze({
              kind: 'boundary_failure',
              category: 'dispatch_unavailable',
            });
            boundaryFailures += 1;
          }
        }

        processed += 1;
        try {
          await this.#dependencies.recordOutcome(candidateForCall(candidate), observation);
        } catch {
          outcomeUnconfirmed += 1;
        }
      }

      return Object.freeze({
        version: 1,
        kind: 'completed',
        claimed: raw.length,
        processed,
        verified,
        unknown,
        boundaryFailures,
        invalid,
        outcomeUnconfirmed,
      });
    } finally {
      this.#running = false;
    }
  }
}
