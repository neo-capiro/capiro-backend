import {
  MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1,
  MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1,
} from './meri-hermes-tool-view.js';
import {
  MERI_PHASE4_CLAIM_ATTESTATION_PROTOCOL_V1,
  MERI_PHASE4_TOOL_VIEW_PROTOCOL_V1,
} from './meri-phase4-route-operator.contract.js';

/** Nonsecret exact binding expected by a future Phase 4 transport. */
export interface MeriHermesRouteBoundWorkerRequestV2 {
  readonly tenantId: string;
  readonly scopeId: string;
  readonly workerAudience: string;
  readonly workerIngressId: string;
  readonly workerGeneration: string;
  readonly workerCredentialId: string;
  readonly workerImageDigest: string;
  readonly workerBuildId: string;
  readonly workerCatalogDigest: string;
  readonly meriCatalogVersion: string;
  readonly meriCatalogDigest: string;
  readonly capabilityMappingVersion: string;
  readonly capabilityMappingDigest: string;
}

export interface MeriHermesRouteBoundWorkerResolutionV2
extends MeriHermesRouteBoundWorkerRequestV2 {
  readonly endpointOrigin: string;
  readonly workerCatalogDigestAlgorithm:
    typeof MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1;
  readonly appliedToolViewDigestAlgorithm:
    typeof MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1;
  readonly toolViewProtocol: typeof MERI_PHASE4_TOOL_VIEW_PROTOCOL_V1;
  readonly claimAttestationProtocol: typeof MERI_PHASE4_CLAIM_ATTESTATION_PROTOCOL_V1;
  readonly attestationCredentialId: string;
  readonly resolutionSource: 'source-qualified-control-plane';
}

/**
 * Phase 4 has no default/static fallback. The implementation must resolve the
 * exact source-qualified binding and a private endpoint together.
 */
export interface MeriHermesRouteBoundWorkerResolverPortV2 {
  resolveExactWorker(
    expected: Readonly<MeriHermesRouteBoundWorkerRequestV2>,
  ): Promise<Readonly<MeriHermesRouteBoundWorkerResolutionV2>>;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** Fail closed before a future transport can send any request bytes. */
export function assertMeriHermesRouteBoundWorkerResolutionV2(
  expected: Readonly<MeriHermesRouteBoundWorkerRequestV2>,
  resolved: Readonly<MeriHermesRouteBoundWorkerResolutionV2>,
): void {
  const exactKeys: readonly (keyof MeriHermesRouteBoundWorkerRequestV2)[] = [
    'tenantId', 'scopeId', 'workerAudience', 'workerIngressId', 'workerGeneration',
    'workerCredentialId', 'workerImageDigest', 'workerBuildId', 'workerCatalogDigest',
    'meriCatalogVersion', 'meriCatalogDigest', 'capabilityMappingVersion',
    'capabilityMappingDigest',
  ];
  let endpoint: URL;
  try { endpoint = new URL(resolved.endpointOrigin); } catch {
    throw new Error('invalid Phase 4 route-bound worker resolution');
  }
  if (exactKeys.some((key) => resolved[key] !== expected[key]) ||
      endpoint.protocol !== 'https:' || endpoint.origin !== resolved.endpointOrigin ||
      endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
      !SHA256.test(resolved.workerImageDigest) ||
      !SHA256.test(resolved.workerCatalogDigest) || !SHA256.test(resolved.meriCatalogDigest) ||
      !SHA256.test(resolved.capabilityMappingDigest) ||
      resolved.workerCatalogDigestAlgorithm !==
        MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1 ||
      resolved.appliedToolViewDigestAlgorithm !==
        MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1 ||
      resolved.toolViewProtocol !== MERI_PHASE4_TOOL_VIEW_PROTOCOL_V1 ||
      resolved.claimAttestationProtocol !== MERI_PHASE4_CLAIM_ATTESTATION_PROTOCOL_V1 ||
      resolved.attestationCredentialId !== expected.workerCredentialId ||
      resolved.resolutionSource !== 'source-qualified-control-plane') {
    throw new Error('invalid Phase 4 route-bound worker resolution');
  }
}
