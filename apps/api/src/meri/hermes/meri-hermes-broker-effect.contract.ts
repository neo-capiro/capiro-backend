import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

/**
 * Dormant Phase 4 broker-effect contract for `meri_record_turn` only.
 * Database-derived facts may be attested by a separate Ed25519 verifier. This
 * module only computes canonical digests and verifies returned evidence.
 */

export const MERI_HERMES_BROKER_EFFECT_VERSION = 1 as const;
export const MERI_HERMES_BROKER_EFFECT_RECEIPT_PURPOSE =
  'meri-phase4-broker-effect-receipt-v1' as const;
export const MERI_HERMES_RECORD_TURN_TOOL = 'meri_record_turn' as const;
export const MERI_HERMES_REQUEST_CLARIFICATION_TOOL =
  'meri_request_clarification' as const;
export const MERI_HERMES_PROPOSE_MEMORY_TOOL = 'meri_propose_memory' as const;
export const MERI_HERMES_MEMORY_SEARCH_TOOL = 'meri_memory_search' as const;
export const MERI_HERMES_FETCH_ATTACHMENT_TOOL = 'meri_fetch_attachment' as const;
export const MERI_HERMES_CLARIFICATION_INSTRUCTION =
  'The question has been delivered to the user in Meri. End your turn now with one short sentence saying you are waiting for their answer. Do not guess; the answer arrives as the next user message.' as const;

const REQUEST_DOMAIN = 'capiro.meri.phase4.broker-effect-request/v1';
const CLAIMS_DOMAIN = 'capiro.meri.phase4.broker-effect-receipt-claims/v1';
const RECEIPT_DOMAIN = 'capiro.meri.phase4.broker-effect-receipt/v1';
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
const MAX_SIGNED_INT32 = 2_147_483_647;
const MAX_RETENTION_SPAN_MICROS = 31_536_000_000_000n;
const MAX_CHAR_COUNT = 100_000_000;
const MAX_CLARIFICATION_TEXT = 2_000;
const MAX_PUBLIC_KEY_BYTES = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKER_RUN_ID = /^[\x21-\x7e]{1,120}$/;
const POSITIVE_MICROS = /^[1-9][0-9]{0,18}$/;
const ED25519_SIGNATURE = /^[A-Za-z0-9_-]{85}[AQgw]$/;

export interface MeriHermesRecordTurnRequestV1 {
  readonly userChars: number | null;
  readonly assistantChars: number | null;
}

export interface MeriHermesRecordTurnEffectIdentityV1 {
  readonly version: typeof MERI_HERMES_BROKER_EFFECT_VERSION;
  readonly tenantId: string;
  readonly runId: string;
  readonly workerRunId: string;
  readonly dispatchRequestSha256: string;
  readonly scopeId: string;
  readonly operationId: string;
  readonly tool: typeof MERI_HERMES_RECORD_TURN_TOOL;
  readonly requestSha256: string;
}

export interface CreateMeriHermesRecordTurnEffectIdentityV1 {
  readonly tenantId: string;
  readonly runId: string;
  readonly workerRunId: string;
  readonly dispatchRequestSha256: string;
  readonly scopeId: string;
  readonly operationId: string;
  readonly request: Readonly<MeriHermesRecordTurnRequestV1>;
}

export type MeriHermesBrokerEffectResultKindV1 =
  | 'committed'
  | 'denied_before_effect'
  | 'effect_unknown';

export type MeriHermesBrokerEffectDeniedDetailV1 =
  | 'authority_closed'
  | 'stop_requested'
  | 'run_terminal'
  | 'tool_denied'
  | 'tool_budget_exhausted';

export interface MeriHermesBrokerEffectReceiptFactsV1 {
  readonly result: MeriHermesBrokerEffectResultKindV1;
  readonly detail: 'recorded' | MeriHermesBrokerEffectDeniedDetailV1 |
    'caller_reported_unknown';
  readonly brokerCallsBefore: number;
  readonly brokerCallsAfter: number;
  readonly eventSeq: number | null;
}

export interface MeriHermesBrokerEffectReceiptKeyV1 {
  readonly purpose: typeof MERI_HERMES_BROKER_EFFECT_RECEIPT_PURPOSE;
  readonly keyId: string;
  readonly tenantId: string;
  readonly scopeId: string;
  /** DER SubjectPublicKeyInfo bytes for one trusted Ed25519 public key. */
  readonly publicKeySpkiDer: Uint8Array;
  readonly publicKeySpkiSha256: string;
  readonly notBeforeEpochMicros: string;
  readonly notAfterEpochMicros: string;
  readonly qualificationSha256: string;
}

/** Exact fixed row returned by `meri_phase4_record_turn_effect`. */
export interface MeriHermesBrokerEffectReceiptRowV1 {
  readonly receipt_id: string;
  readonly result: string;
  readonly detail: string;
  readonly scope?: 'personal' | 'firm' | 'client';
  readonly broker_calls_before: number;
  readonly broker_calls_after: number;
  readonly event_seq: number | null;
  readonly applied_at: Date;
  readonly applied_at_epoch_micros: bigint | string;
  readonly retain_until_epoch_micros: bigint | string;
  readonly signed_claims_sha256: string;
  readonly signer_key_id: string | null;
  readonly signature: string | null;
  readonly signature_verified_at_epoch_micros: bigint | string | null;
  readonly qualification_sha256: string | null;
  readonly receipt_sha256: string;
}

export interface MeriHermesBrokerEffectReceiptV1
extends MeriHermesRecordTurnEffectIdentityV1, MeriHermesBrokerEffectReceiptFactsV1 {
  readonly purpose: typeof MERI_HERMES_BROKER_EFFECT_RECEIPT_PURPOSE;
  readonly receiptId: string;
  readonly resultSummary: 'recorded' | 'denied' | 'unknown';
  readonly domainRef: 'meri_institutional_memory' | null;
  readonly appliedAt: string;
  readonly appliedAtEpochMicros: string;
  readonly retainUntilEpochMicros: string;
  readonly signedClaimsSha256: string;
  readonly signerKeyId: string | null;
  readonly signature: string | null;
  readonly qualificationSha256: string | null;
  readonly signatureVerifiedAtEpochMicros: string | null;
  readonly receiptSha256: string;
  readonly signed: boolean;
}

export type MeriHermesBrokerEffectResultV1 =
  | Readonly<{ kind: 'committed'; receipt: MeriHermesBrokerEffectReceiptV1;
      result: Readonly<{ recorded: true;
        authoritativeMemory: 'meri_institutional_memory' }> }>
  | Readonly<{ kind: 'denied_before_effect'; receipt: MeriHermesBrokerEffectReceiptV1;
      result: Readonly<{ recorded: false; code: 'denied_before_effect';
        detail: MeriHermesBrokerEffectDeniedDetailV1 }> }>
  | Readonly<{ kind: 'effect_unknown'; receipt: MeriHermesBrokerEffectReceiptV1 | null }>;

const DENIED_DETAILS = new Set<MeriHermesBrokerEffectDeniedDetailV1>([
  'authority_closed', 'stop_requested', 'run_terminal', 'tool_denied',
  'tool_budget_exhausted',
]);

function exactFieldSet(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

/** PostgreSQL `int4send(length) || convert_to(value, 'UTF8')` framing. */
function frame(parts: readonly string[]): Buffer {
  const framed: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    if (bytes.length > 0x7fffffff) throw new Error('broker-effect digest field is too large');
    const length = Buffer.alloc(4);
    length.writeInt32BE(bytes.length);
    framed.push(length, bytes);
  }
  return Buffer.concat(framed);
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(frame(parts)).digest('hex');
}

function canonicalMicros(value: unknown): string | null {
  const text = typeof value === 'bigint' ? value.toString() : value;
  if (typeof text !== 'string' || !POSITIVE_MICROS.test(text)) return null;
  return BigInt(text) <= MAX_SIGNED_INT64 ? text : null;
}

function canonicalInteger(
  value: unknown,
  maximum = MAX_SIGNED_INT32,
  allowZero = true,
): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= (allowZero ? 0 : 1) && value <= maximum ? value : null;
}

function validPrivateScope(tenantId: string, scopeId: string): boolean {
  const prefix = `tenant:${tenantId}:user:`;
  return scopeId.length <= 200 && scopeId.startsWith(prefix) &&
    UUID.test(scopeId.slice(prefix.length));
}

function canonicalRequest(value: unknown): MeriHermesRecordTurnRequestV1 | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!exactFieldSet(row, ['userChars', 'assistantChars'])) return null;
  const userChars = row.userChars === null
    ? null : canonicalInteger(row.userChars, MAX_CHAR_COUNT);
  const assistantChars = row.assistantChars === null
    ? null : canonicalInteger(row.assistantChars, MAX_CHAR_COUNT);
  if ((row.userChars !== null && userChars === null) ||
      (row.assistantChars !== null && assistantChars === null)) return null;
  return Object.freeze({ userChars, assistantChars });
}

function requestParts(
  input: Omit<CreateMeriHermesRecordTurnEffectIdentityV1, 'operationId'>,
): readonly string[] {
  const request = canonicalRequest(input.request);
  if (!request) throw new Error('invalid meri_record_turn request');
  return [
    REQUEST_DOMAIN, input.tenantId, input.runId, input.workerRunId,
    input.dispatchRequestSha256, input.scopeId, MERI_HERMES_RECORD_TURN_TOOL,
    request.userChars === null ? 'null' : String(request.userChars),
    request.assistantChars === null ? 'null' : String(request.assistantChars),
  ];
}

export function meriHermesRecordTurnRequestSha256V1(
  input: Omit<CreateMeriHermesRecordTurnEffectIdentityV1, 'operationId'>,
): string {
  if (!input || typeof input !== 'object' ||
      typeof input.tenantId !== 'string' || !UUID.test(input.tenantId) ||
      typeof input.runId !== 'string' || !UUID.test(input.runId) ||
      typeof input.workerRunId !== 'string' || !WORKER_RUN_ID.test(input.workerRunId) ||
      typeof input.dispatchRequestSha256 !== 'string' ||
      !SHA256.test(input.dispatchRequestSha256) || typeof input.scopeId !== 'string' ||
      !validPrivateScope(input.tenantId, input.scopeId)) {
    throw new Error('invalid meri_record_turn request identity');
  }
  return digest(requestParts(input));
}

export function isMeriHermesRecordTurnEffectIdentityV1(
  value: unknown,
): value is MeriHermesRecordTurnEffectIdentityV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return exactFieldSet(row, [
    'version', 'tenantId', 'runId', 'workerRunId', 'dispatchRequestSha256',
    'scopeId', 'operationId', 'tool', 'requestSha256',
  ]) && row.version === MERI_HERMES_BROKER_EFFECT_VERSION &&
    typeof row.tenantId === 'string' && UUID.test(row.tenantId) &&
    typeof row.runId === 'string' && UUID.test(row.runId) &&
    typeof row.workerRunId === 'string' && WORKER_RUN_ID.test(row.workerRunId) &&
    typeof row.dispatchRequestSha256 === 'string' && SHA256.test(row.dispatchRequestSha256) &&
    typeof row.scopeId === 'string' && validPrivateScope(row.tenantId, row.scopeId) &&
    typeof row.operationId === 'string' && UUID.test(row.operationId) &&
    row.tool === MERI_HERMES_RECORD_TURN_TOOL &&
    typeof row.requestSha256 === 'string' && SHA256.test(row.requestSha256);
}

export function createMeriHermesRecordTurnEffectIdentityV1(
  input: Readonly<CreateMeriHermesRecordTurnEffectIdentityV1>,
): MeriHermesRecordTurnEffectIdentityV1 {
  const identity: MeriHermesRecordTurnEffectIdentityV1 = {
    version: MERI_HERMES_BROKER_EFFECT_VERSION,
    tenantId: input?.tenantId,
    runId: input?.runId,
    workerRunId: input?.workerRunId,
    dispatchRequestSha256: input?.dispatchRequestSha256,
    scopeId: input?.scopeId,
    operationId: input?.operationId,
    tool: MERI_HERMES_RECORD_TURN_TOOL,
    requestSha256: meriHermesRecordTurnRequestSha256V1(input),
  };
  if (!isMeriHermesRecordTurnEffectIdentityV1(identity)) {
    throw new Error('invalid meri_record_turn effect identity');
  }
  return Object.freeze(identity);
}

function normalizedFacts(value: unknown): MeriHermesBrokerEffectReceiptFactsV1 | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const before = canonicalInteger(row.brokerCallsBefore);
  const after = canonicalInteger(row.brokerCallsAfter);
  const eventSeq = row.eventSeq === null
    ? null : canonicalInteger(row.eventSeq, MAX_SIGNED_INT32, false);
  if (before === null || after === null ||
      (row.eventSeq !== null && eventSeq === null)) return null;
  if (row.result === 'committed' && row.detail === 'recorded' &&
      after === before + 1 && eventSeq !== null) {
    return Object.freeze({ result: row.result, detail: row.detail,
      brokerCallsBefore: before, brokerCallsAfter: after, eventSeq });
  }
  if (row.result === 'denied_before_effect' && typeof row.detail === 'string' &&
      DENIED_DETAILS.has(row.detail as MeriHermesBrokerEffectDeniedDetailV1) &&
      after === before && eventSeq === null) {
    return Object.freeze({ result: row.result,
      detail: row.detail as MeriHermesBrokerEffectDeniedDetailV1,
      brokerCallsBefore: before, brokerCallsAfter: after, eventSeq: null });
  }
  if (row.result === 'effect_unknown' && row.detail === 'caller_reported_unknown' &&
      after === before && eventSeq === null) {
    return Object.freeze({ result: row.result, detail: row.detail,
      brokerCallsBefore: before, brokerCallsAfter: after, eventSeq: null });
  }
  return null;
}

function summaryFor(result: MeriHermesBrokerEffectResultKindV1):
{ readonly resultSummary: 'recorded' | 'denied' | 'unknown';
  readonly domainRef: 'meri_institutional_memory' | null } {
  if (result === 'committed') {
    return { resultSummary: 'recorded', domainRef: 'meri_institutional_memory' };
  }
  return result === 'denied_before_effect'
    ? { resultSummary: 'denied', domainRef: null }
    : { resultSummary: 'unknown', domainRef: null };
}

export function meriHermesBrokerEffectReceiptClaimsSha256V1(
  identity: Readonly<MeriHermesRecordTurnEffectIdentityV1>,
  facts: Readonly<MeriHermesBrokerEffectReceiptFactsV1>,
): string {
  if (!isMeriHermesRecordTurnEffectIdentityV1(identity)) {
    throw new Error('invalid broker-effect receipt identity');
  }
  const normalized = normalizedFacts(facts);
  if (!normalized) throw new Error('invalid broker-effect receipt facts');
  const summary = summaryFor(normalized.result);
  return digest([
    CLAIMS_DOMAIN, identity.tenantId, identity.runId, identity.workerRunId,
    identity.dispatchRequestSha256, identity.scopeId, identity.operationId,
    identity.tool, identity.requestSha256, normalized.result, normalized.detail,
    String(normalized.brokerCallsBefore), String(normalized.brokerCallsAfter),
    normalized.eventSeq === null ? 'null' : String(normalized.eventSeq),
    summary.resultSummary, summary.domainRef ?? 'null',
  ]);
}

export function meriHermesBrokerEffectReceiptSha256V1(
  signedClaimsSha256: string,
  signerKeyId: string | null,
  signature: string | null,
  qualificationSha256: string | null,
): string {
  if (!SHA256.test(signedClaimsSha256) ||
      (signerKeyId !== null && !KEY_ID.test(signerKeyId)) ||
      (signature !== null && !ED25519_SIGNATURE.test(signature)) ||
      (qualificationSha256 !== null && !SHA256.test(qualificationSha256)) ||
      ((signerKeyId === null || signature === null || qualificationSha256 === null) &&
        !(signerKeyId === null && signature === null && qualificationSha256 === null))) {
    throw new Error('invalid broker-effect signed receipt material');
  }
  return digest([
    RECEIPT_DOMAIN, signedClaimsSha256, signerKeyId ?? 'null', signature ?? 'null',
    qualificationSha256 ?? 'null',
  ]);
}

function canonicalSignature(value: string): Buffer | null {
  if (!ED25519_SIGNATURE.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 64 && bytes.toString('base64url') === value ? bytes : null;
}

function validKey(
  key: unknown,
  identity: Readonly<{ tenantId: string; scopeId: string }>,
): key is MeriHermesBrokerEffectReceiptKeyV1 {
  if (key === null || typeof key !== 'object' || Array.isArray(key)) return false;
  const row = key as Record<string, unknown>;
  const before = canonicalMicros(row.notBeforeEpochMicros);
  const after = canonicalMicros(row.notAfterEpochMicros);
  if (!exactFieldSet(row, [
    'purpose', 'keyId', 'tenantId', 'scopeId', 'publicKeySpkiDer',
    'publicKeySpkiSha256', 'notBeforeEpochMicros', 'notAfterEpochMicros',
    'qualificationSha256',
  ]) || row.purpose !== MERI_HERMES_BROKER_EFFECT_RECEIPT_PURPOSE ||
      typeof row.keyId !== 'string' || !KEY_ID.test(row.keyId) ||
      row.tenantId !== identity.tenantId || row.scopeId !== identity.scopeId ||
      !(row.publicKeySpkiDer instanceof Uint8Array) || row.publicKeySpkiDer.length < 32 ||
      row.publicKeySpkiDer.length > MAX_PUBLIC_KEY_BYTES ||
      typeof row.publicKeySpkiSha256 !== 'string' || !SHA256.test(row.publicKeySpkiSha256) ||
      createHash('sha256').update(row.publicKeySpkiDer).digest('hex') !==
        row.publicKeySpkiSha256 || before === null || after === null || before >= after ||
      typeof row.qualificationSha256 !== 'string' || !SHA256.test(row.qualificationSha256)) {
    return false;
  }
  return true;
}

function verifySignature(
  claimsSha256: string,
  signature: string,
  key: Readonly<MeriHermesBrokerEffectReceiptKeyV1>,
): boolean {
  const bytes = canonicalSignature(signature);
  if (!bytes) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKeySpkiDer), format: 'der', type: 'spki',
    });
    return publicKey.asymmetricKeyType === 'ed25519' &&
      verify(null, Buffer.from(claimsSha256, 'hex'), publicKey, bytes);
  } catch {
    return false;
  }
}

export function parseMeriHermesBrokerEffectReceiptV1(
  row: unknown,
  identity: Readonly<MeriHermesRecordTurnEffectIdentityV1>,
  keys: ReadonlyMap<string, Readonly<MeriHermesBrokerEffectReceiptKeyV1>>,
): MeriHermesBrokerEffectReceiptV1 | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row) ||
      !isMeriHermesRecordTurnEffectIdentityV1(identity) || !(keys instanceof Map)) return null;
  const value = row as Record<string, unknown>;
  if (!exactFieldSet(value, [
    'receipt_id', 'result', 'detail', 'broker_calls_before', 'broker_calls_after',
    'event_seq', 'applied_at', 'applied_at_epoch_micros',
    'retain_until_epoch_micros', 'signed_claims_sha256', 'signer_key_id',
    'signature', 'signature_verified_at_epoch_micros', 'qualification_sha256',
    'receipt_sha256',
  ]) || typeof value.receipt_id !== 'string' || !UUID.test(value.receipt_id) ||
      !(value.applied_at instanceof Date) || !Number.isFinite(value.applied_at.getTime()) ||
      typeof value.signed_claims_sha256 !== 'string' ||
      !SHA256.test(value.signed_claims_sha256) || typeof value.receipt_sha256 !== 'string' ||
      !SHA256.test(value.receipt_sha256)) return null;
  const facts = normalizedFacts({
    result: value.result, detail: value.detail,
    brokerCallsBefore: value.broker_calls_before,
    brokerCallsAfter: value.broker_calls_after,
    eventSeq: value.event_seq,
  });
  const applied = canonicalMicros(value.applied_at_epoch_micros);
  const retain = canonicalMicros(value.retain_until_epoch_micros);
  if (!facts || !applied || !retain || BigInt(retain) <= BigInt(applied) ||
      BigInt(retain) - BigInt(applied) > MAX_RETENTION_SPAN_MICROS) return null;
  const expectedClaims = meriHermesBrokerEffectReceiptClaimsSha256V1(identity, facts);
  if (!timingSafeEqual(
    Buffer.from(expectedClaims, 'hex'), Buffer.from(value.signed_claims_sha256, 'hex'),
  )) return null;
  const signerKeyId = value.signer_key_id;
  const signature = value.signature;
  const qualification = value.qualification_sha256;
  const verifiedAt = canonicalMicros(value.signature_verified_at_epoch_micros);
  const unsigned = signerKeyId === null && signature === null && qualification === null &&
    value.signature_verified_at_epoch_micros === null;
  let signed = false;
  if (unsigned) {
    if (facts.result !== 'effect_unknown') return null;
  } else {
    if (facts.result === 'effect_unknown') return null;
    if (typeof signerKeyId !== 'string' || typeof signature !== 'string' ||
        typeof qualification !== 'string' || !verifiedAt) return null;
    const key = keys.get(signerKeyId);
    if (!key || key.keyId !== signerKeyId || !validKey(key, identity) ||
        qualification !== key.qualificationSha256 ||
        BigInt(verifiedAt) < BigInt(key.notBeforeEpochMicros) ||
        BigInt(verifiedAt) >= BigInt(key.notAfterEpochMicros) ||
        BigInt(verifiedAt) > BigInt(applied) ||
        !verifySignature(expectedClaims, signature, key)) return null;
    signed = true;
  }
  let expectedReceipt: string;
  try {
    expectedReceipt = meriHermesBrokerEffectReceiptSha256V1(
      expectedClaims,
      typeof signerKeyId === 'string' ? signerKeyId : null,
      typeof signature === 'string' ? signature : null,
      typeof qualification === 'string' ? qualification : null,
    );
  } catch {
    return null;
  }
  if (!timingSafeEqual(
    Buffer.from(expectedReceipt, 'hex'), Buffer.from(value.receipt_sha256, 'hex'),
  )) return null;
  const summary = summaryFor(facts.result);
  return Object.freeze({
    ...identity,
    purpose: MERI_HERMES_BROKER_EFFECT_RECEIPT_PURPOSE,
    receiptId: value.receipt_id,
    ...facts,
    ...summary,
    appliedAt: value.applied_at.toISOString(),
    appliedAtEpochMicros: applied,
    retainUntilEpochMicros: retain,
    signedClaimsSha256: expectedClaims,
    signerKeyId: typeof signerKeyId === 'string' ? signerKeyId : null,
    signature: typeof signature === 'string' ? signature : null,
    qualificationSha256: typeof qualification === 'string' ? qualification : null,
    signatureVerifiedAtEpochMicros: verifiedAt,
    receiptSha256: expectedReceipt,
    signed,
  });
}

export function meriHermesBrokerEffectResultV1(
  receipt: Readonly<MeriHermesBrokerEffectReceiptV1> | null,
): MeriHermesBrokerEffectResultV1 {
  if (!receipt || receipt.result === 'effect_unknown') {
    return Object.freeze({ kind: 'effect_unknown' as const, receipt: receipt ?? null });
  }
  if (!receipt.signed) return Object.freeze({ kind: 'effect_unknown' as const, receipt: null });
  if (receipt.result === 'committed') {
    return Object.freeze({ kind: 'committed' as const, receipt,
      result: Object.freeze({ recorded: true as const,
        authoritativeMemory: 'meri_institutional_memory' as const }) });
  }
  return Object.freeze({ kind: 'denied_before_effect' as const, receipt,
    result: Object.freeze({ recorded: false as const, code: 'denied_before_effect' as const,
      detail: receipt.detail as MeriHermesBrokerEffectDeniedDetailV1 }) });
}

// ---------------------------------------------------------------------------
// Dormant `meri_request_clarification` effect contract.
// ---------------------------------------------------------------------------

export interface MeriHermesClarificationRequestV1 {
  readonly question: string;
  readonly choices: readonly string[];
  readonly multiSelect: boolean;
}

export interface MeriHermesClarificationEffectIdentityV1 {
  readonly version: typeof MERI_HERMES_BROKER_EFFECT_VERSION;
  readonly tenantId: string;
  readonly runId: string;
  readonly workerRunId: string;
  readonly dispatchRequestSha256: string;
  readonly scopeId: string;
  readonly operationId: string;
  readonly tool: typeof MERI_HERMES_REQUEST_CLARIFICATION_TOOL;
  readonly requestSha256: string;
}

export interface CreateMeriHermesClarificationEffectIdentityV1 {
  readonly tenantId: string;
  readonly runId: string;
  readonly workerRunId: string;
  readonly dispatchRequestSha256: string;
  readonly scopeId: string;
  readonly operationId: string;
  readonly request: Readonly<{
    question: string;
    choices?: readonly string[];
    multiSelect?: boolean;
  }>;
}

export interface MeriHermesClarificationEffectReceiptFactsV1 {
  readonly result: MeriHermesBrokerEffectResultKindV1;
  readonly detail: 'clarification_requested' | MeriHermesBrokerEffectDeniedDetailV1 |
    'caller_reported_unknown';
  readonly brokerCallsBefore: number;
  readonly brokerCallsAfter: number;
  readonly eventSeq: number | null;
}

export interface MeriHermesClarificationEffectReceiptV1
extends MeriHermesClarificationEffectIdentityV1,
  MeriHermesClarificationEffectReceiptFactsV1 {
  readonly purpose: typeof MERI_HERMES_BROKER_EFFECT_RECEIPT_PURPOSE;
  readonly receiptId: string;
  readonly resultSummary: 'clarification_requested' | 'denied' | 'unknown';
  readonly domainRef: string | null;
  readonly appliedAt: string;
  readonly appliedAtEpochMicros: string;
  readonly retainUntilEpochMicros: string;
  readonly signedClaimsSha256: string;
  readonly signerKeyId: string | null;
  readonly signature: string | null;
  readonly qualificationSha256: string | null;
  readonly signatureVerifiedAtEpochMicros: string | null;
  readonly receiptSha256: string;
  readonly signed: boolean;
}

export type MeriHermesClarificationEffectResultV1 =
  | Readonly<{ kind: 'committed'; receipt: MeriHermesClarificationEffectReceiptV1;
      result: Readonly<{ requestId: string;
        instruction: typeof MERI_HERMES_CLARIFICATION_INSTRUCTION }> }>
  | Readonly<{ kind: 'denied_before_effect'; receipt: MeriHermesClarificationEffectReceiptV1;
      result: Readonly<{ requested: false; code: 'denied_before_effect';
        detail: MeriHermesBrokerEffectDeniedDetailV1 }> }>
  | Readonly<{ kind: 'effect_unknown';
      receipt: MeriHermesClarificationEffectReceiptV1 | null }>;

export function meriHermesClarificationRequestIdV1(operationId: string): string {
  if (!UUID.test(operationId)) throw new Error('invalid clarification operation id');
  return `clar_${operationId}`;
}

export function normalizeMeriHermesClarificationRequestV1(
  value: Readonly<{ question: string; choices?: readonly string[];
    multiSelect?: boolean }>,
): MeriHermesClarificationRequestV1 {
  if (!value || typeof value !== 'object' || typeof value.question !== 'string' ||
      (value.choices !== undefined && !Array.isArray(value.choices)) ||
      (value.multiSelect !== undefined && typeof value.multiSelect !== 'boolean')) {
    throw new Error('invalid clarification request');
  }
  const question = value.question.trim();
  if (!question || question.length > MAX_CLARIFICATION_TEXT) {
    throw new Error('invalid clarification question');
  }
  const choices: string[] = [];
  for (const raw of value.choices ?? []) {
    if (typeof raw !== 'string') throw new Error('invalid clarification choice');
    const choice = raw.trim();
    if (!choice) continue;
    if (choice.length > MAX_CLARIFICATION_TEXT) {
      throw new Error('invalid clarification choice');
    }
    if (choices.length < 4) choices.push(choice);
  }
  return Object.freeze({
    question,
    choices: Object.freeze(choices),
    multiSelect: value.multiSelect === true && choices.length > 0,
  });
}

function clarificationRequestParts(
  input: Omit<CreateMeriHermesClarificationEffectIdentityV1, 'operationId'>,
): readonly string[] {
  const request = normalizeMeriHermesClarificationRequestV1(input.request);
  return [
    REQUEST_DOMAIN, input.tenantId, input.runId, input.workerRunId,
    input.dispatchRequestSha256, input.scopeId,
    MERI_HERMES_REQUEST_CLARIFICATION_TOOL, request.question,
    String(request.choices.length), ...request.choices,
    request.multiSelect ? 'true' : 'false',
  ];
}

export function meriHermesClarificationRequestSha256V1(
  input: Omit<CreateMeriHermesClarificationEffectIdentityV1, 'operationId'>,
): string {
  if (!input || typeof input !== 'object' ||
      typeof input.tenantId !== 'string' || !UUID.test(input.tenantId) ||
      typeof input.runId !== 'string' || !UUID.test(input.runId) ||
      typeof input.workerRunId !== 'string' || !WORKER_RUN_ID.test(input.workerRunId) ||
      typeof input.dispatchRequestSha256 !== 'string' ||
      !SHA256.test(input.dispatchRequestSha256) ||
      typeof input.scopeId !== 'string' ||
      !validPrivateScope(input.tenantId, input.scopeId)) {
    throw new Error('invalid clarification request identity');
  }
  return digest(clarificationRequestParts(input));
}

export function isMeriHermesClarificationEffectIdentityV1(
  value: unknown,
): value is MeriHermesClarificationEffectIdentityV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return exactFieldSet(row, [
    'version', 'tenantId', 'runId', 'workerRunId', 'dispatchRequestSha256',
    'scopeId', 'operationId', 'tool', 'requestSha256',
  ]) && row.version === MERI_HERMES_BROKER_EFFECT_VERSION &&
    typeof row.tenantId === 'string' && UUID.test(row.tenantId) &&
    typeof row.runId === 'string' && UUID.test(row.runId) &&
    typeof row.workerRunId === 'string' && WORKER_RUN_ID.test(row.workerRunId) &&
    typeof row.dispatchRequestSha256 === 'string' && SHA256.test(row.dispatchRequestSha256) &&
    typeof row.scopeId === 'string' && validPrivateScope(row.tenantId, row.scopeId) &&
    typeof row.operationId === 'string' && UUID.test(row.operationId) &&
    row.tool === MERI_HERMES_REQUEST_CLARIFICATION_TOOL &&
    typeof row.requestSha256 === 'string' && SHA256.test(row.requestSha256);
}

export function createMeriHermesClarificationEffectIdentityV1(
  input: Readonly<CreateMeriHermesClarificationEffectIdentityV1>,
): MeriHermesClarificationEffectIdentityV1 {
  const identity: MeriHermesClarificationEffectIdentityV1 = {
    version: MERI_HERMES_BROKER_EFFECT_VERSION,
    tenantId: input?.tenantId,
    runId: input?.runId,
    workerRunId: input?.workerRunId,
    dispatchRequestSha256: input?.dispatchRequestSha256,
    scopeId: input?.scopeId,
    operationId: input?.operationId,
    tool: MERI_HERMES_REQUEST_CLARIFICATION_TOOL,
    requestSha256: meriHermesClarificationRequestSha256V1(input),
  };
  if (!isMeriHermesClarificationEffectIdentityV1(identity)) {
    throw new Error('invalid clarification effect identity');
  }
  return Object.freeze(identity);
}

function normalizedClarificationFacts(
  value: unknown,
): MeriHermesClarificationEffectReceiptFactsV1 | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const before = canonicalInteger(row.brokerCallsBefore);
  const after = canonicalInteger(row.brokerCallsAfter);
  const eventSeq = row.eventSeq === null
    ? null : canonicalInteger(row.eventSeq, MAX_SIGNED_INT32, false);
  if (before === null || after === null ||
      (row.eventSeq !== null && eventSeq === null)) return null;
  if (row.result === 'committed' && row.detail === 'clarification_requested' &&
      after === before + 1 && eventSeq !== null) {
    return Object.freeze({ result: row.result, detail: row.detail,
      brokerCallsBefore: before, brokerCallsAfter: after, eventSeq });
  }
  if (row.result === 'denied_before_effect' && typeof row.detail === 'string' &&
      DENIED_DETAILS.has(row.detail as MeriHermesBrokerEffectDeniedDetailV1) &&
      after === before && eventSeq === null) {
    return Object.freeze({ result: row.result,
      detail: row.detail as MeriHermesBrokerEffectDeniedDetailV1,
      brokerCallsBefore: before, brokerCallsAfter: after, eventSeq: null });
  }
  if (row.result === 'effect_unknown' && row.detail === 'caller_reported_unknown' &&
      after === before && eventSeq === null) {
    return Object.freeze({ result: row.result, detail: row.detail,
      brokerCallsBefore: before, brokerCallsAfter: after, eventSeq: null });
  }
  return null;
}

function clarificationSummary(
  result: MeriHermesBrokerEffectResultKindV1,
  operationId: string,
): { readonly resultSummary: 'clarification_requested' | 'denied' | 'unknown';
  readonly domainRef: string | null } {
  if (result === 'committed') return {
    resultSummary: 'clarification_requested',
    domainRef: meriHermesClarificationRequestIdV1(operationId),
  };
  return result === 'denied_before_effect'
    ? { resultSummary: 'denied', domainRef: null }
    : { resultSummary: 'unknown', domainRef: null };
}

export function meriHermesClarificationReceiptClaimsSha256V1(
  identity: Readonly<MeriHermesClarificationEffectIdentityV1>,
  facts: Readonly<MeriHermesClarificationEffectReceiptFactsV1>,
): string {
  if (!isMeriHermesClarificationEffectIdentityV1(identity)) {
    throw new Error('invalid clarification receipt identity');
  }
  const normalized = normalizedClarificationFacts(facts);
  if (!normalized) throw new Error('invalid clarification receipt facts');
  const summary = clarificationSummary(normalized.result, identity.operationId);
  return digest([
    CLAIMS_DOMAIN, identity.tenantId, identity.runId, identity.workerRunId,
    identity.dispatchRequestSha256, identity.scopeId, identity.operationId,
    identity.tool, identity.requestSha256, normalized.result, normalized.detail,
    String(normalized.brokerCallsBefore), String(normalized.brokerCallsAfter),
    normalized.eventSeq === null ? 'null' : String(normalized.eventSeq),
    summary.resultSummary, summary.domainRef ?? 'null',
  ]);
}

export function parseMeriHermesClarificationEffectReceiptV1(
  row: unknown,
  identity: Readonly<MeriHermesClarificationEffectIdentityV1>,
  keys: ReadonlyMap<string, Readonly<MeriHermesBrokerEffectReceiptKeyV1>>,
): MeriHermesClarificationEffectReceiptV1 | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row) ||
      !isMeriHermesClarificationEffectIdentityV1(identity) ||
      !(keys instanceof Map)) return null;
  const value = row as Record<string, unknown>;
  if (!exactFieldSet(value, [
    'receipt_id', 'result', 'detail', 'broker_calls_before', 'broker_calls_after',
    'event_seq', 'applied_at', 'applied_at_epoch_micros',
    'retain_until_epoch_micros', 'signed_claims_sha256', 'signer_key_id',
    'signature', 'signature_verified_at_epoch_micros', 'qualification_sha256',
    'receipt_sha256',
  ]) || typeof value.receipt_id !== 'string' || !UUID.test(value.receipt_id) ||
      !(value.applied_at instanceof Date) || !Number.isFinite(value.applied_at.getTime()) ||
      typeof value.signed_claims_sha256 !== 'string' ||
      !SHA256.test(value.signed_claims_sha256) ||
      typeof value.receipt_sha256 !== 'string' || !SHA256.test(value.receipt_sha256)) return null;
  const facts = normalizedClarificationFacts({
    result: value.result, detail: value.detail,
    brokerCallsBefore: value.broker_calls_before,
    brokerCallsAfter: value.broker_calls_after,
    eventSeq: value.event_seq,
  });
  const applied = canonicalMicros(value.applied_at_epoch_micros);
  const retain = canonicalMicros(value.retain_until_epoch_micros);
  if (!facts || !applied || !retain || BigInt(retain) <= BigInt(applied) ||
      BigInt(retain) - BigInt(applied) > MAX_RETENTION_SPAN_MICROS) return null;
  const expectedClaims = meriHermesClarificationReceiptClaimsSha256V1(identity, facts);
  if (!timingSafeEqual(
    Buffer.from(expectedClaims, 'hex'), Buffer.from(value.signed_claims_sha256, 'hex'),
  )) return null;
  const signerKeyId = value.signer_key_id;
  const signature = value.signature;
  const qualification = value.qualification_sha256;
  const verifiedAt = canonicalMicros(value.signature_verified_at_epoch_micros);
  const unsigned = signerKeyId === null && signature === null && qualification === null &&
    value.signature_verified_at_epoch_micros === null;
  let signed = false;
  if (unsigned) {
    if (facts.result !== 'effect_unknown') return null;
  } else {
    if (facts.result === 'effect_unknown') return null;
    if (typeof signerKeyId !== 'string' || typeof signature !== 'string' ||
        typeof qualification !== 'string' || !verifiedAt) return null;
    const key = keys.get(signerKeyId);
    if (!key || key.keyId !== signerKeyId || !validKey(key, identity) ||
        qualification !== key.qualificationSha256 ||
        BigInt(verifiedAt) < BigInt(key.notBeforeEpochMicros) ||
        BigInt(verifiedAt) >= BigInt(key.notAfterEpochMicros) ||
        BigInt(verifiedAt) > BigInt(applied) ||
        !verifySignature(expectedClaims, signature, key)) return null;
    signed = true;
  }
  let expectedReceipt: string;
  try {
    expectedReceipt = meriHermesBrokerEffectReceiptSha256V1(
      expectedClaims,
      typeof signerKeyId === 'string' ? signerKeyId : null,
      typeof signature === 'string' ? signature : null,
      typeof qualification === 'string' ? qualification : null,
    );
  } catch {
    return null;
  }
  if (!timingSafeEqual(
    Buffer.from(expectedReceipt, 'hex'), Buffer.from(value.receipt_sha256, 'hex'),
  )) return null;
  const summary = clarificationSummary(facts.result, identity.operationId);
  return Object.freeze({
    ...identity,
    purpose: MERI_HERMES_BROKER_EFFECT_RECEIPT_PURPOSE,
    receiptId: value.receipt_id,
    ...facts,
    ...summary,
    appliedAt: value.applied_at.toISOString(),
    appliedAtEpochMicros: applied,
    retainUntilEpochMicros: retain,
    signedClaimsSha256: expectedClaims,
    signerKeyId: typeof signerKeyId === 'string' ? signerKeyId : null,
    signature: typeof signature === 'string' ? signature : null,
    qualificationSha256: typeof qualification === 'string' ? qualification : null,
    signatureVerifiedAtEpochMicros: verifiedAt,
    receiptSha256: expectedReceipt,
    signed,
  });
}

export function meriHermesClarificationEffectResultV1(
  receipt: Readonly<MeriHermesClarificationEffectReceiptV1> | null,
): MeriHermesClarificationEffectResultV1 {
  if (!receipt || receipt.result === 'effect_unknown') {
    return Object.freeze({ kind: 'effect_unknown' as const, receipt: receipt ?? null });
  }
  if (!receipt.signed) return Object.freeze({ kind: 'effect_unknown' as const, receipt: null });
  if (receipt.result === 'committed') {
    return Object.freeze({ kind: 'committed' as const, receipt,
      result: Object.freeze({
        requestId: meriHermesClarificationRequestIdV1(receipt.operationId),
        instruction: MERI_HERMES_CLARIFICATION_INSTRUCTION,
      }) });
  }
  return Object.freeze({ kind: 'denied_before_effect' as const, receipt,
    result: Object.freeze({ requested: false as const,
      code: 'denied_before_effect' as const,
      detail: receipt.detail as MeriHermesBrokerEffectDeniedDetailV1 }) });
}

// ---------------------------------------------------------------------------
// Dormant `meri_propose_memory` effect contract.
// ---------------------------------------------------------------------------

export interface MeriHermesMemoryProposalRequestV1 {
  readonly key: string;
  readonly value: string;
  readonly scope: 'personal' | 'firm' | 'client';
  readonly clientId: string | null;
  readonly confidence: number | null;
  readonly sourceExcerpt: string | null;
}

export interface MeriHermesMemoryProposalEffectIdentityV1 {
  readonly version: typeof MERI_HERMES_BROKER_EFFECT_VERSION;
  readonly tenantId: string;
  readonly runId: string;
  readonly workerRunId: string;
  readonly dispatchRequestSha256: string;
  readonly scopeId: string;
  readonly operationId: string;
  readonly tool: typeof MERI_HERMES_PROPOSE_MEMORY_TOOL;
  readonly requestSha256: string;
}

export interface CreateMeriHermesMemoryProposalEffectIdentityV1 {
  readonly tenantId: string;
  readonly runId: string;
  readonly workerRunId: string;
  readonly dispatchRequestSha256: string;
  readonly scopeId: string;
  readonly operationId: string;
  readonly request: Readonly<{
    key: string;
    value: string;
    scope: 'personal' | 'firm' | 'client';
    clientId?: string | null;
    confidence?: number | null;
    sourceExcerpt?: string | null;
  }>;
}

export interface MeriHermesMemoryProposalEffectReceiptFactsV1 {
  readonly result: MeriHermesBrokerEffectResultKindV1;
  readonly detail: 'memory_proposed' | MeriHermesBrokerEffectDeniedDetailV1 |
    'caller_reported_unknown';
  readonly brokerCallsBefore: number;
  readonly brokerCallsAfter: number;
  readonly eventSeq: number | null;
}

export interface MeriHermesMemoryProposalEffectReceiptV1
extends MeriHermesMemoryProposalEffectIdentityV1,
  MeriHermesMemoryProposalEffectReceiptFactsV1 {
  readonly purpose: typeof MERI_HERMES_BROKER_EFFECT_RECEIPT_PURPOSE;
  readonly receiptId: string;
  readonly resultSummary: 'memory_proposed' | 'denied' | 'unknown';
  readonly domainRef: string | null;
  readonly appliedAt: string;
  readonly appliedAtEpochMicros: string;
  readonly retainUntilEpochMicros: string;
  readonly signedClaimsSha256: string;
  readonly signerKeyId: string | null;
  readonly signature: string | null;
  readonly qualificationSha256: string | null;
  readonly signatureVerifiedAtEpochMicros: string | null;
  readonly receiptSha256: string;
  readonly signed: boolean;
}

export type MeriHermesMemoryProposalEffectResultV1 =
  | Readonly<{ kind: 'committed'; receipt: MeriHermesMemoryProposalEffectReceiptV1;
      result: Readonly<{ candidateId: string;
        scope: 'personal' | 'firm' | 'client' }> }>
  | Readonly<{ kind: 'denied_before_effect'; receipt: MeriHermesMemoryProposalEffectReceiptV1;
      result: Readonly<{ proposed: false; code: 'denied_before_effect';
        detail: MeriHermesBrokerEffectDeniedDetailV1 }> }>
  | Readonly<{ kind: 'effect_unknown';
      receipt: MeriHermesMemoryProposalEffectReceiptV1 | null }>;

function confidenceToCanonical(confidence: number | null): string {
  if (confidence === null) return 'null';
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(confidence);
  return buf.toString('hex');
}

export function meriHermesMemoryProposalCandidateIdV1(operationId: string): string {
  if (!UUID.test(operationId)) throw new Error('invalid memory proposal operation id');
  return `memcand_${operationId}`;
}

export function normalizeMeriHermesMemoryProposalRequestV1(
  value: Readonly<{ key: string; value: string; scope: 'personal' | 'firm' | 'client';
    clientId?: string | null; confidence?: number | null; sourceExcerpt?: string | null }>,
): MeriHermesMemoryProposalRequestV1 {
  if (!value || typeof value !== 'object' ||
      typeof value.key !== 'string' || typeof value.value !== 'string' ||
      (value.scope !== 'personal' && value.scope !== 'firm' && value.scope !== 'client') ||
      (value.clientId !== undefined && value.clientId !== null &&
       typeof value.clientId !== 'string') ||
      (value.confidence !== undefined && value.confidence !== null &&
       typeof value.confidence !== 'number') ||
      (value.sourceExcerpt !== undefined && value.sourceExcerpt !== null &&
       typeof value.sourceExcerpt !== 'string')) {
    throw new Error('invalid memory proposal request');
  }
  const key = value.key.trim();
  if (!key || key.length > 200) {
    throw new Error('invalid memory proposal key');
  }
  const normalizedValue = value.value.trim();
  if (!normalizedValue || normalizedValue.length > 8000) {
    throw new Error('invalid memory proposal value');
  }
  const clientId = (value.scope === 'client' ? value.clientId : null) ?? null;
  if (value.scope === 'client' && (clientId === null || !UUID.test(clientId))) {
    throw new Error('invalid memory proposal scope/clientId');
  }
  if (value.scope !== 'client' && value.clientId !== undefined && value.clientId !== null) {
    throw new Error('invalid memory proposal scope/clientId');
  }
  const confidence = (value.confidence ?? null) as number | null;
  if (confidence !== null && (confidence < 0 || confidence > 1 || !Number.isFinite(confidence))) {
    throw new Error('invalid memory proposal confidence');
  }
  const sourceExcerpt = value.sourceExcerpt === null || value.sourceExcerpt === undefined
    ? null : value.sourceExcerpt.slice(0, 4000);
  return Object.freeze({
    key,
    value: normalizedValue,
    scope: value.scope,
    clientId,
    confidence,
    sourceExcerpt,
  });
}

function memoryProposalRequestParts(
  input: Omit<CreateMeriHermesMemoryProposalEffectIdentityV1, 'operationId'>,
): readonly string[] {
  const request = normalizeMeriHermesMemoryProposalRequestV1(input.request);
  return [
    REQUEST_DOMAIN, input.tenantId, input.runId, input.workerRunId,
    input.dispatchRequestSha256, input.scopeId, MERI_HERMES_PROPOSE_MEMORY_TOOL,
    request.key, request.value, request.scope, request.clientId ?? 'null',
    confidenceToCanonical(request.confidence), request.sourceExcerpt ?? 'null',
  ];
}

export function meriHermesMemoryProposalRequestSha256V1(
  input: Omit<CreateMeriHermesMemoryProposalEffectIdentityV1, 'operationId'>,
): string {
  if (!input || typeof input !== 'object' ||
      typeof input.tenantId !== 'string' || !UUID.test(input.tenantId) ||
      typeof input.runId !== 'string' || !UUID.test(input.runId) ||
      typeof input.workerRunId !== 'string' || !WORKER_RUN_ID.test(input.workerRunId) ||
      typeof input.dispatchRequestSha256 !== 'string' ||
      !SHA256.test(input.dispatchRequestSha256) ||
      typeof input.scopeId !== 'string' ||
      !validPrivateScope(input.tenantId, input.scopeId)) {
    throw new Error('invalid memory proposal request identity');
  }
  return digest(memoryProposalRequestParts(input));
}

export function isMeriHermesMemoryProposalEffectIdentityV1(
  value: unknown,
): value is MeriHermesMemoryProposalEffectIdentityV1 {

  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!exactFieldSet(row, [
    'version', 'tenantId', 'runId', 'workerRunId', 'dispatchRequestSha256',
    'scopeId', 'operationId', 'tool', 'requestSha256',
  ]) || row.version !== MERI_HERMES_BROKER_EFFECT_VERSION ||
      typeof row.tenantId !== 'string' || !UUID.test(row.tenantId) ||
      typeof row.runId !== 'string' || !UUID.test(row.runId) ||
      typeof row.workerRunId !== 'string' || !WORKER_RUN_ID.test(row.workerRunId) ||
      typeof row.dispatchRequestSha256 !== 'string' || !SHA256.test(row.dispatchRequestSha256) ||
      typeof row.scopeId !== 'string' || !validPrivateScope(row.tenantId, row.scopeId) ||
      typeof row.operationId !== 'string' || !UUID.test(row.operationId) ||
      row.tool !== MERI_HERMES_PROPOSE_MEMORY_TOOL ||
      typeof row.requestSha256 !== 'string' || !SHA256.test(row.requestSha256)) {
    return false;
  }
  return true;
}

export function createMeriHermesMemoryProposalEffectIdentityV1(
  input: Readonly<CreateMeriHermesMemoryProposalEffectIdentityV1>,
): MeriHermesMemoryProposalEffectIdentityV1 {
  const identity: MeriHermesMemoryProposalEffectIdentityV1 = {
    version: MERI_HERMES_BROKER_EFFECT_VERSION,
    tenantId: input?.tenantId,
    runId: input?.runId,
    workerRunId: input?.workerRunId,
    dispatchRequestSha256: input?.dispatchRequestSha256,
    scopeId: input?.scopeId,
    operationId: input?.operationId,
    tool: MERI_HERMES_PROPOSE_MEMORY_TOOL,
    requestSha256: meriHermesMemoryProposalRequestSha256V1(input),
  };
  if (!isMeriHermesMemoryProposalEffectIdentityV1(identity)) {
    throw new Error('invalid memory proposal effect identity');
  }
  return Object.freeze(identity);
}

function normalizedMemoryProposalFacts(
  value: unknown,
): MeriHermesMemoryProposalEffectReceiptFactsV1 | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const before = canonicalInteger(row.brokerCallsBefore);
  const after = canonicalInteger(row.brokerCallsAfter);
  const eventSeq = row.eventSeq === null
    ? null : canonicalInteger(row.eventSeq, MAX_SIGNED_INT32, false);
  if (before === null || after === null ||
      (row.eventSeq !== null && eventSeq === null)) return null;
  if (row.result === 'committed' && row.detail === 'memory_proposed' &&
      after === before + 1 && eventSeq !== null) {
    return Object.freeze({ result: row.result, detail: row.detail,
      brokerCallsBefore: before, brokerCallsAfter: after, eventSeq });
  }
  if (row.result === 'denied_before_effect' && typeof row.detail === 'string' &&
      DENIED_DETAILS.has(row.detail as MeriHermesBrokerEffectDeniedDetailV1) &&
      after === before && eventSeq === null) {
    return Object.freeze({ result: row.result,
      detail: row.detail as MeriHermesBrokerEffectDeniedDetailV1,
      brokerCallsBefore: before, brokerCallsAfter: after, eventSeq: null });
  }
  if (row.result === 'effect_unknown' && row.detail === 'caller_reported_unknown' &&
      after === before && eventSeq === null) {
    return Object.freeze({ result: row.result, detail: row.detail,
      brokerCallsBefore: before, brokerCallsAfter: after, eventSeq: null });
  }
  return null;
}

function memoryProposalSummary(
  result: MeriHermesBrokerEffectResultKindV1,
  operationId: string,
): { readonly resultSummary: 'memory_proposed' | 'denied' | 'unknown';
  readonly domainRef: string | null } {
  if (result === 'committed') return {
    resultSummary: 'memory_proposed',
    domainRef: meriHermesMemoryProposalCandidateIdV1(operationId),
  };
  return result === 'denied_before_effect'
    ? { resultSummary: 'denied', domainRef: null }
    : { resultSummary: 'unknown', domainRef: null };
}

export function meriHermesMemoryProposalReceiptClaimsSha256V1(
  identity: Readonly<MeriHermesMemoryProposalEffectIdentityV1>,
  facts: Readonly<MeriHermesMemoryProposalEffectReceiptFactsV1>,
): string {
  if (!isMeriHermesMemoryProposalEffectIdentityV1(identity)) {
    throw new Error('invalid memory proposal receipt identity');
  }
  const normalized = normalizedMemoryProposalFacts(facts);
  if (!normalized) throw new Error('invalid memory proposal receipt facts');
  const summary = memoryProposalSummary(normalized.result, identity.operationId);
  return digest([
    CLAIMS_DOMAIN, identity.tenantId, identity.runId, identity.workerRunId,
    identity.dispatchRequestSha256, identity.scopeId, identity.operationId,
    identity.tool, identity.requestSha256, normalized.result, normalized.detail,
    String(normalized.brokerCallsBefore), String(normalized.brokerCallsAfter),
    normalized.eventSeq === null ? 'null' : String(normalized.eventSeq),
    summary.resultSummary, summary.domainRef ?? 'null',
  ]);
}

export function parseMeriHermesMemoryProposalEffectReceiptV1(
  row: unknown,
  identity: Readonly<MeriHermesMemoryProposalEffectIdentityV1>,
  keys: ReadonlyMap<string, Readonly<MeriHermesBrokerEffectReceiptKeyV1>>,
): MeriHermesMemoryProposalEffectReceiptV1 | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row) ||
      !isMeriHermesMemoryProposalEffectIdentityV1(identity) ||
      !(keys instanceof Map)) return null;
  const value = row as Record<string, unknown>;
  if (!exactFieldSet(value, [
    'receipt_id', 'result', 'detail', 'broker_calls_before', 'broker_calls_after',
    'event_seq', 'applied_at', 'applied_at_epoch_micros',
    'retain_until_epoch_micros', 'signed_claims_sha256', 'signer_key_id',
    'signature', 'signature_verified_at_epoch_micros', 'qualification_sha256',
    'receipt_sha256',
  ]) || typeof value.receipt_id !== 'string' || !UUID.test(value.receipt_id) ||
      !(value.applied_at instanceof Date) || !Number.isFinite(value.applied_at.getTime()) ||
      typeof value.signed_claims_sha256 !== 'string' ||
      !SHA256.test(value.signed_claims_sha256) ||
      typeof value.receipt_sha256 !== 'string' || !SHA256.test(value.receipt_sha256)) return null;
  const facts = normalizedMemoryProposalFacts({
    result: value.result, detail: value.detail,
    brokerCallsBefore: value.broker_calls_before,
    brokerCallsAfter: value.broker_calls_after,
    eventSeq: value.event_seq,
  });
  const applied = canonicalMicros(value.applied_at_epoch_micros);
  const retain = canonicalMicros(value.retain_until_epoch_micros);
  if (!facts || !applied || !retain || BigInt(retain) <= BigInt(applied) ||
      BigInt(retain) - BigInt(applied) > MAX_RETENTION_SPAN_MICROS) return null;
  const expectedClaims = meriHermesMemoryProposalReceiptClaimsSha256V1(identity, facts);
  if (!timingSafeEqual(
    Buffer.from(expectedClaims, 'hex'), Buffer.from(value.signed_claims_sha256, 'hex'),
  )) return null;
  const signerKeyId = value.signer_key_id;
  const signature = value.signature;
  const qualification = value.qualification_sha256;
  const verifiedAt = canonicalMicros(value.signature_verified_at_epoch_micros);
  const unsigned = signerKeyId === null && signature === null && qualification === null &&
    value.signature_verified_at_epoch_micros === null;
  let signed = false;
  if (unsigned) {
    if (facts.result !== 'effect_unknown') return null;
  } else {
    if (facts.result === 'effect_unknown') return null;
    if (typeof signerKeyId !== 'string' || typeof signature !== 'string' ||
        typeof qualification !== 'string' || !verifiedAt) return null;
    const key = keys.get(signerKeyId);
    if (!key || key.keyId !== signerKeyId || !validKey(key, identity) ||
        qualification !== key.qualificationSha256 ||
        BigInt(verifiedAt) < BigInt(key.notBeforeEpochMicros) ||
        BigInt(verifiedAt) >= BigInt(key.notAfterEpochMicros) ||
        BigInt(verifiedAt) > BigInt(applied) ||
        !verifySignature(expectedClaims, signature, key)) return null;
    signed = true;
  }
  let expectedReceipt: string;
  try {
    expectedReceipt = meriHermesBrokerEffectReceiptSha256V1(
      expectedClaims,
      typeof signerKeyId === 'string' ? signerKeyId : null,
      typeof signature === 'string' ? signature : null,
      typeof qualification === 'string' ? qualification : null,
    );
  } catch {
    return null;
  }
  if (!timingSafeEqual(
    Buffer.from(expectedReceipt, 'hex'), Buffer.from(value.receipt_sha256, 'hex'),
  )) return null;
  const summary = memoryProposalSummary(facts.result, identity.operationId);
  return Object.freeze({
    ...identity,
    purpose: MERI_HERMES_BROKER_EFFECT_RECEIPT_PURPOSE,
    receiptId: value.receipt_id,
    ...facts,
    ...summary,
    appliedAt: value.applied_at.toISOString(),
    appliedAtEpochMicros: applied,
    retainUntilEpochMicros: retain,
    signedClaimsSha256: expectedClaims,
    signerKeyId: typeof signerKeyId === 'string' ? signerKeyId : null,
    signature: typeof signature === 'string' ? signature : null,
    qualificationSha256: typeof qualification === 'string' ? qualification : null,
    signatureVerifiedAtEpochMicros: verifiedAt,
    receiptSha256: expectedReceipt,
    signed,
  });
}

export function meriHermesMemoryProposalEffectResultV1(
  receipt: Readonly<MeriHermesMemoryProposalEffectReceiptV1> | null,
  scope: 'personal' | 'firm' | 'client',
): MeriHermesMemoryProposalEffectResultV1 {
  if (!receipt || receipt.result === 'effect_unknown') {
    return Object.freeze({ kind: 'effect_unknown' as const, receipt: receipt ?? null });
  }
  if (!receipt.signed) return Object.freeze({ kind: 'effect_unknown' as const, receipt: null });
  if (receipt.result === 'committed') {
    return Object.freeze({ kind: 'committed' as const, receipt,
      result: Object.freeze({ candidateId: meriHermesMemoryProposalCandidateIdV1(receipt.operationId),
        scope }) });
  }
  return Object.freeze({ kind: 'denied_before_effect' as const, receipt,
    result: Object.freeze({ proposed: false as const,
      code: 'denied_before_effect' as const,
      detail: receipt.detail as MeriHermesBrokerEffectDeniedDetailV1 }) });
}

// ── Read-effect saga boundary (item 2, smallest safe first package) ──
// The full read-effect saga (prepare/admit/execute/seal) is not yet implemented.
// This boundary provides the contract-level rejection for retryExtraction=true
// and the tool name constants for future budget integration.

/**
 * Result returned when `meri_fetch_attachment` is called with `retryExtraction=true`.
 * The extraction saga requires a reconciler that does not yet exist. The caller
 * must not retry the same operation with `retryExtraction=true` until the
 * reconciler is available.
 */
export interface MeriHermesReadEffectRetryRequiresReconcilerV1 {
  readonly kind: 'retry_requires_reconciler';
  readonly tool: typeof MERI_HERMES_FETCH_ATTACHMENT_TOOL;
  readonly reason: 'extraction_saga_not_available';
}

export function meriHermesReadEffectRetryRequiresReconcilerV1(): MeriHermesReadEffectRetryRequiresReconcilerV1 {
  return Object.freeze({
    kind: 'retry_requires_reconciler' as const,
    tool: MERI_HERMES_FETCH_ATTACHMENT_TOOL,
    reason: 'extraction_saga_not_available' as const,
  });
}

// ── Item 5: Stable per-tool operation identity ──
// The API mints a random operation namespace UUID in the successful run-claim
// transaction. The worker allocates a per-run monotonic slot (0, 1, 2, …).
// The API derives the final operation UUID deterministically from (namespace,
// dispatch identity, slot) using UUID v5 (SHA-1 name-based). Retries reuse the
// same slot; two intentional identical calls get different slots. The worker
// never submits or chooses an operation UUID.

const OPERATION_ID_DOMAIN =
  'capiro.meri.phase4.operation-identity/v1' as const;

/** Maximum slot value: 40 tool calls bounded by maxToolCalls. */
export const MERI_HERMES_MAX_OPERATION_SLOT = 40;

/**
 * The API-minted namespace persisted in the run-claim transaction.
 * A broker-run grant carries this namespace to the effect boundary.
 */
export interface MeriHermesOperationNamespaceV1 {
  readonly version: typeof MERI_HERMES_BROKER_EFFECT_VERSION;
  readonly namespace: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly workerRunId: string;
  readonly dispatchRequestSha256: string;
}

export function isMeriHermesOperationNamespaceV1(
  value: unknown,
): value is MeriHermesOperationNamespaceV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return row.version === MERI_HERMES_BROKER_EFFECT_VERSION &&
    typeof row.namespace === 'string' && UUID.test(row.namespace) &&
    typeof row.tenantId === 'string' && UUID.test(row.tenantId) &&
    typeof row.runId === 'string' && UUID.test(row.runId) &&
    typeof row.workerRunId === 'string' && row.workerRunId.length > 0 &&
    row.workerRunId.length <= 120 &&
    typeof row.dispatchRequestSha256 === 'string' &&
    SHA256.test(row.dispatchRequestSha256);
}

export function createMeriHermesOperationNamespaceV1(
  input: Omit<MeriHermesOperationNamespaceV1, 'version'>,
): MeriHermesOperationNamespaceV1 {
  const ns: MeriHermesOperationNamespaceV1 = {
    version: MERI_HERMES_BROKER_EFFECT_VERSION,
    namespace: input?.namespace,
    tenantId: input?.tenantId,
    runId: input?.runId,
    workerRunId: input?.workerRunId,
    dispatchRequestSha256: input?.dispatchRequestSha256,
  };
  if (!isMeriHermesOperationNamespaceV1(ns)) {
    throw new Error('invalid operation namespace');
  }
  return Object.freeze(ns);
}

/**
 * Derive a deterministic operation UUID from the API-minted namespace, the
 * exact claimed dispatch identity, and a monotonic slot. Uses UUID v5
 * (RFC 4122 §4.3, SHA-1 name-based) with the namespace UUID as the v5
 * namespace and a canonical input string as the name.
 *
 * The slot is the worker's per-run monotonic counter (0-based). Retries of the
 * same tool call reuse the slot; two intentional identical calls get different
 * slots. The worker never submits or chooses an operation UUID.
 */
export function deriveOperationIdV1(
  ns: Readonly<MeriHermesOperationNamespaceV1>,
  tool: string,
  slot: number,
): string {
  if (!isMeriHermesOperationNamespaceV1(ns)) {
    throw new Error('invalid operation namespace for derivation');
  }
  if (typeof tool !== 'string' || tool.length === 0 || tool.length > 128) {
    throw new Error('invalid tool name for operation derivation');
  }
  if (!Number.isInteger(slot) || slot < 0 ||
      slot > MERI_HERMES_MAX_OPERATION_SLOT) {
    throw new Error(`operation slot must be 0..${MERI_HERMES_MAX_OPERATION_SLOT}`);
  }
  // Canonical name: domain + namespace fields + tool + slot
  const name = [
    OPERATION_ID_DOMAIN,
    ns.namespace,
    ns.tenantId,
    ns.runId,
    ns.workerRunId,
    ns.dispatchRequestSha256,
    tool,
    String(slot),
  ].join('\0');
  return uuidV5FromSha1(ns.namespace, name);
}

/**
 * UUID v5 per RFC 4122 §4.3. Uses SHA-1 of (namespace bytes ++ name bytes)
 * and sets version=5, variant=10xx.
 */
function uuidV5FromSha1(namespaceUuid: string, name: string): string {
  // Parse namespace UUID to 16 bytes
  const hex = namespaceUuid.replace(/-/g, '');
  const nsBytes = Buffer.from(hex, 'hex');
  if (nsBytes.length !== 16) throw new Error('invalid namespace uuid length');
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1').update(nsBytes).update(nameBytes).digest();
  // Set version 5 (bits 48-51 = 0101)
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  // Set variant (bits 64-65 = 10)
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Broker-run grant returned to the effect boundary after a successful claim.
 * The namespace is the only new field; existing fields (tenantId, runId,
 * workerRunId, dispatchRequestSha256) are already available in the locked
 * dispatch context and are repeated here for self-contained derivation.
 */
export interface MeriHermesBrokerRunGrantV1 {
  readonly version: typeof MERI_HERMES_BROKER_EFFECT_VERSION;
  readonly operationNamespace: Readonly<MeriHermesOperationNamespaceV1>;
}

export function createMeriHermesBrokerRunGrantV1(
  ns: Readonly<MeriHermesOperationNamespaceV1>,
): MeriHermesBrokerRunGrantV1 {
  if (!isMeriHermesOperationNamespaceV1(ns)) {
    throw new Error('invalid operation namespace for broker run grant');
  }
  return Object.freeze({
    version: MERI_HERMES_BROKER_EFFECT_VERSION,
    operationNamespace: ns,
  });
}
