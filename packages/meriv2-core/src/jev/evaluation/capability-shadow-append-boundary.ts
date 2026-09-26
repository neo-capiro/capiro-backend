import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { z } from 'zod';
import {
  capabilityShadowEventSigningBytes,
  capabilityShadowEventVerificationKeysSchema,
  capabilityShadowSignedEventSchema,
  verifyCapabilityShadowSignedEvent,
  type CapabilityShadowSignedEvent,
} from './capability-shadow-event-trust';
import {
  prepareCapabilityShadowSignedEvent,
  type CapabilityShadowPreparedSignedEvent,
  type CapabilityShadowProducerBoundaryInput,
} from './capability-shadow-producer-boundary';
import { parseCapabilityShadowUniqueJson } from './capability-shadow-signed-ingest';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const keyIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const endpointSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const audienceSchema = z.string().regex(/^[a-z][a-z0-9._:/-]{0,127}$/);
const timestampSchema = z.string().datetime({ offset: true });
const signatureSchema = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
export const MAX_CAPABILITY_SHADOW_LEDGER_SEQUENCE = Number.MAX_SAFE_INTEGER;
export const MAX_CAPABILITY_SHADOW_FUTURE_SKEW_MS = 5 * 60 * 1000;
const keyWindowSchema = z.object({
  notBefore: timestampSchema,
  notAfter: timestampSchema,
}).strict().refine(
  (window) => Date.parse(window.notBefore) < Date.parse(window.notAfter),
  'invalid key validity window',
);

const sinkReceiptKeySchema = z.object({
  keyId: keyIdSchema,
  version: z.literal('sink_receipt_ed25519.v1'),
  audience: audienceSchema,
  endpointId: endpointSchema,
  publicKeyPem: z.string().min(1).max(4096),
  trustedSpkiSha256: digestSchema,
  window: keyWindowSchema,
}).strict();

export const capabilityShadowSinkRegistrySchema = z.object({
  version: z.literal('meri_capability_shadow_sink_registry.v1'),
  keys: z.array(sinkReceiptKeySchema).min(1).max(32),
}).strict().superRefine((registry, context) => {
  const references = new Set<string>();
  for (let index = 0; index < registry.keys.length; index += 1) {
    const key = registry.keys[index]!;
    const reference = `${key.keyId}\0${key.version}`;
    if (references.has(reference)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['keys', index],
        message: 'duplicate sink receipt key reference',
      });
    }
    references.add(reference);
  }
});

export const capabilityShadowAppendRequestPayloadSchema = z.object({
  version: z.literal('meri_capability_shadow_append_request.v1'),
  audience: audienceSchema,
  endpointId: endpointSchema,
  producerRegistrySha256: digestSchema,
  sinkRegistrySha256: digestSchema,
  idempotencyKey: digestSchema,
  eventPayloadDigest: digestSchema,
  envelope: capabilityShadowSignedEventSchema,
}).strict().superRefine((payload, context) => {
  if (payload.idempotencyKey !== payload.envelope.payload.event.eventId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['idempotencyKey'],
      message: 'append idempotency key must equal the deterministic event ID',
    });
  }
});

export const capabilityShadowAuthenticatedAppendRequestSchema = z.object({
  payload: capabilityShadowAppendRequestPayloadSchema,
  producerAuthorization: z.object({
    keyId: keyIdSchema,
    version: z.literal('event_ed25519.v1'),
    signatureBase64: signatureSchema,
  }).strict(),
}).strict().superRefine((request, context) => {
  if (request.producerAuthorization.keyId !== request.payload.envelope.payload.signingKey.keyId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['producerAuthorization', 'keyId'],
      message: 'append authorization key must equal the event signing key',
    });
  }
});

const ledgerEntryBaseSchema = z.object({
  sequence: z.number().int().positive().max(MAX_CAPABILITY_SHADOW_LEDGER_SEQUENCE),
  previousEntryDigest: digestSchema.nullable(),
  appendedAt: timestampSchema,
  requestDigest: digestSchema,
  eventId: digestSchema,
  idempotencyKey: digestSchema,
  eventPayloadDigest: digestSchema,
  ledgerEntryDigest: digestSchema,
}).strict();

const ledgerEntrySchema = ledgerEntryBaseSchema.superRefine((entry, context) => {
  if ((entry.sequence === 1) !== (entry.previousEntryDigest === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['previousEntryDigest'],
      message: 'only the first ledger entry may omit its predecessor digest',
    });
  }
  if (entry.eventId !== entry.idempotencyKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['idempotencyKey'],
      message: 'ledger idempotency key must equal the deterministic event ID',
    });
  }
});

export const capabilityShadowAppendReceiptPayloadSchema = z.object({
  version: z.literal('meri_capability_shadow_append_receipt.v1'),
  audience: audienceSchema,
  endpointId: endpointSchema,
  disposition: z.enum(['appended', 'replayed']),
  receiptIssuedAt: timestampSchema,
  requestDigest: digestSchema,
  entry: ledgerEntrySchema,
}).strict().superRefine((receipt, context) => {
  if (receipt.requestDigest !== receipt.entry.requestDigest) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requestDigest'],
      message: 'receipt and ledger entry request digests differ',
    });
  }
  if (Date.parse(receipt.receiptIssuedAt) < Date.parse(receipt.entry.appendedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['receiptIssuedAt'],
      message: 'receipt cannot precede the append time',
    });
  }
});

export const capabilityShadowSignedAppendReceiptSchema = z.object({
  payload: capabilityShadowAppendReceiptPayloadSchema,
  sinkKey: z.object({
    keyId: keyIdSchema,
    version: z.literal('sink_receipt_ed25519.v1'),
  }).strict(),
  signatureBase64: signatureSchema,
}).strict();

export type CapabilityShadowAuthenticatedAppendRequest = z.infer<
  typeof capabilityShadowAuthenticatedAppendRequestSchema
>;
export type CapabilityShadowSignedAppendReceipt = z.infer<
  typeof capabilityShadowSignedAppendReceiptSchema
>;
export type CapabilityShadowSinkRegistry = z.infer<typeof capabilityShadowSinkRegistrySchema>;

export const capabilityShadowTrustedTimeSchema = z.object({
  verifiedAt: timestampSchema,
  maxFutureSkewMs: z.number().int().min(0).max(MAX_CAPABILITY_SHADOW_FUTURE_SKEW_MS),
}).strict();
export type CapabilityShadowTrustedTime = z.infer<typeof capabilityShadowTrustedTimeSchema>;

const REGISTRY_BYTE_LIMIT = 128 * 1024;
const REQUEST_BYTE_LIMIT = 128 * 1024;
const appendAuthorizationDomain = Buffer.from(
  'meri.capability_shadow.append_authorization.v1\0',
  'utf8',
);
const authenticatedRequestDomain = Buffer.from(
  'meri.capability_shadow.authenticated_append_request.v1\0',
  'utf8',
);
const ledgerEntryDomain = Buffer.from(
  'meri.capability_shadow.append_ledger_entry.v1\0',
  'utf8',
);
const sinkReceiptDomain = Buffer.from(
  'meri.capability_shadow.append_receipt.v1\0',
  'utf8',
);

function decodeUtf8WithoutBom(bytes: Uint8Array, kind: string): string {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`${kind} must not contain a UTF-8 BOM`);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number') return JSON.stringify(value)!;
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('unsupported append boundary value');
}

function canonicalBytes<T>(schema: z.ZodType<T>, input: unknown, domain: Buffer): Buffer {
  const bytes = Buffer.from(stableJson(schema.parse(input)), 'utf8');
  if (bytes.byteLength > REQUEST_BYTE_LIMIT) throw new Error('append boundary value exceeds 128 KiB');
  return Buffer.concat([domain, bytes]);
}

export function capabilityShadowAppendAuthorizationBytes(input: unknown): Buffer {
  return canonicalBytes(
    capabilityShadowAppendRequestPayloadSchema,
    input,
    appendAuthorizationDomain,
  );
}

export function capabilityShadowAuthenticatedAppendRequestDigest(input: unknown): string {
  return createHash('sha256').update(canonicalBytes(
    capabilityShadowAuthenticatedAppendRequestSchema,
    input,
    authenticatedRequestDomain,
  )).digest('hex');
}

export function capabilityShadowAuthenticatedAppendRequestToCanonicalJson(input: unknown): string {
  const json = stableJson(capabilityShadowAuthenticatedAppendRequestSchema.parse(input));
  if (Buffer.byteLength(json, 'utf8') > REQUEST_BYTE_LIMIT) {
    throw new Error('authenticated append request exceeds 128 KiB');
  }
  return json;
}

const ledgerDigestInputSchema = ledgerEntryBaseSchema.omit({ ledgerEntryDigest: true });

export function capabilityShadowLedgerEntryDigest(input: unknown): string {
  return createHash('sha256').update(canonicalBytes(
    ledgerDigestInputSchema,
    input,
    ledgerEntryDomain,
  )).digest('hex');
}

export function capabilityShadowSinkReceiptSigningBytes(input: unknown): Buffer {
  return canonicalBytes(
    capabilityShadowAppendReceiptPayloadSchema,
    input,
    sinkReceiptDomain,
  );
}

function decodeRegistry(bytes: Uint8Array, expectedSha256: string, kind: string): {
  text: string;
  sha256: string;
} {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > REGISTRY_BYTE_LIMIT) {
    throw new Error(`${kind} registry exceeds 128 KiB or is not bytes`);
  }
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error(`independently pinned ${kind} registry SHA-256 is required`);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedSha256.toLowerCase()) throw new Error(`${kind} registry SHA-256 pin mismatch`);
  return { text: decodeUtf8WithoutBom(bytes, `${kind} registry`), sha256 };
}

function keyIsValidAt(window: { notBefore: string; notAfter: string }, at: string): boolean {
  const timestamp = Date.parse(at);
  return timestamp >= Date.parse(window.notBefore) && timestamp < Date.parse(window.notAfter);
}

function assertNotAfterTrustedFuture(
  timestamp: string,
  trustedTime: CapabilityShadowTrustedTime,
  kind: string,
): void {
  if (Date.parse(timestamp) > Date.parse(trustedTime.verifiedAt) + trustedTime.maxFutureSkewMs) {
    throw new Error(`${kind} exceeds the bounded trusted-time future skew`);
  }
}

function verifyEd25519Signature(input: {
  publicKeyPem: string;
  trustedSpkiSha256: string;
  bytes: Uint8Array;
  signatureBase64: string;
  errorPrefix: string;
}): void {
  const publicKey = createPublicKey(input.publicKeyPem);
  const fingerprint = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  const signature = Buffer.from(input.signatureBase64, 'base64');
  if (publicKey.asymmetricKeyType !== 'ed25519'
    || fingerprint !== input.trustedSpkiSha256
    || signature.byteLength !== 64
    || signature.toString('base64') !== input.signatureBase64
    || !verify(null, input.bytes, publicKey, signature)) {
    throw new Error(`${input.errorPrefix} signature is invalid or untrusted`);
  }
}

function assertTrustedSinkRegistryKeys(registry: CapabilityShadowSinkRegistry): void {
  for (const key of registry.keys) {
    const publicKey = createPublicKey(key.publicKeyPem);
    const fingerprint = createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    if (publicKey.asymmetricKeyType !== 'ed25519' || fingerprint !== key.trustedSpkiSha256) {
      throw new Error('sink registry key fingerprint is invalid or untrusted');
    }
  }
}

function assertFinalLifecycle(envelope: CapabilityShadowSignedEvent): void {
  for (const provider of ['baseline', 'jev'] as const) {
    const status = envelope.payload.event.execution[provider].status;
    if (status === 'attempted' || status === 'dispatched') {
      throw new Error('append-only evidence requires a final lifecycle record');
    }
  }
}

interface VerifiedCapabilityShadowAppendRequestFields {
  request: CapabilityShadowAuthenticatedAppendRequest;
  requestDigest: string;
  producerRegistrySha256: string;
  /** Exclusive end of the producer authorization key's trusted window. */
  producerAuthorizationKeyNotAfter: string;
}

// These symbols are deliberately module-private. Consumers can receive a
// capability from a verifier, but cannot reproduce either nominal type with
// ordinary object construction. Symbol-keyed, non-enumerable properties are
// also omitted from JSON and canonical request serialization.
const replayLookupOnlyBrand: unique symbol = Symbol(
  'meri.capability_shadow.replay_lookup_only',
);
const currentAppendAuthorizedBrand: unique symbol = Symbol(
  'meri.capability_shadow.current_append_authorized',
);

export type VerifiedCapabilityShadowReplayLookupRequest =
  VerifiedCapabilityShadowAppendRequestFields & {
    readonly [replayLookupOnlyBrand]: 'replay_lookup_only';
  };

export type VerifiedCapabilityShadowCurrentAppendAuthorizedRequest =
  VerifiedCapabilityShadowAppendRequestFields & {
    readonly [currentAppendAuthorizedBrand]: 'current_append_authorized';
  };

function asReplayLookupOnlyCapability(
  verified: VerifiedCapabilityShadowAppendRequestFields,
): VerifiedCapabilityShadowReplayLookupRequest {
  Object.defineProperty(verified, replayLookupOnlyBrand, {
    value: 'replay_lookup_only',
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return verified as VerifiedCapabilityShadowReplayLookupRequest;
}

function asCurrentAppendAuthorizedCapability(
  verified: VerifiedCapabilityShadowAppendRequestFields,
): VerifiedCapabilityShadowCurrentAppendAuthorizedRequest {
  Object.defineProperty(verified, currentAppendAuthorizedBrand, {
    value: 'current_append_authorized',
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return verified as VerifiedCapabilityShadowCurrentAppendAuthorizedRequest;
}

function verifyCapabilityShadowAuthenticatedAppendRequestBytesInternal(
  requestBytes: Uint8Array,
  producerRegistryBytes: Uint8Array,
  expectedProducerRegistrySha256: string,
  expectedSink: {
    audience: string;
    endpointId: string;
    sinkRegistrySha256: string;
  },
  trustedTimeInput: CapabilityShadowTrustedTime,
  requireKeyValidAtTrustedTime: boolean,
): VerifiedCapabilityShadowAppendRequestFields {
  if (!(requestBytes instanceof Uint8Array) || requestBytes.byteLength > REQUEST_BYTE_LIMIT) {
    throw new Error('authenticated append request exceeds 128 KiB or is not bytes');
  }
  const requestText = decodeUtf8WithoutBom(requestBytes, 'authenticated append request');
  const request = capabilityShadowAuthenticatedAppendRequestSchema.parse(
    parseCapabilityShadowUniqueJson(requestText, REQUEST_BYTE_LIMIT),
  );
  if (requestText !== capabilityShadowAuthenticatedAppendRequestToCanonicalJson(request)) {
    throw new Error('authenticated append request is not canonical JSON');
  }
  const expectedAudience = audienceSchema.parse(expectedSink.audience);
  const expectedEndpointId = endpointSchema.parse(expectedSink.endpointId);
  const expectedSinkRegistrySha256 = digestSchema.parse(
    expectedSink.sinkRegistrySha256.toLowerCase(),
  );
  if (request.payload.audience !== expectedAudience
    || request.payload.endpointId !== expectedEndpointId
    || request.payload.sinkRegistrySha256 !== expectedSinkRegistrySha256) {
    throw new Error('append request is not addressed to the pinned sink generation');
  }

  const producerRegistrySource = decodeRegistry(
    producerRegistryBytes,
    expectedProducerRegistrySha256,
    'producer',
  );
  if (request.payload.producerRegistrySha256 !== producerRegistrySource.sha256) {
    throw new Error('append request and pinned producer registry differ');
  }
  const producerRegistry = capabilityShadowEventVerificationKeysSchema.parse(
    parseCapabilityShadowUniqueJson(producerRegistrySource.text, REGISTRY_BYTE_LIMIT),
  );
  const verifiedEvent = verifyCapabilityShadowSignedEvent(
    request.payload.envelope,
    producerRegistry,
  );
  if (verifiedEvent.payloadDigest !== request.payload.eventPayloadDigest) {
    throw new Error('append request event digest does not match its signed envelope');
  }
  assertFinalLifecycle(request.payload.envelope);
  const producerKeys = producerRegistry.signing.filter((key) =>
    key.keyId === request.producerAuthorization.keyId
      && key.version === request.producerAuthorization.version);
  const occurredAt = request.payload.envelope.payload.event.occurredAt;
  const trustedTime = capabilityShadowTrustedTimeSchema.parse(trustedTimeInput);
  assertNotAfterTrustedFuture(occurredAt, trustedTime, 'event observation time');
  if (producerKeys.length !== 1
    || !keyIsValidAt(producerKeys[0]!.window, occurredAt)) {
    throw new Error('append authorization key is missing, ambiguous, or outside its validity window');
  }
  if (requireKeyValidAtTrustedTime
    && !keyIsValidAt(producerKeys[0]!.window, trustedTime.verifiedAt)) {
    throw new Error('append authorization key is missing, ambiguous, or outside its validity window');
  }
  verifyEd25519Signature({
    publicKeyPem: producerKeys[0]!.publicKeyPem,
    trustedSpkiSha256: producerKeys[0]!.trustedSpkiSha256,
    bytes: capabilityShadowAppendAuthorizationBytes(request.payload),
    signatureBase64: request.producerAuthorization.signatureBase64,
    errorPrefix: 'append authorization',
  });
  return {
    request,
    requestDigest: capabilityShadowAuthenticatedAppendRequestDigest(request),
    producerRegistrySha256: producerRegistrySource.sha256,
    producerAuthorizationKeyNotAfter: producerKeys[0]!.window.notAfter,
  };
}

/**
 * Historical exact-byte verification for ambiguity recovery only. It verifies
 * the event and append authorization under the key that was valid at the
 * signed event time, but deliberately does not authorize a new append after
 * that key expires. A sink may use this result only to look up and compare an
 * already immutable entry; absence must fall through to the current-key
 * verifier below before any write.
 */
export function verifyCapabilityShadowAuthenticatedAppendRequestBytesForReplay(
  requestBytes: Uint8Array,
  producerRegistryBytes: Uint8Array,
  expectedProducerRegistrySha256: string,
  expectedSink: {
    audience: string;
    endpointId: string;
    sinkRegistrySha256: string;
  },
  trustedTimeInput: CapabilityShadowTrustedTime,
): VerifiedCapabilityShadowReplayLookupRequest {
  return asReplayLookupOnlyCapability(
    verifyCapabilityShadowAuthenticatedAppendRequestBytesInternal(
      requestBytes,
      producerRegistryBytes,
      expectedProducerRegistrySha256,
      expectedSink,
      trustedTimeInput,
      false,
    ),
  );
}

/**
 * Shared sink-side verifier for a possible new append. In addition to
 * historical event-time validity, the producer authorization key must still
 * be valid at trusted verification time.
 */
export function verifyCapabilityShadowAuthenticatedAppendRequestBytes(
  requestBytes: Uint8Array,
  producerRegistryBytes: Uint8Array,
  expectedProducerRegistrySha256: string,
  expectedSink: {
    audience: string;
    endpointId: string;
    sinkRegistrySha256: string;
  },
  trustedTimeInput: CapabilityShadowTrustedTime,
): VerifiedCapabilityShadowCurrentAppendAuthorizedRequest {
  return asCurrentAppendAuthorizedCapability(
    verifyCapabilityShadowAuthenticatedAppendRequestBytesInternal(
      requestBytes,
      producerRegistryBytes,
      expectedProducerRegistrySha256,
      expectedSink,
      trustedTimeInput,
      true,
    ),
  );
}

type ProducerInput = Extract<CapabilityShadowProducerBoundaryInput, { mode: 'prepare_only' }>;

export type CapabilityShadowAppendBoundaryInput =
  | { mode: 'off' }
  | {
    mode: 'append_only';
    producer: ProducerInput;
    /** Trusted server/KMS clock observation captured for this append attempt. */
    trustedTime: CapabilityShadowTrustedTime;
    sink: {
      audience: string;
      endpointId: string;
      publicRegistryBytes: Uint8Array;
      expectedPublicRegistrySha256: string;
      /** Domain-restricted producer/KMS authorization over the canonical request payload. */
      authorize: (exactAuthorizationBytes: Uint8Array) => Promise<Uint8Array>;
      /** One attempt only. A caller may retry the same deterministic request after ambiguity. */
      append: (
        exactCanonicalRequestBytes: Uint8Array,
      ) => Promise<Uint8Array>;
    };
  };

export interface CapabilityShadowAppendResult {
  prepared: CapabilityShadowPreparedSignedEvent;
  request: CapabilityShadowAuthenticatedAppendRequest;
  requestBytes: Uint8Array;
  requestDigest: string;
  receipt: CapabilityShadowSignedAppendReceipt;
  sinkRegistrySha256: string;
}

/**
 * Dormant authenticated delivery boundary. It has no runtime registration,
 * network client, retry loop, key loader, or live-evidence verdict.
 */
export async function appendCapabilityShadowSignedEvent(
  input: CapabilityShadowAppendBoundaryInput,
): Promise<CapabilityShadowAppendResult | null> {
  // Preserve a strict zero-touch default: hostile getters beyond mode are not read.
  if (input.mode === 'off') return null;

  const sinkRegistrySource = decodeRegistry(
    input.sink.publicRegistryBytes,
    input.sink.expectedPublicRegistrySha256,
    'sink',
  );
  const sinkRegistry = capabilityShadowSinkRegistrySchema.parse(
    parseCapabilityShadowUniqueJson(sinkRegistrySource.text, REGISTRY_BYTE_LIMIT),
  );
  assertTrustedSinkRegistryKeys(sinkRegistry);
  const trustedTime = capabilityShadowTrustedTimeSchema.parse(input.trustedTime);

  const prepared = await prepareCapabilityShadowSignedEvent(input.producer);
  if (prepared === null) throw new Error('append producer unexpectedly returned off');
  assertFinalLifecycle(prepared.envelope);

  const requestPayload = capabilityShadowAppendRequestPayloadSchema.parse({
    version: 'meri_capability_shadow_append_request.v1',
    audience: input.sink.audience,
    endpointId: input.sink.endpointId,
    producerRegistrySha256: prepared.publicRegistrySha256,
    sinkRegistrySha256: sinkRegistrySource.sha256,
    idempotencyKey: prepared.envelope.payload.event.eventId,
    eventPayloadDigest: prepared.payloadDigest,
    envelope: prepared.envelope,
  });
  const authorizationBytes = capabilityShadowAppendAuthorizationBytes(requestPayload);
  const authorizationSignature = await input.sink.authorize(authorizationBytes);
  if (!(authorizationSignature instanceof Uint8Array) || authorizationSignature.byteLength !== 64) {
    throw new Error('append authorizer did not return a 64-byte Ed25519 signature');
  }
  const request = capabilityShadowAuthenticatedAppendRequestSchema.parse({
    payload: requestPayload,
    producerAuthorization: {
      keyId: prepared.envelope.payload.signingKey.keyId,
      version: 'event_ed25519.v1',
      signatureBase64: Buffer.from(authorizationSignature).toString('base64'),
    },
  });

  const privateRequestBytes = Buffer.from(
    capabilityShadowAuthenticatedAppendRequestToCanonicalJson(request),
    'utf8',
  );
  const verifiedRequest = verifyCapabilityShadowAuthenticatedAppendRequestBytes(
    privateRequestBytes,
    input.producer.publicRegistryBytes,
    input.producer.expectedPublicRegistrySha256,
    {
      audience: input.sink.audience,
      endpointId: input.sink.endpointId,
      sinkRegistrySha256: sinkRegistrySource.sha256,
    },
    trustedTime,
  );
  if (!timingSafeEqual(
    Buffer.from(verifiedRequest.producerRegistrySha256, 'hex'),
    Buffer.from(prepared.publicRegistrySha256, 'hex'),
  )) throw new Error('prepared event and append producer registries differ');
  const occurredAt = request.payload.envelope.payload.event.occurredAt;
  // Recompute the event signing bytes here so a future refactor cannot silently
  // replace a verified event with a differently encoded payload before append.
  capabilityShadowEventSigningBytes(request.payload.envelope.payload);

  const requestDigest = verifiedRequest.requestDigest;
  const untrustedReceiptBytes = await input.sink.append(Buffer.from(privateRequestBytes));
  if (!(untrustedReceiptBytes instanceof Uint8Array)
    || untrustedReceiptBytes.byteLength > REQUEST_BYTE_LIMIT) {
    throw new Error('sink receipt exceeds 128 KiB or is not bytes');
  }
  const receiptBytes = Uint8Array.from(untrustedReceiptBytes);
  const receiptText = decodeUtf8WithoutBom(receiptBytes, 'sink receipt');
  const receipt = capabilityShadowSignedAppendReceiptSchema.parse(
    parseCapabilityShadowUniqueJson(receiptText, REQUEST_BYTE_LIMIT),
  );
  if (receipt.payload.audience !== request.payload.audience
    || receipt.payload.endpointId !== request.payload.endpointId
    || receipt.payload.requestDigest !== requestDigest
    || receipt.payload.entry.requestDigest !== requestDigest
    || receipt.payload.entry.eventId !== request.payload.envelope.payload.event.eventId
    || receipt.payload.entry.idempotencyKey !== request.payload.idempotencyKey
    || receipt.payload.entry.eventPayloadDigest !== request.payload.eventPayloadDigest) {
    throw new Error('sink receipt does not bind the exact authenticated append request');
  }
  if (Date.parse(receipt.payload.entry.appendedAt) < Date.parse(occurredAt)) {
    throw new Error('sink ledger append time precedes the observed event');
  }
  assertNotAfterTrustedFuture(receipt.payload.entry.appendedAt, trustedTime, 'sink append time');
  assertNotAfterTrustedFuture(receipt.payload.receiptIssuedAt, trustedTime, 'sink receipt time');
  const expectedLedgerDigest = capabilityShadowLedgerEntryDigest(receipt.payload.entry);
  if (!timingSafeEqual(
    Buffer.from(expectedLedgerDigest, 'hex'),
    Buffer.from(receipt.payload.entry.ledgerEntryDigest, 'hex'),
  )) throw new Error('sink ledger entry digest is invalid');

  const sinkKeys = sinkRegistry.keys.filter((key) =>
    key.keyId === receipt.sinkKey.keyId
      && key.version === receipt.sinkKey.version
      && key.audience === request.payload.audience
      && key.endpointId === request.payload.endpointId);
  if (sinkKeys.length !== 1
    || !keyIsValidAt(sinkKeys[0]!.window, receipt.payload.receiptIssuedAt)
    || !keyIsValidAt(sinkKeys[0]!.window, trustedTime.verifiedAt)) {
    throw new Error('sink receipt key is missing, ambiguous, or outside its validity window');
  }
  verifyEd25519Signature({
    publicKeyPem: sinkKeys[0]!.publicKeyPem,
    trustedSpkiSha256: sinkKeys[0]!.trustedSpkiSha256,
    bytes: capabilityShadowSinkReceiptSigningBytes(receipt.payload),
    signatureBase64: receipt.signatureBase64,
    errorPrefix: 'sink receipt',
  });

  return {
    prepared,
    request,
    requestBytes: Uint8Array.from(privateRequestBytes),
    requestDigest,
    receipt,
    sinkRegistrySha256: sinkRegistrySource.sha256,
  };
}
