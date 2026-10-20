import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

/**
 * Server-only trust pins for the retained-read principal (data envelope) and
 * authority-only probe purposes. One loader serves both owners so Core (the
 * only signer) and Intel (verifier only) read identical issuer, origin and key
 * identity pins.
 *
 * Disabled or absent configuration returns null, and every port built from
 * null stays inert (503). An explicit RETAINED_READS_ENABLED=true with any
 * missing or invalid pin throws at startup instead of serving a partial trust
 * set. Errors name the variable, never its value.
 */
export const CORE_RETAINED_TRUST_ENV = Object.freeze({
  enabled: 'RETAINED_READS_ENABLED',
  issuer: 'RETAINED_TRUST_ISSUER',
  coreOrigin: 'RETAINED_CORE_ORIGIN',
  intelOrigin: 'RETAINED_INTEL_ORIGIN',
  principalKeyId: 'RETAINED_PRINCIPAL_KEY_ID',
  principalPrivateKey: 'RETAINED_PRINCIPAL_PRIVATE_KEY_PEM',
  principalPublicKey: 'RETAINED_PRINCIPAL_PUBLIC_KEY_PEM',
  probeKeyId: 'RETAINED_PROBE_KEY_ID',
  probePrivateKey: 'RETAINED_PROBE_PRIVATE_KEY_PEM',
  probePublicKey: 'RETAINED_PROBE_PUBLIC_KEY_PEM',
});
export const CORE_RETAINED_TRUST_ENV_KEYS = Object.freeze(Object.values(CORE_RETAINED_TRUST_ENV));

/** `core` signs both purposes and needs private keys. `intel` only verifies and
 * must not be given a private key. */
export type CoreRetainedTrustRole = 'core' | 'intel';

export interface CoreRetainedKeyPin {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  /** Present only for the `core` role. */
  readonly privateKey: KeyObject | null;
}

export interface CoreRetainedTrust {
  readonly issuer: string;
  readonly coreOrigin: string;
  readonly intelOrigin: string;
  readonly principal: CoreRetainedKeyPin;
  readonly probe: CoreRetainedKeyPin;
}

export class CoreRetainedTrustConfigError extends Error {
  readonly code = 'CORE_RETAINED_TRUST_CONFIG';
  constructor(readonly variable: string) {
    super(`Retained read trust configuration is invalid or incomplete: ${variable}`);
    this.name = 'CoreRetainedTrustConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export function readCoreRetainedTrust(env: Env, role: CoreRetainedTrustRole): CoreRetainedTrust | null {
  const names = CORE_RETAINED_TRUST_ENV;
  const enabled = env[names.enabled];
  if (enabled === undefined || enabled === '' || enabled === 'false') return null;
  if (enabled !== 'true') throw new CoreRetainedTrustConfigError(names.enabled);
  const trust: CoreRetainedTrust = {
    issuer: pinText(env, names.issuer),
    coreOrigin: httpsOrigin(env, names.coreOrigin),
    intelOrigin: httpsOrigin(env, names.intelOrigin),
    principal: keyPin(env, role, names.principalKeyId, names.principalPrivateKey, names.principalPublicKey),
    probe: keyPin(env, role, names.probeKeyId, names.probePrivateKey, names.probePublicKey),
  };
  return Object.freeze(trust);
}

function value(env: Env, name: string): string {
  const raw = env[name];
  if (typeof raw !== 'string' || raw.length === 0) throw new CoreRetainedTrustConfigError(name);
  return raw;
}

/** keyId and issuer: 1..256 visible ASCII characters, matching the codec pins. */
function pinText(env: Env, name: string): string {
  const raw = value(env, name);
  if (!/^[\x21-\x7e]{1,256}$/.test(raw)) throw new CoreRetainedTrustConfigError(name);
  return raw;
}

function httpsOrigin(env: Env, name: string): string {
  const raw = value(env, name);
  let url: URL;
  try { url = new URL(raw); } catch { throw new CoreRetainedTrustConfigError(name); }
  if (url.protocol !== 'https:' || url.origin !== raw || url.username || url.password) {
    throw new CoreRetainedTrustConfigError(name);
  }
  return raw;
}

function pem(env: Env, name: string): string | null {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  // Secrets injected as single-line strings carry escaped newlines.
  return raw.includes('\n') ? raw : raw.replace(/\\n/g, '\n');
}

function keyPin(env: Env, role: CoreRetainedTrustRole, keyIdName: string, privateName: string, publicName: string): CoreRetainedKeyPin {
  const keyId = pinText(env, keyIdName);
  const privatePem = pem(env, privateName);
  const publicPem = pem(env, publicName);
  if (role === 'intel') {
    if (privatePem !== null) throw new CoreRetainedTrustConfigError(privateName);
    if (publicPem === null) throw new CoreRetainedTrustConfigError(publicName);
    return Object.freeze({ keyId, publicKey: ed25519Public(publicPem, publicName), privateKey: null });
  }
  if (privatePem === null) throw new CoreRetainedTrustConfigError(privateName);
  let privateKey: KeyObject;
  try { privateKey = createPrivateKey({ key: privatePem, format: 'pem' }); } catch { throw new CoreRetainedTrustConfigError(privateName); }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new CoreRetainedTrustConfigError(privateName);
  const publicKey = createPublicKey(privateKey);
  if (publicPem !== null) {
    const pinned = ed25519Public(publicPem, publicName);
    const derived = publicKey.export({ format: 'der', type: 'spki' });
    if (!pinned.export({ format: 'der', type: 'spki' }).equals(derived)) throw new CoreRetainedTrustConfigError(publicName);
  }
  return Object.freeze({ keyId, publicKey, privateKey });
}

function ed25519Public(text: string, name: string): KeyObject {
  // createPublicKey also derives a public key from private-key PEM; refuse that
  // so a signing key can never sit unnoticed in a verifier-only variable.
  if (!/^-----BEGIN PUBLIC KEY-----\s[\s\S]+\s-----END PUBLIC KEY-----$/.test(text.trim())) {
    throw new CoreRetainedTrustConfigError(name);
  }
  let key: KeyObject;
  try { key = createPublicKey({ key: text, format: 'pem' }); } catch { throw new CoreRetainedTrustConfigError(name); }
  if (key.asymmetricKeyType !== 'ed25519') throw new CoreRetainedTrustConfigError(name);
  return key;
}
