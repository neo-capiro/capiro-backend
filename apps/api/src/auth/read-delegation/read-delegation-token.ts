import { createHash, randomUUID, verify as nodeVerify } from 'node:crypto';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import type { CoreEd25519KeyConfig } from '../core-ed25519-key-config.js';
import type { CoreEd25519Signer } from '../core-ed25519-signer.js';
import {
  MERI_CORRELATED_READ_TOOLS, READ_TOKEN_AUDIENCE, READ_TOKEN_KINDS, READ_TOKEN_SCHEME, READ_TOKEN_TYPE,
  isMeriCorrelatedReadOperationVersion, isSha, isUuid,
  type OperationRef, type ReadTokenKind,
} from './read-delegation.contract.js';

/**
 * The single-use read token (contract §10). Core is both its issuer and its
 * only verifier; Meri treats it as opaque (`isReadToken`). Signed as a compact
 * Ed25519 JWS by the `MERI_READ_DELEGATION_SIGNER` KMS key (D016 #9: one pure
 * Ed25519 key per Core signing purpose). The contract's §11.4 names ES256;
 * that deviation is flagged in the ledger and changes nothing on Meri's side.
 * The payload bytes are their RFC 8785 form, so a re-encoded payload refuses.
 */
export interface ReadTokenClaims {
  iss: string;
  aud: typeof READ_TOKEN_AUDIENCE;
  sub: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  kind: ReadTokenKind;
  callKey: string;
  method: 'POST';
  path: string;
  bodySha256: string;
  operation: OperationRef | null;
  toolRequestSha256: string | null;
  referenceSha256: string | null;
  tenantId: string;
  actorId: string;
  clientId: string;
  conversationId: string;
  runId: string;
  /** Present only for a correlation-bearing tool token. Bound to a separately
   * authenticated correlation header at use; legacy tokens omit it. */
  correlationSha256?: string;
}
const CLAIM_KEYS = ['iss', 'aud', 'sub', 'jti', 'iat', 'nbf', 'exp', 'kind', 'callKey', 'method', 'path', 'bodySha256', 'operation',
  'toolRequestSha256', 'referenceSha256', 'tenantId', 'actorId', 'clientId', 'conversationId', 'runId'];
const SOURCE_CLAIM_KEYS = [...CLAIM_KEYS, 'correlationSha256'];
export const READ_TOKEN_MAX_SECONDS = 60;
const SKEW_SECONDS = 5;
const header = (kid: string) => JSON.stringify({ alg: 'EdDSA', typ: READ_TOKEN_TYPE, kid });
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
export const readTokenSha256 = (token: string) => createHash('sha256').update(token, 'ascii').digest('hex');

export async function signReadToken(signer: CoreEd25519Signer, claims: Omit<ReadTokenClaims, 'iss' | 'aud' | 'jti'>, signal?: AbortSignal):
  Promise<{ token: string; jti: string; tokenSha256: string }> {
  const source = claims.operation != null && MERI_CORRELATED_READ_TOOLS.has(claims.operation.id);
  if (source ? claims.kind !== 'tool' || !isMeriCorrelatedReadOperationVersion(claims.operation) ||
    !isSha(claims.correlationSha256)
    : Object.hasOwn(claims, 'correlationSha256')) {
    throw new Error('Invalid read token correlation');
  }
  const jti = randomUUID();
  const payload = canonicalizeCoreRetainedJson({ ...claims, iss: signer.issuer, aud: READ_TOKEN_AUDIENCE, jti });
  const input = `${b64(header(signer.kid))}.${b64(payload)}`;
  const signature = await signer.sign(Buffer.from(input, 'ascii'), { signal });
  const token = `${input}.${Buffer.from(signature).toString('base64url')}`;
  return { token, jti, tokenSha256: readTokenSha256(token) };
}

/** `Authorization: CapiroMeriRead <token>`: exactly one space, nothing else. */
export function readTokenFromAuthorization(authorization: unknown): string | null {
  if (typeof authorization !== 'string' || !authorization.startsWith(`${READ_TOKEN_SCHEME} `)) return null;
  const token = authorization.slice(READ_TOKEN_SCHEME.length + 1);
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) && token.length <= 8192 ? token : null;
}

const nullableSha = (v: unknown) => v === null || isSha(v);
function operation(v: unknown): v is OperationRef | null {
  if (v === null) return true;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  const o = v as Record<string, unknown>;
  return keys.length === 2 && typeof o.id === 'string' && typeof o.version === 'string';
}

/**
 * Cryptographic and claim checks only: exact header and kid, pure Ed25519,
 * canonical payload, issuer, audience, a closed claim set and time (≤ 60 s,
 * 5 s skew). The middleware then consumes the `jti` and runs every current
 * check in one transaction. Returns null on any failure.
 */
export function verifyReadToken(token: string, config: CoreEd25519KeyConfig, nowMs: number): ReadTokenClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    if (Buffer.from(parts[0]!, 'base64url').toString('utf8') !== header(config.kid)) return null;
    const signature = Buffer.from(parts[2]!, 'base64url');
    if (signature.length !== 64 || signature.toString('base64url') !== parts[2] ||
        !nodeVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), config.publicKey, signature)) return null;
    const text = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const p = JSON.parse(text) as Record<string, unknown>;
    if (!p || typeof p !== 'object' || Array.isArray(p) || canonicalizeCoreRetainedJson(p) !== text) return null;
    if (!operation(p.operation)) return null;
    const source = p.operation !== null && MERI_CORRELATED_READ_TOOLS.has(p.operation.id);
    const expectedKeys = source ? SOURCE_CLAIM_KEYS : CLAIM_KEYS;
    const keys = Object.keys(p);
    if (keys.length !== expectedKeys.length || expectedKeys.some((k) => !Object.hasOwn(p, k)) ||
        (source ? p.kind !== 'tool' || !isMeriCorrelatedReadOperationVersion(p.operation) ||
          !isSha(p.correlationSha256)
          : Object.hasOwn(p, 'correlationSha256'))) return null;
    const now = Math.floor(nowMs / 1000);
    if (p.iss !== config.issuer || p.aud !== READ_TOKEN_AUDIENCE || !Number.isSafeInteger(p.iat) || p.nbf !== p.iat ||
        !Number.isSafeInteger(p.exp) || (p.iat as number) > now + SKEW_SECONDS || (p.exp as number) <= now ||
        (p.exp as number) - (p.iat as number) > READ_TOKEN_MAX_SECONDS || (p.exp as number) <= (p.iat as number)) return null;
    if (![p.sub, p.jti, p.tenantId, p.actorId, p.clientId, p.conversationId, p.runId].every(isUuid) ||
        !READ_TOKEN_KINDS.includes(p.kind as ReadTokenKind) || typeof p.callKey !== 'string' || p.method !== 'POST' ||
        typeof p.path !== 'string' || !isSha(p.bodySha256) || !operation(p.operation) ||
        !nullableSha(p.toolRequestSha256) || !nullableSha(p.referenceSha256)) return null;
    return p as unknown as ReadTokenClaims;
  } catch {
    return null;
  }
}
