import { KeyObject, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { CORE_ED25519_ISSUER, CORE_ED25519_KID } from './core-ed25519-signer.js';

// Pure (no SDK): the tenant middleware's authority closure imports this file;
// the KMS client lives only in core-ed25519-kms-config.ts.
/**
 * Server-side configuration of one Core Ed25519 KMS signing purpose (D016 #9:
 * `ECC_NIST_EDWARDS25519`, pure Ed25519, one key per purpose, created only in
 * the deployment packet). All four values are required together; none means
 * the purpose is not enabled. The key ARN is never published; `kid` is a label.
 *
 *   <PREFIX>_ISSUER        issuer label in the token
 *   <PREFIX>_KID           JOSE kid
 *   <PREFIX>_KMS_KEY_ARN   arn:aws:kms:<region>:<account>:key/<uuid>
 *   <PREFIX>_PUBLIC_KEY_X  base64url Ed25519 public key: the GetPublicKey readback
 */
export type CoreEd25519Purpose = 'MERI_EXECUTION_SIGNER' | 'MERI_ROUTINE_CANCEL_SIGNER' | 'MERI_ROUTINE_FIRE_SIGNER' | 'MERI_READ_DELEGATION_SIGNER';

export interface CoreEd25519KeyConfig {
  issuer: string;
  kid: string;
  keyArn: string;
  region: string;
  publicKey: KeyObject;
}

const KMS_KEY_ARN = /^arn:aws:kms:([a-z0-9-]{1,32}):[0-9]{12}:key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

export function readCoreEd25519KeyConfig(env: NodeJS.ProcessEnv, prefix: CoreEd25519Purpose): CoreEd25519KeyConfig | null {
  const read = (name: string) => {
    const value = env[`${prefix}_${name}`];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const issuer = read('ISSUER'), kid = read('KID'), keyArn = read('KMS_KEY_ARN'), x = read('PUBLIC_KEY_X');
  if ([issuer, kid, keyArn, x].every((v) => v === undefined)) return null;
  if ([issuer, kid, keyArn, x].some((v) => v === undefined)) throw new Error(`${prefix}: ISSUER, KID, KMS_KEY_ARN and PUBLIC_KEY_X are required together`);
  const arn = KMS_KEY_ARN.exec(keyArn!);
  if (!CORE_ED25519_ISSUER.test(issuer!) || !CORE_ED25519_KID.test(kid!) || !arn || !B64URL_32.test(x!)) {
    throw new Error(`${prefix}: invalid issuer, kid, KMS key ARN or public key`);
  }
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: x! }, format: 'jwk' });
  return { issuer: issuer!, kid: kid!, keyArn: keyArn!, region: arn[1]!, publicKey };
}

export const MERI_EXECUTION_TOKEN_TYPE_HEADER = 'capiro-meri-execution+jwt';

/**
 * The identity a Meri execution capability carries, after the cryptographic
 * checks only: exact header, pinned kid, pure Ed25519, payload bytes equal to
 * their RFC 8785 form, issuer, audience and time. Used by the tenant middleware
 * (which may not import Meri receiver code) to resolve the tenant context for
 * the single receiver route; the receiver re-verifies the whole contract and
 * runs every current check before any effect. Returns null on any failure.
 */
export function readMeriExecutionIdentity(token: string, config: CoreEd25519KeyConfig, nowMs: number):
  { tenantId: string; actorId: string; jti: string; expMs: number } | null {
  try {
    if (typeof token !== 'string' || token.length > 8192) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
    const header = Buffer.from(parts[0]!, 'base64url').toString('utf8');
    if (header !== JSON.stringify({ alg: 'EdDSA', typ: MERI_EXECUTION_TOKEN_TYPE_HEADER, kid: config.kid })) return null;
    const signature = Buffer.from(parts[2]!, 'base64url');
    if (signature.length !== 64 || !nodeVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), config.publicKey, signature)) return null;
    const text = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const p = JSON.parse(text) as Record<string, unknown>;
    if (canonicalizeCoreRetainedJson(p) !== text) return null;
    const now = Math.floor(nowMs / 1000);
    if (p.iss !== config.issuer || p.aud !== 'meri-gateway' || typeof p.iat !== 'number' || typeof p.exp !== 'number' ||
        p.nbf !== p.iat || p.iat > now || p.exp <= now || p.exp - p.iat > 120 || typeof p.jti !== 'string') return null;
    const binding = (p.capability as { binding?: { tenantId?: unknown; actorId?: unknown } } | undefined)?.binding;
    if (typeof binding?.tenantId !== 'string' || typeof binding.actorId !== 'string') return null;
    return { tenantId: binding.tenantId, actorId: binding.actorId, jti: p.jti, expMs: p.exp * 1000 };
  } catch {
    return null;
  }
}

/** True when the bearer's JOSE header names the execution capability type. */
export function isMeriExecutionBearer(authorization: unknown): authorization is string {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  const first = authorization.slice('Bearer '.length).split('.')[0] ?? '';
  try {
    return (JSON.parse(Buffer.from(first, 'base64url').toString('utf8')) as { typ?: unknown }).typ === MERI_EXECUTION_TOKEN_TYPE_HEADER;
  } catch {
    return false;
  }
}
