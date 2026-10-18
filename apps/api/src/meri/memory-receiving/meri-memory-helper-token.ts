import { randomUUID, verify as nodeVerify } from 'node:crypto';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import type { CoreEd25519KeyConfig } from '../../auth/core-ed25519-key-config.js';
import type { CoreEd25519Signer } from '../../auth/core-ed25519-signer.js';
import { isSha, isUuid, sha256Hex } from '../../auth/read-delegation/read-delegation.contract.js';

/** The helper uses Meri's existing Authorization scheme, but its distinct
 * audience, type and kind are rejected by the ordinary read-token verifier.
 * The HTTP owner must branch on the fixed helper target before that verifier. */
export const MEMORY_HELPER_SCHEME = 'CapiroMeriRead';
export const MEMORY_HELPER_TYPE = 'capiro-meri-memory-eligibility+jwt';
export const MEMORY_HELPER_AUDIENCE = 'capiro:meri-memory-eligibility:v1';
export const MEMORY_HELPER_KIND = 'memory_eligibility';
export const MEMORY_HELPER_PATH = '/api/clio/tools/search_memory_eligibility';
const MAX_SECONDS = 15;
const CALL_KEY = /^[A-Za-z0-9_-]{1,128}$/;

export interface MemoryHelperClaims {
  iss: string;
  aud: typeof MEMORY_HELPER_AUDIENCE;
  sub: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  kind: typeof MEMORY_HELPER_KIND;
  parentJti: string;
  callKey: string;
  method: 'POST';
  path: typeof MEMORY_HELPER_PATH;
  bodySha256: string;
  parentBodySha256: string;
  argumentsSha256: string;
  requestSha256: string;
  correlationSha256: string;
  resultSha256: string;
  recordsSha256: string;
  bindingSha256: string;
  proofDeadlineMs: number;
  tenantId: string;
  actorId: string;
  clientId: string;
  conversationId: string;
  runId: string;
  attemptId: string;
  writerFence: number;
}

const CLAIM_KEYS: readonly (keyof MemoryHelperClaims)[] = [
  'iss', 'aud', 'sub', 'jti', 'iat', 'nbf', 'exp', 'kind', 'parentJti', 'callKey', 'method', 'path',
  'bodySha256', 'parentBodySha256', 'argumentsSha256', 'requestSha256', 'correlationSha256',
  'resultSha256', 'recordsSha256', 'bindingSha256', 'proofDeadlineMs', 'tenantId', 'actorId', 'clientId',
  'conversationId', 'runId', 'attemptId', 'writerFence',
];
const header = (kid: string) => JSON.stringify({ alg: 'EdDSA', typ: MEMORY_HELPER_TYPE, kid });
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

/** The caller holds the original admission lock while signing and inserting
 * the helper row. A lost page response cannot reissue this token. */
export async function signMemoryHelperToken(
  signer: CoreEd25519Signer,
  claims: Omit<MemoryHelperClaims, 'iss' | 'aud' | 'jti'>,
  signal?: AbortSignal,
): Promise<{ token: string; jti: string; tokenSha256: string }> {
  const jti = randomUUID();
  const payload = canonicalizeCoreRetainedJson({ ...claims, iss: signer.issuer, aud: MEMORY_HELPER_AUDIENCE, jti });
  const input = `${b64(header(signer.kid))}.${b64(payload)}`;
  const signature = await signer.sign(Buffer.from(input, 'ascii'), { signal });
  const token = `${input}.${Buffer.from(signature).toString('base64url')}`;
  return { token, jti, tokenSha256: sha256Hex(Buffer.from(token, 'ascii')) };
}

export function memoryHelperTokenFromAuthorization(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(`${MEMORY_HELPER_SCHEME} `)) return null;
  const token = value.slice(MEMORY_HELPER_SCHEME.length + 1);
  return token.length <= 8192 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ? token : null;
}

/** Cryptographic and closed-claim check only. The unmounted receiver must also
 * atomically consume the stored JTI, recheck current authority and compare the
 * callback, parent page and admitted binding before the memory SQL. */
export function verifyMemoryHelperToken(
  token: string,
  config: CoreEd25519KeyConfig,
  nowMs: number,
): MemoryHelperClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !part || Buffer.from(part, 'base64url').toString('base64url') !== part)) return null;
    if (Buffer.from(parts[0]!, 'base64url').toString('utf8') !== header(config.kid)) return null;
    const signature = Buffer.from(parts[2]!, 'base64url');
    if (signature.length !== 64 || !nodeVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), config.publicKey, signature)) return null;
    const encoded = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const parsed = JSON.parse(encoded) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        canonicalizeCoreRetainedJson(parsed) !== encoded ||
        Object.keys(parsed).length !== CLAIM_KEYS.length || CLAIM_KEYS.some((key) => !Object.hasOwn(parsed, key))) return null;
    const now = Math.floor(nowMs / 1000);
    if (parsed.iss !== config.issuer || parsed.aud !== MEMORY_HELPER_AUDIENCE ||
        parsed.kind !== MEMORY_HELPER_KIND || parsed.method !== 'POST' || parsed.path !== MEMORY_HELPER_PATH ||
        !Number.isSafeInteger(parsed.iat) || parsed.nbf !== parsed.iat || !Number.isSafeInteger(parsed.exp) ||
        (parsed.iat as number) > now + 1 || (parsed.exp as number) <= now ||
        (parsed.exp as number) <= (parsed.iat as number) || (parsed.exp as number) - (parsed.iat as number) > MAX_SECONDS ||
        !Number.isSafeInteger(parsed.writerFence) || (parsed.writerFence as number) < 1 ||
        !Number.isSafeInteger(parsed.proofDeadlineMs) || (parsed.proofDeadlineMs as number) < (parsed.exp as number) * 1000 ||
        ![parsed.sub, parsed.jti, parsed.parentJti, parsed.tenantId, parsed.actorId, parsed.clientId,
          parsed.conversationId, parsed.runId, parsed.attemptId].every(isUuid) ||
        typeof parsed.callKey !== 'string' || !CALL_KEY.test(parsed.callKey) ||
        ![parsed.bodySha256, parsed.parentBodySha256, parsed.argumentsSha256, parsed.requestSha256,
          parsed.correlationSha256, parsed.resultSha256, parsed.recordsSha256, parsed.bindingSha256].every(isSha)) return null;
    return parsed as unknown as MemoryHelperClaims;
  } catch { return null; }
}
