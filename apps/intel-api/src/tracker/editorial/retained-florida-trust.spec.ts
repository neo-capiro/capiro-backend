import { describe, expect, it, jest } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { CORE_RETAINED_TRUST_ENV, CoreRetainedTrustConfigError } from '@capiro/shared/core-retained-trust';
import { createCoreRetainedPrincipalSigner } from '@capiro/shared/core-retained-principal';
import {
  CORE_RETAINED_AUTHORITY_PROBE_OPERATION,
  CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH,
  createCoreRetainedAuthorityProbeSigner,
} from '@capiro/shared/core-retained-authority-probe';
import { CORE_RETAINED_FLORIDA_DATA_PATH } from '@capiro/shared/core-retained-authority-http';
import { createIntelRetainedFloridaPorts, intelRetainedFloridaPortsFromEnv } from './retained-florida-trust.js';

const principal = generateKeyPairSync('ed25519');
const probe = generateKeyPairSync('ed25519');
const spki = (key: typeof principal.publicKey) => key.export({ format: 'pem', type: 'spki' }).toString();
const N = CORE_RETAINED_TRUST_ENV;
const env = {
  [N.enabled]: 'true', [N.issuer]: 'capiro-core-retained',
  [N.coreOrigin]: 'https://core.example.invalid', [N.intelOrigin]: 'https://intel.example.invalid',
  [N.principalKeyId]: 'retained-principal-1', [N.principalPublicKey]: spki(principal.publicKey),
  [N.probeKeyId]: 'retained-probe-1', [N.probePublicKey]: spki(probe.publicKey),
};
const nowMs = 1_800_000_000_000;
const time = { nowMs, deadlineMs: nowMs + 30_000 };
const facts = {
  principal: { tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', actorId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', clerkUserId: 'user_current' },
  identityRevision: '1'.repeat(64), currentAuthority: '{"schemaVersion":1,"observation":"synthetic-only"}',
  issuedAtMs: nowMs, originalExpiresAtMs: nowMs + 30_000,
};
const digests = { rawRequestSha256: '3'.repeat(64), normalizedArgsSha256: '4'.repeat(64), normalizationContextSha256: '5'.repeat(64) };
const selector = { schemaVersion: 1 as const, sessionKey: '', folderId: null, clientSelector: null };
// Exactly the pins Core's apps/api/src/auth/retained-trust.ts gives the Florida signers.
const corePins = { canonicalize: canonicalizeCoreRetainedJson, issuer: 'capiro-core-retained', audienceOrigin: 'https://intel.example.invalid' };

describe('Intel verifier-only retained Florida ports', () => {
  it('is null (both signed routes 503) when disabled or absent', () => {
    expect(createIntelRetainedFloridaPorts(null)).toBeNull();
    expect(intelRetainedFloridaPortsFromEnv({})).toBeNull();
    expect(intelRetainedFloridaPortsFromEnv({ [N.enabled]: 'false' })).toBeNull();
  });

  it('refuses to start with a signing key on the Intel side', () => {
    const privatePem = principal.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => intelRetainedFloridaPortsFromEnv({ ...env, [N.principalPrivateKey]: privatePem })).toThrow(CoreRetainedTrustConfigError);
  });

  it('verifies a Core Florida data envelope and rejects one addressed to a Core recipient', () => {
    const ports = intelRetainedFloridaPortsFromEnv(env)!;
    const sign = (recipientPath: string, audienceOrigin: string) => createCoreRetainedPrincipalSigner({
      ...corePins, audienceOrigin, keyId: 'retained-principal-1', recipientPath,
      operation: 'get_florida_budget_project', privateKey: principal.privateKey,
    }).sign({ ...facts, resourceRevision: '2'.repeat(64), ...digests }, time);
    const header = sign(CORE_RETAINED_FLORIDA_DATA_PATH, 'https://intel.example.invalid');
    expect(ports.dataVerifier.verifyCryptographically(header, { ...time, expectedDigests: digests }).principal).toEqual(facts.principal);
    const wrongRecipient = sign('/api/clio/retained-reads/research-portfolio', 'https://core.example.invalid');
    expect(() => ports.dataVerifier.verifyCryptographically(wrongRecipient, { ...time, expectedDigests: digests })).toThrow();
  });

  it('verifies the authority-only probe only with the probe key', () => {
    const ports = intelRetainedFloridaPortsFromEnv(env)!;
    const sign = (privateKey: typeof probe.privateKey) => createCoreRetainedAuthorityProbeSigner({
      ...corePins, keyId: 'retained-probe-1', recipientPath: CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH,
      operation: CORE_RETAINED_AUTHORITY_PROBE_OPERATION, privateKey,
    }).sign({ ...facts, selector }, time);
    expect(ports.probeVerifier.verifyCryptographically(sign(probe.privateKey), { ...time, selector }).principal).toEqual(facts.principal);
    expect(() => ports.probeVerifier.verifyCryptographically(sign(principal.privateKey), { ...time, selector })).toThrow();
  });

  it('composes the Core corroboration client without fetching', () => {
    const fetchImpl = jest.fn();
    const ports = createIntelRetainedFloridaPorts(
      { issuer: 'capiro-core-retained', coreOrigin: env[N.coreOrigin], intelOrigin: env[N.intelOrigin],
        principal: { keyId: 'retained-principal-1', publicKey: principal.publicKey, privateKey: null },
        probe: { keyId: 'retained-probe-1', publicKey: probe.publicKey, privateKey: null } },
      fetchImpl as never,
    )!;
    expect(typeof ports.current.verifyProbeCurrent).toBe('function');
    expect(typeof ports.current.verifyFloridaDataCurrent).toBe('function');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
