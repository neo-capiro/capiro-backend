import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  isMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestIdentityV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
  MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
  meriHermesRecoveryKeysAreDistinctV1,
  type MeriHermesRecoveryCommandKeyV1,
  type MeriHermesRecoveryReceiptKeyV1,
  type MeriHermesRecoveryWorkerStatusV1,
} from './meri-hermes-dispatch-recovery.contract.js';

/** Dormant API peer of the worker's unknown-ID reservation/seal protocol. */
export const MERI_HERMES_RESERVATION_RECOVERY_VERSION = 1 as const;
export const MERI_HERMES_RESERVATION_COMMAND_PURPOSE =
  'meri-hermes-reservation-command' as const;
export const MERI_HERMES_RESERVATION_RECEIPT_PURPOSE =
  'meri-hermes-reservation-receipt' as const;
export const MERI_HERMES_RESERVATION_NATIVE_PATH =
  '/v1/meri/phase4/reservations/lookup-or-seal' as const;

const COMMAND_PREFIX = 'mhrqc1';
const RECEIPT_PREFIX = 'mhrqr1';
const COMMAND_DOMAIN = 'capiro.meri.phase4.reservation-command/v1\0';
const RECEIPT_DOMAIN = 'capiro.meri.phase4.reservation-receipt/v1\0';
const MAX_TOKEN_BYTES = 8192;
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
const MAX_COMMAND_TTL_MICROS = 60_000_000n;
const POSITIVE_MICROS = /^[1-9][0-9]{0,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROUTE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ATTEMPT_NONCE = /^[A-Za-z0-9_-]{22}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
const WORKER_RUN_ID = /^[\x21-\x7e]{1,120}$/;
const EMPTY_SHA256 = createHash('sha256').update(new Uint8Array()).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });
const WORKER_STATUSES = new Set<MeriHermesRecoveryWorkerStatusV1>([
  'queued', 'provisioning', 'running', 'waiting_for_approval',
  'waiting_for_clarification', 'cancelling', 'completed', 'cancelled',
  'failed', 'interrupted', 'expired',
]);

export type MeriHermesReservationOutcomeV1 = 'reserved' | 'sealed_absent';

export interface MintMeriHermesReservationCommandV1 {
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
  readonly idempotencyKey: string;
  readonly deliveryNotBeforeEpochMicros: string;
  readonly operationId: string;
  readonly attemptNonce: string;
  readonly notBeforeEpochMicros: string;
  readonly notAfterEpochMicros: string;
}

export interface MeriHermesReservationCommandClaimsV1 {
  readonly version: 1;
  readonly purpose: typeof MERI_HERMES_RESERVATION_COMMAND_PURPOSE;
  readonly keyId: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly requestSha256: string;
  readonly workerAudience: string;
  readonly workerIngressId: string;
  readonly workerGeneration: string;
  readonly workerCredentialId: string;
  readonly idempotencyKey: string;
  readonly deliveryNotBeforeEpochMicros: string;
  readonly reconciliationNotAfterEpochMicros: string;
  readonly retainUntilEpochMicros: string;
  readonly operationId: string;
  readonly attemptNonce: string;
  readonly nativeMethod: 'POST';
  readonly nativePath: typeof MERI_HERMES_RESERVATION_NATIVE_PATH;
  readonly nativeBodySha256: string;
  readonly notBeforeEpochMicros: string;
  readonly notAfterEpochMicros: string;
}

export interface MeriHermesReservationReceiptClaimsV1 {
  readonly version: 1;
  readonly purpose: typeof MERI_HERMES_RESERVATION_RECEIPT_PURPOSE;
  readonly keyId: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly requestSha256: string;
  readonly workerAudience: string;
  readonly workerIngressId: string;
  readonly workerGeneration: string;
  readonly workerCredentialId: string;
  readonly idempotencyKey: string;
  readonly deliveryNotBeforeEpochMicros: string;
  readonly retainUntilEpochMicros: string;
  readonly operationId: string;
  readonly attemptNonce: string;
  readonly commandSha256: string;
  readonly nativeMethod: 'POST';
  readonly nativePath: typeof MERI_HERMES_RESERVATION_NATIVE_PATH;
  readonly nativeBodySha256: string;
  readonly nativeHttpStatus: 200;
  readonly nativeResponseBodySha256: string;
  readonly outcome: MeriHermesReservationOutcomeV1;
  readonly workerRunId: string | null;
  readonly workerStatus: MeriHermesRecoveryWorkerStatusV1 | null;
  readonly sealedAtEpochMicros: string | null;
  readonly observedAtEpochMicros: string;
  readonly notBeforeEpochMicros: string;
  readonly notAfterEpochMicros: string;
}

function micros(value: unknown): bigint | null {
  if (typeof value !== 'string' || !POSITIVE_MICROS.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_SIGNED_INT64 ? parsed : null;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validNonce(value: unknown): value is string {
  if (typeof value !== 'string' || !ATTEMPT_NONCE.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 16 && bytes.toString('base64url') === value;
}

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY.test(value) && value.trim() === value;
}

function validWorkerRunId(value: unknown): value is string {
  return typeof value === 'string' && WORKER_RUN_ID.test(value) && value.trim() === value;
}

function keyBinding(identity: Readonly<MeriDispatchRequestIdentityV2>) {
  return {
    tenantId: identity.tenantId,
    workerAudience: identity.workerAudience,
    workerIngressId: identity.workerIngressId,
    workerGeneration: identity.workerGeneration,
    workerCredentialId: identity.workerCredentialId,
  };
}

function validKey(
  value: unknown,
  identity: Readonly<MeriDispatchRequestIdentityV2>,
  purpose: typeof MERI_HERMES_RECOVERY_COMMAND_PURPOSE |
    typeof MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
): value is MeriHermesRecoveryCommandKeyV1 | MeriHermesRecoveryReceiptKeyV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const binding = keyBinding(identity);
  const keys = Object.keys(row);
  const expected = new Set([
    'purpose', 'keyId', 'tenantId', 'workerAudience', 'workerIngressId',
    'workerGeneration', 'workerCredentialId', 'secret',
    'notBeforeEpochMicros', 'notAfterEpochMicros',
  ]);
  const before = micros(row.notBeforeEpochMicros);
  const after = micros(row.notAfterEpochMicros);
  return keys.length === expected.size && keys.every((key) => expected.has(key)) &&
    row.purpose === purpose && typeof row.keyId === 'string' && KEY_ID.test(row.keyId) &&
    row.tenantId === binding.tenantId && row.workerAudience === binding.workerAudience &&
    row.workerIngressId === binding.workerIngressId &&
    row.workerGeneration === binding.workerGeneration &&
    row.workerCredentialId === binding.workerCredentialId &&
    row.secret instanceof Uint8Array && row.secret.length >= 32 &&
    before !== null && after !== null && before < after &&
    ROUTE_TOKEN.test(binding.workerAudience) && ROUTE_TOKEN.test(binding.workerIngressId) &&
    ROUTE_TOKEN.test(binding.workerGeneration) && ROUTE_TOKEN.test(binding.workerCredentialId);
}

function commandClaims(
  material: Readonly<MintMeriHermesReservationCommandV1>, keyId: string,
): MeriHermesReservationCommandClaimsV1 {
  const identity = material.identity;
  return {
    version: 1,
    purpose: MERI_HERMES_RESERVATION_COMMAND_PURPOSE,
    keyId,
    tenantId: identity.tenantId,
    runId: identity.runId,
    requestSha256: identity.requestSha256,
    workerAudience: identity.workerAudience,
    workerIngressId: identity.workerIngressId,
    workerGeneration: identity.workerGeneration,
    workerCredentialId: identity.workerCredentialId,
    idempotencyKey: material.idempotencyKey,
    deliveryNotBeforeEpochMicros: material.deliveryNotBeforeEpochMicros,
    reconciliationNotAfterEpochMicros: identity.reconciliationNotAfterEpochMicros,
    retainUntilEpochMicros: identity.retainUntilEpochMicros,
    operationId: material.operationId,
    attemptNonce: material.attemptNonce,
    nativeMethod: 'POST',
    nativePath: MERI_HERMES_RESERVATION_NATIVE_PATH,
    nativeBodySha256: EMPTY_SHA256,
    notBeforeEpochMicros: material.notBeforeEpochMicros,
    notAfterEpochMicros: material.notAfterEpochMicros,
  };
}

function validCommandWindow(
  claims: Readonly<MeriHermesReservationCommandClaimsV1>,
  identity: Readonly<MeriDispatchRequestIdentityV2>,
  key: MeriHermesRecoveryCommandKeyV1,
  nowEpochMicros: string,
): boolean {
  const before = micros(claims.notBeforeEpochMicros);
  const after = micros(claims.notAfterEpochMicros);
  const now = micros(nowEpochMicros);
  const delivery = micros(claims.deliveryNotBeforeEpochMicros);
  const reconcile = micros(identity.reconciliationNotAfterEpochMicros);
  const retain = micros(identity.retainUntilEpochMicros);
  const keyBefore = micros(key.notBeforeEpochMicros);
  const keyAfter = micros(key.notAfterEpochMicros);
  return before !== null && after !== null && now !== null && delivery !== null &&
    reconcile !== null && retain !== null && keyBefore !== null && keyAfter !== null &&
    delivery < reconcile && reconcile <= retain && delivery <= before && before <= now &&
    now < after && after <= reconcile && after - before <= MAX_COMMAND_TTL_MICROS &&
    keyBefore <= before && after <= keyAfter;
}

function canonicalSegment(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !BASE64URL.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length > 0 && bytes.toString('base64url') === value ? bytes : null;
}

function sign(prefix: string, domain: string, payload: string, secret: Uint8Array): Buffer {
  return createHmac('sha256', Uint8Array.from(secret))
    .update(domain, 'utf8').update(`${prefix}.${payload}`, 'ascii').digest();
}

function encodeToken(prefix: string, domain: string, value: unknown, secret: Uint8Array): string {
  const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${prefix}.${payload}.${sign(prefix, domain, payload, secret).toString('base64url')}`;
}

function decodeToken(token: unknown, prefix: string): {
  readonly encoded: string; readonly payload: Buffer; readonly signature: Buffer;
} | null {
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const payload = canonicalSegment(parts[1]);
  const signature = canonicalSegment(parts[2]);
  return payload && signature?.length === 32
    ? { encoded: parts[1]!, payload, signature } : null;
}

export function mintMeriHermesReservationCommandV1(
  material: Readonly<MintMeriHermesReservationCommandV1>,
  key: MeriHermesRecoveryCommandKeyV1,
): string {
  if (!isMeriDispatchRequestIdentityV2(material.identity) ||
      !validIdempotencyKey(material.idempotencyKey) ||
      micros(material.deliveryNotBeforeEpochMicros) === null ||
      !UUID.test(material.operationId) || !validNonce(material.attemptNonce) ||
      !validKey(key, material.identity, MERI_HERMES_RECOVERY_COMMAND_PURPOSE)) {
    throw new Error('invalid Phase 4 reservation command material');
  }
  const claims = commandClaims(material, key.keyId);
  if (!validCommandWindow(claims, material.identity, key, claims.notBeforeEpochMicros)) {
    throw new Error('invalid Phase 4 reservation command window');
  }
  return encodeToken(COMMAND_PREFIX, COMMAND_DOMAIN, claims, key.secret);
}

export function verifyMeriHermesReservationCommandV1(
  token: unknown,
  identity: Readonly<MeriDispatchRequestIdentityV2>,
  key: MeriHermesRecoveryCommandKeyV1,
  dbNowEpochMicros: string,
): MeriHermesReservationCommandClaimsV1 | null {
  if (!isMeriDispatchRequestIdentityV2(identity) ||
      !validKey(key, identity, MERI_HERMES_RECOVERY_COMMAND_PURPOSE)) return null;
  const decoded = decodeToken(token, COMMAND_PREFIX);
  if (!decoded) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(decoder.decode(decoded.payload)); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (!validIdempotencyKey(row.idempotencyKey) ||
      micros(row.deliveryNotBeforeEpochMicros) === null ||
      typeof row.operationId !== 'string' || !UUID.test(row.operationId) ||
      !validNonce(row.attemptNonce) || typeof row.notBeforeEpochMicros !== 'string' ||
      typeof row.notAfterEpochMicros !== 'string') return null;
  const expected = commandClaims({
    identity,
    idempotencyKey: row.idempotencyKey,
    deliveryNotBeforeEpochMicros: row.deliveryNotBeforeEpochMicros as string,
    operationId: row.operationId,
    attemptNonce: row.attemptNonce,
    notBeforeEpochMicros: row.notBeforeEpochMicros,
    notAfterEpochMicros: row.notAfterEpochMicros,
  }, key.keyId);
  if (decoder.decode(decoded.payload) !== JSON.stringify(expected) ||
      !validCommandWindow(expected, identity, key, dbNowEpochMicros)) return null;
  const expectedSignature = sign(COMMAND_PREFIX, COMMAND_DOMAIN, decoded.encoded, key.secret);
  return timingSafeEqual(decoded.signature, expectedSignature) ? Object.freeze(expected) : null;
}

export function matchesMeriHermesReservationNativeRequestV1(
  command: Readonly<MeriHermesReservationCommandClaimsV1>, method: unknown,
  path: unknown, query: unknown, bodyBytes: Uint8Array,
): boolean {
  return method === 'POST' && path === MERI_HERMES_RESERVATION_NATIVE_PATH &&
    query === '' && bodyBytes instanceof Uint8Array && bodyBytes.length === 0 &&
    command.nativeMethod === method && command.nativePath === path &&
    command.nativeBodySha256 === EMPTY_SHA256;
}

function receiptClaims(
  command: Readonly<MeriHermesReservationCommandClaimsV1>, commandSha256: string,
  row: Readonly<Record<string, unknown>>, keyId: string,
): MeriHermesReservationReceiptClaimsV1 {
  return {
    version: 1,
    purpose: MERI_HERMES_RESERVATION_RECEIPT_PURPOSE,
    keyId,
    tenantId: command.tenantId,
    runId: command.runId,
    requestSha256: command.requestSha256,
    workerAudience: command.workerAudience,
    workerIngressId: command.workerIngressId,
    workerGeneration: command.workerGeneration,
    workerCredentialId: command.workerCredentialId,
    idempotencyKey: command.idempotencyKey,
    deliveryNotBeforeEpochMicros: command.deliveryNotBeforeEpochMicros,
    retainUntilEpochMicros: command.retainUntilEpochMicros,
    operationId: command.operationId,
    attemptNonce: command.attemptNonce,
    commandSha256,
    nativeMethod: command.nativeMethod,
    nativePath: command.nativePath,
    nativeBodySha256: command.nativeBodySha256,
    nativeHttpStatus: row.nativeHttpStatus as 200,
    nativeResponseBodySha256: row.nativeResponseBodySha256 as string,
    outcome: row.outcome as MeriHermesReservationOutcomeV1,
    workerRunId: row.workerRunId as string | null,
    workerStatus: row.workerStatus as MeriHermesRecoveryWorkerStatusV1 | null,
    sealedAtEpochMicros: row.sealedAtEpochMicros as string | null,
    observedAtEpochMicros: row.observedAtEpochMicros as string,
    notBeforeEpochMicros: command.notBeforeEpochMicros,
    notAfterEpochMicros: command.notAfterEpochMicros,
  };
}

function validReceiptOutcome(row: Readonly<Record<string, unknown>>): boolean {
  if (row.nativeHttpStatus !== 200) return false;
  if (row.outcome === 'reserved') {
    return validWorkerRunId(row.workerRunId) && typeof row.workerStatus === 'string' &&
      WORKER_STATUSES.has(row.workerStatus as MeriHermesRecoveryWorkerStatusV1) &&
      row.sealedAtEpochMicros === null;
  }
  return row.outcome === 'sealed_absent' && row.workerRunId === null &&
    row.workerStatus === null && micros(row.sealedAtEpochMicros) !== null;
}

export function verifyMeriHermesReservationReceiptV1(
  token: unknown, commandToken: unknown,
  identity: Readonly<MeriDispatchRequestIdentityV2>,
  commandKey: MeriHermesRecoveryCommandKeyV1,
  receiptKey: MeriHermesRecoveryReceiptKeyV1,
  dbNowEpochMicros: string,
): MeriHermesReservationReceiptClaimsV1 | null {
  if (!meriHermesRecoveryKeysAreDistinctV1(commandKey, receiptKey)) return null;
  const command = verifyMeriHermesReservationCommandV1(
    commandToken, identity, commandKey, dbNowEpochMicros);
  if (!command || typeof commandToken !== 'string' ||
      !validKey(receiptKey, identity, MERI_HERMES_RECOVERY_RECEIPT_PURPOSE)) return null;
  const decoded = decodeToken(token, RECEIPT_PREFIX);
  if (!decoded) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(decoder.decode(decoded.payload)); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (!validReceiptOutcome(row) || typeof row.nativeResponseBodySha256 !== 'string' ||
      !SHA256.test(row.nativeResponseBodySha256) ||
      micros(row.observedAtEpochMicros) === null) return null;
  const expected = receiptClaims(
    command, sha256(Buffer.from(commandToken, 'ascii')), row, receiptKey.keyId);
  const observed = micros(expected.observedAtEpochMicros)!;
  const now = micros(dbNowEpochMicros);
  const keyBefore = micros(receiptKey.notBeforeEpochMicros);
  const keyAfter = micros(receiptKey.notAfterEpochMicros);
  if (decoder.decode(decoded.payload) !== JSON.stringify(expected) || now === null ||
      keyBefore === null || keyAfter === null || observed > now ||
      observed < BigInt(command.notBeforeEpochMicros) ||
      observed >= BigInt(command.notAfterEpochMicros) ||
      BigInt(command.notBeforeEpochMicros) < keyBefore ||
      BigInt(command.notAfterEpochMicros) > keyAfter) return null;
  if (expected.outcome === 'sealed_absent' &&
      !(BigInt(command.deliveryNotBeforeEpochMicros) <= BigInt(expected.sealedAtEpochMicros!) &&
        BigInt(expected.sealedAtEpochMicros!) <= observed &&
        BigInt(expected.sealedAtEpochMicros!) < BigInt(command.retainUntilEpochMicros))) return null;
  const signature = sign(RECEIPT_PREFIX, RECEIPT_DOMAIN, decoded.encoded, receiptKey.secret);
  return timingSafeEqual(decoded.signature, signature) ? Object.freeze(expected) : null;
}

export function matchesMeriHermesReservationNativeResponseV1(
  receipt: Readonly<MeriHermesReservationReceiptClaimsV1>,
  httpStatus: unknown, bodyBytes: Uint8Array,
): boolean {
  return httpStatus === receipt.nativeHttpStatus && bodyBytes instanceof Uint8Array &&
    sha256(bodyBytes) === receipt.nativeResponseBodySha256;
}
