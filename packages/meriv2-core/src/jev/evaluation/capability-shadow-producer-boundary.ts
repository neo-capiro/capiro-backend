import { createHash, createPublicKey } from 'node:crypto';
import {
  assertCapabilityShadowEventMatchesLockedMembership,
  capabilityShadowEventSchema,
  resolveLockedCapabilityShadowAssignment,
  type CapabilityShadowEvent,
  type VerifiedCapabilityShadowMembership,
} from './capability-shadow';
import {
  assertCapabilityShadowPseudonymKeyPreflight,
  capabilityShadowEventPayloadToCanonicalJson,
  capabilityShadowEventSigningBytes,
  capabilityShadowEventVerificationKeysSchema,
  capabilityShadowSignedEventSchema,
  deriveCapabilityShadowPseudonyms,
  verifyCapabilityShadowEventPseudonyms,
  verifyCapabilityShadowSignedEvent,
  type CapabilityShadowPseudonymKeys,
  type CapabilityShadowSignedEvent,
} from './capability-shadow-event-trust';
import { parseCapabilityShadowUniqueJson } from './capability-shadow-signed-ingest';

type PseudonymKey = CapabilityShadowPseudonymKeys['tenant'][number];
type EvaluationUnitKey = CapabilityShadowPseudonymKeys['evaluationUnit'][number];

/**
 * These values must eventually come from server-observed turn, provider and
 * tool receipts, not a browser request or a reconstructed answer. This dormant
 * helper cannot itself authenticate that upstream provenance or event time.
 */
export interface CapabilityShadowObservedTurn {
  turnKeyHash: string;
  occurredAt: string;
  route: Omit<CapabilityShadowEvent['route'], 'eligible' | 'ineligibleReason'>;
  tools: CapabilityShadowEvent['tools'];
  execution: CapabilityShadowEvent['execution'];
}

export type CapabilityShadowProducerBoundaryInput =
  | { mode: 'off' }
  | {
    mode: 'prepare_only';
    membership: VerifiedCapabilityShadowMembership;
    observed: CapabilityShadowObservedTurn;
    /** Authorized raw identifier bytes, supplied by a future trusted caller. */
    tenantIdentifier: Uint8Array;
    evaluationUnitIdentifier: Uint8Array;
    tenantKey: PseudonymKey;
    evaluationUnitKey: EvaluationUnitKey;
    signingKeyId: string;
    /** Exact registry bytes and digest obtained from independent key custody. */
    publicRegistryBytes: Uint8Array;
    expectedPublicRegistrySha256: string;
    /** KMS/HSM-backed implementation is a future integration decision. */
    sign: (exactSigningBytes: Uint8Array) => Promise<Uint8Array>;
  };

export interface CapabilityShadowPreparedSignedEvent {
  envelope: CapabilityShadowSignedEvent;
  payloadDigest: string;
  publicRegistrySha256: string;
}

const REGISTRY_BYTE_LIMIT = 128 * 1024;
const eventIdDomain = Buffer.from('meri.capability_shadow.event_id.v1\0', 'utf8');

function requireRegisteredReference<T extends { keyId: string; version: string; window: { notBefore: string; notAfter: string } }>(
  keys: readonly T[], reference: { keyId: string; version: string }, occurredAt: string,
): T {
  const matching = keys.filter((key) => key.keyId === reference.keyId && key.version === reference.version);
  const time = Date.parse(occurredAt);
  if (matching.length !== 1 || time < Date.parse(matching[0]!.window.notBefore)
    || time >= Date.parse(matching[0]!.window.notAfter)) {
    throw new Error('event trust key is missing or outside its validity window');
  }
  return matching[0]!;
}

/**
 * Build and locally verify one signed envelope, without writing, routing,
 * executing a tool, or assigning live-evidence credit. There is no runtime
 * caller and no event sink; `prepare_only` is not a rollout mode.
 */
export async function prepareCapabilityShadowSignedEvent(
  input: CapabilityShadowProducerBoundaryInput,
): Promise<CapabilityShadowPreparedSignedEvent | null> {
  // The off branch must not inspect secrets, membership, signer, or registry.
  if (input.mode === 'off') return null;

  if (!(input.publicRegistryBytes instanceof Uint8Array)
    || input.publicRegistryBytes.byteLength > REGISTRY_BYTE_LIMIT) {
    throw new Error('public registry exceeds 128 KiB or is not bytes');
  }
  if (!/^[a-f0-9]{64}$/i.test(input.expectedPublicRegistrySha256)) {
    throw new Error('independently pinned public registry SHA-256 is required');
  }
  const publicRegistrySha256 = createHash('sha256').update(input.publicRegistryBytes).digest('hex');
  if (publicRegistrySha256 !== input.expectedPublicRegistrySha256.toLowerCase()) {
    throw new Error('public registry SHA-256 pin mismatch');
  }
  const registryText = new TextDecoder('utf-8', { fatal: true }).decode(input.publicRegistryBytes);
  const registry = capabilityShadowEventVerificationKeysSchema.parse(
    parseCapabilityShadowUniqueJson(registryText, REGISTRY_BYTE_LIMIT),
  );

  const locked = resolveLockedCapabilityShadowAssignment(input.membership, input.observed.turnKeyHash);
  const pseudonyms = deriveCapabilityShadowPseudonyms({
    tenantIdentifier: input.tenantIdentifier,
    evaluationUnitIdentifier: input.evaluationUnitIdentifier,
    tenantKey: input.tenantKey,
    evaluationUnitKey: input.evaluationUnitKey,
    occurredAt: input.observed.occurredAt,
  });
  const eventId = createHash('sha256')
    .update(eventIdDomain)
    .update(Buffer.from(locked.digest, 'hex'))
    .update(Buffer.from(input.observed.turnKeyHash, 'hex'))
    .digest('hex');
  const event = capabilityShadowEventSchema.parse({
    event: 'meri.capability_shadow.turn',
    schemaVersion: 1,
    eventId,
    turnKeyHash: input.observed.turnKeyHash,
    evaluationUnitHash: pseudonyms.evaluationUnitHash,
    evaluationUnitKeyVersion: pseudonyms.evaluationUnitKeyVersion,
    tenantPseudonymKeyVersion: pseudonyms.tenantPseudonymKeyVersion,
    tenantPseudonymHash: pseudonyms.tenantPseudonymHash,
    occurredAt: input.observed.occurredAt,
    sample: {
      source: locked.assignment.source,
      cohort: locked.assignment.cohort,
      split: locked.assignment.split,
      membershipManifestDigest: locked.digest,
      selectionPolicyVersion: locked.versions.selectionPolicy,
      surface: locked.assignment.surface,
      domain: locked.assignment.domain,
      taskFamily: locked.assignment.taskFamily,
    },
    versions: {
      catalog: locked.versions.catalog,
      routingModel: locked.versions.routingModel,
      question: locked.versions.question,
      policy: locked.versions.policy,
    },
    route: {
      ...input.observed.route,
      eligible: locked.assignment.eligibleSelected,
      ineligibleReason: locked.assignment.eligibilityReason,
    },
    tools: input.observed.tools,
    execution: input.observed.execution,
  });
  assertCapabilityShadowEventMatchesLockedMembership(event, input.membership);

  const payload = {
    version: 'meri_capability_shadow_signed_event.v1' as const,
    signingKey: { keyId: input.signingKeyId, version: 'event_ed25519.v1' as const },
    pseudonymKeys: {
      tenant: { keyId: pseudonyms.tenantPseudonymKeyId, version: pseudonyms.tenantPseudonymKeyVersion },
      evaluationUnit: { keyId: pseudonyms.evaluationUnitKeyId, version: pseudonyms.evaluationUnitKeyVersion },
    },
    event,
  };
  // Validate before asking a signer to use its protected private key.
  capabilityShadowEventPayloadToCanonicalJson(payload);
  const signingRecord = requireRegisteredReference(registry.signing, payload.signingKey, event.occurredAt);
  const publicKey = createPublicKey(signingRecord.publicKeyPem);
  const publicKeyDigest = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  if (publicKey.asymmetricKeyType !== 'ed25519' || publicKeyDigest !== signingRecord.trustedSpkiSha256) {
    throw new Error('event signing key fingerprint is not trusted');
  }
  const pseudonymKeys = {
    tenant: [input.tenantKey],
    evaluationUnit: [input.evaluationUnitKey],
  };
  assertCapabilityShadowPseudonymKeyPreflight(
    registry, pseudonymKeys, payload.pseudonymKeys, event.occurredAt,
  );
  const signature = await input.sign(Buffer.from(capabilityShadowEventSigningBytes(payload)));
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) {
    throw new Error('event signer did not return a 64-byte Ed25519 signature');
  }
  const envelope = capabilityShadowSignedEventSchema.parse({
    payload,
    signatureBase64: Buffer.from(signature).toString('base64'),
  });
  const verified = verifyCapabilityShadowSignedEvent(envelope, registry);
  verifyCapabilityShadowEventPseudonyms(envelope, registry, pseudonymKeys, {
    tenantIdentifier: input.tenantIdentifier,
    evaluationUnitIdentifier: input.evaluationUnitIdentifier,
  });
  return { envelope, payloadDigest: verified.payloadDigest, publicRegistrySha256 };
}
