import {
  meriHermesRecoveryKeyBindingV1,
  meriHermesRecoveryKeysAreDistinctV1,
  type MeriHermesRecoveryCommandKeyV1,
  type MeriHermesRecoveryReceiptKeyV1,
} from './meri-hermes-dispatch-recovery.contract.js';
import {
  isMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestIdentityV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  matchesMeriHermesReservationNativeResponseV1,
  mintMeriHermesReservationCommandV1,
  verifyMeriHermesReservationCommandV1,
  verifyMeriHermesReservationReceiptV1,
  type MeriHermesReservationCommandClaimsV1,
  type MeriHermesReservationReceiptClaimsV1,
} from './meri-hermes-reservation-recovery.contract.js';
import type {
  MeriHermesReservationTransportRequestV1,
  MeriHermesReservationTransportResponseV1,
} from './meri-hermes-reservation-recovery.transport.js';

/**
 * Dormant API coordinator for a lost worker-acceptance response when no worker
 * run ID was committed. It registers no caller, scheduler, key source,
 * transport, or database writer.
 */
const ATTEMPT_TTL_MICROS = 30_000_000n;
const POSITIVE_MICROS = /^[1-9][0-9]{0,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;

export interface MeriHermesReservationRecoveryContextV1 {
  /** Exact immutable dispatch identity loaded from one authoritative intent. */
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
  /** Unknown-worker reconciliation applies only before a worker ID is bound. */
  readonly state: 'prepared';
  readonly workerRunId: null;
  /** Independently selected from the authoritative intent row. */
  readonly idempotencyKey: string;
  /** Exclusive dispatch-delivery cutoff from the authoritative intent row. */
  readonly deliveryNotBeforeEpochMicros: string;
}

export interface MeriHermesVerifiedReservationRecoveryCommitV1 {
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
  readonly idempotencyKey: string;
  readonly deliveryNotBeforeEpochMicros: string;
  readonly commandToken: string;
  readonly commandKey: Readonly<MeriHermesRecoveryCommandKeyV1>;
  readonly receiptToken: string;
  readonly receiptKey: Readonly<MeriHermesRecoveryReceiptKeyV1>;
  readonly verifiedCommand: Readonly<MeriHermesReservationCommandClaimsV1>;
  readonly verifiedReceipt: Readonly<MeriHermesReservationReceiptClaimsV1>;
}

export type MeriHermesReservationRecoveryCommitOutcomeV1 =
  | { readonly kind: 'bound_worker'; readonly workerRunId: string }
  | { readonly kind: 'sealed_absent' };

export interface MeriHermesReservationRecoveryBoundaryDependenciesV1 {
  /** Must resolve a currently unbound prepared intent; commit rechecks it under locks. */
  readonly resolveContext: (
    tenantId: string,
    runId: string,
  ) => Promise<MeriHermesReservationRecoveryContextV1 | null>;
  /** Database/authority clock. The process clock is never read. */
  readonly readDbNowEpochMicros: () => Promise<string>;
  readonly resolveCommandKey: (
    binding: ReturnType<typeof meriHermesRecoveryKeyBindingV1>,
  ) => Promise<MeriHermesRecoveryCommandKeyV1>;
  readonly resolveReceiptKey: (
    binding: ReturnType<typeof meriHermesRecoveryKeyBindingV1>,
  ) => Promise<MeriHermesRecoveryReceiptKeyV1>;
  readonly transport: {
    execute(
      request: Readonly<MeriHermesReservationTransportRequestV1>,
    ): Promise<MeriHermesReservationTransportResponseV1>;
  };
  readonly persistence: {
    commitVerified(
      value: Readonly<MeriHermesVerifiedReservationRecoveryCommitV1>,
    ): Promise<MeriHermesReservationRecoveryCommitOutcomeV1>;
  };
}

export interface MeriHermesReservationRecoveryInputV1 {
  readonly tenantId: string;
  readonly runId: string;
  /** Stable across retries for this one logical reconciliation operation. */
  readonly operationId: string;
  /** Fresh canonical base64url encoding of exactly 16 bytes. */
  readonly attemptNonce: string;
}

export type MeriHermesReservationRecoveryResultV1 =
  | {
      readonly version: 1;
      readonly kind: 'bound_worker';
      readonly workerRunId: string;
      readonly receipt: Readonly<MeriHermesReservationReceiptClaimsV1>;
    }
  | {
      readonly version: 1;
      readonly kind: 'sealed_absent';
      readonly receipt: Readonly<MeriHermesReservationReceiptClaimsV1>;
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
        | 'persistence_unconfirmed';
    };

function unknown(
  reason: Extract<MeriHermesReservationRecoveryResultV1, { kind: 'UNKNOWN' }>['reason'],
): MeriHermesReservationRecoveryResultV1 {
  return Object.freeze({ version: 1, kind: 'UNKNOWN', reason });
}

function micros(value: unknown): bigint | null {
  if (typeof value !== 'string' || !POSITIVE_MICROS.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_SIGNED_INT64 ? parsed : null;
}

function validNonce(value: unknown): value is string {
  if (typeof value !== 'string' || !NONCE.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 16 && decoded.toString('base64url') === value;
}

function minBigint(values: readonly bigint[]): bigint {
  return values.reduce((smallest, value) => value < smallest ? value : smallest);
}

function copyCommandKey(
  key: MeriHermesRecoveryCommandKeyV1,
): MeriHermesRecoveryCommandKeyV1 {
  return Object.freeze({ ...key, secret: Uint8Array.from(key.secret) });
}

function copyReceiptKey(
  key: MeriHermesRecoveryReceiptKeyV1,
): MeriHermesRecoveryReceiptKeyV1 {
  return Object.freeze({ ...key, secret: Uint8Array.from(key.secret) });
}

function exactCommitOutcome(
  receipt: Readonly<MeriHermesReservationReceiptClaimsV1>,
  committed: MeriHermesReservationRecoveryCommitOutcomeV1,
): boolean {
  return receipt.outcome === 'reserved'
    ? committed.kind === 'bound_worker' && committed.workerRunId === receipt.workerRunId
    : committed.kind === 'sealed_absent';
}

export class MeriHermesReservationRecoveryBoundaryV1 {
  readonly #dependencies: MeriHermesReservationRecoveryBoundaryDependenciesV1;

  constructor(dependencies: MeriHermesReservationRecoveryBoundaryDependenciesV1) {
    if (!dependencies || typeof dependencies.resolveContext !== 'function' ||
        typeof dependencies.readDbNowEpochMicros !== 'function' ||
        typeof dependencies.resolveCommandKey !== 'function' ||
        typeof dependencies.resolveReceiptKey !== 'function' ||
        typeof dependencies.transport?.execute !== 'function' ||
        typeof dependencies.persistence?.commitVerified !== 'function') {
      throw new Error('reservation boundary requires dedicated explicit dependencies');
    }
    this.#dependencies = dependencies;
  }

  async recover(
    input: Readonly<MeriHermesReservationRecoveryInputV1>,
  ): Promise<MeriHermesReservationRecoveryResultV1> {
    let copied: MeriHermesReservationRecoveryInputV1;
    try {
      copied = Object.freeze({
        tenantId: input.tenantId,
        runId: input.runId,
        operationId: input.operationId,
        attemptNonce: input.attemptNonce,
      });
    } catch {
      return unknown('invalid_request');
    }
    if (!UUID.test(copied.tenantId) || !UUID.test(copied.runId) ||
        !UUID.test(copied.operationId) || !validNonce(copied.attemptNonce)) {
      return unknown('invalid_request');
    }

    let context: MeriHermesReservationRecoveryContextV1 | null;
    try {
      context = await this.#dependencies.resolveContext(copied.tenantId, copied.runId);
    } catch {
      return unknown('context_unavailable');
    }
    if (!context || !isMeriDispatchRequestIdentityV2(context.identity) ||
        context.identity.tenantId !== copied.tenantId ||
        context.identity.runId !== copied.runId || context.state !== 'prepared' ||
        context.workerRunId !== null ||
        context.idempotencyKey !== context.identity.idempotencyKey ||
        context.deliveryNotBeforeEpochMicros !== context.identity.deliveryNotAfterEpochMicros) {
      return unknown('context_unavailable');
    }
    const identity = Object.freeze({ ...context.identity });
    const idempotencyKey = context.idempotencyKey;
    const deliveryNotBeforeEpochMicros = context.deliveryNotBeforeEpochMicros;
    const delivery = micros(deliveryNotBeforeEpochMicros);
    if (delivery === null) return unknown('context_unavailable');
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
    const commandKeyBefore = micros(commandKey.notBeforeEpochMicros);
    const commandKeyAfter = micros(commandKey.notAfterEpochMicros);
    const receiptKeyBefore = micros(receiptKey.notBeforeEpochMicros);
    const receiptKeyAfter = micros(receiptKey.notAfterEpochMicros);
    const reconciliationAfter = micros(identity.reconciliationNotAfterEpochMicros);
    const retainUntil = micros(identity.retainUntilEpochMicros);
    if (startedAt === null || commandKeyBefore === null || commandKeyAfter === null ||
        receiptKeyBefore === null || receiptKeyAfter === null ||
        reconciliationAfter === null || retainUntil === null || startedAt < delivery ||
        startedAt < commandKeyBefore || startedAt < receiptKeyBefore) {
      return unknown('window_unavailable');
    }
    const notAfter = minBigint([
      startedAt + ATTEMPT_TTL_MICROS,
      commandKeyAfter,
      receiptKeyAfter,
      reconciliationAfter,
      retainUntil,
    ]);
    if (notAfter <= startedAt) return unknown('window_unavailable');

    let commandToken: string;
    let command: MeriHermesReservationCommandClaimsV1 | null;
    try {
      commandToken = mintMeriHermesReservationCommandV1({
        identity,
        idempotencyKey,
        deliveryNotBeforeEpochMicros,
        operationId: copied.operationId,
        attemptNonce: copied.attemptNonce,
        notBeforeEpochMicros: startedAt.toString(),
        notAfterEpochMicros: notAfter.toString(),
      }, commandKey);
      command = verifyMeriHermesReservationCommandV1(
        commandToken, identity, commandKey, startedAt.toString(),
      );
    } catch {
      return unknown('key_unavailable');
    }
    if (!command || command.idempotencyKey !== idempotencyKey ||
        command.deliveryNotBeforeEpochMicros !== deliveryNotBeforeEpochMicros) {
      return unknown('key_unavailable');
    }

    let transportResponse: MeriHermesReservationTransportResponseV1;
    try {
      const received = await this.#dependencies.transport.execute(Object.freeze({
        identity,
        commandToken,
        command,
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
    const receipt = verifyMeriHermesReservationReceiptV1(
      transportResponse.receiptToken,
      commandToken,
      identity,
      commandKey,
      receiptKey,
      verifiedAt,
    );
    if (!receipt || !matchesMeriHermesReservationNativeResponseV1(
      receipt,
      transportResponse.nativeHttpStatus,
      transportResponse.nativeResponseBodyBytes,
    )) {
      return unknown('receipt_unverified');
    }

    let committed: MeriHermesReservationRecoveryCommitOutcomeV1;
    try {
      committed = await this.#dependencies.persistence.commitVerified(Object.freeze({
        identity,
        idempotencyKey,
        deliveryNotBeforeEpochMicros,
        commandToken,
        commandKey,
        receiptToken: transportResponse.receiptToken,
        receiptKey,
        verifiedCommand: command,
        verifiedReceipt: receipt,
      }));
    } catch {
      return unknown('persistence_unconfirmed');
    }
    if (!exactCommitOutcome(receipt, committed)) {
      return unknown('persistence_unconfirmed');
    }
    return receipt.outcome === 'reserved'
      ? Object.freeze({
          version: 1,
          kind: 'bound_worker',
          workerRunId: receipt.workerRunId!,
          receipt,
        })
      : Object.freeze({ version: 1, kind: 'sealed_absent', receipt });
  }
}
