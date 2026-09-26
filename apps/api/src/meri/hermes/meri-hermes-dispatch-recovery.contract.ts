import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  isMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestIdentityV2,
} from './meri-hermes-dispatch-intent.contract.js';

/**
 * Dormant Phase 4 status/Stop recovery cryptographic contract.
 *
 * This file registers no route, provider, scheduler, or Nest dependency. A
 * command authorizes only one exact native status/Stop request. A receipt is
 * an authenticated worker observation, not execution authority and not proof
 * of effect absence. In particular, `not_found` and a missing/transport-failed
 * receipt remain UNKNOWN, while `stop_accepted` is explicitly nonterminal.
 */

export const MERI_HERMES_RECOVERY_VERSION = 1 as const;
export const MERI_HERMES_RECOVERY_COMMAND_PURPOSE =
  'meri-hermes-recovery-command' as const;
export const MERI_HERMES_RECOVERY_RECEIPT_PURPOSE =
  'meri-hermes-recovery-receipt' as const;

const COMMAND_PREFIX = 'mhrc1';
const RECEIPT_PREFIX = 'mhrr1';
const COMMAND_DOMAIN = 'capiro.meri.phase4.recovery-command/v1\0';
const RECEIPT_DOMAIN = 'capiro.meri.phase4.recovery-receipt/v1\0';
const MAX_TOKEN_BYTES = 8192;
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
const MAX_COMMAND_TTL_MICROS = 60_000_000n;
const POSITIVE_MICROS = /^[1-9][0-9]{0,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROUTE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const WORKER_RUN_ID = /^[\x21-\x7e]{1,120}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ATTEMPT_NONCE = /^[A-Za-z0-9_-]{22}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const EMPTY_SHA256 = createHash('sha256').update(new Uint8Array()).digest('hex');

export type MeriHermesRecoveryActionV1 = 'status' | 'stop';
export type MeriHermesRecoveryNativeMethodV1 = 'GET' | 'POST';
export type MeriHermesRecoveryNonterminalStatusV1 =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_clarification'
  | 'cancelling';
export type MeriHermesRecoveryTerminalStatusV1 =
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted'
  | 'expired';
export type MeriHermesRecoveryWorkerStatusV1 =
  | MeriHermesRecoveryNonterminalStatusV1
  | MeriHermesRecoveryTerminalStatusV1;
export type MeriHermesRecoveryObservationV1 =
  | 'run_nonterminal'
  | 'run_terminal'
  | 'stop_accepted'
  | 'not_found';

const NONTERMINAL = new Set<MeriHermesRecoveryWorkerStatusV1>([
  'queued', 'provisioning', 'running', 'waiting_for_approval',
  'waiting_for_clarification', 'cancelling',
]);
const TERMINAL = new Set<MeriHermesRecoveryWorkerStatusV1>([
  'completed', 'cancelled', 'failed', 'interrupted', 'expired',
]);

export interface MeriHermesRecoveryKeyBindingV1 {
  readonly tenantId: string;
  readonly workerAudience: string;
  readonly workerIngressId: string;
  readonly workerGeneration: string;
  readonly workerCredentialId: string;
}

interface MeriHermesRecoveryKeyBaseV1 extends MeriHermesRecoveryKeyBindingV1 {
  readonly keyId: string;
  readonly secret: Uint8Array;
  readonly notBeforeEpochMicros: string;
  readonly notAfterEpochMicros: string;
}

/** API-to-worker command key. Provision independently from every other key. */
export interface MeriHermesRecoveryCommandKeyV1 extends MeriHermesRecoveryKeyBaseV1 {
  readonly purpose: typeof MERI_HERMES_RECOVERY_COMMAND_PURPOSE;
}

/** Worker-to-API receipt key. It must not reuse the command-key secret. */
export interface MeriHermesRecoveryReceiptKeyV1 extends MeriHermesRecoveryKeyBaseV1 {
  readonly purpose: typeof MERI_HERMES_RECOVERY_RECEIPT_PURPOSE;
}

/** Fail-closed provisioning check before any recovery network request. */
export function meriHermesRecoveryKeysAreDistinctV1(
  commandKey: Pick<MeriHermesRecoveryCommandKeyV1, 'secret'>,
  receiptKey: Pick<MeriHermesRecoveryReceiptKeyV1, 'secret'>,
): boolean {
  if (!(commandKey?.secret instanceof Uint8Array) ||
      !(receiptKey?.secret instanceof Uint8Array)) return false;
  const commandSecretDigest = createHash('sha256').update(commandKey.secret).digest();
  const receiptSecretDigest = createHash('sha256').update(receiptKey.secret).digest();
  return !timingSafeEqual(commandSecretDigest, receiptSecretDigest);
}

export interface MintMeriHermesRecoveryCommandV1 {
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
  readonly workerRunId: string;
  readonly action: MeriHermesRecoveryActionV1;
  /** Stable across retries for one logical status/Stop operation. */
  readonly operationId: string;
  /** Canonical base64url encoding of exactly 16 fresh attempt bytes. */
  readonly attemptNonce: string;
  /** Exact bytes sent to the native endpoint; GET status must use no body. */
  readonly nativeBodyBytes: Uint8Array;
  readonly notBeforeEpochMicros: string;
  /** Exclusive command/receipt deadline. */
  readonly notAfterEpochMicros: string;
}

export interface MeriHermesRecoveryCommandClaimsV1 {
  readonly version: typeof MERI_HERMES_RECOVERY_VERSION;
  readonly purpose: typeof MERI_HERMES_RECOVERY_COMMAND_PURPOSE;
  readonly keyId: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly requestSha256: string;
  readonly workerRunId: string;
  readonly workerAudience: string;
  readonly workerIngressId: string;
  readonly workerGeneration: string;
  readonly workerCredentialId: string;
  readonly action: MeriHermesRecoveryActionV1;
  readonly operationId: string;
  readonly attemptNonce: string;
  readonly nativeMethod: MeriHermesRecoveryNativeMethodV1;
  readonly nativePath: string;
  readonly nativeBodySha256: string;
  readonly notBeforeEpochMicros: string;
  readonly notAfterEpochMicros: string;
}

export interface MintMeriHermesRecoveryReceiptV1 {
  /** Exact command token already verified by the worker. */
  readonly commandToken: string;
  readonly command: Readonly<MeriHermesRecoveryCommandClaimsV1>;
  readonly observation: MeriHermesRecoveryObservationV1;
  readonly workerStatus: MeriHermesRecoveryWorkerStatusV1 | null;
  readonly nativeHttpStatus: number;
  /** Exact native response bytes from which the observation was normalized. */
  readonly nativeResponseBodyBytes: Uint8Array;
  /** Explicit trusted worker observation time; this module reads no clock. */
  readonly observedAtEpochMicros: string;
}

export interface MeriHermesRecoveryReceiptClaimsV1 {
  readonly version: typeof MERI_HERMES_RECOVERY_VERSION;
  readonly purpose: typeof MERI_HERMES_RECOVERY_RECEIPT_PURPOSE;
  readonly keyId: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly requestSha256: string;
  readonly workerRunId: string;
  readonly workerAudience: string;
  readonly workerIngressId: string;
  readonly workerGeneration: string;
  readonly workerCredentialId: string;
  readonly action: MeriHermesRecoveryActionV1;
  readonly operationId: string;
  readonly attemptNonce: string;
  readonly commandSha256: string;
  readonly nativeMethod: MeriHermesRecoveryNativeMethodV1;
  readonly nativePath: string;
  readonly nativeBodySha256: string;
  readonly nativeHttpStatus: number;
  readonly nativeResponseBodySha256: string;
  readonly observation: MeriHermesRecoveryObservationV1;
  readonly workerStatus: MeriHermesRecoveryWorkerStatusV1 | null;
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

function validWorkerRunId(value: unknown): value is string {
  return typeof value === 'string' && WORKER_RUN_ID.test(value) && value.trim() === value;
}

function validAttemptNonce(value: unknown): value is string {
  if (typeof value !== 'string' || !ATTEMPT_NONCE.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 16 && bytes.toString('base64url') === value;
}

function keyBinding(identity: Readonly<MeriDispatchRequestIdentityV2>): MeriHermesRecoveryKeyBindingV1 {
  return {
    tenantId: identity.tenantId,
    workerAudience: identity.workerAudience,
    workerIngressId: identity.workerIngressId,
    workerGeneration: identity.workerGeneration,
    workerCredentialId: identity.workerCredentialId,
  };
}

function validBinding(binding: Readonly<MeriHermesRecoveryKeyBindingV1>): boolean {
  return UUID.test(binding.tenantId) && ROUTE_TOKEN.test(binding.workerAudience) &&
    ROUTE_TOKEN.test(binding.workerIngressId) && ROUTE_TOKEN.test(binding.workerGeneration) &&
    ROUTE_TOKEN.test(binding.workerCredentialId);
}

export function meriHermesRecoveryKeyBindingV1(
  identity: Readonly<MeriDispatchRequestIdentityV2>,
): Readonly<MeriHermesRecoveryKeyBindingV1> {
  if (!isMeriDispatchRequestIdentityV2(identity)) {
    throw new Error('invalid Phase 4 recovery identity');
  }
  const binding = keyBinding(identity);
  if (!validBinding(binding)) throw new Error('invalid Phase 4 recovery route binding');
  return Object.freeze(binding);
}

function validKey(
  value: unknown,
  binding: Readonly<MeriHermesRecoveryKeyBindingV1>,
  purpose: typeof MERI_HERMES_RECOVERY_COMMAND_PURPOSE |
    typeof MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
): value is MeriHermesRecoveryCommandKeyV1 | MeriHermesRecoveryReceiptKeyV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const expectedKeys = new Set([
    'purpose', 'keyId', 'tenantId', 'workerAudience', 'workerIngressId',
    'workerGeneration', 'workerCredentialId', 'secret',
    'notBeforeEpochMicros', 'notAfterEpochMicros',
  ]);
  const keys = Object.keys(row);
  const before = micros(row.notBeforeEpochMicros);
  const after = micros(row.notAfterEpochMicros);
  return validBinding(binding) && keys.length === expectedKeys.size &&
    keys.every((key) => expectedKeys.has(key)) &&
    row.purpose === purpose &&
    typeof row.keyId === 'string' && KEY_ID.test(row.keyId) &&
    row.tenantId === binding.tenantId &&
    row.workerAudience === binding.workerAudience &&
    row.workerIngressId === binding.workerIngressId &&
    row.workerGeneration === binding.workerGeneration &&
    row.workerCredentialId === binding.workerCredentialId &&
    row.secret instanceof Uint8Array && row.secret.length >= 32 &&
    before !== null && after !== null && before < after;
}

function nativeMethod(action: MeriHermesRecoveryActionV1): MeriHermesRecoveryNativeMethodV1 {
  return action === 'status' ? 'GET' : 'POST';
}

function nativePath(action: MeriHermesRecoveryActionV1, workerRunId: string): string {
  const run = encodeURIComponent(workerRunId);
  return action === 'status' ? `/v1/runs/${run}` : `/v1/runs/${run}/stop`;
}

function commandClaims(
  material: Omit<MintMeriHermesRecoveryCommandV1, 'nativeBodyBytes'>,
  nativeBodySha256: string,
  keyId: string,
): MeriHermesRecoveryCommandClaimsV1 {
  const { identity } = material;
  return {
    version: MERI_HERMES_RECOVERY_VERSION,
    purpose: MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
    keyId,
    tenantId: identity.tenantId,
    runId: identity.runId,
    requestSha256: identity.requestSha256,
    workerRunId: material.workerRunId,
    workerAudience: identity.workerAudience,
    workerIngressId: identity.workerIngressId,
    workerGeneration: identity.workerGeneration,
    workerCredentialId: identity.workerCredentialId,
    action: material.action,
    operationId: material.operationId,
    attemptNonce: material.attemptNonce,
    nativeMethod: nativeMethod(material.action),
    nativePath: nativePath(material.action, material.workerRunId),
    nativeBodySha256,
    notBeforeEpochMicros: material.notBeforeEpochMicros,
    notAfterEpochMicros: material.notAfterEpochMicros,
  };
}

function validCommandWindow(
  claims: Readonly<MeriHermesRecoveryCommandClaimsV1>,
  identity: Readonly<MeriDispatchRequestIdentityV2>,
  key: MeriHermesRecoveryCommandKeyV1,
  nowEpochMicros: string,
): boolean {
  const before = micros(claims.notBeforeEpochMicros);
  const after = micros(claims.notAfterEpochMicros);
  const now = micros(nowEpochMicros);
  const keyBefore = micros(key.notBeforeEpochMicros);
  const keyAfter = micros(key.notAfterEpochMicros);
  return before !== null && after !== null && now !== null &&
    keyBefore !== null && keyAfter !== null && before < after &&
    after - before <= MAX_COMMAND_TTL_MICROS &&
    before >= keyBefore && after <= keyAfter &&
    after <= BigInt(identity.reconciliationNotAfterEpochMicros) &&
    after <= BigInt(identity.retainUntilEpochMicros) &&
    now >= before && now < after;
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
  readonly encoded: string;
  readonly payload: Buffer;
  readonly signature: Buffer;
} | null {
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const payload = canonicalSegment(parts[1]);
  const signature = canonicalSegment(parts[2]);
  if (!payload || !signature || signature.length !== 32) return null;
  return { encoded: parts[1]!, payload, signature };
}

/** All time inputs are explicit trusted epoch microseconds; no process clock is read. */
export function mintMeriHermesRecoveryCommandV1(
  material: MintMeriHermesRecoveryCommandV1,
  key: MeriHermesRecoveryCommandKeyV1,
): string {
  if (!isMeriDispatchRequestIdentityV2(material.identity) ||
      !validWorkerRunId(material.workerRunId) ||
      (material.action !== 'status' && material.action !== 'stop') ||
      !UUID.test(material.operationId) || !validAttemptNonce(material.attemptNonce) ||
      !(material.nativeBodyBytes instanceof Uint8Array) ||
      (material.action === 'status' && material.nativeBodyBytes.length !== 0) ||
      !validKey(key, keyBinding(material.identity), MERI_HERMES_RECOVERY_COMMAND_PURPOSE)) {
    throw new Error('invalid Phase 4 recovery command material');
  }
  const claims = commandClaims(material, sha256(material.nativeBodyBytes), key.keyId);
  if (!validCommandWindow(claims, material.identity, key, claims.notBeforeEpochMicros)) {
    throw new Error('invalid Phase 4 recovery command window');
  }
  return encodeToken(COMMAND_PREFIX, COMMAND_DOMAIN, claims, key.secret);
}

/** Strict API/reference verification against the immutable dispatch identity. */
export function verifyMeriHermesRecoveryCommandV1(
  token: unknown,
  identity: Readonly<MeriDispatchRequestIdentityV2>,
  expectedWorkerRunId: string,
  key: MeriHermesRecoveryCommandKeyV1,
  dbNowEpochMicros: string,
): MeriHermesRecoveryCommandClaimsV1 | null {
  if (!isMeriDispatchRequestIdentityV2(identity) || !validWorkerRunId(expectedWorkerRunId) ||
      !validKey(key, keyBinding(identity), MERI_HERMES_RECOVERY_COMMAND_PURPOSE)) return null;
  const decoded = decodeToken(token, COMMAND_PREFIX);
  if (!decoded) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(decoded.payload));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if ((row.action !== 'status' && row.action !== 'stop') ||
      typeof row.operationId !== 'string' || !UUID.test(row.operationId) ||
      !validAttemptNonce(row.attemptNonce) ||
      typeof row.nativeBodySha256 !== 'string' || !SHA256.test(row.nativeBodySha256) ||
      (row.action === 'status' && row.nativeBodySha256 !== EMPTY_SHA256) ||
      typeof row.notBeforeEpochMicros !== 'string' ||
      typeof row.notAfterEpochMicros !== 'string') return null;
  const expected = commandClaims({
    identity,
    workerRunId: expectedWorkerRunId,
    action: row.action,
    operationId: row.operationId,
    attemptNonce: row.attemptNonce,
    notBeforeEpochMicros: row.notBeforeEpochMicros,
    notAfterEpochMicros: row.notAfterEpochMicros,
  }, row.nativeBodySha256, key.keyId);
  // Exact re-encoding rejects duplicate/unknown keys, reordered fields, and
  // alternate JSON spellings even when an otherwise valid signer produced it.
  if (decoder.decode(decoded.payload) !== JSON.stringify(expected) ||
      !validCommandWindow(expected, identity, key, dbNowEpochMicros)) return null;
  const signature = sign(COMMAND_PREFIX, COMMAND_DOMAIN, decoded.encoded, key.secret);
  return timingSafeEqual(decoded.signature, signature) ? Object.freeze(expected) : null;
}

/** Worker-side exact native request comparison after command verification. */
export function matchesMeriHermesRecoveryNativeRequestV1(
  command: Readonly<MeriHermesRecoveryCommandClaimsV1>,
  method: unknown,
  path: unknown,
  bodyBytes: Uint8Array,
): boolean {
  return (method === 'GET' || method === 'POST') &&
    typeof path === 'string' && bodyBytes instanceof Uint8Array &&
    method === command.nativeMethod && path === command.nativePath &&
    sha256(bodyBytes) === command.nativeBodySha256 &&
    (command.action !== 'status' || command.nativeBodySha256 === EMPTY_SHA256);
}

function validObservation(
  observation: unknown,
  workerStatus: unknown,
  nativeHttpStatus: unknown,
  action: MeriHermesRecoveryActionV1,
): workerStatus is MeriHermesRecoveryWorkerStatusV1 | null {
  if (!Number.isSafeInteger(nativeHttpStatus) ||
      (nativeHttpStatus as number) < 0 || (nativeHttpStatus as number) > 599) return false;
  if (observation === 'run_nonterminal') {
    return nativeHttpStatus === 200 && typeof workerStatus === 'string' &&
      NONTERMINAL.has(workerStatus as MeriHermesRecoveryWorkerStatusV1);
  }
  if (observation === 'run_terminal') {
    return nativeHttpStatus === 200 && typeof workerStatus === 'string' &&
      TERMINAL.has(workerStatus as MeriHermesRecoveryWorkerStatusV1);
  }
  if (observation === 'stop_accepted') {
    return action === 'stop' && workerStatus === null &&
      (nativeHttpStatus === 200 || nativeHttpStatus === 202 || nativeHttpStatus === 204);
  }
  return observation === 'not_found' && workerStatus === null && nativeHttpStatus === 404;
}

function receiptClaims(
  command: Readonly<MeriHermesRecoveryCommandClaimsV1>,
  commandSha256: string,
  input: Omit<MintMeriHermesRecoveryReceiptV1,
    'commandToken' | 'command' | 'nativeResponseBodyBytes'>,
  nativeResponseBodySha256: string,
  keyId: string,
): MeriHermesRecoveryReceiptClaimsV1 {
  return {
    version: MERI_HERMES_RECOVERY_VERSION,
    purpose: MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
    keyId,
    tenantId: command.tenantId,
    runId: command.runId,
    requestSha256: command.requestSha256,
    workerRunId: command.workerRunId,
    workerAudience: command.workerAudience,
    workerIngressId: command.workerIngressId,
    workerGeneration: command.workerGeneration,
    workerCredentialId: command.workerCredentialId,
    action: command.action,
    operationId: command.operationId,
    attemptNonce: command.attemptNonce,
    commandSha256,
    nativeMethod: command.nativeMethod,
    nativePath: command.nativePath,
    nativeBodySha256: command.nativeBodySha256,
    nativeHttpStatus: input.nativeHttpStatus,
    nativeResponseBodySha256,
    observation: input.observation,
    workerStatus: input.workerStatus,
    observedAtEpochMicros: input.observedAtEpochMicros,
    notBeforeEpochMicros: command.notBeforeEpochMicros,
    notAfterEpochMicros: command.notAfterEpochMicros,
  };
}

function exactCommandClaims(value: unknown): value is MeriHermesRecoveryCommandClaimsV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if ((row.action !== 'status' && row.action !== 'stop') ||
      !validWorkerRunId(row.workerRunId) || !UUID.test(String(row.operationId)) ||
      !validAttemptNonce(row.attemptNonce) || !SHA256.test(String(row.nativeBodySha256)) ||
      typeof row.notBeforeEpochMicros !== 'string' || typeof row.notAfterEpochMicros !== 'string') {
    return false;
  }
  const expected = {
    version: MERI_HERMES_RECOVERY_VERSION,
    purpose: MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
    keyId: row.keyId,
    tenantId: row.tenantId,
    runId: row.runId,
    requestSha256: row.requestSha256,
    workerRunId: row.workerRunId,
    workerAudience: row.workerAudience,
    workerIngressId: row.workerIngressId,
    workerGeneration: row.workerGeneration,
    workerCredentialId: row.workerCredentialId,
    action: row.action,
    operationId: row.operationId,
    attemptNonce: row.attemptNonce,
    nativeMethod: nativeMethod(row.action),
    nativePath: nativePath(row.action, row.workerRunId),
    nativeBodySha256: row.nativeBodySha256,
    notBeforeEpochMicros: row.notBeforeEpochMicros,
    notAfterEpochMicros: row.notAfterEpochMicros,
  };
  return JSON.stringify(value) === JSON.stringify(expected) &&
    typeof row.tenantId === 'string' && UUID.test(row.tenantId) &&
    typeof row.keyId === 'string' && KEY_ID.test(row.keyId) &&
    typeof row.runId === 'string' && UUID.test(row.runId) &&
    typeof row.requestSha256 === 'string' && SHA256.test(row.requestSha256) &&
    typeof row.workerAudience === 'string' && ROUTE_TOKEN.test(row.workerAudience) &&
    typeof row.workerIngressId === 'string' && ROUTE_TOKEN.test(row.workerIngressId) &&
    typeof row.workerGeneration === 'string' && ROUTE_TOKEN.test(row.workerGeneration) &&
    typeof row.workerCredentialId === 'string' && ROUTE_TOKEN.test(row.workerCredentialId) &&
    micros(row.notBeforeEpochMicros) !== null && micros(row.notAfterEpochMicros) !== null;
}

/** Worker-side minting after strict command verification and native observation. */
export function mintMeriHermesRecoveryReceiptV1(
  material: MintMeriHermesRecoveryReceiptV1,
  key: MeriHermesRecoveryReceiptKeyV1,
): string {
  const encodedCommand = decodeToken(material.commandToken, COMMAND_PREFIX);
  let commandPayloadMatches = false;
  try {
    commandPayloadMatches = encodedCommand !== null &&
      decoder.decode(encodedCommand.payload) === JSON.stringify(material.command);
  } catch {
    commandPayloadMatches = false;
  }
  if (!exactCommandClaims(material.command) || !commandPayloadMatches ||
      !validObservation(material.observation, material.workerStatus,
        material.nativeHttpStatus, material.command.action) ||
      !(material.nativeResponseBodyBytes instanceof Uint8Array) ||
      !validKey(key, {
        tenantId: material.command.tenantId,
        workerAudience: material.command.workerAudience,
        workerIngressId: material.command.workerIngressId,
        workerGeneration: material.command.workerGeneration,
        workerCredentialId: material.command.workerCredentialId,
      }, MERI_HERMES_RECOVERY_RECEIPT_PURPOSE)) {
    throw new Error('invalid Phase 4 recovery receipt material');
  }
  const observed = micros(material.observedAtEpochMicros);
  const before = micros(material.command.notBeforeEpochMicros);
  const after = micros(material.command.notAfterEpochMicros);
  const keyBefore = micros(key.notBeforeEpochMicros);
  const keyAfter = micros(key.notAfterEpochMicros);
  if (observed === null || before === null || after === null ||
      keyBefore === null || keyAfter === null || observed < before || observed >= after ||
      before < keyBefore || after > keyAfter) {
    throw new Error('invalid Phase 4 recovery receipt window');
  }
  const claims = receiptClaims(
    material.command,
    sha256(Buffer.from(material.commandToken, 'ascii')),
    material,
    sha256(material.nativeResponseBodyBytes),
    key.keyId,
  );
  return encodeToken(RECEIPT_PREFIX, RECEIPT_DOMAIN, claims, key.secret);
}

/**
 * API-side verification. It first authenticates the exact command with the
 * command key, then authenticates the worker receipt with a separate key.
 */
export function verifyMeriHermesRecoveryReceiptV1(
  token: unknown,
  commandToken: unknown,
  identity: Readonly<MeriDispatchRequestIdentityV2>,
  expectedWorkerRunId: string,
  commandKey: MeriHermesRecoveryCommandKeyV1,
  receiptKey: MeriHermesRecoveryReceiptKeyV1,
  dbNowEpochMicros: string,
): MeriHermesRecoveryReceiptClaimsV1 | null {
  // Domain separation prevents token substitution; distinct key material also
  // makes a provisioning mistake fail closed instead of silently reusing one
  // bidirectional recovery credential.
  if (!meriHermesRecoveryKeysAreDistinctV1(commandKey, receiptKey)) return null;
  const command = verifyMeriHermesRecoveryCommandV1(
    commandToken, identity, expectedWorkerRunId, commandKey, dbNowEpochMicros,
  );
  if (!command || typeof commandToken !== 'string' ||
      !validKey(receiptKey, keyBinding(identity), MERI_HERMES_RECOVERY_RECEIPT_PURPOSE)) return null;
  const decoded = decodeToken(token, RECEIPT_PREFIX);
  if (!decoded) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(decoded.payload));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (typeof row.nativeResponseBodySha256 !== 'string' ||
      !SHA256.test(row.nativeResponseBodySha256) ||
      typeof row.observedAtEpochMicros !== 'string' ||
      !validObservation(row.observation, row.workerStatus, row.nativeHttpStatus, command.action)) {
    return null;
  }
  const expected = receiptClaims(command, sha256(Buffer.from(commandToken, 'ascii')), {
    observation: row.observation as MeriHermesRecoveryObservationV1,
    workerStatus: row.workerStatus as MeriHermesRecoveryWorkerStatusV1 | null,
    nativeHttpStatus: row.nativeHttpStatus as number,
    observedAtEpochMicros: row.observedAtEpochMicros,
  }, row.nativeResponseBodySha256, receiptKey.keyId);
  if (decoder.decode(decoded.payload) !== JSON.stringify(expected)) return null;
  const observed = micros(expected.observedAtEpochMicros);
  const now = micros(dbNowEpochMicros);
  const keyBefore = micros(receiptKey.notBeforeEpochMicros);
  const keyAfter = micros(receiptKey.notAfterEpochMicros);
  if (observed === null || now === null || keyBefore === null || keyAfter === null ||
      observed < BigInt(command.notBeforeEpochMicros) ||
      observed >= BigInt(command.notAfterEpochMicros) || observed > now ||
      BigInt(command.notBeforeEpochMicros) < keyBefore ||
      BigInt(command.notAfterEpochMicros) > keyAfter) return null;
  const signature = sign(RECEIPT_PREFIX, RECEIPT_DOMAIN, decoded.encoded, receiptKey.secret);
  return timingSafeEqual(decoded.signature, signature) ? Object.freeze(expected) : null;
}

/** Exact raw-response comparison before accepting the normalized observation. */
export function matchesMeriHermesRecoveryNativeResponseV1(
  receipt: Readonly<MeriHermesRecoveryReceiptClaimsV1>,
  httpStatus: unknown,
  bodyBytes: Uint8Array,
): boolean {
  return Number.isSafeInteger(httpStatus) && httpStatus === receipt.nativeHttpStatus &&
    bodyBytes instanceof Uint8Array &&
    sha256(bodyBytes) === receipt.nativeResponseBodySha256;
}

/**
 * A missing receipt represents transport failure and remains UNKNOWN.
 * `not_found` is not an absence seal; `stop_accepted` is not terminal.
 */
export function meriHermesRecoveryDispositionV1(
  receipt: Readonly<MeriHermesRecoveryReceiptClaimsV1> | null,
): 'terminal' | 'nonterminal' | 'UNKNOWN' {
  if (!receipt || receipt.observation === 'not_found') return 'UNKNOWN';
  return receipt.observation === 'run_terminal' ? 'terminal' : 'nonterminal';
}
