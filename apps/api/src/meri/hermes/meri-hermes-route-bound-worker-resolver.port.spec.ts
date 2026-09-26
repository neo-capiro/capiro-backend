import {
  assertMeriHermesRouteBoundWorkerResolutionV2,
  type MeriHermesRouteBoundWorkerRequestV2,
  type MeriHermesRouteBoundWorkerResolutionV2,
} from './meri-hermes-route-bound-worker-resolver.port.js';

const expected: MeriHermesRouteBoundWorkerRequestV2 = Object.freeze({
  tenantId: '11111111-1111-4111-8111-111111111111',
  scopeId: 'tenant:11111111-1111-4111-8111-111111111111:user:22222222-2222-4222-8222-222222222222',
  workerAudience: 'meri-hermes-scope-worker', workerIngressId: 'ingress-a',
  workerGeneration: 'generation-a', workerCredentialId: 'credential-a',
  workerImageDigest: 'a'.repeat(64), workerBuildId: 'build-a',
  workerCatalogDigest: 'b'.repeat(64), meriCatalogVersion: 'catalog-7',
  meriCatalogDigest: 'c'.repeat(64), capabilityMappingVersion: 'mapping-7',
  capabilityMappingDigest: 'd'.repeat(64),
});
const resolved: MeriHermesRouteBoundWorkerResolutionV2 = Object.freeze({
  ...expected, endpointOrigin: 'https://worker.internal.example',
  workerCatalogDigestAlgorithm: 'capiro.meri.phase4.worker-catalog/v1',
  appliedToolViewDigestAlgorithm: 'capiro.meri.phase4.applied-tool-view/v1',
  toolViewProtocol: 'capiro.meri.phase4.request-local-tool-view/v1',
  claimAttestationProtocol: 'capiro.meri.phase4.claim-tool-view-attestation/v1',
  attestationCredentialId: expected.workerCredentialId,
  resolutionSource: 'source-qualified-control-plane',
});

describe('dormant Phase 4 route-bound worker resolver contract', () => {
  test('accepts only an exact HTTPS source-qualified resolution', () => {
    expect(() => assertMeriHermesRouteBoundWorkerResolutionV2(expected, resolved)).not.toThrow();
  });

  test.each([
    { workerGeneration: 'other-generation' },
    { workerImageDigest: 'e'.repeat(64) },
    { workerCatalogDigest: 'f'.repeat(64) },
    { attestationCredentialId: 'caller-selected-key' },
    { endpointOrigin: 'http://localhost:8642' },
    { endpointOrigin: 'https://worker.internal.example/path' },
    { resolutionSource: 'static-default' },
  ])('rejects drift or fallback resolution %p', (change) => {
    expect(() => assertMeriHermesRouteBoundWorkerResolutionV2(
      expected, { ...resolved, ...change } as MeriHermesRouteBoundWorkerResolutionV2,
    )).toThrow('invalid Phase 4 route-bound worker resolution');
  });
});
