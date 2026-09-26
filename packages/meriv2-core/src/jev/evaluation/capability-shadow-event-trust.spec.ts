import { describe, expect, it } from '@jest/globals';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  capabilityShadowEventPayloadToCanonicalJson,
  capabilityShadowEventSigningBytes,
  deriveCapabilityShadowPseudonyms,
  verifyCapabilityShadowEventPseudonyms,
  verifyCapabilityShadowSignedEvent,
  type CapabilityShadowEventVerificationKeys,
  type CapabilityShadowPseudonymKeys,
  type CapabilityShadowSignedEventPayload,
} from './capability-shadow-event-trust';
import { ingestCapabilityShadowSignedEvents, parseCapabilityShadowUniqueJson } from './capability-shadow-signed-ingest';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const window = { notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2027-01-01T00:00:00.000Z' };
const tenantIdentifier = Buffer.from('tenant-42', 'utf8');
const evaluationUnitIdentifier = Buffer.from('turn-99', 'utf8');

function fixture() {
  const signing = generateKeyPairSync('ed25519');
  const tenantKey = { keyId: 'tenant_2026', version: 'tenant_hmac.v1', secret: Buffer.alloc(32, 0x21), window };
  const evaluationUnitKey = { keyId: 'unit_2026', version: 'eval_unit_hmac.v1', secret: Buffer.alloc(32, 0x31), window };
  const pseudonyms = deriveCapabilityShadowPseudonyms({
    tenantIdentifier, evaluationUnitIdentifier, tenantKey, evaluationUnitKey,
    occurredAt: '2026-09-25T10:00:00.000Z',
  });
  const emptyAttempt = {
    status: 'not_attempted' as const, attemptedAt: null, dispatchedAt: null, finishedAt: null,
    durationMs: null, inputTokens: null, outputTokens: null, costUsd: null,
  };
  const payload: CapabilityShadowSignedEventPayload = {
    version: 'meri_capability_shadow_signed_event.v1',
    signingKey: { keyId: 'event_2026', version: 'event_ed25519.v1' },
    pseudonymKeys: {
      tenant: { keyId: tenantKey.keyId, version: tenantKey.version },
      evaluationUnit: { keyId: evaluationUnitKey.keyId, version: evaluationUnitKey.version },
    },
    event: {
      event: 'meri.capability_shadow.turn', schemaVersion: 1, eventId: digest('event-1'),
      turnKeyHash: digest('turn-1'), evaluationUnitHash: pseudonyms.evaluationUnitHash,
      evaluationUnitKeyVersion: 'eval_unit_hmac.v1', tenantPseudonymHash: pseudonyms.tenantPseudonymHash,
      tenantPseudonymKeyVersion: 'tenant_hmac.v1', occurredAt: '2026-09-25T10:00:00.000Z',
      sample: {
        source: 'live', cohort: 'representative', split: 'tuning', membershipManifestDigest: digest('manifest'),
        selectionPolicyVersion: 'sampling.v1', surface: 'chat', domain: 'gov_affairs', taskFamily: 'awards_search',
      },
      versions: { catalog: 'catalog.v1', routingModel: 'jev_luna.v1', question: 'route.v1', policy: 'policy.v1' },
      route: { eligible: false, ineligibleReason: 'policy_denied', baseline: null, candidate: null, confidence: null, fallbackReason: null },
      tools: { required: [], candidateExposed: [], baselineExposed: [], baselineUsed: [] },
      execution: { executor: 'baseline', baseline: emptyAttempt, jev: emptyAttempt },
    },
  };
  const signatureBase64 = sign(null, capabilityShadowEventSigningBytes(payload), signing.privateKey).toString('base64');
  const publicKeyPem = signing.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const trustedSpkiSha256 = createHash('sha256').update(signing.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const verificationKeys: CapabilityShadowEventVerificationKeys = {
    signing: [{ keyId: 'event_2026', version: 'event_ed25519.v1', publicKeyPem, trustedSpkiSha256, window }],
    tenant: [{ keyId: tenantKey.keyId, version: tenantKey.version, window }],
    evaluationUnit: [{ keyId: evaluationUnitKey.keyId, version: evaluationUnitKey.version, window }],
  };
  const pseudonymKeys: CapabilityShadowPseudonymKeys = { tenant: [tenantKey], evaluationUnit: [evaluationUnitKey] };
  return { payload, envelope: { payload, signatureBase64 }, verificationKeys, pseudonymKeys, tenantKey, evaluationUnitKey };
}

describe('isolated capability shadow event trust', () => {
  it('uses canonical signed bytes independent of object insertion order', () => {
    const { payload, envelope, verificationKeys, pseudonymKeys } = fixture();
    const reordered = { event: payload.event, pseudonymKeys: payload.pseudonymKeys, signingKey: payload.signingKey, version: payload.version };
    expect(capabilityShadowEventPayloadToCanonicalJson(reordered)).toBe(capabilityShadowEventPayloadToCanonicalJson(payload));
    expect(verifyCapabilityShadowSignedEvent(envelope, verificationKeys)).toMatchObject({ signingKeyId: 'event_2026' });
    verifyCapabilityShadowEventPseudonyms(envelope, verificationKeys, pseudonymKeys, { tenantIdentifier, evaluationUnitIdentifier });
    expect(() => verifyCapabilityShadowSignedEvent(envelope, { ...verificationKeys, tenant: pseudonymKeys.tenant })).toThrow();
  });

  it('rejects tampering, wrong fingerprints, unknown or expired keys, and noncanonical base64', () => {
    const { envelope, verificationKeys, pseudonymKeys } = fixture();
    const tampered = { ...envelope, payload: { ...envelope.payload, event: { ...envelope.payload.event, turnKeyHash: digest('changed') } } };
    expect(() => verifyCapabilityShadowSignedEvent(tampered, verificationKeys)).toThrow('signature is invalid');
    expect(() => verifyCapabilityShadowSignedEvent(envelope, { ...verificationKeys, signing: [{ ...verificationKeys.signing[0]!, trustedSpkiSha256: digest('wrong') }] })).toThrow('not trusted');
    expect(() => verifyCapabilityShadowSignedEvent(envelope, { ...verificationKeys, signing: [] })).toThrow();
    expect(() => verifyCapabilityShadowSignedEvent(envelope, { ...verificationKeys, signing: [{ ...verificationKeys.signing[0]!, window: { ...window, notAfter: '2026-09-25T09:00:00.000Z' } }] })).toThrow('outside its validity window');
    expect(() => verifyCapabilityShadowSignedEvent({ ...envelope, signatureBase64: `${envelope.signatureBase64}=` }, verificationKeys)).toThrow();
    expect(() => verifyCapabilityShadowEventPseudonyms(envelope, verificationKeys, pseudonymKeys, { tenantIdentifier: Buffer.from('other'), evaluationUnitIdentifier })).toThrow('pseudonyms do not match');
  });

  it('binds key IDs and versions and supports an explicitly registered historical rotation', () => {
    const { envelope, verificationKeys, pseudonymKeys, tenantKey } = fixture();
    expect(() => verifyCapabilityShadowSignedEvent({ ...envelope, payload: { ...envelope.payload, pseudonymKeys: { ...envelope.payload.pseudonymKeys, tenant: { keyId: 'other', version: 'tenant_hmac.v1' } } } }, verificationKeys)).toThrow();
    expect(() => verifyCapabilityShadowSignedEvent({ ...envelope, payload: { ...envelope.payload, pseudonymKeys: { ...envelope.payload.pseudonymKeys, tenant: { keyId: tenantKey.keyId, version: 'tenant_hmac.v2' } } } }, verificationKeys)).toThrow('version differs from event');
    expect(() => verifyCapabilityShadowSignedEvent(envelope, { ...verificationKeys, tenant: [{ ...verificationKeys.tenant[0]!, keyId: 'replacement' }] })).toThrow('missing or outside');
    const rotated = { ...verificationKeys, tenant: [...verificationKeys.tenant, { ...verificationKeys.tenant[0]!, keyId: 'tenant_2027', window: { notBefore: '2027-01-01T00:00:00.000Z', notAfter: '2028-01-01T00:00:00.000Z' } }] };
    expect(verifyCapabilityShadowSignedEvent(envelope, rotated).signingKeyId).toBe('event_2026');
    expect(() => verifyCapabilityShadowSignedEvent(envelope, { ...rotated, tenant: [rotated.tenant[1]!] })).toThrow('missing or outside');
    expect(() => verifyCapabilityShadowEventPseudonyms(envelope, verificationKeys, { ...pseudonymKeys, tenant: [{ ...tenantKey, window: { ...window, notAfter: '2026-10-01T00:00:00.000Z' } }] }, { tenantIdentifier, evaluationUnitIdentifier })).toThrow('window differs');
    expect(() => verifyCapabilityShadowEventPseudonyms(envelope, verificationKeys, { ...pseudonymKeys, tenant: [...pseudonymKeys.tenant, { ...tenantKey, keyId: 'unknown', secret: Buffer.alloc(32, 0x42) }] }, { tenantIdentifier, evaluationUnitIdentifier })).toThrow('reference or window differs');
  });

  it('rejects reused HMAC material, non-32-byte keys, and invalid identifiers', () => {
    const { envelope, verificationKeys, pseudonymKeys, tenantKey, evaluationUnitKey } = fixture();
    expect(() => deriveCapabilityShadowPseudonyms({ tenantIdentifier, evaluationUnitIdentifier, tenantKey, evaluationUnitKey: { ...evaluationUnitKey, secret: tenantKey.secret }, occurredAt: envelope.payload.event.occurredAt })).toThrow('must be separate');
    expect(() => deriveCapabilityShadowPseudonyms({ tenantIdentifier, evaluationUnitIdentifier, tenantKey: { ...tenantKey, secret: Buffer.alloc(31) }, evaluationUnitKey, occurredAt: envelope.payload.event.occurredAt })).toThrow('exactly 32 bytes');
    const equivalentHmacKey = Buffer.concat([tenantKey.secret, Buffer.from([0])]);
    expect(() => deriveCapabilityShadowPseudonyms({ tenantIdentifier, evaluationUnitIdentifier, tenantKey, evaluationUnitKey: { ...evaluationUnitKey, secret: equivalentHmacKey }, occurredAt: envelope.payload.event.occurredAt })).toThrow('exactly 32 bytes');
    expect(() => verifyCapabilityShadowEventPseudonyms(envelope, verificationKeys, { ...pseudonymKeys, evaluationUnit: [{ ...evaluationUnitKey, secret: equivalentHmacKey }] }, { tenantIdentifier, evaluationUnitIdentifier })).toThrow('exactly 32 bytes');
    expect(() => deriveCapabilityShadowPseudonyms({ tenantIdentifier: Buffer.alloc(0), evaluationUnitIdentifier, tenantKey, evaluationUnitKey, occurredAt: envelope.payload.event.occurredAt })).toThrow('identifier');
    expect(() => verifyCapabilityShadowEventPseudonyms(envelope, verificationKeys, { ...pseudonymKeys, tenant: [...pseudonymKeys.tenant, { ...tenantKey, keyId: 'alias' }] }, { tenantIdentifier, evaluationUnitIdentifier })).toThrow('must be separate');
  });
});

describe('opt-in signed event ingest', () => {
  const serialized = () => {
    const { envelope, verificationKeys } = fixture();
    const registryJson = JSON.stringify(verificationKeys);
    return {
      envelope,
      verificationKeys,
      registryJson,
      registryPin: digest(registryJson),
      line: JSON.stringify(envelope),
    };
  };

  it('accepts only envelopes individually verified under a pinned public registry', () => {
    const { line, registryJson, registryPin } = serialized();
    const ingested = ingestCapabilityShadowSignedEvents(`${line}\n`, registryJson, registryPin);
    expect(ingested.verifiedEvents).toBe(1);
    expect(ingested.events[0]?.eventId).toBe(fixture().payload.event.eventId);
    expect(() => ingestCapabilityShadowSignedEvents(line, registryJson, digest('untrusted registry'))).toThrow('pin mismatch');
    expect(() => ingestCapabilityShadowSignedEvents(JSON.stringify(JSON.parse(line).payload.event), registryJson, registryPin)).toThrow();
  });

  it('rejects nested and escaped duplicate JSON keys before object parsing', () => {
    const { line, registryJson, registryPin } = serialized();
    expect(() => parseCapabilityShadowUniqueJson('{"a":1,"\\u0061":2}', 100)).toThrow('duplicate raw JSON key');
    const duplicateEventId = line.replace('"eventId":', `"eventId":"${digest('extra')}","eventId":`);
    expect(() => ingestCapabilityShadowSignedEvents(duplicateEventId, registryJson, registryPin)).toThrow('duplicate raw JSON key');
    const duplicateRegistry = registryJson.replace('"signing":', '"signing":[],"signing":');
    expect(() => ingestCapabilityShadowSignedEvents(line, duplicateRegistry, digest(duplicateRegistry))).toThrow('duplicate raw JSON key');
  });

  it('fails closed on tampering, untrusted keys, secrets, and bounded input', () => {
    const { envelope, verificationKeys, registryJson, registryPin, line } = serialized();
    const tampered = { ...envelope, payload: { ...envelope.payload, event: { ...envelope.payload.event, eventId: digest('tampered') } } };
    expect(() => ingestCapabilityShadowSignedEvents(JSON.stringify(tampered), registryJson, registryPin)).toThrow('signature is invalid');
    const untrusted = JSON.stringify({ ...verificationKeys, signing: [{ ...verificationKeys.signing[0]!, keyId: 'other' }] });
    expect(() => ingestCapabilityShadowSignedEvents(line, untrusted, digest(untrusted))).toThrow('missing or outside');
    const secretBearing = JSON.stringify({ ...verificationKeys, tenant: [{ ...verificationKeys.tenant[0]!, secret: 'forbidden' }] });
    expect(() => ingestCapabilityShadowSignedEvents(line, secretBearing, digest(secretBearing))).toThrow();
    expect(() => ingestCapabilityShadowSignedEvents(`${line}\n${' '.repeat(128 * 1024 + 1)}x`, registryJson, registryPin)).toThrow('byte limit');
    expect(() => ingestCapabilityShadowSignedEvents(`${line}\n`.repeat(2_001), registryJson, registryPin)).toThrow('signed event count exceeds 2000');
    expect(() => ingestCapabilityShadowSignedEvents('', registryJson, registryPin)).toThrow('empty');
  });
});
