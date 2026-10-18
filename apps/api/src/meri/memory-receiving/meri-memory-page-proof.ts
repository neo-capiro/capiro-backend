import { randomUUID, verify as nodeVerify } from 'node:crypto';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import type { CoreEd25519KeyConfig } from '../../auth/core-ed25519-key-config.js';
import type { CoreEd25519Signer } from '../../auth/core-ed25519-signer.js';
import { isSha, isUuid } from '../../auth/read-delegation/read-delegation.contract.js';

export const MEMORY_PAGE_PROOF_HEADER = 'x-meri-memory-page-proof';
export const MEMORY_PAGE_PROOF_TYPE = 'capiro-meri-memory-page-proof+jwt';
export const MEMORY_PAGE_PROOF_AUDIENCE = 'capiro:meri-memory-page-proof:v1';
const MAX_SECONDS = 30;
const CALL_KEY = /^[A-Za-z0-9_-]{1,128}$/;

/** The proof cannot call a receiver. It only authenticates the Core page pins
 * when the service asks for its separate one-use helper token. */
export interface MemoryPageProofClaims {
  iss: string;
  aud: typeof MEMORY_PAGE_PROOF_AUDIENCE;
  sub: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  parentJti: string;
  callKey: string;
  parentBodySha256: string;
  argumentsSha256: string;
  requestSha256: string;
  correlationSha256: string;
  resultSha256: string;
  recordsSha256: string;
  bindingSha256: string;
  policyRevision: string;
  tenantId: string;
  actorId: string;
  clientId: string;
  conversationId: string;
  runId: string;
  attemptId: string;
  writerFence: number;
  deadlineMs: number;
}

const KEYS: readonly (keyof MemoryPageProofClaims)[] = [
  'iss', 'aud', 'sub', 'jti', 'iat', 'nbf', 'exp', 'parentJti', 'callKey', 'parentBodySha256',
  'argumentsSha256', 'requestSha256', 'correlationSha256', 'resultSha256', 'recordsSha256',
  'bindingSha256', 'policyRevision', 'tenantId', 'actorId', 'clientId', 'conversationId',
  'runId', 'attemptId', 'writerFence', 'deadlineMs',
];
const header = (kid: string) => JSON.stringify({ alg: 'EdDSA', typ: MEMORY_PAGE_PROOF_TYPE, kid });
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

export async function signMemoryPageProof(
  signer: CoreEd25519Signer,
  claims: Omit<MemoryPageProofClaims, 'iss' | 'aud' | 'jti'>,
  signal?: AbortSignal,
): Promise<string> {
  const payload = canonicalizeCoreRetainedJson({ ...claims, iss: signer.issuer,
    aud: MEMORY_PAGE_PROOF_AUDIENCE, jti: randomUUID() });
  const input = `${b64(header(signer.kid))}.${b64(payload)}`;
  const signature = await signer.sign(Buffer.from(input, 'ascii'), { signal });
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

export function verifyMemoryPageProof(
  token: unknown,
  config: Pick<CoreEd25519KeyConfig, 'issuer' | 'kid' | 'publicKey'>,
  nowMs: number,
): MemoryPageProofClaims | null {
  try {
    if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
    const parts = token.split('.');
    if (parts.some((part) => Buffer.from(part, 'base64url').toString('base64url') !== part) ||
        Buffer.from(parts[0]!, 'base64url').toString('utf8') !== header(config.kid)) return null;
    const signature = Buffer.from(parts[2]!, 'base64url');
    if (signature.length !== 64 || !nodeVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), config.publicKey, signature)) return null;
    const encoded = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const p = JSON.parse(encoded) as Record<string, unknown>;
    if (!p || typeof p !== 'object' || Array.isArray(p) || canonicalizeCoreRetainedJson(p) !== encoded ||
        Object.keys(p).length !== KEYS.length || KEYS.some((key) => !Object.hasOwn(p, key))) return null;
    const now = Math.floor(nowMs / 1000);
    if (p.iss !== config.issuer || p.aud !== MEMORY_PAGE_PROOF_AUDIENCE ||
        !Number.isSafeInteger(p.iat) || p.nbf !== p.iat || !Number.isSafeInteger(p.exp) ||
        (p.iat as number) > now + 1 || (p.exp as number) <= now ||
        (p.exp as number) <= (p.iat as number) || (p.exp as number) - (p.iat as number) > MAX_SECONDS ||
        !Number.isSafeInteger(p.deadlineMs) || (p.deadlineMs as number) !== (p.exp as number) * 1000 ||
        !Number.isSafeInteger(p.writerFence) || (p.writerFence as number) < 1 ||
        ![p.sub, p.jti, p.parentJti, p.tenantId, p.actorId, p.clientId,
          p.conversationId, p.runId, p.attemptId].every(isUuid) ||
        typeof p.callKey !== 'string' || !CALL_KEY.test(p.callKey) ||
        typeof p.policyRevision !== 'string' || p.policyRevision.length < 1 || p.policyRevision.length > 128 ||
        ![p.parentBodySha256, p.argumentsSha256, p.requestSha256, p.correlationSha256,
          p.resultSha256, p.recordsSha256, p.bindingSha256].every(isSha)) return null;
    return p as unknown as MemoryPageProofClaims;
  } catch { return null; }
}
