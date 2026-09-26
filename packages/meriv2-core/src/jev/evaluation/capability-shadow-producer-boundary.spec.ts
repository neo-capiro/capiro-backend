import { describe, expect, it } from '@jest/globals';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  capabilityShadowMembershipPayloadToCanonicalJson,
  verifyCapabilityShadowMembershipManifest,
  type CapabilityShadowMembershipPayload,
  type VerifiedCapabilityShadowMembership,
} from './capability-shadow';
import {
  capabilityShadowEventSigningBytes,
  deriveCapabilityShadowPseudonyms,
} from './capability-shadow-event-trust';
import {
  prepareCapabilityShadowSignedEvent,
  type CapabilityShadowProducerBoundaryInput,
} from './capability-shadow-producer-boundary';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const occurredAt = '2026-09-25T10:00:03.000Z';
const window = { notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2027-01-01T00:00:00.000Z' };
const tenantIdentifier = Buffer.from('raw-tenant-42', 'utf8');
const evaluationUnitIdentifier = Buffer.from('raw-evaluation-unit-99', 'utf8');

function settledAttempt() {
  return {
    status: 'settled' as const,
    attemptedAt: '2026-09-25T10:00:00.000Z',
    dispatchedAt: '2026-09-25T10:00:01.000Z',
    finishedAt: '2026-09-25T10:00:02.000Z',
    durationMs: 50,
    inputTokens: 10,
    outputTokens: 4,
    costUsd: 0.001,
  };
}

function fixture() {
  const signing = generateKeyPairSync('ed25519');
  const membershipSigning = generateKeyPairSync('ed25519');
  const tenantKey = { keyId: 'tenant_2026', version: 'tenant_hmac.v1', secret: Buffer.alloc(32, 0x21), window };
  const evaluationUnitKey = { keyId: 'unit_2026', version: 'eval_unit_hmac.v1', secret: Buffer.alloc(32, 0x31), window };
  const pseudonyms = deriveCapabilityShadowPseudonyms({
    tenantIdentifier, evaluationUnitIdentifier, tenantKey, evaluationUnitKey, occurredAt,
  });
  const assignment: CapabilityShadowMembershipPayload['assignments'][number] = {
    turnKeyHash: digest('turn-1'),
    evaluationUnitHash: pseudonyms.evaluationUnitHash,
    evaluationUnitKeyVersion: pseudonyms.evaluationUnitKeyVersion,
    tenantPseudonymHash: pseudonyms.tenantPseudonymHash,
    tenantPseudonymKeyVersion: pseudonyms.tenantPseudonymKeyVersion,
    eligibleSelected: true,
    eligibilityReason: null,
    source: 'live',
    cohort: 'representative',
    split: 'tuning',
    surface: 'chat',
    domain: 'gov_affairs',
    taskFamily: 'awards_search',
  };
  const membershipPayload: CapabilityShadowMembershipPayload = {
    version: 'meri_capability_shadow_membership.v1',
    keyId: 'membership_2026',
    versions: {
      catalog: 'catalog.v1', routingModel: 'jev_luna.v1', question: 'route.v1',
      policy: 'policy.v1', selectionPolicy: 'sampling.v1',
    },
    registry: {
      surfaces: ['chat'], domains: ['gov_affairs'], taskFamilies: ['awards_search'],
      routes: ['general', 'awards'], tools: ['award_search'], reasonCodes: ['no_result'],
    },
    assignments: [assignment],
  };
  const membership = verifyCapabilityShadowMembershipManifest({
    payload: membershipPayload,
    signatureBase64: sign(null, Buffer.from(capabilityShadowMembershipPayloadToCanonicalJson(membershipPayload)), membershipSigning.privateKey).toString('base64'),
  }, membershipSigning.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  createHash('sha256').update(membershipSigning.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'));
  const publicRegistry = {
    signing: [{ keyId: 'event_2026', version: 'event_ed25519.v1',
      publicKeyPem: signing.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      trustedSpkiSha256: createHash('sha256').update(signing.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
      window }],
    tenant: [{ keyId: tenantKey.keyId, version: tenantKey.version, window }],
    evaluationUnit: [{ keyId: evaluationUnitKey.keyId, version: evaluationUnitKey.version, window }],
  };
  const publicRegistryBytes = Buffer.from(JSON.stringify(publicRegistry), 'utf8');
  let calls = 0;
  let lastSigningBytes: Buffer | null = null;
  const signEvent = async (bytes: Uint8Array): Promise<Uint8Array> => {
    calls += 1;
    lastSigningBytes = Buffer.from(bytes);
    return sign(null, bytes, signing.privateKey);
  };
  const input: Extract<CapabilityShadowProducerBoundaryInput, { mode: 'prepare_only' }> = {
    mode: 'prepare_only', membership,
    observed: {
      turnKeyHash: assignment.turnKeyHash,
      occurredAt,
      route: { baseline: 'general', candidate: 'awards', confidence: 0.8, fallbackReason: null },
      tools: { required: ['award_search'], candidateExposed: ['award_search'], baselineExposed: ['award_search'], baselineUsed: ['award_search'] },
      execution: { executor: 'baseline', baseline: settledAttempt(), jev: settledAttempt() },
    },
    tenantIdentifier, evaluationUnitIdentifier, tenantKey, evaluationUnitKey,
    signingKeyId: 'event_2026', publicRegistryBytes,
    expectedPublicRegistrySha256: createHash('sha256').update(publicRegistryBytes).digest('hex'),
    sign: signEvent,
  };
  return { input, membership, publicRegistry, publicRegistryBytes, assignment, getCalls: () => calls, getLastSigningBytes: () => lastSigningBytes };
}

describe('dormant capability shadow producer boundary', () => {
  it('is a zero-call off path even when other properties are hostile getters', async () => {
    const input = { mode: 'off' as const, get sign() { throw new Error('signer accessed in off'); }, get membership() { throw new Error('membership accessed in off'); } };
    expect(await prepareCapabilityShadowSignedEvent(input)).toBeNull();
  });

  it('builds exact signed bytes from locked membership and returns no raw identifier or live verdict', async () => {
    const f = fixture();
    const prepared = await prepareCapabilityShadowSignedEvent(f.input);
    expect(prepared).not.toBeNull();
    expect(f.getCalls()).toBe(1);
    expect(f.getLastSigningBytes()).toEqual(capabilityShadowEventSigningBytes(prepared!.envelope.payload));
    expect(prepared!.envelope.payload.event.sample).toMatchObject({
      source: 'live', cohort: 'representative', membershipManifestDigest: f.membership.digest,
    });
    expect(prepared!.envelope.payload.event.eventId).toHaveLength(64);
    const serialized = JSON.stringify(prepared);
    expect(serialized).not.toContain(tenantIdentifier.toString('utf8'));
    expect(serialized).not.toContain(evaluationUnitIdentifier.toString('utf8'));
    expect(serialized).not.toContain('liveEvidenceVerified');
    expect(serialized).not.toContain('qualified');
  });

  it('uses the private verified snapshot despite mutation of the public typed view', async () => {
    const f = fixture();
    f.membership.payload.assignments[0]!.cohort = 'fixture';
    (f.membership.assignments as Map<string, typeof f.assignment>)
      .set(f.assignment.turnKeyHash, { ...f.assignment, tenantPseudonymHash: digest('forged') });
    const prepared = await prepareCapabilityShadowSignedEvent(f.input);
    expect(prepared!.envelope.payload.event.sample.cohort).toBe('representative');
    expect(prepared!.envelope.payload.event.tenantPseudonymHash).toBe(f.assignment.tenantPseudonymHash);
  });

  it('rejects unverified assignment, wrong authorized identifier and pre-signer lifecycle/content fields', async () => {
    const f = fixture();
    await expect(prepareCapabilityShadowSignedEvent({ ...f.input, membership: {} as VerifiedCapabilityShadowMembership }))
      .rejects.toThrow('verified membership');
    await expect(prepareCapabilityShadowSignedEvent({ ...f.input, tenantIdentifier: Buffer.from('other-tenant') }))
      .rejects.toThrow('locked membership assignment');
    await expect(prepareCapabilityShadowSignedEvent({ ...f.input, evaluationUnitIdentifier: Buffer.from('other-unit') }))
      .rejects.toThrow('locked membership assignment');
    await expect(prepareCapabilityShadowSignedEvent({ ...f.input, observed: {
      ...f.input.observed, execution: { ...f.input.observed.execution,
        jev: { ...settledAttempt(), dispatchedAt: null },
      },
    } })).rejects.toThrow();
    await expect(prepareCapabilityShadowSignedEvent({ ...f.input, observed: {
      ...f.input.observed,
      route: { ...f.input.observed.route, prompt: 'private text' } as typeof f.input.observed.route,
    } })).rejects.toThrow();
    expect(f.getCalls()).toBe(0);
  });

  it('rejects unpinned, duplicate-key and secret-bearing registries before signer access', async () => {
    const f = fixture();
    await expect(prepareCapabilityShadowSignedEvent({ ...f.input, expectedPublicRegistrySha256: digest('wrong') }))
      .rejects.toThrow('pin mismatch');
    const duplicate = Buffer.from(JSON.stringify(f.publicRegistry).replace('"signing":', '"signing":[],"signing":'));
    await expect(prepareCapabilityShadowSignedEvent({ ...f.input, publicRegistryBytes: duplicate,
      expectedPublicRegistrySha256: createHash('sha256').update(duplicate).digest('hex') }))
      .rejects.toThrow('duplicate raw JSON key');
    const secretBearing = Buffer.from(JSON.stringify({ ...f.publicRegistry, secret: 'forbidden' }));
    await expect(prepareCapabilityShadowSignedEvent({ ...f.input, publicRegistryBytes: secretBearing,
      expectedPublicRegistrySha256: createHash('sha256').update(secretBearing).digest('hex') }))
      .rejects.toThrow();
    expect(f.getCalls()).toBe(0);
  });

  it('does not call the protected signer for mismatched HMAC windows or versions', async () => {
    const f = fixture();
    await expect(prepareCapabilityShadowSignedEvent({ ...f.input,
      tenantKey: { ...f.input.tenantKey, window: { ...window, notAfter: '2026-10-01T00:00:00.000Z' } },
    })).rejects.toThrow('window differs');
    const registryWithDifferentVersion = {
      ...f.publicRegistry,
      tenant: [{ ...f.publicRegistry.tenant[0]!, version: 'tenant_hmac.v2' }],
    };
    const publicRegistryBytes = Buffer.from(JSON.stringify(registryWithDifferentVersion));
    await expect(prepareCapabilityShadowSignedEvent({ ...f.input, publicRegistryBytes,
      expectedPublicRegistrySha256: createHash('sha256').update(publicRegistryBytes).digest('hex'),
    })).rejects.toThrow('reference or window differs');
    expect(f.getCalls()).toBe(0);
  });

  it('rejects globally ambiguous cross-purpose registry key IDs before signer access', async () => {
    const f = fixture();
    const ambiguousRegistry = {
      ...f.publicRegistry,
      evaluationUnit: [{ ...f.publicRegistry.evaluationUnit[0]!, keyId: f.publicRegistry.tenant[0]!.keyId }],
    };
    const publicRegistryBytes = Buffer.from(JSON.stringify(ambiguousRegistry));
    await expect(prepareCapabilityShadowSignedEvent({ ...f.input, publicRegistryBytes,
      expectedPublicRegistrySha256: createHash('sha256').update(publicRegistryBytes).digest('hex'),
    })).rejects.toThrow('pseudonym key IDs must be separate');
    expect(f.getCalls()).toBe(0);
  });

  it('rejects an unregistered signer before a private-key call, then rejects bad signatures', async () => {
    const f = fixture();
    await expect(prepareCapabilityShadowSignedEvent({ ...f.input, signingKeyId: 'unknown' }))
      .rejects.toThrow('missing or outside');
    expect(f.getCalls()).toBe(0);
    await expect(prepareCapabilityShadowSignedEvent({ ...f.input, sign: async () => Buffer.alloc(64, 7) }))
      .rejects.toThrow('signature is invalid');
    await expect(prepareCapabilityShadowSignedEvent({ ...f.input, sign: async () => Buffer.alloc(63) }))
      .rejects.toThrow('64-byte Ed25519');
  });
});
