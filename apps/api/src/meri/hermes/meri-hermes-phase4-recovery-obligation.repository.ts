import type {
  MeriHermesPhase4RecoveryCandidateV1,
  MeriHermesPhase4RecoveryObservationV1,
} from './meri-hermes-phase4-recovery-coordinator.js';

/**
 * Dormant database adapter for the separately owned Phase 4 recovery caller.
 *
 * The injected database must connect as the dedicated recovery caller; this
 * class never uses the ordinary Prisma/capiro_app pool and never interpolates
 * data into SQL. The SECURITY DEFINER routines own candidate discovery,
 * cross-replica claims, database time, receipt existence checks and retry
 * scheduling.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const MAX_BATCH = 100;
const MIN_LEASE_MICROS = 1_000_000n;
const MAX_LEASE_MICROS = 300_000_000n;
const STOP_BODY = Uint8Array.from(Buffer.from('{}'));
const UNKNOWN_DETAILS = new Set([
  'invalid_request', 'context_unavailable', 'key_unavailable', 'window_unavailable',
  'transport_unconfirmed', 'receipt_unverified', 'persistence_unconfirmed',
  'absence_unproven',
]);

export interface MeriHermesPhase4RecoveryCallerTransactionV1 {
  query<T extends object>(sql: string, parameters: readonly unknown[]): Promise<readonly T[]>;
}

export interface MeriHermesPhase4RecoveryCallerDatabaseV1 {
  withRecoveryCallerTransaction<T>(
    run: (tx: MeriHermesPhase4RecoveryCallerTransactionV1) => Promise<T>,
  ): Promise<T>;
}

interface CandidateRow {
  obligation_id: string;
  tenant_id: string;
  run_id: string;
  obligation_kind: string;
  action: string | null;
  claim_token: string;
  operation_id: string;
  attempt_nonce: string;
  native_body_bytes: Uint8Array;
}

interface OutcomeRow { record_result: string }

export class MeriHermesPhase4RecoveryObligationSourceError extends Error {
  constructor() {
    super('Phase 4 recovery obligation source is malformed or unavailable');
    this.name = 'MeriHermesPhase4RecoveryObligationSourceError';
  }
}

export class MeriHermesPhase4RecoveryOutcomeConflictError extends Error {
  constructor() {
    super('Phase 4 recovery outcome does not match the claimed operation');
    this.name = 'MeriHermesPhase4RecoveryOutcomeConflictError';
  }
}

function validNonce(value: unknown): value is string {
  if (typeof value !== 'string' || !NONCE.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 16 && decoded.toString('base64url') === value;
}

function canonicalLease(value: bigint | number | string): string | null {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    return null;
  }
  return parsed >= MIN_LEASE_MICROS && parsed <= MAX_LEASE_MICROS ? parsed.toString() : null;
}

function candidateFromRow(row: CandidateRow): MeriHermesPhase4RecoveryCandidateV1 | null {
  if (!row || !UUID.test(row.obligation_id) || !UUID.test(row.tenant_id) ||
      !UUID.test(row.run_id) || !UUID.test(row.operation_id) ||
      !UUID.test(row.claim_token) ||
      row.obligation_id !== row.operation_id ||
      !validNonce(row.attempt_nonce) || !(row.native_body_bytes instanceof Uint8Array)) return null;

  if (row.obligation_kind === 'reservation' && row.action === null &&
      row.native_body_bytes.length === 0) {
    return Object.freeze({
      kind: 'reservation',
      tenantId: row.tenant_id,
      runId: row.run_id,
      claimToken: row.claim_token,
      operationId: row.operation_id,
      attemptNonce: row.attempt_nonce,
    });
  }
  if (row.obligation_kind === 'dispatch' &&
      (row.action === 'status' || row.action === 'stop') &&
      ((row.action === 'status' && row.native_body_bytes.length === 0) ||
       (row.action === 'stop' && Buffer.from(row.native_body_bytes).equals(STOP_BODY)))) {
    return Object.freeze({
      kind: 'dispatch',
      tenantId: row.tenant_id,
      runId: row.run_id,
      action: row.action,
      claimToken: row.claim_token,
      operationId: row.operation_id,
      attemptNonce: row.attempt_nonce,
      nativeBodyBytes: Uint8Array.from(row.native_body_bytes),
    });
  }
  return null;
}

interface EncodedOutcome {
  readonly kind: string;
  readonly detail: string;
  readonly receiptOperationId: string | null;
  readonly receiptAttemptNonce: string | null;
}

function stringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' ? candidate : null;
}

function exactReceiptIdentity(
  candidate: Readonly<MeriHermesPhase4RecoveryCandidateV1>,
  receipt: unknown,
): boolean {
  return stringField(receipt, 'tenantId') === candidate.tenantId &&
    stringField(receipt, 'runId') === candidate.runId &&
    stringField(receipt, 'operationId') === candidate.operationId &&
    stringField(receipt, 'attemptNonce') === candidate.attemptNonce;
}

function encodeOutcome(
  candidate: Readonly<MeriHermesPhase4RecoveryCandidateV1>,
  observation: Readonly<MeriHermesPhase4RecoveryObservationV1>,
): EncodedOutcome | null {
  if (observation.kind === 'boundary_failure') {
    const expected = candidate.kind === 'reservation'
      ? 'reservation_unavailable'
      : 'dispatch_unavailable';
    return observation.category === expected
      ? Object.freeze({
          kind: 'boundary_failure',
          detail: observation.category,
          receiptOperationId: null,
          receiptAttemptNonce: null,
        })
      : null;
  }

  if (candidate.kind !== observation.kind) return null;
  const result = observation.result;
  if (!result || typeof result !== 'object' || result.version !== 1) return null;
  if (result.kind === 'UNKNOWN') {
    if (!UNKNOWN_DETAILS.has(result.reason)) return null;
    return Object.freeze({
      kind: 'unknown',
      detail: result.reason,
      receiptOperationId: null,
      receiptAttemptNonce: null,
    });
  }

  if (!exactReceiptIdentity(candidate, result.receipt)) return null;
  if (candidate.kind === 'reservation' && observation.kind === 'reservation') {
    if (result.kind !== 'bound_worker' && result.kind !== 'sealed_absent') return null;
    const receiptOutcome = stringField(result.receipt, 'outcome');
    const expectedReceiptOutcome = result.kind === 'bound_worker' ? 'reserved' : 'sealed_absent';
    if (receiptOutcome !== expectedReceiptOutcome ||
        (result.kind === 'bound_worker' &&
         stringField(result.receipt, 'workerRunId') !== result.workerRunId)) return null;
    return Object.freeze({
      kind: result.kind === 'bound_worker' ? 'reservation_bound_worker' : 'reservation_sealed_absent',
      detail: expectedReceiptOutcome,
      receiptOperationId: candidate.operationId,
      receiptAttemptNonce: candidate.attemptNonce,
    });
  }

  if (candidate.kind === 'dispatch' && observation.kind === 'dispatch' &&
      observation.action === candidate.action &&
      stringField(result.receipt, 'action') === candidate.action) {
    const receiptObservation = stringField(result.receipt, 'observation');
    const terminal = result.kind === 'terminal' && receiptObservation === 'run_terminal';
    const nonterminal = result.kind === 'nonterminal' &&
      (receiptObservation === 'run_nonterminal' || receiptObservation === 'stop_accepted');
    if (!terminal && !nonterminal) return null;
    return Object.freeze({
      kind: result.kind === 'terminal' ? 'dispatch_terminal' : 'dispatch_nonterminal',
      detail: receiptObservation!,
      receiptOperationId: candidate.operationId,
      receiptAttemptNonce: candidate.attemptNonce,
    });
  }
  return null;
}

export class MeriHermesPhase4RecoveryObligationRepositoryV1 {
  readonly #database: MeriHermesPhase4RecoveryCallerDatabaseV1;
  readonly #ownerId: string;
  readonly #leaseMicros: string;

  constructor(
    database: MeriHermesPhase4RecoveryCallerDatabaseV1,
    ownerId: string,
    leaseMicros: bigint | number | string,
  ) {
    const lease = canonicalLease(leaseMicros);
    if (!database || typeof database.withRecoveryCallerTransaction !== 'function' ||
        !UUID.test(ownerId) || lease === null) {
      throw new Error('Phase 4 recovery obligation repository configuration is invalid');
    }
    this.#database = database;
    this.#ownerId = ownerId;
    this.#leaseMicros = lease;
  }

  async claimBatch(limit: number): Promise<readonly MeriHermesPhase4RecoveryCandidateV1[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH) {
      throw new MeriHermesPhase4RecoveryObligationSourceError();
    }
    return this.#database.withRecoveryCallerTransaction(async (tx) => {
      const rows = await tx.query<CandidateRow>(
        `SELECT obligation_id, tenant_id, run_id, obligation_kind, action, claim_token,
                operation_id, attempt_nonce, native_body_bytes
           FROM public.meri_phase4_claim_recovery_obligations(
             $1::uuid, $2::integer, $3::bigint
           )`,
        [this.#ownerId, limit, this.#leaseMicros],
      );
      if (!Array.isArray(rows) || rows.length > limit) {
        throw new MeriHermesPhase4RecoveryObligationSourceError();
      }
      const seen = new Set<string>();
      const candidates: MeriHermesPhase4RecoveryCandidateV1[] = [];
      for (const row of rows) {
        const candidate = candidateFromRow(row);
        if (!candidate) throw new MeriHermesPhase4RecoveryObligationSourceError();
        const key = `${candidate.tenantId}:${candidate.operationId}`;
        if (seen.has(key)) throw new MeriHermesPhase4RecoveryObligationSourceError();
        seen.add(key);
        candidates.push(candidate);
      }
      return Object.freeze(candidates);
    });
  }

  async recordOutcome(
    candidate: Readonly<MeriHermesPhase4RecoveryCandidateV1>,
    observation: Readonly<MeriHermesPhase4RecoveryObservationV1>,
  ): Promise<'recorded' | 'replayed'> {
    const copied = candidateFromRow({
      obligation_id: candidate.operationId,
      tenant_id: candidate.tenantId,
      run_id: candidate.runId,
      obligation_kind: candidate.kind,
      action: candidate.kind === 'dispatch' ? candidate.action : null,
      claim_token: candidate.claimToken,
      operation_id: candidate.operationId,
      attempt_nonce: candidate.attemptNonce,
      native_body_bytes: candidate.kind === 'dispatch'
        ? Uint8Array.from(candidate.nativeBodyBytes)
        : new Uint8Array(),
    });
    const encoded = copied ? encodeOutcome(copied, observation) : null;
    if (!copied || !encoded) throw new MeriHermesPhase4RecoveryOutcomeConflictError();

    return this.#database.withRecoveryCallerTransaction(async (tx) => {
      const rows = await tx.query<OutcomeRow>(
        `SELECT record_result
           FROM public.meri_phase4_record_recovery_outcome(
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
             $6::varchar, $7::varchar, $8::uuid, $9::varchar, $10::varchar
           )`,
        [
          copied.tenantId,
          copied.operationId,
          this.#ownerId,
          copied.claimToken,
          copied.operationId,
          copied.attemptNonce,
          encoded.kind,
          encoded.receiptOperationId,
          encoded.receiptAttemptNonce,
          encoded.detail,
        ],
      );
      if (!Array.isArray(rows) || rows.length !== 1 ||
          (rows[0]!.record_result !== 'recorded' && rows[0]!.record_result !== 'replayed')) {
        throw new MeriHermesPhase4RecoveryOutcomeConflictError();
      }
      return rows[0]!.record_result as 'recorded' | 'replayed';
    });
  }
}
