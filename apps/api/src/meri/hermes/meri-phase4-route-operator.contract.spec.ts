import {
  assertMeriPhase4AttestationV1,
  assertMeriPhase4AttestationV2,
  assertMeriPhase4LifetimeV1,
  assertMeriPhase4PrivateScopeV1,
  assertMeriPhase4RouteIdentityV1,
  computeMeriPhase4RouteRequestDigestV1,
  MERI_PHASE4_ROUTE_MAX_LIFETIME_MICROS_V1,
} from './meri-phase4-route-operator.contract.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const scopeId = `tenant:${tenantId}:user:22222222-2222-4222-8222-222222222222`;

describe('dormant Phase 4 route operator contract', () => {
  it('frames versioned request digests and makes order/action drift visible', () => {
    const value = computeMeriPhase4RouteRequestDigestV1(['enable', tenantId, scopeId]);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(computeMeriPhase4RouteRequestDigestV1(['enable', tenantId, scopeId])).toBe(value);
    expect(computeMeriPhase4RouteRequestDigestV1(['close', tenantId, scopeId])).not.toBe(value);
    expect(computeMeriPhase4RouteRequestDigestV1(['enable', scopeId, tenantId])).not.toBe(value);
  });

  it('accepts only canonical tenant-private user scopes', () => {
    expect(() => assertMeriPhase4PrivateScopeV1(tenantId, scopeId)).not.toThrow();
    expect(() => assertMeriPhase4PrivateScopeV1(tenantId, `tenant:${tenantId}:user:bad`)).toThrow();
    expect(() => assertMeriPhase4PrivateScopeV1(
      'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', scopeId,
    )).toThrow();
  });

  it('bounds route identities, attestation windows, and route lifetime', () => {
    const identity = {
      requestId: '33333333-3333-4333-8333-333333333333', scopeId,
      ingressId: 'ingress-a', expectedGeneration: 'generation-a',
      expectedCredentialId: 'credential-a',
    };
    expect(() => assertMeriPhase4RouteIdentityV1(tenantId, identity)).not.toThrow();
    expect(() => assertMeriPhase4RouteIdentityV1(tenantId, {
      ...identity, ingressId: 'bad/value',
    })).toThrow();
    expect(() => assertMeriPhase4LifetimeV1(MERI_PHASE4_ROUTE_MAX_LIFETIME_MICROS_V1)).not.toThrow();
    expect(() => assertMeriPhase4LifetimeV1(MERI_PHASE4_ROUTE_MAX_LIFETIME_MICROS_V1 + 1n)).toThrow();
    expect(() => assertMeriPhase4AttestationV1({
      bindingId: '44444444-4444-4444-8444-444444444444',
      externalRecordId: 'source-record-1', tenantId, scopeId,
      ingressId: 'ingress-a', generation: 'generation-a', credentialId: 'credential-a',
      notBeforeEpochMicros: 10n, notAfterEpochMicros: 10n + 60_000_000n,
    })).not.toThrow();
    expect(() => assertMeriPhase4AttestationV1({
      bindingId: '44444444-4444-4444-8444-444444444444',
      externalRecordId: 'source-record-1', tenantId, scopeId,
      ingressId: 'ingress-a', generation: 'generation-a', credentialId: 'credential-a',
      notBeforeEpochMicros: 10n, notAfterEpochMicros: 10n +
        MERI_PHASE4_ROUTE_MAX_LIFETIME_MICROS_V1 + 1n,
    })).toThrow();
  });

  it('requires all source-qualified v2 evidence and a route-selected attestation key', () => {
    const binding = {
      bindingId: '44444444-4444-4444-8444-444444444444',
      externalRecordId: 'source-record-v2', tenantId, scopeId,
      ingressId: 'ingress-a', generation: 'generation-a', credentialId: 'credential-a',
      notBeforeEpochMicros: 10n, notAfterEpochMicros: 60_000_010n,
      bindingVersion: 2 as const, workerImageDigest: 'a'.repeat(64), workerBuildId: 'build-a',
      workerCatalogDigestAlgorithm: 'capiro.meri.phase4.worker-catalog/v1' as const,
      workerCatalogDigest: 'b'.repeat(64),
      appliedToolViewDigestAlgorithm: 'capiro.meri.phase4.applied-tool-view/v1' as const,
      meriCatalogVersion: 'catalog-7', meriCatalogDigest: 'c'.repeat(64),
      capabilityMappingVersion: 'mapping-7', capabilityMappingDigest: 'd'.repeat(64),
      toolViewProtocol: 'capiro.meri.phase4.request-local-tool-view/v1' as const,
      claimAttestationProtocol:
        'capiro.meri.phase4.claim-tool-view-attestation/v1' as const,
      attestationCredentialId: 'credential-a',
    };
    expect(() => assertMeriPhase4AttestationV2(binding)).not.toThrow();
    expect(() => assertMeriPhase4AttestationV2({
      ...binding, attestationCredentialId: 'caller-selected-key',
    })).toThrow('invalid source-qualified worker binding v2');
    expect(() => assertMeriPhase4AttestationV2({
      ...binding, workerCatalogDigestAlgorithm: 'legacy-sha256' as never,
    })).toThrow('invalid source-qualified worker binding v2');
  });
});
