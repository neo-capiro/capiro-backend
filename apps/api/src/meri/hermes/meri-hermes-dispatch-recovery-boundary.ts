import {
  matchesMeriHermesRecoveryNativeResponseV1,
  meriHermesRecoveryDispositionV1,
  meriHermesRecoveryKeyBindingV1,
  meriHermesRecoveryKeysAreDistinctV1,
  mintMeriHermesRecoveryCommandV1,
  verifyMeriHermesRecoveryCommandV1,
  verifyMeriHermesRecoveryReceiptV1,
  type MeriHermesRecoveryActionV1,
  type MeriHermesRecoveryCommandClaimsV1,
  type MeriHermesRecoveryCommandKeyV1,
  type MeriHermesRecoveryReceiptClaimsV1,
  type MeriHermesRecoveryReceiptKeyV1,
} from './meri-hermes-dispatch-recovery.contract.js';
import {
  isMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestIdentityV2,
} from './meri-hermes-dispatch-intent.contract.js';

/**
 * Dormant API-side recovery coordinator.
 *
 * It registers no controller, scheduler, transport, key source, or database
 * writer. Every authority-bearing dependency is explicit. A transport error,
 * malformed/missing receipt, persistence uncertainty, or `not_found`
 * observation remains UNKNOWN.
 */

const RECOVERY_ATTEMPT_TTL_MICROS = 30_000_000n;
const POSITIVE_MICROS = /^[1-9][0-9]{0,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;

export interface MeriHermesRecoveryContextV1 {
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
  readonly workerRunId: string;
}

export interface MeriHermesRecoveryTransportRequestV1 {
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
  readonly workerRunId: string;
  readonly action: MeriHermesRecoveryActionV1;
  readonly commandToken: string;
  readonly command: Readonly<MeriHermesRecoveryCommandClaimsV1>;
  /** Frozen exact bytes whose digest is bound by `command`. */
  readonly nativeBodyBytes: Uint8Array;
}

export interface MeriHermesRecoveryTransportResponseV1 {
  readonly receiptToken: unknown;
  readonly nativeHttpStatus: unknown;
  readonly nativeResponseBodyBytes: Uint8Array;
}

export interface MeriHermesVerifiedRecoveryPersistenceV1 {
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
  readonly workerRunId: string;
  readonly commandToken: string;
  readonly commandKey: Readonly<MeriHermesRecoveryCommandKeyV1>;
  readonly receiptToken: string;
  readonly receiptKey: Readonly<MeriHermesRecoveryReceiptKeyV1>;
  /** Claims and frozen key snapshots used for this exact verification. */
  readonly verifiedCommand: Readonly<MeriHermesRecoveryCommandClaimsV1>;
  readonly verifiedReceipt: Readonly<MeriHermesRecoveryReceiptClaimsV1>;
  /** Defensive copy of the exact response bytes already matched to the receipt. */
  readonly nativeResponseBodyBytes: Uint8Array;
}

export interface MeriHermesRecoveryPersistenceOutcomeV1 {
  readonly kind: 'inserted' | 'replayed';
}

export interface MeriHermesDispatchRecoveryBoundaryDependenciesV1 {
  /** Must load one already-claimed immutable intent from authoritative state. */
  readonly resolveContext: (
    tenantId: string,
    runId: string,
  ) => Promise<MeriHermesRecoveryContextV1 | null>;
  /** Database/authority clock. The boundary never reads the process clock. */
  readonly readDbNowEpochMicros: () => Promise<string>;
  readonly resolveCommandKey: (
    binding: ReturnType<typeof meriHermesRecoveryKeyBindingV1>,
  ) => Promise<MeriHermesRecoveryCommandKeyV1>;
  readonly resolveReceiptKey: (
    binding: ReturnType<typeof meriHermesRecoveryKeyBindingV1>,
  ) => Promise<MeriHermesRecoveryReceiptKeyV1>;
  readonly transport: {
    execute(
      request: Readonly<MeriHermesRecoveryTransportRequestV1>,
    ): Promise<MeriHermesRecoveryTransportResponseV1>;
  };
  readonly persistence: {
    persistVerified(
      value: Readonly<MeriHermesVerifiedRecoveryPersistenceV1>,
    ): Promise<MeriHermesRecoveryPersistenceOutcomeV1>;
  };
}

export interface MeriHermesDispatchRecoveryInputV1 {
  readonly tenantId: string;
  readonly runId: string;
  readonly action: MeriHermesRecoveryActionV1;
  /** Stable across retries for this one logical observation/Stop operation. */
  readonly operationId: string;
  /** Fresh canonical base64url encoding of 16 bytes for this attempt. */
  readonly attemptNonce: string;
  /** Exact bytes sent to the native status/Stop endpoint. */
  readonly nativeBodyBytes: Uint8Array;
}

export type MeriHermesDispatchRecoveryResultV1 =
  | {
      readonly version: 1;
      readonly kind: 'terminal' | 'nonterminal';
      readonly receipt: Readonly<MeriHermesRecoveryReceiptClaimsV1>;
    }
  | {
      readonly version: 1;
      readonly kind: 'UNKNOWN';
      readonly reason:
        | 'invalid_request'
        | 'context_unavailable'
        | 'key_unavailable'
        | 'window_unavailable'
        | 'transport_unconfirmed'
        | 'receipt_unverified'
        | 'persistence_unconfirmed'
        | 'absence_unproven';
    };

function unknown(reason: Extract<MeriHermesDispatchRecoveryResultV1, { kind: 'UNKNOWN' }>['reason']):
MeriHermesDispatchRecoveryResultV1 {
  return Object.freeze({ version: 1, kind: 'UNKNOWN', reason });
}

function micros(value: unknown): bigint | null {
  if (typeof value !== 'string' || !POSITIVE_MICROS.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_SIGNED_INT64 ? parsed : null;
}

function minBigint(values: readonly bigint[]): bigint {
  return values.reduce((smallest, value) => value < smallest ? value : smallest);
}

function copyCommandKey(key: MeriHermesRecoveryCommandKeyV1): MeriHermesRecoveryCommandKeyV1 {
  return Object.freeze({ ...key, secret: Uint8Array.from(key.secret) });
}

function copyReceiptKey(key: MeriHermesRecoveryReceiptKeyV1): MeriHermesRecoveryReceiptKeyV1 {
  return Object.freeze({ ...key, secret: Uint8Array.from(key.secret) });
}

export class MeriHermesDispatchRecoveryBoundaryV1 {
  readonly #dependencies: MeriHermesDispatchRecoveryBoundaryDependenciesV1;

  constructor(dependencies: MeriHermesDispatchRecoveryBoundaryDependenciesV1) {
    if (!dependencies ||
        typeof dependencies.resolveContext !== 'function' ||
        typeof dependencies.readDbNowEpochMicros !== 'function' ||
        typeof dependencies.resolveCommandKey !== 'function' ||
        typeof dependencies.resolveReceiptKey !== 'function' ||
        typeof dependencies.transport?.execute !== 'function' ||
        typeof dependencies.persistence?.persistVerified !== 'function') {
      throw new Error('recovery boundary requires dedicated explicit dependencies');
    }
    this.#dependencies = dependencies;
  }

  async recover(input: MeriHermesDispatchRecoveryInputV1):
  Promise<MeriHermesDispatchRecoveryResultV1> {
    let copied: MeriHermesDispatchRecoveryInputV1;
    try {
      // Copy all caller-owned data before the first await.
      copied = Object.freeze({
        tenantId: input.tenantId,
        runId: input.runId,
        action: input.action,
        operationId: input.operationId,
        attemptNonce: input.attemptNonce,
        nativeBodyBytes: Uint8Array.from(input.nativeBodyBytes),
      });
    } catch {
      return unknown('invalid_request');
    }
    if (!UUID.test(copied.tenantId) || !UUID.test(copied.runId) ||
        (copied.action !== 'status' && copied.action !== 'stop') ||
        !UUID.test(copied.operationId) || typeof copied.attemptNonce !== 'string' ||
        !(copied.nativeBodyBytes instanceof Uint8Array) ||
        (copied.action === 'status' && copied.nativeBodyBytes.length !== 0)) {
      return unknown('invalid_request');
    }

    let context: MeriHermesRecoveryContextV1 | null;
    try {
      context = await this.#dependencies.resolveContext(copied.tenantId, copied.runId);
    } catch {
      return unknown('context_unavailable');
    }
    if (!context || !isMeriDispatchRequestIdentityV2(context.identity) ||
        context.identity.tenantId !== copied.tenantId ||
        context.identity.runId !== copied.runId ||
        typeof context.workerRunId !== 'string' ||
        context.workerRunId.length === 0 || context.workerRunId.length > 120 ||
        context.workerRunId.trim() !== context.workerRunId ||
        /[\u0000-\u001f\u007f]/.test(context.workerRunId)) {
      return unknown('context_unavailable');
    }
    const identity = Object.freeze({ ...context.identity });
    const workerRunId = context.workerRunId;
    const binding = meriHermesRecoveryKeyBindingV1(identity);

    let commandKey: MeriHermesRecoveryCommandKeyV1;
    let receiptKey: MeriHermesRecoveryReceiptKeyV1;
    let startedAt: bigint | null;
    try {
      const [resolvedCommandKey, resolvedReceiptKey, dbNow] = await Promise.all([
        this.#dependencies.resolveCommandKey(binding),
        this.#dependencies.resolveReceiptKey(binding),
        this.#dependencies.readDbNowEpochMicros(),
      ]);
      commandKey = copyCommandKey(resolvedCommandKey);
      receiptKey = copyReceiptKey(resolvedReceiptKey);
      startedAt = micros(dbNow);
    } catch {
      return unknown('key_unavailable');
    }
    if (!meriHermesRecoveryKeysAreDistinctV1(commandKey, receiptKey)) {
      return unknown('key_unavailable');
    }
    const commandKeyAfter = micros(commandKey.notAfterEpochMicros);
    const receiptKeyAfter = micros(receiptKey.notAfterEpochMicros);
    const reconciliationAfter = micros(identity.reconciliationNotAfterEpochMicros);
    const retainUntil = micros(identity.retainUntilEpochMicros);
    if (startedAt === null || commandKeyAfter === null || receiptKeyAfter === null ||
        reconciliationAfter === null || retainUntil === null) {
      return unknown('window_unavailable');
    }
    const notAfter = minBigint([
      startedAt + RECOVERY_ATTEMPT_TTL_MICROS,
      commandKeyAfter,
      receiptKeyAfter,
      reconciliationAfter,
      retainUntil,
    ]);
    if (notAfter <= startedAt) return unknown('window_unavailable');

    let commandToken: string;
    let command: MeriHermesRecoveryCommandClaimsV1 | null;
    try {
      commandToken = mintMeriHermesRecoveryCommandV1({
        identity,
        workerRunId,
        action: copied.action,
        operationId: copied.operationId,
        attemptNonce: copied.attemptNonce,
        nativeBodyBytes: copied.nativeBodyBytes,
        notBeforeEpochMicros: startedAt.toString(),
        notAfterEpochMicros: notAfter.toString(),
      }, commandKey);
      command = verifyMeriHermesRecoveryCommandV1(
        commandToken, identity, workerRunId, commandKey, startedAt.toString(),
      );
    } catch {
      return unknown('key_unavailable');
    }
    if (!command) return unknown('key_unavailable');

    let transportResponse: MeriHermesRecoveryTransportResponseV1;
    try {
      const received = await this.#dependencies.transport.execute(Object.freeze({
        identity,
        workerRunId,
        action: copied.action,
        commandToken,
        command,
        nativeBodyBytes: Uint8Array.from(copied.nativeBodyBytes),
      }));
      transportResponse = Object.freeze({
        receiptToken: received.receiptToken,
        nativeHttpStatus: received.nativeHttpStatus,
        nativeResponseBodyBytes: Uint8Array.from(received.nativeResponseBodyBytes),
      });
    } catch {
      return unknown('transport_unconfirmed');
    }

    let verifiedAt: string;
    try {
      verifiedAt = await this.#dependencies.readDbNowEpochMicros();
    } catch {
      return unknown('receipt_unverified');
    }
    const receipt = verifyMeriHermesRecoveryReceiptV1(
      transportResponse.receiptToken,
      commandToken,
      identity,
      workerRunId,
      commandKey,
      receiptKey,
      verifiedAt,
    );
    if (!receipt ||
        !matchesMeriHermesRecoveryNativeResponseV1(
          receipt,
          transportResponse.nativeHttpStatus,
          transportResponse.nativeResponseBodyBytes,
        ) ||
        typeof transportResponse.receiptToken !== 'string') {
      return unknown('receipt_unverified');
    }

    let persistence: MeriHermesRecoveryPersistenceOutcomeV1;
    try {
      persistence = await this.#dependencies.persistence.persistVerified(Object.freeze({
        identity,
        workerRunId,
        commandToken,
        commandKey,
        receiptToken: transportResponse.receiptToken,
        receiptKey,
        verifiedCommand: command,
        verifiedReceipt: receipt,
        nativeResponseBodyBytes: Uint8Array.from(transportResponse.nativeResponseBodyBytes),
      }));
    } catch {
      return unknown('persistence_unconfirmed');
    }
    if (persistence.kind !== 'inserted' && persistence.kind !== 'replayed') {
      return unknown('persistence_unconfirmed');
    }
    const disposition = meriHermesRecoveryDispositionV1(receipt);
    return disposition === 'UNKNOWN'
      ? unknown('absence_unproven')
      : Object.freeze({ version: 1, kind: disposition, receipt });
  }
}
