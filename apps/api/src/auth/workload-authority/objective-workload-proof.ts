import { KeyObject, constants, createHash, verify as rsaVerify } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

/** Caller authentication at the Core issuer only. This pure verifier neither
 * reserves a proof jti nor decides current delegation, consent, job or user
 * authority. The issuer must do those checks in its own durable transaction. */
export const OBJECTIVE_WORKLOAD_PROOF_TYPE = 'capiro-objective-workload-proof+jwt';
export const OBJECTIVE_WORKLOAD_PROOF_AUDIENCE = 'capiro:objective-core-issuer:v1';
export const OBJECTIVE_WORKLOAD_PROOF_PATH = '/api/internal/objective-workload-authority/decisions';

const ALGORITHM = 'RS256';
const MAX_TOKEN_BYTES = 8_192;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_LIFETIME_SECONDS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9:._-]{0,127}$/;
const KID = /^[A-Za-z0-9._-]{1,64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface ObjectiveWorkloadProofRequest {
  /** Pass the actual method and original URL, not values copied from claims. */
  readonly method: 'POST';
  readonly path: typeof OBJECTIVE_WORKLOAD_PROOF_PATH;
  readonly query: '';
  /** Captured HTTP entity bytes; never JSON re-serialized after parsing. */
  readonly body: Uint8Array;
  /** Extracted by the issuer's closed request parser from the same raw body. */
  readonly operationId: string;
}

export interface ObjectiveWorkloadCallerKeyPin {
  /** Environment-qualified issuer and fixed named service identity. */
  readonly issuer: string;
  readonly subject: string;
  readonly publicKey: KeyObject;
}

export interface ObjectiveWorkloadProofTrust {
  /** Versioned local pins only. A kid chooses one key AND its issuer/subject. */
  readonly publicKeys: Readonly<Record<string, ObjectiveWorkloadCallerKeyPin>>;
  readonly nowSeconds: number;
}

export interface ObjectiveWorkloadProofIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly kid: string;
  readonly proofJti: string;
  readonly operationId: string;
  readonly issuedAtSeconds: number;
  readonly notBeforeSeconds: number;
  readonly expiresAtSeconds: number;
}

interface ProofClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly jti: string;
  readonly operationId: string;
  readonly method: 'POST';
  readonly path: string;
  readonly query: '';
  readonly bodySha256: string;
}

export class ObjectiveWorkloadProofError extends Error {
  constructor() { super('Objective workload caller proof unavailable'); }
}

const denied = (): never => { throw new ObjectiveWorkloadProofError(); };

function ownData(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) denied();
  const record = value as object;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) denied();
  const keys = Reflect.ownKeys(record);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) denied();
  const captured: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field) ?? denied();
    if (!('value' in descriptor)) denied();
    captured[field] = descriptor.value;
  }
  return captured;
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function seconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function rsaPublicKey(value: unknown): value is KeyObject {
  return value instanceof KeyObject && value.type === 'public' && value.asymmetricKeyType === 'rsa' &&
    (value.asymmetricKeyDetails?.modulusLength ?? 0) >= 3072;
}

function base64urlText(segment: string): string {
  if (!BASE64URL.test(segment)) denied();
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) denied();
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function headerJson(kid: string): string {
  return JSON.stringify({ alg: ALGORITHM, typ: OBJECTIVE_WORKLOAD_PROOF_TYPE, kid });
}

function claimsJson(value: ProofClaims): string {
  return JSON.stringify({
    iss: value.iss, sub: value.sub, aud: value.aud, iat: value.iat,
    nbf: value.nbf, exp: value.exp, jti: value.jti, operationId: value.operationId,
    method: value.method, path: value.path, query: value.query, bodySha256: value.bodySha256,
  });
}

/** Verify the named caller's short-lived proof over the exact inbound issuer
 * request. A successful return must still be recorded under a unique
 * (issuer,proofJti) constraint with the Core operation and authorization jti.
 * Repeated calls to this pure function are intentionally not replay checks. */
export function verifyObjectiveWorkloadCallerProof(
  token: string,
  expected: ObjectiveWorkloadProofRequest,
  trust: ObjectiveWorkloadProofTrust,
): Readonly<ObjectiveWorkloadProofIdentity> {
  try {
    const request = ownData(expected, ['method', 'path', 'query', 'body', 'operationId']) as unknown as ObjectiveWorkloadProofRequest;
    if (request.method !== 'POST' || request.path !== OBJECTIVE_WORKLOAD_PROOF_PATH ||
        request.query !== '' || !uuid(request.operationId) ||
        !(request.body instanceof Uint8Array) || nodeTypes.isProxy(request.body) ||
        request.body.byteLength === 0 || request.body.byteLength > MAX_BODY_BYTES) denied();
    const body = Buffer.from(request.body);
    const pinned = ownData(trust, ['publicKeys', 'nowSeconds']) as unknown as ObjectiveWorkloadProofTrust;
    if (!seconds(pinned.nowSeconds) || typeof token !== 'string' || token.length > MAX_TOKEN_BYTES) denied();
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !BASE64URL.test(part))) denied();
    const headerText = base64urlText(parts[0]!);
    const header: unknown = JSON.parse(headerText);
    const headerKid = header && typeof header === 'object' && !Array.isArray(header)
      ? (header as Record<string, unknown>).kid : null;
    const kid: string = typeof headerKid === 'string' ? headerKid : denied();
    if (!header || typeof header !== 'object' || Array.isArray(header) ||
        (header as Record<string, unknown>).alg !== ALGORITHM ||
        (header as Record<string, unknown>).typ !== OBJECTIVE_WORKLOAD_PROOF_TYPE ||
        !KID.test(kid) || headerText !== headerJson(kid)) denied();
    const pins = pinned.publicKeys;
    if (!pins || typeof pins !== 'object' || Array.isArray(pins) || nodeTypes.isProxy(pins) ||
        (Object.getPrototypeOf(pins) !== Object.prototype && Object.getPrototypeOf(pins) !== null) ||
        !Object.hasOwn(pins, kid)) denied();
    const descriptor = Object.getOwnPropertyDescriptor(pins, kid);
    const pin = ownData(descriptor && 'value' in descriptor ? descriptor.value : null,
      ['issuer', 'subject', 'publicKey']) as unknown as ObjectiveWorkloadCallerKeyPin;
    if (typeof pin.issuer !== 'string' || !NAME.test(pin.issuer) ||
        typeof pin.subject !== 'string' || !NAME.test(pin.subject) ||
        !rsaPublicKey(pin.publicKey)) denied();
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
    const signature = Buffer.from(parts[2]!, 'base64url');
    if (signature.toString('base64url') !== parts[2] ||
        !rsaVerify('RSA-SHA256', signingInput,
          { key: pin.publicKey, padding: constants.RSA_PKCS1_PADDING }, signature)) denied();
    const claimsText = base64urlText(parts[1]!);
    const raw: unknown = JSON.parse(claimsText);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) denied();
    const claims = raw as ProofClaims;
    if (claimsText !== claimsJson(claims) ||
        claims.iss !== pin.issuer || claims.sub !== pin.subject ||
        claims.aud !== OBJECTIVE_WORKLOAD_PROOF_AUDIENCE ||
        !seconds(claims.iat) || !seconds(claims.nbf) || !seconds(claims.exp) ||
        claims.nbf < claims.iat || claims.exp <= claims.nbf ||
        claims.exp - claims.iat > MAX_LIFETIME_SECONDS ||
        claims.iat > pinned.nowSeconds || claims.nbf > pinned.nowSeconds ||
        claims.exp <= pinned.nowSeconds || !uuid(claims.jti) ||
        claims.operationId !== request.operationId ||
        claims.method !== request.method || claims.path !== request.path ||
        claims.query !== '' || typeof claims.bodySha256 !== 'string' ||
        !SHA256.test(claims.bodySha256) ||
        claims.bodySha256 !== createHash('sha256').update(body).digest('hex')) denied();
    return Object.freeze({ issuer: pin.issuer, subject: pin.subject, kid,
      proofJti: claims.jti, operationId: claims.operationId,
      issuedAtSeconds: claims.iat, notBeforeSeconds: claims.nbf,
      expiresAtSeconds: claims.exp });
  } catch { return denied(); }
}
