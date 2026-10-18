import {
  KeyObject,
  constants,
  createHash,
  sign as rsaSign,
  verify as rsaVerify,
} from 'node:crypto';
import { types as nodeTypes } from 'node:util';

/** Cryptographic transport binding only. Neither a valid JWT nor this module
 * admits a job, proves consent/membership, or replaces a current DB claim.
 * Only the Core issuer may call issueObjectiveWorkloadJwt, after its own
 * authenticated caller, immutable source, and current authority decisions.
 * The private key is deliberately supplied by a separate issuer-only owner. */

const ALGORITHM = 'RS256';
export const OBJECTIVE_WORKLOAD_JWT_TYPE = 'capiro-objective-workload+jwt';
const MAX_TOKEN_BYTES = 8_192;
const MAX_HEADER_BYTES = 1_024;
const MAX_PAYLOAD_BYTES = 4_096;
const MAX_SIGNING_INPUT_CHARS = 4_096;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_RETAINED_BODY_BYTES = 65_536;
const MAX_LIFETIME_SECONDS = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9:._-]{0,127}$/;
const KID = /^[A-Za-z0-9._-]{1,64}$/;
const PATH = /^\/[A-Za-z0-9/_-]+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const BINDING_FIELDS = [
  'subject', 'audience', 'method', 'path', 'query', 'body', 'operation',
  'phase', 'tenantId', 'generationJobId', 'delegationRef', 'consentId', 'attemptId',
  'runId', 'acceptedBindingSha256', 'sourceSha256',
] as const;

export const OBJECTIVE_GENERATION_WORKER_SUBJECT = 'capiro-objective-generation-worker:v1';
export const OBJECTIVE_TERMINAL_ACCOUNTANT_SUBJECT = 'capiro-objective-terminal-accountant:v1';
export const OBJECTIVE_CORE_RESULT_READER_SUBJECT = 'capiro-objective-core-result-reader:v1';
export const OBJECTIVE_STRATEGY_AUDIENCE = 'capiro:objective-strategy-api:v1';
export const OBJECTIVE_MERI_RETAINED_AUDIENCE = 'capiro:objective-meri-retained-result:v1';
const STRATEGY_ROOT = '/strategy-api/internal/objective-canonical';
const MERI_RESULT_PATH = '/v1/internal/objective-generation/retained-result/read';
const PHASE_ROUTES = {
  admit: { subject: OBJECTIVE_GENERATION_WORKER_SUBJECT, audience: OBJECTIVE_STRATEGY_AUDIENCE, method: 'POST', path: `${STRATEGY_ROOT}/generation-admissions`, accepted: false },
  'admission-read': { subject: OBJECTIVE_GENERATION_WORKER_SUBJECT, audience: OBJECTIVE_STRATEGY_AUDIENCE, method: 'GET', path: `${STRATEGY_ROOT}/generation-admissions`, accepted: false },
  publish: { subject: OBJECTIVE_GENERATION_WORKER_SUBJECT, audience: OBJECTIVE_STRATEGY_AUDIENCE, method: 'POST', path: `${STRATEGY_ROOT}/generation-requests`, accepted: false },
  'request-read': { subject: OBJECTIVE_GENERATION_WORKER_SUBJECT, audience: OBJECTIVE_STRATEGY_AUDIENCE, method: 'GET', path: `${STRATEGY_ROOT}/generation-requests`, accepted: false },
  accept: { subject: OBJECTIVE_GENERATION_WORKER_SUBJECT, audience: OBJECTIVE_STRATEGY_AUDIENCE, method: 'POST', path: `${STRATEGY_ROOT}/generation-acceptances`, accepted: true },
  complete: { subject: OBJECTIVE_GENERATION_WORKER_SUBJECT, audience: OBJECTIVE_STRATEGY_AUDIENCE, method: 'POST', path: `${STRATEGY_ROOT}/generation-completions`, accepted: true },
  'completion-read': { subject: OBJECTIVE_GENERATION_WORKER_SUBJECT, audience: OBJECTIVE_STRATEGY_AUDIENCE, method: 'GET', path: `${STRATEGY_ROOT}/generation-completions`, accepted: true },
  'terminal-account': { subject: OBJECTIVE_TERMINAL_ACCOUNTANT_SUBJECT, audience: OBJECTIVE_STRATEGY_AUDIENCE, method: 'POST', path: `${STRATEGY_ROOT}/generation-terminals`, accepted: true },
  'terminal-read': { subject: OBJECTIVE_TERMINAL_ACCOUNTANT_SUBJECT, audience: OBJECTIVE_STRATEGY_AUDIENCE, method: 'GET', path: `${STRATEGY_ROOT}/generation-terminals`, accepted: true },
  'retained-result-read': { subject: OBJECTIVE_CORE_RESULT_READER_SUBJECT, audience: OBJECTIVE_MERI_RETAINED_AUDIENCE, method: 'POST', path: MERI_RESULT_PATH, accepted: true },
} as const;

export type ObjectiveWorkloadOperation = 'objective.strategy.draft' | 'objective.retained-result.read';
export type ObjectiveWorkloadPhase = keyof typeof PHASE_ROUTES;

export interface ObjectiveWorkloadRequestBinding {
  /** These values must come from the fixed receiving route and DB source, not
   * from claims copied out of the bearer token. `body` is the captured raw
   * request entity, never a re-serialization of parsed JSON. */
  readonly subject: string;
  readonly audience: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly query: '';
  readonly body: Uint8Array;
  readonly operation: ObjectiveWorkloadOperation;
  readonly phase: ObjectiveWorkloadPhase;
  /** Core-derived routing hint, compared with the exact DB row by the receiver. */
  readonly tenantId: string;
  readonly generationJobId: string;
  readonly delegationRef: string;
  readonly consentId: string;
  /** Absent before Meri has issued an accepted run. Never invent these fields. */
  readonly attemptId: string | null;
  readonly runId: string | null;
  /** Hash of the full persisted AcceptedRunBinding, including workerId and
   * writerFence, using the existing generationBindingKey canonicalization. */
  readonly acceptedBindingSha256: string | null;
  /** Derived from the independently resolved complete accepted source. This
   * digest does not replace current source, custody or membership checks. */
  readonly sourceSha256: string | null;
}

export interface ObjectiveWorkloadJwtClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly jti: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly query: '';
  readonly bodySha256: string;
  readonly operation: ObjectiveWorkloadOperation;
  readonly phase: ObjectiveWorkloadPhase;
  readonly tenantId: string;
  readonly generationJobId: string;
  readonly delegationRef: string;
  readonly consentId: string;
  readonly attemptId: string | null;
  readonly runId: string | null;
  readonly acceptedBindingSha256: string | null;
  readonly sourceSha256: string | null;
}

export interface ObjectiveWorkloadIssuerSigner {
  /** Pinned per environment by the Core issuer owner, not request input. */
  readonly issuer: string;
  readonly kid: string;
  readonly privateKey: KeyObject;
}

export interface ObjectiveWorkloadIssueDecision {
  /** Core's durable operation identifier, reused on an idempotent retry. */
  readonly jti: string;
  readonly nowSeconds: number;
  /** Core's current source deadline; this helper clips it to sixty seconds. */
  readonly expiresAtSeconds: number;
}

export interface ObjectiveWorkloadVerifierTrust {
  readonly issuer: string;
  readonly audience: string;
  /** Trusted, versioned local key pins. No URL, JWK or key from token input. */
  readonly publicKeys: Readonly<Record<string, KeyObject>>;
  readonly nowSeconds: number;
}

export class ObjectiveWorkloadJwtError extends Error {
  constructor() { super('Objective workload token unavailable'); }
}

const denied = (): never => { throw new ObjectiveWorkloadJwtError(); };

function name(value: unknown): value is string {
  return typeof value === 'string' && NAME.test(value);
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function uuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

function seconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function rsaKey(value: unknown, type: 'private' | 'public'): value is KeyObject {
  return value instanceof KeyObject && value.type === type && value.asymmetricKeyType === 'rsa' &&
    (value.asymmetricKeyDetails?.modulusLength ?? 0) >= 3072;
}

/** Capture external records before checking them. Accessors and Proxies must
 * not change an authorized tuple between validation and signing/comparison. */
function ownData(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) denied();
  const record = value as object;
  if (nodeTypes.isProxy(record) || Object.getPrototypeOf(record) !== Object.prototype) denied();
  const keys = Reflect.ownKeys(record);
  if (keys.length !== fields.length || keys.some(key =>
    typeof key !== 'string' || !fields.includes(key))) denied();
  const captured: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field) ?? denied();
    if (!('value' in descriptor)) denied();
    captured[field] = descriptor.value;
  }
  return captured;
}

function requestBinding(input: ObjectiveWorkloadRequestBinding): ObjectiveWorkloadRequestBinding {
  const captured = ownData(input, BINDING_FIELDS) as unknown as ObjectiveWorkloadRequestBinding;
  if (!name(captured.subject) || !name(captured.audience) ||
      (captured.method !== 'GET' && captured.method !== 'POST') ||
      typeof captured.path !== 'string' || !PATH.test(captured.path) ||
      captured.path.includes('//') || captured.path.endsWith('/') || captured.query !== '' ||
      !(captured.body instanceof Uint8Array) || nodeTypes.isProxy(captured.body) ||
      captured.body.byteLength > MAX_BODY_BYTES ||
      (captured.phase === 'retained-result-read' &&
        captured.body.byteLength > MAX_RETAINED_BODY_BYTES) ||
      (captured.method === 'GET' && captured.body.byteLength !== 0) ||
      (captured.method === 'POST' && captured.body.byteLength === 0) ||
      captured.operation !== (captured.phase === 'retained-result-read'
        ? 'objective.retained-result.read' : 'objective.strategy.draft') ||
      !uuid(captured.tenantId) || !uuid(captured.generationJobId) || !uuid(captured.delegationRef) ||
      !uuid(captured.consentId) || !Object.hasOwn(PHASE_ROUTES, captured.phase)) denied();
  const route = PHASE_ROUTES[captured.phase];
  const expectedPath = route.method === 'GET'
    ? `${route.path}/${captured.generationJobId}` : route.path;
  if (captured.subject !== route.subject || captured.audience !== route.audience || captured.method !== route.method ||
      captured.path !== expectedPath) denied();
  if (route.accepted) {
    if (!uuid(captured.attemptId) || !uuid(captured.runId) ||
        typeof captured.acceptedBindingSha256 !== 'string' ||
        !SHA256.test(captured.acceptedBindingSha256)) denied();
  } else if (captured.attemptId !== null || captured.runId !== null ||
      captured.acceptedBindingSha256 !== null) denied();
  if (captured.phase === 'retained-result-read') {
    if (typeof captured.sourceSha256 !== 'string' || !SHA256.test(captured.sourceSha256)) denied();
  } else if (captured.sourceSha256 !== null) denied();
  return Object.freeze({ ...captured, body: Buffer.from(captured.body) });
}

function claimsJson(value: ObjectiveWorkloadJwtClaims): string {
  return JSON.stringify({
    iss: value.iss, sub: value.sub, aud: value.aud, iat: value.iat,
    nbf: value.nbf, exp: value.exp, jti: value.jti, method: value.method,
    path: value.path, query: value.query, bodySha256: value.bodySha256,
    operation: value.operation, phase: value.phase,
    tenantId: value.tenantId, generationJobId: value.generationJobId, delegationRef: value.delegationRef,
    consentId: value.consentId, attemptId: value.attemptId, runId: value.runId,
    acceptedBindingSha256: value.acceptedBindingSha256,
    sourceSha256: value.sourceSha256,
  });
}

function headerJson(kid: string): string {
  return JSON.stringify({ alg: ALGORITHM, typ: OBJECTIVE_WORKLOAD_JWT_TYPE, kid });
}

function checkClaims(value: ObjectiveWorkloadJwtClaims): void {
  if (!name(value.iss) || !name(value.sub) || !name(value.aud) ||
      !seconds(value.iat) || !seconds(value.nbf) || !seconds(value.exp) ||
      value.nbf < value.iat || value.exp <= value.nbf ||
      value.exp - value.iat > MAX_LIFETIME_SECONDS || !uuidV4(value.jti) ||
      !SHA256.test(value.bodySha256)) denied();
  if (value.phase === 'retained-result-read') {
    if (typeof value.sourceSha256 !== 'string' || !SHA256.test(value.sourceSha256)) denied();
  } else if (value.sourceSha256 !== null) denied();
}

/** Issuer-only signing primitive. The Core issuer must first authenticate its
 * named caller, decide current source authority and atomically reserve `jti`.
 * Calling this function alone is never an authorization decision. */
export function issueObjectiveWorkloadJwt(
  binding: ObjectiveWorkloadRequestBinding,
  signer: ObjectiveWorkloadIssuerSigner,
  decision: ObjectiveWorkloadIssueDecision,
): string {
  try {
    const authorized = requestBinding(binding);
    const key = ownData(signer, ['issuer', 'kid', 'privateKey']) as unknown as ObjectiveWorkloadIssuerSigner;
    const allocation = ownData(decision, ['jti', 'nowSeconds', 'expiresAtSeconds']) as unknown as ObjectiveWorkloadIssueDecision;
    if (!name(key.issuer) || !KID.test(key.kid) ||
        !rsaKey(key.privateKey, 'private') || !uuidV4(allocation.jti) ||
        !seconds(allocation.nowSeconds) || !seconds(allocation.expiresAtSeconds)) denied();
    const exp = Math.min(allocation.expiresAtSeconds, allocation.nowSeconds + MAX_LIFETIME_SECONDS);
    if (exp <= allocation.nowSeconds) denied();
    const claims: ObjectiveWorkloadJwtClaims = {
      iss: key.issuer, sub: authorized.subject, aud: authorized.audience,
      iat: allocation.nowSeconds, nbf: allocation.nowSeconds, exp, jti: allocation.jti,
      method: authorized.method, path: authorized.path, query: '',
      bodySha256: createHash('sha256').update(authorized.body).digest('hex'),
      operation: authorized.operation, phase: authorized.phase,
      tenantId: authorized.tenantId, generationJobId: authorized.generationJobId, delegationRef: authorized.delegationRef,
      consentId: authorized.consentId, attemptId: authorized.attemptId, runId: authorized.runId,
      acceptedBindingSha256: authorized.acceptedBindingSha256,
      sourceSha256: authorized.sourceSha256,
    };
    checkClaims(claims);
    const headerBytes = Buffer.from(headerJson(key.kid), 'utf8');
    const payloadBytes = Buffer.from(claimsJson(claims), 'utf8');
    if (headerBytes.length > MAX_HEADER_BYTES || payloadBytes.length > MAX_PAYLOAD_BYTES) denied();
    const input = Buffer.from(`${headerBytes.toString('base64url')}.` +
      payloadBytes.toString('base64url'), 'ascii');
    if (input.length > MAX_SIGNING_INPUT_CHARS) denied();
    const signature = rsaSign('RSA-SHA256', input, {
      key: key.privateKey, padding: constants.RSA_PKCS1_PADDING,
    });
    const token = `${input.toString('ascii')}.${signature.toString('base64url')}`;
    if (token.length > MAX_TOKEN_BYTES) denied();
    return token;
  } catch { return denied(); }
}

function decoded(segment: string): string {
  if (!BASE64URL.test(segment)) denied();
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) denied();
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Cryptographic gate only. The caller must pass an independently known route,
 * raw body, named subject and DB-source binding; it must then apply current
 * membership/consent/job/claim checks and durable operation-level jti dedup.
 * A token cannot authorize itself by supplying its own expected binding. */
export function verifyObjectiveWorkloadJwt(
  token: string,
  expected: ObjectiveWorkloadRequestBinding,
  trust: ObjectiveWorkloadVerifierTrust,
): Readonly<ObjectiveWorkloadJwtClaims> {
  try {
    const authorized = requestBinding(expected);
    const pinned = ownData(trust, ['issuer', 'audience', 'publicKeys', 'nowSeconds']) as unknown as ObjectiveWorkloadVerifierTrust;
    if (!name(pinned.issuer) || !name(pinned.audience) ||
        authorized.audience !== pinned.audience || !seconds(pinned.nowSeconds) ||
        typeof token !== 'string' || token.length > MAX_TOKEN_BYTES) denied();
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !BASE64URL.test(part))) denied();
    if (`${parts[0]}.${parts[1]}`.length > MAX_SIGNING_INPUT_CHARS) denied();
    if (Buffer.from(parts[0]!, 'base64url').length > MAX_HEADER_BYTES ||
        Buffer.from(parts[1]!, 'base64url').length > MAX_PAYLOAD_BYTES) denied();
    const headerText = decoded(parts[0]!);
    const header: unknown = JSON.parse(headerText);
    const kidValue = header && typeof header === 'object' && !Array.isArray(header)
      ? (header as Record<string, unknown>).kid : null;
    if (!header || typeof header !== 'object' || Array.isArray(header) ||
        (header as Record<string, unknown>).alg !== ALGORITHM ||
        (header as Record<string, unknown>).typ !== OBJECTIVE_WORKLOAD_JWT_TYPE ||
        typeof kidValue !== 'string' || !KID.test(kidValue) ||
        headerText !== headerJson(kidValue)) denied();
    const kid: string = typeof kidValue === 'string' ? kidValue : denied();
    const pins = pinned.publicKeys;
    if (!pins || typeof pins !== 'object' || nodeTypes.isProxy(pins) ||
        !Object.hasOwn(pins, kid)) denied();
    const descriptor = Object.getOwnPropertyDescriptor(pins, kid);
    const key: unknown = descriptor && 'value' in descriptor ? descriptor.value : null;
    const trustedKey: KeyObject = rsaKey(key, 'public') ? key : denied();
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
    const signature = Buffer.from(parts[2]!, 'base64url');
    if (signature.toString('base64url') !== parts[2] ||
        !rsaVerify('RSA-SHA256', signingInput,
          { key: trustedKey, padding: constants.RSA_PKCS1_PADDING }, signature)) denied();
    const claimsText = decoded(parts[1]!);
    const raw: unknown = JSON.parse(claimsText);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) denied();
    const claims = raw as ObjectiveWorkloadJwtClaims;
    if (claimsText !== claimsJson(claims)) denied();
    checkClaims(claims);
    if (claims.iss !== pinned.issuer || claims.sub !== authorized.subject ||
        claims.aud !== pinned.audience || claims.iat > pinned.nowSeconds ||
        claims.nbf > pinned.nowSeconds || claims.exp <= pinned.nowSeconds ||
        claims.method !== authorized.method || claims.path !== authorized.path ||
        claims.query !== '' ||
        claims.bodySha256 !== createHash('sha256').update(authorized.body).digest('hex') ||
        claims.operation !== authorized.operation || claims.phase !== authorized.phase ||
        claims.tenantId !== authorized.tenantId ||
        claims.generationJobId !== authorized.generationJobId ||
        claims.delegationRef !== authorized.delegationRef ||
        claims.consentId !== authorized.consentId ||
        claims.attemptId !== authorized.attemptId || claims.runId !== authorized.runId ||
        claims.acceptedBindingSha256 !== authorized.acceptedBindingSha256 ||
        claims.sourceSha256 !== authorized.sourceSha256) denied();
    return Object.freeze(claims);
  } catch { return denied(); }
}
