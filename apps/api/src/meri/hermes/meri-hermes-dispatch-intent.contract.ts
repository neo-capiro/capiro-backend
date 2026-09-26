import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { privateExecutionScopeId } from './meri-hermes-worker-token.js';

/**
 * Dormant Phase 4 no-copy wire identity. Nothing imports this into the active
 * adapter, worker client, controller, module or worker overlay. In particular,
 * producing a digest is NOT an admission, authorization, Stop or launch grant.
 *
 * The body hash covers the exact UTF-8 bytes sent to POST /v1/runs, including
 * model, instructions, session_id and any request-local tool-view token. The
 * worker must submit the bytes it actually received, not reserialize JSON.
 * The session-key value is represented only by a keyed hash. The worker sends
 * the exact received header to the authenticated private API gate, which
 * recomputes the HMAC; the untrusted worker does not receive the HMAC key.
 * The API must retain old keys through the reconciliation horizon. No bearer
 * or HMAC key is stored in the intent.
 */
export const MERI_DISPATCH_IDENTITY_VERSION = 2 as const;
const DOMAIN = 'capiro.meri.phase4.dispatch-request/v2';
const SESSION_DOMAIN = 'capiro.meri.phase4.session-header/v2';
const SOURCE_MESSAGE_DOMAIN = 'capiro.meri.phase4.source-message/v2';
const REQUEST_ASSEMBLY_DOMAIN = 'capiro.meri.phase4.request-assembly/v2';
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EPOCH_MICROS = /^(0|[1-9][0-9]{0,18})$/;
const MAX_SIGNED_INT64_MICROS = 9_223_372_036_854_775_807n;
/** Minimum uncertainty-observation time beyond every delivery/credential expiry. */
export const MERI_DISPATCH_RECOVERY_MARGIN_MICROS_V2 = 86_400_000_000n;
/** Minimum tombstone retention after the reconciliation deadline. */
export const MERI_DISPATCH_RETENTION_MARGIN_MICROS_V2 = 86_400_000_000n;

export interface MeriDispatchRequestMetadataV2 {
  version: typeof MERI_DISPATCH_IDENTITY_VERSION;
  tenantId: string;
  /** V2 is intentionally limited to today's private user execution scope. */
  actorType: 'user';
  actorId: string;
  meriAudience: 'private';
  clientId: string | null;
  workspaceId: string | null;
  scopeId: string;
  conversationId: string;
  userMessageId: string;
  runId: string;
  idempotencyKey: string;
  conversationEpoch: number;
  workerAudience: string;
  workerIngressId: string;
  workerGeneration: string;
  workerCredentialId: string;
  /** Exact Meri envelope authorizationVersion, not merely a policy label. */
  authorizationVersion: string;
  authorizationPolicyVersion: string;
  grantVersion: string;
  catalogDigest: string;
  toolViewDigest: string;
  sessionHeaderKeyId: string;
  /** Cutoffs are canonical decimal Unix microseconds, enforced by DB clock. */
  claimNotAfterEpochMicros: string;
  deliveryNotAfterEpochMicros: string;
  workerCredentialNotAfterEpochMicros: string;
  reconciliationNotAfterEpochMicros: string;
  retainUntilEpochMicros: string;
}

export interface MeriDispatchRequestIdentityV2 extends MeriDispatchRequestMetadataV2 {
  sourceMessageSha256: string;
  bodyLengthBytes: number;
  bodySha256: string;
  requestAssemblySha256: string;
  sessionHeaderHmacSha256: string;
  requestSha256: string;
}

export interface MeriDispatchSourceMessageMaterialV2 {
  /** Exact body persisted on the user ClioMessage. */
  body: string;
  /** Exact JSON provenance persisted on that message. */
  metadata: unknown;
}

/**
 * Transient inputs only. Never persist either content-bearing body, the
 * session-key value, or the HMAC key; only their bound digests survive.
 */
export interface MeriDispatchRequestMaterialV2 {
  metadata: MeriDispatchRequestMetadataV2;
  sourceMessage: MeriDispatchSourceMessageMaterialV2;
  bodyBytes: Uint8Array;
  sessionKeyHeaderValue: string;
  /** API-selected from a trusted keyring by metadata.sessionHeaderKeyId. */
  sessionHeaderHmacKey: Uint8Array;
}

/** Mirrors today's `sessionKeyFor` only for the V2 private-user scope. */
export function meriDispatchExpectedPrivateSessionKeyV2(
  metadata: Pick<MeriDispatchRequestMetadataV2,
    'tenantId' | 'actorId' | 'conversationId' | 'conversationEpoch'>,
): string {
  const scopeId = privateExecutionScopeId(metadata.tenantId, metadata.actorId);
  const base = `${scopeId}:conversation:${metadata.conversationId}`;
  return metadata.conversationEpoch > 0 ? `${base}:e${metadata.conversationEpoch}` : base;
}

function framed(parts: readonly string[]): Buffer {
  const frames: Buffer[] = [];
  for (const part of parts) {
    const value = Buffer.from(part, 'utf8');
    if (value.length > 0xffffffff) throw new Error('dispatch identity field is too large');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length, 0);
    frames.push(length, value);
  }
  return Buffer.concat(frames);
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('source-message string is not JSON');
    return encoded;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('source-message metadata contains a non-finite number');
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('source-message metadata must be plain JSON');
    }
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('source-message metadata is not JSON');
}

/**
 * Detaches a caller-owned JSON graph and gives every consumer the same sorted,
 * plain-JSON snapshot. This is intentionally synchronous so admission code can
 * call it before its first await and never retain a mutable caller reference.
 */
export function meriDispatchCanonicalJsonSnapshot<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export function meriDispatchSourceMessageSha256V2(
  metadata: Pick<MeriDispatchRequestMetadataV2,
    'tenantId' | 'actorId' | 'clientId' | 'conversationId' | 'userMessageId'>,
  source: MeriDispatchSourceMessageMaterialV2,
): string {
  if (typeof source?.body !== 'string' || source.body.length === 0) {
    throw new Error('source-message body must be nonempty');
  }
  return createHash('sha256').update(framed([
    SOURCE_MESSAGE_DOMAIN,
    metadata.tenantId,
    metadata.actorId,
    metadata.clientId === null ? '0' : '1',
    metadata.clientId ?? '',
    metadata.conversationId,
    metadata.userMessageId,
    'user',
    source.body,
    canonicalJson(source.metadata),
  ])).digest('hex');
}

function requestAssemblySha256(
  sourceMessageSha256: string,
  bodyLengthBytes: number,
  bodySha256: string,
): string {
  return createHash('sha256').update(framed([
    REQUEST_ASSEMBLY_DOMAIN,
    sourceMessageSha256,
    String(bodyLengthBytes),
    bodySha256,
  ])).digest('hex');
}

function requestDigest(identity: Omit<MeriDispatchRequestIdentityV2, 'requestSha256'>): string {
  // Fixed ordered, length-prefixed UTF-8 fields make null distinct from text,
  // delimiters unambiguous, and object insertion order irrelevant. All future
  // fields require a new version; a validator rejects unknown fields below.
  return createHash('sha256').update(framed([
    DOMAIN,
    String(identity.version), 'POST', '/v1/runs', 'application/json',
    identity.tenantId, identity.actorType, identity.actorId, identity.meriAudience,
    identity.clientId === null ? '0' : '1', identity.clientId ?? '',
    identity.workspaceId === null ? '0' : '1', identity.workspaceId ?? '',
    identity.scopeId, identity.conversationId, identity.userMessageId,
    identity.runId, 'idempotency-key', identity.idempotencyKey,
    String(identity.conversationEpoch),
    identity.workerAudience, identity.workerIngressId,
    identity.workerGeneration, identity.workerCredentialId,
    identity.authorizationVersion, identity.authorizationPolicyVersion,
    identity.grantVersion,
    identity.catalogDigest, identity.toolViewDigest, identity.sessionHeaderKeyId,
    identity.claimNotAfterEpochMicros, identity.deliveryNotAfterEpochMicros,
    identity.workerCredentialNotAfterEpochMicros,
    identity.reconciliationNotAfterEpochMicros, identity.retainUntilEpochMicros,
    identity.sourceMessageSha256,
    String(identity.bodyLengthBytes), identity.bodySha256,
    identity.requestAssemblySha256,
    identity.sessionHeaderHmacSha256,
  ])).digest('hex');
}

const identityKeys = [
  'version', 'tenantId', 'actorType', 'actorId', 'meriAudience',
  'clientId', 'workspaceId', 'scopeId', 'conversationId',
  'userMessageId', 'runId', 'idempotencyKey', 'conversationEpoch',
  'workerAudience', 'workerIngressId', 'workerGeneration', 'workerCredentialId',
  'authorizationVersion', 'authorizationPolicyVersion',
  'grantVersion', 'catalogDigest', 'toolViewDigest', 'sessionHeaderKeyId',
  'claimNotAfterEpochMicros', 'deliveryNotAfterEpochMicros',
  'workerCredentialNotAfterEpochMicros', 'reconciliationNotAfterEpochMicros',
  'retainUntilEpochMicros', 'sourceMessageSha256', 'bodyLengthBytes', 'bodySha256',
  'requestAssemblySha256',
  'sessionHeaderHmacSha256', 'requestSha256',
] as const;
const identityKeySet = new Set<string>(identityKeys);

const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value);

// Mirrors MeriAgentRun.hermesRunId VARCHAR(120), which is atomically bound in
// the same transaction as the dispatch intent's claimed state.
const workerRunId = (value: unknown): value is string =>
  nonempty(value) && value.length <= 120;

const positiveEpochMicros = (value: unknown): value is string =>
  typeof value === 'string' && EPOCH_MICROS.test(value) &&
  BigInt(value) > 0n && BigInt(value) <= MAX_SIGNED_INT64_MICROS;

export function isMeriDispatchRequestIdentityV2(value: unknown): value is MeriDispatchRequestIdentityV2 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== identityKeys.length || !keys.every((key) => identityKeySet.has(key))) return false;
  if (row.version !== MERI_DISPATCH_IDENTITY_VERSION) return false;
  if (row.actorType !== 'user' || row.meriAudience !== 'private') return false;
  for (const key of ['tenantId', 'actorId', 'conversationId', 'userMessageId', 'runId'] as const) {
    const identifier = row[key];
    if (typeof identifier !== 'string' || !UUID.test(identifier)) return false;
  }
  if (row.clientId !== null && (typeof row.clientId !== 'string' || !UUID.test(row.clientId))) return false;
  if (row.workspaceId !== null && (typeof row.workspaceId !== 'string' || !UUID.test(row.workspaceId))) return false;
  for (const key of [
    'scopeId', 'idempotencyKey', 'workerAudience', 'workerIngressId',
    'workerGeneration', 'workerCredentialId',
    'authorizationVersion', 'authorizationPolicyVersion',
    'grantVersion', 'sessionHeaderKeyId',
  ] as const) {
    if (!nonempty(row[key])) return false;
  }
  // The authoritative MeriAgentRun column is VARCHAR(200); accepting a wider
  // identity here would produce a contract-valid request that can never be
  // committed atomically with its source run.
  if (typeof row.idempotencyKey !== 'string' || row.idempotencyKey.length > 200 ||
      !/^[\x21-\x7e]+$/.test(row.idempotencyKey)) return false;
  for (const key of ['catalogDigest', 'toolViewDigest', 'sourceMessageSha256', 'bodySha256',
    'requestAssemblySha256',
    'sessionHeaderHmacSha256', 'requestSha256'] as const) {
    const digest = row[key];
    if (typeof digest !== 'string' || !SHA256.test(digest)) return false;
  }
  if (typeof row.conversationEpoch !== 'number' || !Number.isSafeInteger(row.conversationEpoch) ||
      row.conversationEpoch < 0 || typeof row.bodyLengthBytes !== 'number' ||
      !Number.isSafeInteger(row.bodyLengthBytes) || row.bodyLengthBytes <= 0) return false;
  if (row.scopeId !== privateExecutionScopeId(row.tenantId as string, row.actorId as string)) return false;
  const cutoffs = [
    'claimNotAfterEpochMicros', 'deliveryNotAfterEpochMicros',
    'workerCredentialNotAfterEpochMicros', 'reconciliationNotAfterEpochMicros',
    'retainUntilEpochMicros',
  ] as const;
  for (const key of cutoffs) {
    if (!positiveEpochMicros(row[key])) return false;
  }
  const claim = BigInt(row.claimNotAfterEpochMicros as string);
  const delivery = BigInt(row.deliveryNotAfterEpochMicros as string);
  const credential = BigInt(row.workerCredentialNotAfterEpochMicros as string);
  const reconcile = BigInt(row.reconciliationNotAfterEpochMicros as string);
  const retain = BigInt(row.retainUntilEpochMicros as string);
  if (delivery < claim || credential < claim ||
      reconcile < (delivery > credential ? delivery : credential) + MERI_DISPATCH_RECOVERY_MARGIN_MICROS_V2 ||
      retain < reconcile + MERI_DISPATCH_RETENTION_MARGIN_MICROS_V2) return false;
  const identity = row as unknown as MeriDispatchRequestIdentityV2;
  if (identity.requestAssemblySha256 !== requestAssemblySha256(
    identity.sourceMessageSha256,
    identity.bodyLengthBytes,
    identity.bodySha256,
  )) return false;
  const expected = requestDigest(identity);
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(identity.requestSha256, 'hex'));
}

export function createMeriDispatchRequestIdentityV2(
  material: MeriDispatchRequestMaterialV2,
): MeriDispatchRequestIdentityV2 {
  if (!(material.bodyBytes instanceof Uint8Array) || material.bodyBytes.length === 0 ||
      typeof material.sessionKeyHeaderValue !== 'string' ||
      !/^[\x21-\x7e]+$/.test(material.sessionKeyHeaderValue) ||
      material.sessionKeyHeaderValue !== meriDispatchExpectedPrivateSessionKeyV2(material.metadata) ||
      !(material.sessionHeaderHmacKey instanceof Uint8Array) ||
      material.sessionHeaderHmacKey.length < 32) {
    throw new Error('invalid dispatch request material');
  }
  const identityWithoutDigest = {
    ...material.metadata,
    sourceMessageSha256: meriDispatchSourceMessageSha256V2(material.metadata, material.sourceMessage),
    bodyLengthBytes: material.bodyBytes.length,
    bodySha256: createHash('sha256').update(material.bodyBytes).digest('hex'),
    sessionHeaderHmacSha256: createHmac('sha256', material.sessionHeaderHmacKey)
      .update(framed([SESSION_DOMAIN, 'x-hermes-session-key', material.sessionKeyHeaderValue]))
      .digest('hex'),
  };
  const withAssemblyDigest = {
    ...identityWithoutDigest,
    requestAssemblySha256: requestAssemblySha256(
      identityWithoutDigest.sourceMessageSha256,
      identityWithoutDigest.bodyLengthBytes,
      identityWithoutDigest.bodySha256,
    ),
  };
  const identity: MeriDispatchRequestIdentityV2 = {
    ...withAssemblyDigest,
    requestSha256: requestDigest(withAssemblyDigest),
  };
  if (!isMeriDispatchRequestIdentityV2(identity)) throw new Error('invalid dispatch request metadata');
  return Object.freeze(identity);
}

/**
 * A future authenticated claim route must recompute from the received raw
 * bytes and exact header, then compare to the committed identity. This pure
 * check is only one prerequisite; it does not replace transactional Stop,
 * grant/revocation, generation and DB-clock checks.
 */
export function matchesMeriDispatchRequestMaterialV2(
  identity: unknown,
  material: MeriDispatchRequestMaterialV2,
): boolean {
  if (!isMeriDispatchRequestIdentityV2(identity)) return false;
  try {
    const actual = createMeriDispatchRequestIdentityV2(material);
    return timingSafeEqual(
      Buffer.from(identity.requestSha256, 'hex'),
      Buffer.from(actual.requestSha256, 'hex'),
    );
  } catch {
    return false;
  }
}

/**
 * Exact received-wire prerequisite for a future private dispatch gate. The
 * worker supplies its original bytes and session/idempotency headers; the API alone selects the HMAC
 * key by identity.sessionHeaderKeyId. This does not authorize or claim a run.
 * Neither raw input nor key material is retained or logged here.
 */
export function matchesMeriDispatchReceivedRequestV2(
  identity: unknown,
  receivedBodyBytes: unknown,
  receivedSessionKeyHeaderValue: unknown,
  receivedIdempotencyKeyHeaderValue: unknown,
  apiOwnedSessionHeaderHmacKey: unknown,
): boolean {
  if (!isMeriDispatchRequestIdentityV2(identity) ||
      !(receivedBodyBytes instanceof Uint8Array) || receivedBodyBytes.length === 0 ||
      receivedBodyBytes.length !== identity.bodyLengthBytes ||
      typeof receivedSessionKeyHeaderValue !== 'string' ||
      !/^[\x21-\x7e]+$/.test(receivedSessionKeyHeaderValue) ||
      receivedSessionKeyHeaderValue !== meriDispatchExpectedPrivateSessionKeyV2(identity) ||
      typeof receivedIdempotencyKeyHeaderValue !== 'string' ||
      !/^[\x21-\x7e]+$/.test(receivedIdempotencyKeyHeaderValue) ||
      receivedIdempotencyKeyHeaderValue !== identity.idempotencyKey ||
      !(apiOwnedSessionHeaderHmacKey instanceof Uint8Array) ||
      apiOwnedSessionHeaderHmacKey.length < 32) return false;
  const bodyHash = createHash('sha256').update(receivedBodyBytes).digest();
  const sessionHash = createHmac('sha256', apiOwnedSessionHeaderHmacKey)
    .update(framed([SESSION_DOMAIN, 'x-hermes-session-key', receivedSessionKeyHeaderValue]))
    .digest();
  const bodyMatches = timingSafeEqual(bodyHash, Buffer.from(identity.bodySha256, 'hex'));
  const sessionMatches = timingSafeEqual(sessionHash, Buffer.from(identity.sessionHeaderHmacSha256, 'hex'));
  return bodyMatches && sessionMatches;
}

/** Durable state is never changed to UNKNOWN merely because a call timed out. */
export type MeriDispatchIntentStateV2 =
  | { version: 2; state: 'prepared'; workerRunId: null; claimedAtEpochMicros: null;
      sealedAbsentAtEpochMicros: null; absenceProofSha256: null }
  | { version: 2; state: 'claimed'; workerRunId: string; claimedAtEpochMicros: string;
      sealedAbsentAtEpochMicros: null; absenceProofSha256: null }
  | { version: 2; state: 'sealed_absent'; workerRunId: null; claimedAtEpochMicros: null;
      sealedAbsentAtEpochMicros: string; absenceProofSha256: string };

export type MeriDispatchIntentObservationV2 =
  | { version: 2; kind: 'known'; intent: MeriDispatchIntentStateV2 }
  | { version: 2; kind: 'UNKNOWN'; reason:
      'commit_unconfirmed' | 'read_unavailable' | 'gate_response_unconfirmed' | 'absence_unproven' };

export function isMeriDispatchIntentStateV2(value: unknown): value is MeriDispatchIntentStateV2 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const stateKeys = new Set<string>([
    'version', 'state', 'workerRunId', 'claimedAtEpochMicros', 'sealedAbsentAtEpochMicros', 'absenceProofSha256',
  ]);
  const keys = Object.keys(row);
  if (keys.length !== stateKeys.size || !keys.every((key) => stateKeys.has(key))) return false;
  if (row.version !== MERI_DISPATCH_IDENTITY_VERSION) return false;
  if (row.state === 'prepared') {
    return row.workerRunId === null && row.claimedAtEpochMicros === null &&
      row.sealedAbsentAtEpochMicros === null && row.absenceProofSha256 === null;
  }
  if (row.state === 'claimed') {
    return workerRunId(row.workerRunId) && positiveEpochMicros(row.claimedAtEpochMicros) &&
      row.sealedAbsentAtEpochMicros === null &&
      row.absenceProofSha256 === null;
  }
  if (row.state === 'sealed_absent') {
    return row.workerRunId === null && row.claimedAtEpochMicros === null &&
      positiveEpochMicros(row.sealedAbsentAtEpochMicros) &&
      typeof row.absenceProofSha256 === 'string' && SHA256.test(row.absenceProofSha256);
  }
  return false;
}

export function isMeriDispatchIntentObservationV2(value: unknown): value is MeriDispatchIntentObservationV2 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.version !== MERI_DISPATCH_IDENTITY_VERSION) return false;
  const keys = Object.keys(row);
  if (row.kind === 'known') {
    return keys.length === 3 && keys.includes('version') && keys.includes('kind') &&
      keys.includes('intent') && isMeriDispatchIntentStateV2(row.intent);
  }
  if (row.kind === 'UNKNOWN') {
    return keys.length === 3 && keys.includes('version') && keys.includes('kind') &&
      keys.includes('reason') &&
      (row.reason === 'commit_unconfirmed' || row.reason === 'read_unavailable' ||
        row.reason === 'gate_response_unconfirmed' || row.reason === 'absence_unproven');
  }
  return false;
}

/** This is observation only; no branch grants execution or proves absence. */
export function meriDispatchClaimDispositionV2(observation: MeriDispatchIntentObservationV2):
  'requires_authoritative_transaction' | 'status_only' | 'deny' {
  if (observation.kind === 'UNKNOWN') return 'status_only';
  if (observation.intent.state === 'prepared') return 'requires_authoritative_transaction';
  return observation.intent.state === 'claimed' ? 'status_only' : 'deny';
}
