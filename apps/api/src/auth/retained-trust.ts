import { Module, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import {
  CORE_RETAINED_TRUST_ENV_KEYS,
  readCoreRetainedTrust,
  type CoreRetainedTrust,
} from '@capiro/shared/core-retained-trust';
import {
  createCoreRetainedPrincipalCryptographicVerifier,
  createCoreRetainedPrincipalSigner,
  type CoreRetainedPrincipalCryptographicVerifier,
  type CoreRetainedPrincipalSigner,
  type CoreRetainedReadOperation,
} from '@capiro/shared/core-retained-principal';
import {
  CORE_RETAINED_AUTHORITY_PROBE_OPERATION,
  CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH,
  createCoreRetainedAuthorityProbeCryptographicVerifier,
  createCoreRetainedAuthorityProbeSigner,
  type CoreRetainedAuthorityProbeCryptographicVerifier,
} from '@capiro/shared/core-retained-authority-probe';
import {
  createCoreFloridaAuthorityPort,
  type CoreRetainedAuthorityFetch,
} from '@capiro/shared/core-retained-authority-http';
import { DATA_PATHS, type RetainedPrincipalPorts } from './retained-principal.service.js';
import type { RetainedFloridaAuthorityPort } from './retained-read-authority.service.js';

/** Validated trust pins, or null when retained reads are disabled. */
export const RETAINED_TRUST = Symbol('retained-trust');

const OPERATIONS = [
  'get_research_portfolio',
  'get_research_portfolio_changes',
  'get_florida_budget_project',
] as const satisfies readonly CoreRetainedReadOperation[];

export function retainedTrustFromConfig(config: Pick<ConfigService, 'get'>): CoreRetainedTrust | null {
  const env = Object.fromEntries(
    CORE_RETAINED_TRUST_ENV_KEYS.map((key) => [key, config.get<string>(key)]),
  );
  return readCoreRetainedTrust(env, 'core');
}

function signingKey(trust: CoreRetainedTrust, purpose: 'principal' | 'probe') {
  const key = trust[purpose].privateKey;
  // The core role always loads private keys; null here means a wrong-role trust.
  if (!key) throw new ServiceUnavailableException('Retained signer unavailable');
  return key;
}

/** Data envelopes for Portfolio reads are addressed to Core; Florida budget
 * data is addressed to Intel. Each operation pins its own fixed recipient. */
function principalPin(trust: CoreRetainedTrust, operation: CoreRetainedReadOperation) {
  return {
    canonicalize: canonicalizeCoreRetainedJson,
    keyId: trust.principal.keyId,
    issuer: trust.issuer,
    audienceOrigin: operation === 'get_florida_budget_project' ? trust.intelOrigin : trust.coreOrigin,
    recipientPath: DATA_PATHS[operation],
    operation,
  };
}

function probePin(trust: CoreRetainedTrust) {
  return {
    canonicalize: canonicalizeCoreRetainedJson,
    keyId: trust.probe.keyId,
    issuer: trust.issuer,
    audienceOrigin: trust.intelOrigin,
    recipientPath: CORE_RETAINED_AUTHORITY_PROBE_RECIPIENT_PATH,
    operation: CORE_RETAINED_AUTHORITY_PROBE_OPERATION,
  };
}

export function createRetainedPrincipalPorts(trust: CoreRetainedTrust | null): RetainedPrincipalPorts | null {
  if (!trust) return null;
  const signers = {} as Record<CoreRetainedReadOperation, CoreRetainedPrincipalSigner>;
  const verifiers = {} as Record<CoreRetainedReadOperation, CoreRetainedPrincipalCryptographicVerifier>;
  for (const operation of OPERATIONS) {
    const pin = principalPin(trust, operation);
    signers[operation] = createCoreRetainedPrincipalSigner({ ...pin, privateKey: signingKey(trust, 'principal') });
    verifiers[operation] = createCoreRetainedPrincipalCryptographicVerifier({ ...pin, publicKey: trust.principal.publicKey });
  }
  return Object.freeze({
    canonicalize: canonicalizeCoreRetainedJson,
    signers: Object.freeze(signers),
    verifiers: Object.freeze(verifiers),
  });
}

/** Core verifies the authority-only probes it signed for Intel when Intel asks
 * for fresh native corroboration (`retained-florida-native-current`). */
export function createRetainedFloridaProbeVerifier(
  trust: CoreRetainedTrust | null,
): CoreRetainedAuthorityProbeCryptographicVerifier | null {
  if (!trust) return null;
  return createCoreRetainedAuthorityProbeCryptographicVerifier({ ...probePin(trust), publicKey: trust.probe.publicKey });
}

const unavailableFloridaAuthority: RetainedFloridaAuthorityPort = {
  async read() {
    throw new ServiceUnavailableException('Retained Florida issuer/verifier unavailable');
  },
};

/** Fixed redirect-free POSTs; the shared transport bounds bodies and deadlines. */
const fetchPort: CoreRetainedAuthorityFetch = (url, init) => fetch(url, init);

export function createRetainedFloridaAuthorityPort(
  trust: CoreRetainedTrust | null,
  fetchImpl: CoreRetainedAuthorityFetch = fetchPort,
): RetainedFloridaAuthorityPort {
  if (!trust) return unavailableFloridaAuthority;
  return createCoreFloridaAuthorityPort({
    coreOrigin: trust.coreOrigin,
    intelOrigin: trust.intelOrigin,
    fetch: fetchImpl,
    canonicalize: canonicalizeCoreRetainedJson,
    probeSigner: createCoreRetainedAuthorityProbeSigner({ ...probePin(trust), privateKey: signingKey(trust, 'probe') }),
  });
}

/** One validated trust instance per Core process. `RETAINED_READS_ENABLED=true`
 * with an incomplete pin set fails startup rather than serving partial trust. */
@Module({
  providers: [{ provide: RETAINED_TRUST, useFactory: retainedTrustFromConfig, inject: [ConfigService] }],
  exports: [RETAINED_TRUST],
})
export class RetainedTrustModule {}
