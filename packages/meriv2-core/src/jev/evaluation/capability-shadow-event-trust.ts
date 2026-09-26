import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { z } from 'zod';
import { capabilityShadowEventSchema } from './capability-shadow';

const keyIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const tenantVersionSchema = z.string().regex(/^tenant_hmac\.v[1-9][0-9]{0,2}$/);
const unitVersionSchema = z.string().regex(/^eval_unit_hmac\.v[1-9][0-9]{0,2}$/);
const timestampSchema = z.string().datetime({ offset: true });
const keyWindowSchema = z.object({
  notBefore: timestampSchema,
  notAfter: timestampSchema,
}).strict().refine((window) => Date.parse(window.notBefore) < Date.parse(window.notAfter), 'invalid key validity window');

const keyReference = <T extends z.ZodTypeAny>(version: T) => z.object({
  keyId: keyIdSchema,
  version,
}).strict();

export const capabilityShadowSignedEventPayloadSchema = z.object({
  version: z.literal('meri_capability_shadow_signed_event.v1'),
  signingKey: keyReference(z.literal('event_ed25519.v1')),
  pseudonymKeys: z.object({
    tenant: keyReference(tenantVersionSchema),
    evaluationUnit: keyReference(unitVersionSchema),
  }).strict(),
  event: capabilityShadowEventSchema,
}).strict().superRefine((payload, context) => {
  if (payload.pseudonymKeys.tenant.version !== payload.event.tenantPseudonymKeyVersion) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['pseudonymKeys', 'tenant', 'version'], message: 'tenant key version differs from event' });
  }
  if (payload.pseudonymKeys.evaluationUnit.version !== payload.event.evaluationUnitKeyVersion) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['pseudonymKeys', 'evaluationUnit', 'version'], message: 'evaluation-unit key version differs from event' });
  }
});

export const capabilityShadowSignedEventSchema = z.object({
  payload: capabilityShadowSignedEventPayloadSchema,
  signatureBase64: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();

const signingKeySchema = z.object({
  keyId: keyIdSchema,
  version: z.literal('event_ed25519.v1'),
  publicKeyPem: z.string().min(1).max(4096),
  trustedSpkiSha256: digestSchema,
  window: keyWindowSchema,
}).strict();

const pseudonymVerificationKeySchema = <T extends z.ZodTypeAny>(version: T) => z.object({
  keyId: keyIdSchema,
  version,
  window: keyWindowSchema,
}).strict();

const pseudonymKeySchema = <T extends z.ZodTypeAny>(version: T) => z.object({
  keyId: keyIdSchema,
  version,
  secret: z.instanceof(Uint8Array).refine((secret) => secret.byteLength === 32, 'HMAC key must contain exactly 32 bytes'),
  window: keyWindowSchema,
}).strict();

export const capabilityShadowEventVerificationKeysSchema = z.object({
  signing: z.array(signingKeySchema).min(1).max(32),
  tenant: z.array(pseudonymVerificationKeySchema(tenantVersionSchema)).max(32),
  evaluationUnit: z.array(pseudonymVerificationKeySchema(unitVersionSchema)).max(32),
}).strict();

export const capabilityShadowPseudonymKeysSchema = z.object({
  tenant: z.array(pseudonymKeySchema(tenantVersionSchema)).max(32),
  evaluationUnit: z.array(pseudonymKeySchema(unitVersionSchema)).max(32),
}).strict();

export type CapabilityShadowSignedEventPayload = z.infer<typeof capabilityShadowSignedEventPayloadSchema>;
export type CapabilityShadowSignedEvent = z.infer<typeof capabilityShadowSignedEventSchema>;
export type CapabilityShadowEventVerificationKeys = z.infer<typeof capabilityShadowEventVerificationKeysSchema>;
export type CapabilityShadowPseudonymKeys = z.infer<typeof capabilityShadowPseudonymKeysSchema>;
export type CapabilityShadowPseudonymKey = CapabilityShadowPseudonymKeys['tenant'][number] | CapabilityShadowPseudonymKeys['evaluationUnit'][number];

// Sort every object key after strict schema parsing. This is a versioned wire format,
// not a general JSON canonicalization standard; producers must use these exact bytes.
function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)!;
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('unsupported signed event value');
}

export function capabilityShadowEventPayloadToCanonicalJson(input: unknown): string {
  const canonical = stableJson(capabilityShadowSignedEventPayloadSchema.parse(input));
  if (Buffer.byteLength(canonical, 'utf8') > 65536) throw new Error('signed event payload exceeds 64 KiB');
  return canonical;
}

const signatureDomain = Buffer.from('meri.capability_shadow.event_signature.v1\0', 'utf8');
const tenantDomain = Buffer.from('meri.capability_shadow.tenant.v1\0', 'utf8');
const unitDomain = Buffer.from('meri.capability_shadow.evaluation_unit.v1\0', 'utf8');

export function capabilityShadowEventSigningBytes(input: unknown): Buffer {
  return Buffer.concat([signatureDomain, Buffer.from(capabilityShadowEventPayloadToCanonicalJson(input), 'utf8')]);
}

function keyIsValidAt(window: z.infer<typeof keyWindowSchema>, occurredAt: string): boolean {
  const time = Date.parse(occurredAt);
  return time >= Date.parse(window.notBefore) && time < Date.parse(window.notAfter);
}

function assertUniqueKeyReferences(keys: {
  signing?: readonly { keyId: string; version: string }[];
  tenant: readonly { keyId: string; version: string }[];
  evaluationUnit: readonly { keyId: string; version: string }[];
}): void {
  for (const collection of [keys.signing ?? [], keys.tenant, keys.evaluationUnit]) {
    const seen = new Set<string>();
    for (const key of collection) {
      const reference = `${key.keyId}\0${key.version}`;
      if (seen.has(reference)) throw new Error('duplicate event trust key reference');
      seen.add(reference);
    }
  }
  const pseudonymKeys = [...keys.tenant, ...keys.evaluationUnit];
  for (let index = 0; index < pseudonymKeys.length; index += 1) {
    for (let next = index + 1; next < pseudonymKeys.length; next += 1) {
      const left = pseudonymKeys[index]!;
      const right = pseudonymKeys[next]!;
      if (left.keyId === right.keyId) throw new Error('pseudonym key IDs must be separate across purposes and rotations');
    }
  }
}

function assertDistinctPseudonymSecrets(keys: CapabilityShadowPseudonymKeys): void {
  assertUniqueKeyReferences(keys);
  const pseudonymKeys = [...keys.tenant, ...keys.evaluationUnit];
  for (let index = 0; index < pseudonymKeys.length; index += 1) {
    for (let next = index + 1; next < pseudonymKeys.length; next += 1) {
      const left = pseudonymKeys[index]!;
      const right = pseudonymKeys[next]!;
      if (timingSafeEqual(left.secret, right.secret)) {
        throw new Error('HMAC secrets must be separate across purposes and rotations');
      }
    }
  }
}

function assertSecretKeysMatchPublicRegistry(
  verificationKeys: CapabilityShadowEventVerificationKeys,
  pseudonymKeys: CapabilityShadowPseudonymKeys,
): void {
  for (const purpose of ['tenant', 'evaluationUnit'] as const) {
    for (const secretKey of pseudonymKeys[purpose]) {
      const publicKey = verificationKeys[purpose].find((candidate) =>
        candidate.keyId === secretKey.keyId && candidate.version === secretKey.version);
      if (!publicKey || secretKey.window.notBefore !== publicKey.window.notBefore ||
        secretKey.window.notAfter !== publicKey.window.notAfter) {
        throw new Error('pseudonym key reference or window differs from public verification registry');
      }
    }
  }
}

function requireKey<T extends { keyId: string; version: string; window: z.infer<typeof keyWindowSchema> }>(
  keys: readonly T[], reference: { keyId: string; version: string }, occurredAt: string,
): T {
  const key = keys.find((candidate) => candidate.keyId === reference.keyId && candidate.version === reference.version);
  if (!key || !keyIsValidAt(key.window, occurredAt)) throw new Error('event trust key is missing or outside its validity window');
  return key;
}

/**
 * Preflight registry-wide ambiguity and exact public/secret HMAC metadata before
 * a protected producer signer is invoked. This does not attest to key custody
 * or prove that the raw identifiers belong to a production turn.
 */
export function assertCapabilityShadowPseudonymKeyPreflight(
  verificationKeysInput: unknown,
  pseudonymKeysInput: unknown,
  references: {
    tenant: { keyId: string; version: string };
    evaluationUnit: { keyId: string; version: string };
  },
  occurredAt: string,
): void {
  const verificationKeys = capabilityShadowEventVerificationKeysSchema.parse(verificationKeysInput);
  const pseudonymKeys = capabilityShadowPseudonymKeysSchema.parse(pseudonymKeysInput);
  timestampSchema.parse(occurredAt);
  assertUniqueKeyReferences(verificationKeys);
  assertDistinctPseudonymSecrets(pseudonymKeys);
  assertSecretKeysMatchPublicRegistry(verificationKeys, pseudonymKeys);
  requireKey(verificationKeys.tenant, references.tenant, occurredAt);
  requireKey(verificationKeys.evaluationUnit, references.evaluationUnit, occurredAt);
  requireKey(pseudonymKeys.tenant, references.tenant, occurredAt);
  requireKey(pseudonymKeys.evaluationUnit, references.evaluationUnit, occurredAt);
}

function hmacIdentifier(identifier: Uint8Array, key: CapabilityShadowPseudonymKey, domain: Buffer): string {
  if (!(identifier instanceof Uint8Array) || identifier.byteLength === 0 || identifier.byteLength > 1024) {
    throw new Error('identifier must contain 1 to 1024 bytes');
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(identifier.byteLength);
  return createHmac('sha256', key.secret).update(domain).update(size).update(identifier).digest('hex');
}

export function deriveCapabilityShadowPseudonyms(input: {
  tenantIdentifier: Uint8Array;
  evaluationUnitIdentifier: Uint8Array;
  tenantKey: CapabilityShadowPseudonymKeys['tenant'][number];
  evaluationUnitKey: CapabilityShadowPseudonymKeys['evaluationUnit'][number];
  occurredAt: string;
}): {
  tenantPseudonymHash: string;
  tenantPseudonymKeyId: string;
  tenantPseudonymKeyVersion: string;
  evaluationUnitHash: string;
  evaluationUnitKeyId: string;
  evaluationUnitKeyVersion: string;
} {
  const tenantKey = pseudonymKeySchema(tenantVersionSchema).parse(input.tenantKey);
  const evaluationUnitKey = pseudonymKeySchema(unitVersionSchema).parse(input.evaluationUnitKey);
  timestampSchema.parse(input.occurredAt);
  assertDistinctPseudonymSecrets({ tenant: [tenantKey], evaluationUnit: [evaluationUnitKey] });
  if (!keyIsValidAt(tenantKey.window, input.occurredAt) || !keyIsValidAt(evaluationUnitKey.window, input.occurredAt)) {
    throw new Error('pseudonym key is outside its validity window');
  }
  return {
    tenantPseudonymHash: hmacIdentifier(input.tenantIdentifier, tenantKey, tenantDomain),
    tenantPseudonymKeyId: tenantKey.keyId,
    tenantPseudonymKeyVersion: tenantKey.version,
    evaluationUnitHash: hmacIdentifier(input.evaluationUnitIdentifier, evaluationUnitKey, unitDomain),
    evaluationUnitKeyId: evaluationUnitKey.keyId,
    evaluationUnitKeyVersion: evaluationUnitKey.version,
  };
}

export function verifyCapabilityShadowSignedEvent(input: unknown, verificationKeysInput: unknown): {
  payloadDigest: string;
  signingKeyId: string;
  signingKeyVersion: 'event_ed25519.v1';
} {
  const envelope = capabilityShadowSignedEventSchema.parse(input);
  const trust = capabilityShadowEventVerificationKeysSchema.parse(verificationKeysInput);
  assertUniqueKeyReferences(trust);
  const occurredAt = envelope.payload.event.occurredAt;
  const signingKey = requireKey(trust.signing, envelope.payload.signingKey, occurredAt);
  // Require both pseudonym key identities to be registered even when raw IDs
  // are unavailable to this signature-only verifier.
  requireKey(trust.tenant, envelope.payload.pseudonymKeys.tenant, occurredAt);
  requireKey(trust.evaluationUnit, envelope.payload.pseudonymKeys.evaluationUnit, occurredAt);
  const publicKey = createPublicKey(signingKey.publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('event signing key must be Ed25519');
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  if (fingerprint !== signingKey.trustedSpkiSha256) throw new Error('event signing key fingerprint is not trusted');
  const signature = Buffer.from(envelope.signatureBase64, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== envelope.signatureBase64 ||
    !verify(null, capabilityShadowEventSigningBytes(envelope.payload), publicKey, signature)) {
    throw new Error('event signature is invalid');
  }
  return {
    payloadDigest: createHash('sha256').update(capabilityShadowEventSigningBytes(envelope.payload)).digest('hex'),
    signingKeyId: signingKey.keyId,
    signingKeyVersion: signingKey.version,
  };
}

export function verifyCapabilityShadowEventPseudonyms(input: unknown, verificationKeysInput: unknown, pseudonymKeysInput: unknown, identifiers: {
  tenantIdentifier: Uint8Array;
  evaluationUnitIdentifier: Uint8Array;
}): void {
  verifyCapabilityShadowSignedEvent(input, verificationKeysInput);
  const envelope = capabilityShadowSignedEventSchema.parse(input);
  const verificationKeys = capabilityShadowEventVerificationKeysSchema.parse(verificationKeysInput);
  const pseudonymKeys = capabilityShadowPseudonymKeysSchema.parse(pseudonymKeysInput);
  assertDistinctPseudonymSecrets(pseudonymKeys);
  assertSecretKeysMatchPublicRegistry(verificationKeys, pseudonymKeys);
  const occurredAt = envelope.payload.event.occurredAt;
  const tenantKey = requireKey(pseudonymKeys.tenant, envelope.payload.pseudonymKeys.tenant, occurredAt);
  const evaluationUnitKey = requireKey(pseudonymKeys.evaluationUnit, envelope.payload.pseudonymKeys.evaluationUnit, occurredAt);
  const derived = deriveCapabilityShadowPseudonyms({ ...identifiers, tenantKey, evaluationUnitKey, occurredAt: envelope.payload.event.occurredAt });
  const event = envelope.payload.event;
  if (!timingSafeEqual(Buffer.from(derived.tenantPseudonymHash, 'hex'), Buffer.from(event.tenantPseudonymHash, 'hex')) ||
    !timingSafeEqual(Buffer.from(derived.evaluationUnitHash, 'hex'), Buffer.from(event.evaluationUnitHash, 'hex'))) {
    throw new Error('event pseudonyms do not match trusted key derivation');
  }
}
