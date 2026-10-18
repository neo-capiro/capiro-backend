import { KeyObject, createHash, createPublicKey, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

/**
 * Pure Ed25519 (RFC 8032) signing shape shared by Core's Ed25519 issuers
 * (Meri execution capability, Objective reader v2). Asynchronous so the
 * private key can live in an HSM-backed AWS KMS `ECC_NIST_EDWARDS25519`
 * SIGN_VERIFY key (D7-2) as well as in process. Every signature is verified
 * against the pinned public key before it is returned, so a signer can never
 * hand out a signature the published JWK does not verify.
 *
 * No key, client or credential is created here; the composition supplies them.
 */
export interface CoreEd25519Signer {
  readonly issuer: string;
  /** JOSE `kid` published with the public JWK. A short label, never a KMS ARN. */
  readonly kid: string;
  readonly publicKey: KeyObject;
  /** SHA-256 of the SPKI DER of `publicKey`, for key-reuse checks and readback. */
  readonly publicKeySha256: string;
  sign(message: Uint8Array, options?: { signal?: AbortSignal }): Promise<Buffer>;
}

/** The single KMS operation this adapter needs, injected so source never
 * constructs an AWS client. Shape matches `@aws-sdk/client-kms` `SignCommand`. */
export interface KmsEd25519SignClient {
  sign(
    input: { KeyId: string; Message: Uint8Array; MessageType: 'RAW'; SigningAlgorithm: 'ED25519_SHA_512' },
    options: { abortSignal?: AbortSignal },
  ): Promise<{ KeyId?: string; Signature?: Uint8Array; SigningAlgorithm?: string }>;
}

export class CoreEd25519SignerUnavailable extends Error {
  constructor() { super('CORE_ED25519_SIGNER_UNAVAILABLE'); }
}
const refuse = (): never => { throw new CoreEd25519SignerUnavailable(); };

/** KMS signs at most 4096 bytes of RAW message; in-process keys share the bound. */
export const CORE_ED25519_MAX_MESSAGE_BYTES = 4096;
export const CORE_ED25519_KID = /^[A-Za-z0-9._-]{1,64}$/;
export const CORE_ED25519_ISSUER = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/;
const KMS_KEY_ARN = /^arn:aws:kms:[a-z0-9-]{1,32}:[0-9]{12}:key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === 'string' && pattern.exec(value)?.[0] === value;

function edKey(value: unknown, type: 'private' | 'public'): value is KeyObject {
  return !nodeTypes.isProxy(value) && value instanceof KeyObject && value.type === type &&
    value.asymmetricKeyType === 'ed25519';
}

function own(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) refuse();
  const names = Reflect.ownKeys(value as object);
  if (names.length !== keys.length || names.some((k) => typeof k !== 'string' || !keys.includes(k))) refuse();
  return value as Record<string, unknown>;
}

function message(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > CORE_ED25519_MAX_MESSAGE_BYTES) refuse();
  return Buffer.from(value as Uint8Array);
}

export function ed25519PublicKeySha256(publicKey: KeyObject): string {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

function verified(bytes: Buffer, raw: unknown, publicKey: KeyObject): Buffer {
  if (!(raw instanceof Uint8Array) || raw.byteLength !== 64) refuse();
  const signature = Buffer.from(raw as Uint8Array);
  if (!nodeVerify(null, bytes, publicKey, signature)) refuse();
  return signature;
}

function identity(issuer: unknown, kid: unknown, publicKey: unknown) {
  if (!exact(CORE_ED25519_ISSUER, issuer) || !exact(CORE_ED25519_KID, kid) || !edKey(publicKey, 'public')) refuse();
  return { issuer: issuer as string, kid: kid as string, publicKey: publicKey as KeyObject };
}

/** In-process private key (tests, local qualification, or a composition that
 * loads a Secrets Manager PEM server-side). */
export function createInProcessEd25519Signer(input: { issuer: string; kid: string; privateKey: KeyObject }): CoreEd25519Signer {
  try {
    const v = own(input, ['issuer', 'kid', 'privateKey']);
    if (!edKey(v.privateKey, 'private')) refuse();
    const privateKey = v.privateKey as KeyObject;
    const base = identity(v.issuer, v.kid, createPublicKey(privateKey));
    return Object.freeze({
      ...base,
      publicKeySha256: ed25519PublicKeySha256(base.publicKey),
      async sign(bytes: Uint8Array, options?: { signal?: AbortSignal }) {
        if (options?.signal?.aborted) refuse();
        const m = message(bytes);
        return verified(m, nodeSign(null, m, privateKey), base.publicKey);
      },
    });
  } catch { return refuse(); }
}

/**
 * AWS KMS `ECC_NIST_EDWARDS25519` key with `ED25519_SHA_512` over a RAW
 * message, which is pure Ed25519 (RFC 8032) and verifies with the published
 * OKP JWK. DIGEST (Ed25519ph) is never requested: its signatures would not
 * verify as pure Ed25519. The KMS key ARN stays server-side; `kid` is the
 * published label. The pinned `publicKey` must be the readback of
 * `GetPublicKey` for that ARN, recorded in the deployment packet.
 */
export function createKmsEd25519Signer(input: {
  issuer: string; kid: string; keyArn: string; publicKey: KeyObject; client: KmsEd25519SignClient;
}): CoreEd25519Signer {
  try {
    const v = own(input, ['issuer', 'kid', 'keyArn', 'publicKey', 'client']);
    if (!exact(KMS_KEY_ARN, v.keyArn) || typeof (v.client as KmsEd25519SignClient | null)?.sign !== 'function') refuse();
    const keyArn = v.keyArn as string, client = v.client as KmsEd25519SignClient;
    const base = identity(v.issuer, v.kid, v.publicKey);
    return Object.freeze({
      ...base,
      publicKeySha256: ed25519PublicKeySha256(base.publicKey),
      async sign(bytes: Uint8Array, options?: { signal?: AbortSignal }) {
        try {
          if (options?.signal?.aborted) refuse();
          const m = message(bytes);
          const out = await client.sign(
            { KeyId: keyArn, Message: m, MessageType: 'RAW', SigningAlgorithm: 'ED25519_SHA_512' },
            { abortSignal: options?.signal },
          );
          if (!out || out.SigningAlgorithm !== 'ED25519_SHA_512' || out.KeyId !== keyArn) refuse();
          return verified(m, out.Signature, base.publicKey);
        } catch { return refuse(); }
      },
    });
  } catch { return refuse(); }
}
